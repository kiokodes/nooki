import { requireSupabase } from './supabaseClient';
import { describeDatabaseError } from './authService';
import type { ChatMessage, MessageType } from '../types/database';

/**
 * Chat transport for the couple's shared message log.
 *
 * Everything here is couple-scoped: the database, not this file, is what stops another
 * couple reading these rows (see the RLS policies in supabase/migrations/
 * 202610150003_messages.sql). The limits below only keep a phone happy.
 *
 * A message can also point back at a Discuss question (`session_id`): that is the
 * "Say more" bridge — the bubble quotes the question, the quote links back to the
 * revealed answers, and the send policy refuses links to any session but the
 * couple's own (supabase/migrations/202610150005_discuss_comments_chat_links.sql).
 */

/** How many recent messages a phone keeps in memory. */
export const MESSAGE_PAGE_SIZE = 200;

/** Matches the `messages_content_length` database constraint. */
export const MESSAGE_MAX_LENGTH = 4000;

export function normalizeMessageContent(content: string): string {
  return (content || '').replace(/\r\n/g, '\n').trim();
}

export function validateMessageContent(content: string): string {
  const clean = normalizeMessageContent(content);
  if (!clean) throw new Error('Please write a message first.');
  if (clean.length > MESSAGE_MAX_LENGTH) {
    throw new Error(`Messages can be up to ${MESSAGE_MAX_LENGTH} characters.`);
  }
  return clean;
}

function toChatMessage(row: Record<string, unknown>): ChatMessage {
  return {
    id: String(row.id),
    couple_id: String(row.couple_id),
    sender_id: row.sender_id == null ? null : String(row.sender_id),
    content: String(row.content ?? ''),
    type: (row.type as MessageType) ?? 'text',
    session_id: row.session_id == null ? null : String(row.session_id),
    created_at: String(row.created_at),
    read_at: row.read_at == null ? null : String(row.read_at),
  };
}

/**
 * The newest `limit` messages, returned oldest-first so the chat can render straight
 * down the screen. A couple's chat is read from the bottom, so paging cuts the top.
 */
export async function fetchMessages(
  coupleId: string,
  limit: number = MESSAGE_PAGE_SIZE,
): Promise<ChatMessage[]> {
  const { data, error } = await requireSupabase().from('messages')
    .select('*')
    .eq('couple_id', coupleId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(describeDatabaseError(error));
  return (data ?? []).map(toChatMessage).reverse();
}

export async function sendMessage(
  coupleId: string,
  senderId: string,
  content: string,
  type: MessageType = 'text',
  /** The Discuss question this message continues from, or null for an ordinary one. */
  sessionId: string | null = null,
): Promise<ChatMessage> {
  const clean = validateMessageContent(content);
  const { data, error } = await requireSupabase().from('messages')
    .insert({ couple_id: coupleId, sender_id: senderId, content: clean, type, session_id: sessionId })
    .select('*')
    .single();
  if (error) throw new Error(describeDatabaseError(error));
  if (!data) throw new Error('Your message could not be sent. Please try again.');
  return toChatMessage(data as Record<string, unknown>);
}

/**
 * Stamps `read_at` on every unread message the partner sent. Only the recipient can do
 * this — the sender's own bubbles are filtered out by id.
 *
 * System notes (sender_id NULL) are deliberately left alone; nothing renders them as
 * unread yet, and the Discuss tab will decide what a read receipt means for a prompt.
 * Returns the rows it touched so the caller can reconcile its optimistic update.
 */
export async function markMessagesRead(coupleId: string, readerId: string): Promise<ChatMessage[]> {
  const { data, error } = await requireSupabase().from('messages')
    .update({ read_at: new Date().toISOString() })
    .eq('couple_id', coupleId)
    .neq('sender_id', readerId)
    .is('read_at', null)
    .select('*');
  if (error) throw new Error(describeDatabaseError(error));
  return (data ?? []).map(toChatMessage);
}

/** Realtime topic shared by exactly the two members of a couple's chat. */
export function chatTopic(coupleId: string): string {
  return `nooki-chat-${coupleId}`;
}

export interface ChatSubscriptionHandlers {
  onMessageInserted: (message: ChatMessage) => void;
  onMessageUpdated: (message: ChatMessage) => void;
  /** The partner is composing (or clearing) a reply. */
  onPartnerTyping: (typing: boolean) => void;
  onStatus?: (status: string) => void;
}

export interface ChatChannel {
  /** Tell the partner this phone is typing. Silently drops if the socket is not ready. */
  notifyTyping: (payload: { user_id: string; name?: string }) => void;
  /** Tell the partner this phone stopped (sent or cleared the box). */
  notifyStoppedTyping: (payload: { user_id: string }) => void;
  close: () => void;
}

/**
 * Live messages and typing over one Realtime channel.
 *
 * Postgres Changes carries the message rows (instant delivery and read receipts);
 * a Broadcast event carries the typing indicator, which is deliberately never stored —
 * a lost keystroke notification must not leave a stale "typing…" on the partner's phone.
 */
export function subscribeToChat(
  coupleId: string,
  partnerId: string,
  handlers: ChatSubscriptionHandlers,
): ChatChannel {
  const client = requireSupabase();
  let ready = false;
  const channel = client.channel(chatTopic(coupleId), {
    config: { broadcast: { self: false } },
  });

  channel
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `couple_id=eq.${coupleId}` },
      (payload: { new: Record<string, unknown> }) => {
        handlers.onMessageInserted(toChatMessage(payload.new));
      },
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'messages', filter: `couple_id=eq.${coupleId}` },
      (payload: { new: Record<string, unknown> }) => {
        handlers.onMessageUpdated(toChatMessage(payload.new));
      },
    )
    .on('broadcast', { event: 'typing' }, ({ payload }: { payload?: { user_id?: string; typing?: boolean } }) => {
      // Only the partner's keystrokes matter, and only after the socket is live.
      if (!payload || payload.user_id !== partnerId) return;
      handlers.onPartnerTyping(payload.typing !== false);
    })
    .subscribe((status: string) => {
      ready = status === 'SUBSCRIBED';
      handlers.onStatus?.(status);
    });

  const broadcast = (payload: Record<string, unknown>) => {
    if (!ready) return;
    void Promise.resolve(channel.send({ type: 'broadcast', event: 'typing', payload })).catch(() => {
      // A dropped typing ping is invisible by design; the indicator times out instead.
    });
  };

  return {
    notifyTyping: (payload) => broadcast({ ...payload, typing: true }),
    notifyStoppedTyping: (payload) => broadcast({ ...payload, typing: false }),
    close: () => {
      ready = false;
      const removed = client.removeChannel(channel);
      if (removed && typeof removed.catch === 'function') removed.catch(() => {});
    },
  };
}
