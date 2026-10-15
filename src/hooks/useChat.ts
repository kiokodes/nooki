import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MESSAGE_PAGE_SIZE,
  editMessage,
  fetchMessages,
  markMessagesRead,
  normalizeMessageContent,
  sendMessage,
  subscribeToChat,
  type ChatChannel,
} from '../lib/chatService';
import type { ChatEntry, ChatMessage, MessageType } from '../types/database';

interface UseChatOptions {
  /** The shared couple, or null while the account is still unpaired. */
  coupleId: string | null;
  /** The signed-in account (this phone). */
  userId: string | null;
  /** The other partner, used to spot *their* unread messages and typing. */
  partnerId: string | null;
  /**
   * True while the Chat tab is on screen *and* the app is in the foreground. Read
   * receipts are only stamped then — you have to be looking at a message to read it.
   */
  active: boolean;
}

export interface ChatState {
  /** Oldest first, ready to render straight down the screen. */
  messages: ChatEntry[];
  /** Messages the partner sent that this phone has not seen yet. */
  unreadCount: number;
  loading: boolean;
  error: string | null;
  /** The partner is composing right now. */
  partnerTyping: boolean;
  sending: boolean;
  /**
   * `sessionId` marks a "Say more" message: which Discuss question it continues from.
   * `replyToId` marks a swipe-to-reply: which earlier message this one answers.
   * `highlightId` marks a "highlight to chat" share: which book passage it quotes.
   */
  send: (
    content: string,
    type?: MessageType,
    sessionId?: string | null,
    replyToId?: string | null,
    highlightId?: string | null,
  ) => Promise<void>;
  /** Rewrites the words of a message this phone sent. There is no delete. */
  edit: (messageId: string, content: string) => Promise<void>;
  retry: (entryId: string) => Promise<void>;
  /** Call on every keystroke; the throttle lives here. */
  notifyTyping: () => void;
  notifyStoppedTyping: () => void;
  clearError: () => void;
}

interface LoadedMessages {
  /** Which couple these messages belong to, so another couple's chat never flashes up. */
  coupleId: string;
  items: ChatEntry[];
}

/** A stored row is "read" once the partner has stamped it. */
function toEntry(message: ChatMessage): ChatEntry {
  return { ...message, delivery: message.read_at ? 'read' : 'sent' };
}

function byCreatedAt(a: ChatEntry, b: ChatEntry): number {
  const difference = Date.parse(a.created_at) - Date.parse(b.created_at);
  // Pending messages are stamped with the phone clock, which can tie with a server row;
  // the id keeps the order stable so React never sees two different orders for one list.
  return difference !== 0 ? difference : a.id.localeCompare(b.id);
}

/** Keeps the newest copy of a message, whatever route it arrived by (send, insert, receipt). */
function upsert(items: ChatEntry[], entry: ChatEntry): ChatEntry[] {
  const index = items.findIndex((item) => item.id === entry.id);
  if (index === -1) return [...items, entry].sort(byCreatedAt);
  const next = [...items];
  // A realtime update can arrive before the send response; never downgrade a bubble.
  next[index] = next[index].delivery === 'failed' && entry.delivery === 'sending' ? next[index] : entry;
  return next;
}

const TYPING_THROTTLE_MS = 2_000;
/** Long enough to cover the gap between keystrokes, short enough to feel honest. */
const TYPING_TIMEOUT_MS = 4_000;

/**
 * The couple's chat: one live message log shared by the Chat tab and its unread badge.
 *
 * It is owned by the app rather than by the Chat tab, so a message arriving while the
 * partner is browsing another tab still updates the badge, and stepping into the tab
 * shows the message already there.
 */
