/*
 * send-push — the sending half of Nooki's notifications.
 *
 * A Database Webhook on `public.messages` (AFTER INSERT) calls this function with the new
 * row. It works out who should hear about it, looks up that partner's devices in
 * `public.push_subscriptions`, and sends each one a Web Push message signed with Nooki's
 * own VAPID keypair.
 *
 * There is no notification service, SDK, account or bill anywhere in here: this function
 * *is* the push server. What it talks to is each browser's own push endpoint — FCM for
 * Chrome and Edge, Mozilla's autopush for Firefox, Apple's service for Safari and iOS —
 * which is the same unavoidable relay every native app uses, and needs no credentials
 * from us. The payload is encrypted to the device's own keys, so that relay only ever
 * sees ciphertext.
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
import { createClient } from 'npm:@supabase/supabase-js@2';

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
  highlight_id?: string | null;
  created_at?: string;
}

interface WebhookPayload {
  type?: string;
  table?: string;
  schema?: string;
  record?: MessageRecord;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
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

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
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

  const message = payload.record;
  if (!message || payload.table !== 'messages' || payload.type !== 'INSERT') {
    return json({ skipped: 'not a new message' });
  }
  const coupleId = message.couple_id;
  const senderId = message.sender_id ?? null;
  const messageId = message.id ?? null;
  if (!coupleId || !messageId) return json({ skipped: 'the row has no couple or id' });

  // A system note has no author (sender_id NULL) and nothing that a partner wrote, so
  // there is nobody to notify on its behalf.
  if (!senderId) return json({ skipped: 'system note' });

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

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
  // dragging the message rows themselves across the wire. `head: true` puts the total in
  // `count`, not in `data`.
  const { count: unread } = await admin
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('couple_id', coupleId)
    .neq('sender_id', partner.id)
    .is('read_at', null);

  // Deliberately no message text beyond the preview, and never the sender's name in the
  // title when they have not set one: a lock screen is a public surface.
  const senderName = (sender?.name as string | undefined)?.trim() || 'Your partner';
  const notification = {
    title: senderName,
    body: preview(message.content ?? ''),
    // A stable tag per message: a re-delivered notification replaces its own earlier
    // bubble instead of stacking, while two different messages stay two notifications.
    tag: `nooki-message-${messageId}`,
    tab: 'chat',
    url: '/?nooki=chat',
    badge: typeof unread === 'number' ? unread : 0,
    messageId,
  };

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
      // would mean paying for a send to nowhere on every single message.
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

  return json({ sent, failed, removed: gone.length, partner: partner.id });
});
