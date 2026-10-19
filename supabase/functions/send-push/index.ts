/*
 * send-push — the sending half of Nooki's notifications.
 *
 * Database Webhooks call this function. It works out who should hear about an event,
 * looks up that person's devices in `public.push_subscriptions`, and sends each one a
 * Web Push message signed with Nooki's own VAPID keypair.
 *
 * There is no notification service, SDK, account or bill anywhere in here: this function
 * *is* the push server. What it talks to is each browser's own push endpoint — FCM for
 * Chrome and Edge, Mozilla's autopush for Firefox, Apple's service for Safari and iOS —
 * which is the same unavoidable relay every native app uses, and needs no credentials
 * from us. The payload is encrypted to the device's own keys, so that relay only ever
 * sees ciphertext.
 *
 * Events handled (each its own webhook, all pointing at this function):
 *   messages INSERT            → tell the *partner* a new message arrived (chat tab)
 *   answers INSERT             → tell the *other* partner it is their turn to answer
 *                                (Discuss tab) — only while the session is still open
 *   game_matches UPDATE        → tell the player whose *turn_id* just arrived it is
 *                                their move (Games tab) — only while the game is live
 *   scheduled sweep            → remind both partners that a Together time is due

 * Every event is something the recipient must act on, so a Nooki notification is always
 * meaningful: a new message, a question waiting for your answer, a move waiting for you.
 * Nothing fires for "read", "finished", or "both answered" — that would just be noise.
 *
 * Deploy (see "Push notifications" in README.md for the full runbook):
 *   supabase functions deploy send-push --no-verify-jwt
 *   supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
 *
 * Secrets:
 *   VAPID_PUBLIC_KEY   the same public key as VITE_VAPID_PUBLIC_KEY in the app build
 *   VAPID_PRIVATE_KEY  the other half. Never in the app, never in the repository.
 *   VAPID_SUBJECT      mailto: or https: contact for the push service, as the spec wants
 *   PUSH_WEBHOOK_SECRET  optional but recommended; the same value goes in the Database
 *                        Webhook's Authorization header, and every other caller is
 *                        refused. Without it, the function still refuses anything that is
 *                        not a Supabase-style POST carrying an authorization header.
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform: the service
 * key is what lets this function read subscriptions across accounts, which no phone ever
 * can (the table's RLS shows a user only their own rows).
 */

import webPush from 'npm:web-push@3.6.7';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

/** How long a push notification is worth delivering: past this it is just noise. */
const TTL_SECONDS = 60 * 60 * 12;

/** What a message notification shows. Deliberately short: a lock screen, not a reader. */
const PREVIEW_LENGTH = 140;

interface MessageRecord {
  id?: string;
  couple_id?: string;
  sender_id?: string | null;
  content?: string;
  type?: string;
  session_id?: string | null;
  reply_to_id?: string | null;
  created_at?: string;
}

interface WebhookPayload {
  type?: string;
  table?: string;
  schema?: string;
  record?: Record<string, unknown>;
  old_record?: Record<string, unknown>;
}