export function useChat({ coupleId, userId, partnerId, active }: UseChatOptions): ChatState {
  const [loaded, setLoaded] = useState<LoadedMessages | null>(null);
  // Optimistic bubbles, tagged with the couple they belong to so switching couples
  // (or being unpaired) never leaks one chat's pending messages into another's.
  const [pendingState, setPendingState] = useState<{ coupleId: string | null; items: ChatEntry[] }>({
    coupleId: null,
    items: [],
  });
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partnerTyping, setPartnerTyping] = useState(false);

  const channelRef = useRef<ChatChannel | null>(null);
  const lastTypingSentRef = useRef(0);
  const typingTimeoutRef = useRef<number | null>(null);

  const scope = coupleId && userId ? `${coupleId}:${userId}` : null;
  const stored = useMemo(
    () => (loaded && loaded.coupleId === coupleId ? loaded.items : []),
    [coupleId, loaded],
  );

  /** What the badge counts: the partner's messages that nobody has opened yet. */
  const unread = useMemo(
    () => stored.filter((item) => item.sender_id === partnerId && !item.read_at),
    [stored, partnerId],
  );

  const applyStored = useCallback((forCoupleId: string, update: (items: ChatEntry[]) => ChatEntry[]) => {
    setLoaded((current) => ({
      coupleId: forCoupleId,
      items: update(current && current.coupleId === forCoupleId ? current.items : []),
    }));
  }, []);

  const pending = useMemo(
    () => (pendingState.coupleId === coupleId ? pendingState.items : []),
    [coupleId, pendingState],
  );

  const setPending = useCallback((update: (items: ChatEntry[]) => ChatEntry[]) => {
    setPendingState((current) => ({
      coupleId,
      items: update(current.coupleId === coupleId ? current.items : []),
    }));
  }, [coupleId]);

  const messages = useMemo(() => [...stored, ...pending].sort(byCreatedAt), [stored, pending]);

  // --- Live subscription: new messages, read receipts and typing ------------------
  useEffect(() => {
    if (!coupleId || !userId || !partnerId) return;

    let channel: ChatChannel;
    try {
      channel = subscribeToChat(coupleId, partnerId, {
        onMessageInserted: (message) => {
          applyStored(coupleId, (items) => upsert(items, toEntry(message)));
          // Realtime usually beats the send response back. Drop our own optimistic copy
          // of the message that just landed so it never shows twice — matching on the
          // links too, so two identical replies (or two identical "Say more" notes)
          // do not collapse into one.
          if (message.sender_id === userId) {
            setPending((items) => items.filter((item) => !(
              item.sender_id === userId
              && item.content === message.content
              && (item.session_id ?? null) === message.session_id
              && (item.reply_to_id ?? null) === message.reply_to_id
              && (item.highlight_id ?? null) === message.highlight_id
              && item.delivery === 'sending'
            )));
          }
        },
        onMessageUpdated: (message) => applyStored(coupleId, (items) => upsert(items, toEntry(message))),
        onPartnerTyping: (typing) => {
          if (typingTimeoutRef.current !== null) window.clearTimeout(typingTimeoutRef.current);
          typingTimeoutRef.current = null;
          setPartnerTyping(typing);
          if (typing) {
            // A typing ping that never gets a follow-up (closed app, lost socket) expires.
            typingTimeoutRef.current = window.setTimeout(() => setPartnerTyping(false), TYPING_TIMEOUT_MS);
          }
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Live messages are unavailable right now.';
      // Reported outside this effect so the subscription never changes state mid-render.
      queueMicrotask(() => setError(message));
      return;
    }
    channelRef.current = channel;

    return () => {
      channel.close();
      channelRef.current = null;
      if (typingTimeoutRef.current !== null) window.clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
      setPartnerTyping(false);
    };
  }, [applyStored, coupleId, partnerId, setPending, userId]);

  // --- Initial load ---------------------------------------------------------------
  useEffect(() => {
    // With no couple there is nothing to load; `stored` already ignores other couples.
    if (!coupleId) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const fetched = await fetchMessages(coupleId, MESSAGE_PAGE_SIZE);
        if (cancelled) return;
        // Anything the socket delivered while we were loading stays put.
        setLoaded((current) => ({
          coupleId,
          items: (current && current.coupleId === coupleId ? current.items : [])
            .reduce((items, entry) => upsert(items, entry), fetched.map(toEntry)),
        }));
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Your messages could not be loaded.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [coupleId]);

  // --- Read receipts: stamp the partner's messages while the chat is on screen -----
  useEffect(() => {
    if (!active || !coupleId || !userId || !unread.length) return;
    let cancelled = false;
    void (async () => {
      try {
        const stamped = await markMessagesRead(coupleId, userId);
        if (cancelled || !stamped.length) return;
        applyStored(coupleId, (items) => items.map((item) => {
          const row = stamped.find((candidate) => candidate.id === item.id);
          return row ? toEntry(row) : item;
        }));
      } catch {
        // A receipt is a nicety: failing to stamp one must never break the chat.
      }
    })();
    return () => { cancelled = true; };
  }, [active, applyStored, coupleId, unread.length, userId]);

  // --- Sending --------------------------------------------------------------------
  const deliver = useCallback(async (entry: ChatEntry, type: MessageType) => {
    if (!coupleId || !userId) return;
    setSending(true);
    try {
      const saved = await sendMessage(
        coupleId,
        userId,
        entry.content,
        type,
        entry.session_id,
        entry.reply_to_id,
        entry.highlight_id,
      );
      // Replace the optimistic bubble with the stored row.
      setPending((items) => items.filter((item) => item.id !== entry.id));
      applyStored(coupleId, (items) => upsert(items, toEntry(saved)));
      setError(null);
    } catch (err) {
      setPending((items) => items.map((item) => (item.id === entry.id ? { ...item, delivery: 'failed' } : item)));
      setError(err instanceof Error ? err.message : 'Your message could not be sent.');
    } finally {
      setSending(false);
    }
  }, [applyStored, coupleId, setPending, userId]);

  const send = useCallback(async (
    content: string,
    type: MessageType = 'text',
    sessionId: string | null = null,
    replyToId: string | null = null,
    highlightId: string | null = null,
  ) => {
    if (!coupleId || !userId) return;
    const clean = normalizeMessageContent(content);
    if (!clean) return;
    const entry: ChatEntry = {
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      couple_id: coupleId,
      sender_id: userId,
      content: clean,
      type,
      session_id: sessionId ?? null,
      reply_to_id: replyToId ?? null,
      highlight_id: highlightId ?? null,
      created_at: new Date().toISOString(),
      read_at: null,
      edited_at: null,
      delivery: 'sending',
    };
    setPending((items) => [...items, entry]);
    channelRef.current?.notifyStoppedTyping({ user_id: userId });
    await deliver(entry, type);
  }, [coupleId, deliver, setPending, userId]);

  // --- Editing (only your own, and the words only; the database keeps the rest) ----
  const edit = useCallback(async (messageId: string, content: string) => {
    if (!coupleId || !userId) return;
    const clean = normalizeMessageContent(content);
    if (!clean) return;
    try {
      const saved = await editMessage(coupleId, userId, messageId, clean);
      applyStored(coupleId, (items) => upsert(items, toEntry(saved)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Your message could not be edited.');
    }
  }, [applyStored, coupleId, userId]);

  const retry = useCallback(async (entryId: string) => {
    const entry = pending.find((item) => item.id === entryId);
    if (!entry) return;
    setPending((items) => items.map((item) => (item.id === entryId ? { ...item, delivery: 'sending' } : item)));
    await deliver({ ...entry, delivery: 'sending' }, entry.type);
  }, [deliver, pending, setPending]);

  const notifyTyping = useCallback(() => {
    if (!userId) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < TYPING_THROTTLE_MS) return;
    lastTypingSentRef.current = now;
    channelRef.current?.notifyTyping({ user_id: userId });
  }, [userId]);

  const notifyStoppedTyping = useCallback(() => {
    if (!userId) return;
    lastTypingSentRef.current = Date.now();
    channelRef.current?.notifyStoppedTyping({ user_id: userId });
  }, [userId]);

  return {
    messages,
    unreadCount: unread.length,
    loading,
    error,
    partnerTyping: Boolean(scope && partnerTyping),
    sending,
    send,
    edit,
    retry,
    notifyTyping,
    notifyStoppedTyping,
    clearError: () => setError(null),
  };
}