interface TogetherTimeReminder {
  id: string;
  couple_id: string;
  activity_type: string;
  activity_id: string;
  activity_name: string;
  scheduled_at: string;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** A notification we hand to the browser. `tab`/`url` open the right place on tap. */
interface PushNotification {
  title: string;
  body: string;
  tag: string;
  tab: string;
  url: string;
  /** Absent for non-chat reminders so they do not clear the unread-chat app badge. */
  badge?: number;
  messageId: string | null;
}

/** A JSON response, since the webhook only records what came back. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requiredSecret(name: string): string | null {
  const value = Deno.env.get(name);
  return value && value.trim() ? value.trim() : null;
}

/**
 * Only the webhook may call this. The function is deployed with `verify_jwt = false`, so
 * this is the check that stands in its place: the shared secret when the owner set one,
 * and at minimum the Authorization header Supabase's own webhooks always send.
 */
function isAuthorised(request: Request): boolean {
  const presented = request.headers.get('Authorization') ?? request.headers.get('authorization');
  if (!presented) return false;
  const secret = requiredSecret('PUSH_WEBHOOK_SECRET');
  if (!secret) return true;
  const token = presented.replace(/^Bearer\s+/i, '').trim();
  return token === secret;
}

function truncate(value: string, limit: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

/** One line of the message, so the notification reads like the bubble it stands for. */
function preview(content: string): string {
  return content ? truncate(content, PREVIEW_LENGTH) : 'Sent you a message.';
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A friendly label for a game, so the notification says "Snake", not "snake". */
function gameLabel(game: unknown): string {
  switch (str(game)) {
    case 'rock-paper-scissors': return 'Rock Paper Scissors';
    case 'snake': return 'Snake';
    case 'chess': return 'Chess';
    case 'tetris': return 'Tetris';
    default: return 'the game';
  }
}

type Admin = SupabaseClient;

/** The display name for a user, or the safe fallback when they never set one. */
async function displayName(admin: Admin, userId: string): Promise<string> {
  const { data } = await admin.from('profiles').select('name').eq('id', userId).maybeSingle();
  const name = (data as { name?: string } | null)?.name;
  return name?.trim() ? name.trim() : 'Your partner';
}

/**
 * Send `notification` to every device a user has subscribed. Returns the same shape the
 * webhook records, including how many endpoints had to be dropped (404/410 = gone).
 */
async function deliver(admin: Admin, userId: string, notification: PushNotification): Promise<Response> {
  const { data: subscriptions, error: subscriptionError } = await admin
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', userId);
  if (subscriptionError) return json({ error: `Could not read subscriptions: ${subscriptionError.message}` }, 500);
  const devices = (subscriptions ?? []) as SubscriptionRow[];
  if (devices.length === 0) return json({ sent: 0, reason: 'the recipient has no devices subscribed' });

  const gone: string[] = [];
  let sent = 0;
  let failed = 0;

  for (const device of devices) {
    try {
      await webPush.sendNotification(
        { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
        JSON.stringify(notification),
        { TTL: TTL_SECONDS, urgency: 'normal' },
      );
      sent += 1;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      // 404 and 410 are the push services' way of saying this browser is gone: the app was
      // uninstalled, the permission withdrawn, or the subscription rotated. Keeping the row
      // would mean paying for a send to nowhere on every single event.
      if (status === 404 || status === 410) {
        gone.push(device.id);
        continue;
      }
      failed += 1;
      console.error(`send-push: ${device.id} failed with ${status ?? 'no status'}`);
    }
  }

  if (gone.length > 0) {
    await admin.from('push_subscriptions').delete().in('id', gone);
  }

  return json({ sent, failed, removed: gone.length, user: userId });
}

/** How many Discuss questions in this couple are still waiting on `userId` to answer. */
async function discussWaiting(admin: Admin, coupleId: string, userId: string): Promise<number> {
  const { data: open } = await admin
    .from('question_sessions')
    .select('id')
    .eq('couple_id', coupleId)
    .is('completed_at', null)
    .lt('answer_count', 2);
  const openIds = new Set((open ?? []).map((row) => (row as { id: string }).id));
  if (openIds.size === 0) return 0;
  const { data: answered } = await admin
    .from('answers')
    .select('session_id')
    .eq('user_id', userId)
    .in('session_id', [...openIds]);
  const answeredIds = new Set((answered ?? []).map((row) => (row as { session_id: string }).session_id));
  let waiting = 0;
  openIds.forEach((id) => { if (!answeredIds.has(id)) waiting += 1; });
  return waiting;
}

/** How many live games in this couple are currently waiting on `userId` to move. */
async function gamesWaiting(admin: Admin, coupleId: string, userId: string): Promise<number> {
  const { count } = await admin
    .from('game_matches')
    .select('id', { count: 'exact', head: true })
    .eq('couple_id', coupleId)
    .eq('turn_id', userId)
    .eq('finished', false);
  return typeof count === 'number' ? count : 0;
}

/** messages INSERT → notify the partner who did not send it. */
async function handleMessage(admin: Admin, record: Record<string, unknown>): Promise<Response> {
  const message = record as MessageRecord;
  const coupleId = str(message.couple_id);
  const senderId = message.sender_id ?? null;
  const messageId = str(message.id);
  if (!coupleId || !messageId) return json({ skipped: 'the row has no couple or id' });

  // A system note has no author (sender_id NULL) and nothing a partner wrote, so there is
  // nobody to notify on its behalf.
  if (!senderId) return json({ skipped: 'system note' });

  // Tell the *other* partner. The webhook fires for every insert, including the sender's
  // own row arriving from their own phone, and nobody wants their own message back.
  const { data: partner, error: partnerError } = await admin
    .from('profiles')
    .select('id, name')
    .eq('couple_id', coupleId)
    .neq('id', senderId)
    .maybeSingle();
  if (partnerError) return json({ error: `Could not read the partner: ${partnerError.message}` }, 500);
  if (!partner) return json({ skipped: 'no partner yet' });

  const { data: sender } = await admin
    .from('profiles')
    .select('name')
    .eq('id', senderId)
    .maybeSingle();

  const { data: subscriptions, error: subscriptionError } = await admin
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', partner.id);
  if (subscriptionError) return json({ error: `Could not read subscriptions: ${subscriptionError.message}` }, 500);
  const devices = (subscriptions ?? []) as SubscriptionRow[];
  if (devices.length === 0) return json({ sent: 0, reason: 'the partner has no devices subscribed' });

  // A HEAD request with an exact count: the number the partner's icon should show, without
  // dragging the message rows themselves across the wire.
  const { count: unread } = await admin
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('couple_id', coupleId)
    .neq('sender_id', partner.id)
    .is('read_at', null);

  // Deliberately no message text beyond the preview, and never the sender's name in the
  // title when they have not set one: a lock screen is a public surface.
  const senderName = (sender?.name as string | undefined)?.trim() || 'Your partner';
  const notification: PushNotification = {
    title: senderName,
    body: preview(message.content ?? ''),
    tag: `nooki-message-${messageId}`,
    tab: 'chat',
    url: '/?nooki=chat',
    badge: typeof unread === 'number' ? unread : 0,
    messageId,
  };

  return deliver(admin, partner.id, notification);
}

/** answers INSERT → notify the other partner it is their turn to answer (Discuss). */
async function handleAnswer(admin: Admin, record: Record<string, unknown>): Promise<Response> {
  const sessionId = str(record.session_id);
  const answererId = str(record.user_id);
  if (!sessionId || !answererId) return json({ skipped: 'answer has no session or user' });

  const { data: session, error: sessionError } = await admin
    .from('question_sessions')
    .select('couple_id, answer_count, completed_at')
    .eq('id', sessionId)
    .maybeSingle();
  if (sessionError) return json({ error: `Could not read the session: ${sessionError.message}` }, 500);
  if (!session) return json({ skipped: 'no session' });
  // Both have answered (or it was revealed/closed): there is nobody left waiting, so a
  // notification would only be noise.
  if (session.completed_at) return json({ skipped: 'session already complete' });
  if ((session.answer_count ?? 0) >= 2) return json({ skipped: 'both partners already answered' });

  const coupleId = session.couple_id as string;
  const { data: partner, error: partnerError } = await admin
    .from('profiles')
    .select('id, name')
    .eq('couple_id', coupleId)
    .neq('id', answererId)
    .maybeSingle();
  if (partnerError) return json({ error: `Could not read the partner: ${partnerError.message}` }, 500);
  if (!partner) return json({ skipped: 'no partner yet' });

  const actor = await displayName(admin, answererId);
  const waiting = await discussWaiting(admin, coupleId, partner.id);
  const notification: PushNotification = {
    title: actor,
    body: 'Answered a question — your turn to reply.',
    tag: `nooki-discuss-${sessionId}`,
    tab: 'discuss',
    url: '/?nooki=discuss',
    badge: waiting,
    messageId: null,
  };
  return deliver(admin, partner.id, notification);
}

/** game_matches UPDATE → notify the player whose turn just arrived (Games). */
async function handleGameTurn(
  admin: Admin,
  record: Record<string, unknown>,
  oldRecord: Record<string, unknown> | undefined,
): Promise<Response> {
  const coupleId = str(record.couple_id);
  const newTurn = str(record.turn_id);
  const finished = record.finished === true;
  if (!coupleId || !newTurn) return json({ skipped: 'the row has no couple or turn' });
  // The move that ends the game flips the turn too, but there is no move to make — so we
  // stay silent rather than announce a turn that cannot be taken.
  if (finished) return json({ skipped: 'game finished' });

  const oldTurn = oldRecord ? str(oldRecord.turn_id) : null;
  if (!oldTurn || oldTurn === newTurn) return json({ skipped: 'turn did not change' });

  const mover = oldTurn;
  // The recipient is the new turn holder; confirm they are a real profile in this couple
  // before we spend a send on them.
  const { data: recipient, error: recipientError } = await admin
    .from('profiles')
    .select('id')
    .eq('couple_id', coupleId)
    .eq('id', newTurn)
    .maybeSingle();
  if (recipientError) return json({ error: `Could not read the player: ${recipientError.message}` }, 500);
  if (!recipient) return json({ skipped: 'turn holder not in this couple' });

  const actor = await displayName(admin, mover);
  const waiting = await gamesWaiting(admin, coupleId, newTurn);
  const notification: PushNotification = {
    title: actor,
    body: `It's your turn in ${gameLabel(record.game)}.`,
    tag: `nooki-game-${str(record.id) ?? newTurn}`,
    tab: 'games',
    url: '/?nooki=games',
    badge: waiting,
    messageId: null,
  };
  return deliver(admin, newTurn, notification);
}

/** Due-time sweep → remind both partners, with a cold/deep link to this activity. */
async function handleTogetherTimeReminderSweep(admin: Admin): Promise<Response> {
  const { data, error } = await admin.rpc('claim_due_together_time_reminders');
  if (error) return json({ error: `Could not claim due Together times: ${error.message}` }, 500);

  const sessions = (data ?? []) as TogetherTimeReminder[];
  let delivered = 0;
  let failed = 0;
  for (const session of sessions) {
    const { data: partners, error: partnerError } = await admin
      .from('profiles')
      .select('id')
      .eq('couple_id', session.couple_id);
    if (partnerError) {
      failed += 1;
      console.error(`send-push: could not read partners for Together time ${session.id}`);
      continue;
    }
    const notification: PushNotification = {
      title: 'Together time is here',
      body: `It’s time for ${truncate(session.activity_name, 90)}. Tap to open it together.`,
      tag: `nooki-together-time-${session.id}`,
      tab: 'together',
      url: `/?nooki=together&session=${encodeURIComponent(session.id)}`,
      // Do not set `badge`: this is not a chat message and must not clear a chat badge.
      messageId: null,
    };
    const results = await Promise.all(((partners ?? []) as Array<{ id: string }>).map(async ({ id }) => {
      const response = await deliver(admin, id, notification);
      if (!response.ok) return { sent: 0, failed: true };
      const result = await response.json() as { sent?: number; failed?: number };
      return { sent: result.sent ?? 0, failed: (result.failed ?? 0) > 0 };
    }));
    delivered += results.reduce((sum, result) => sum + result.sent, 0);
    failed += results.some((result) => result.failed) ? 1 : 0;
  }
  return json({ claimed: sessions.length, delivered, failed });
}

const PONG = json({ ok: true });

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') {
    // Supabase sends a GET "verify" ping on creation; answer it so the webhook stays healthy.
    if (request.method === 'GET') return PONG;
    return json({ error: 'Use POST.' }, 405);
  }
  if (!isAuthorised(request)) return json({ error: 'Not authorised.' }, 401);

  const publicKey = requiredSecret('VAPID_PUBLIC_KEY');
  const privateKey = requiredSecret('VAPID_PRIVATE_KEY');
  const subject = requiredSecret('VAPID_SUBJECT') ?? 'mailto:hello@example.com';
  const supabaseUrl = requiredSecret('SUPABASE_URL');
  // Projects that have moved to the new API keys expose SUPABASE_SECRET_KEY instead of the
  // legacy service-role key; both are injected by the platform and neither reaches a phone.
  const serviceKey = requiredSecret('SUPABASE_SERVICE_ROLE_KEY') ?? requiredSecret('SUPABASE_SECRET_KEY');
  if (!publicKey || !privateKey) return json({ error: 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not set on send-push.' }, 500);
  if (!supabaseUrl || !serviceKey) return json({ error: 'Supabase service credentials are unavailable.' }, 500);
  webPush.setVapidDetails(subject, publicKey, privateKey);

  let payload: WebhookPayload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Expected the Database Webhook JSON body.' }, 400);
  }

  const record = payload.record;
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const scheduledSweep = payload.type === 'SCHEDULED' && payload.table === 'together_time_sessions';
  if (scheduledSweep) return handleTogetherTimeReminderSweep(admin);
  if (!record || payload.table !== 'messages' && payload.table !== 'answers' && payload.table !== 'game_matches') {
    return json({ skipped: 'not a watched table' });
  }

  switch (payload.table) {
    case 'messages':
      if (payload.type !== 'INSERT') return json({ skipped: 'not a new message' });
      return handleMessage(admin, record);
    case 'answers':
      if (payload.type !== 'INSERT') return json({ skipped: 'not a new answer' });
      return handleAnswer(admin, record);
    case 'game_matches':
      if (payload.type !== 'UPDATE') return json({ skipped: 'not a turn change' });
      return handleGameTurn(admin, record, payload.old_record);
    default:
      return json({ skipped: 'unhandled table' });
  }
});
