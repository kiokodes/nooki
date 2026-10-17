import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, CheckCheck, CircleAlert, Clock, MessageSquare, Pencil, Phone, Reply as ReplyIcon, Send, Video, X } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { useNow } from '../../hooks/useNow';
import { getInitial, formatLastSeen } from '../../lib/coupleTime';
import { formatMessageTime, groupMessagesByDay } from '../../lib/chatTime';
import type { ChatEntry } from '../../types/database';

/** What "Say more" attaches to the composer: the Discuss question being continued. */
export interface ChatQuestionContext {
  sessionId: string;
  questionText: string;
}

interface ChatViewProps {
  /** The whole transcript, oldest first. */
  messages: ChatEntry[];
  /** Partner 1 — the person holding this phone. Their bubbles sit on the right. */
  currentUserId: string;
  partnerName: string;
  partnerOnline: boolean;
  partnerLastSeenAt: string | null;
  partnerTyping: boolean;
  loading: boolean;
  error: string | null;
  /**
   * `sessionId` links the message to the Discuss question it continues ("Say more");
   * `replyToId` quotes the message it answers (swipe-to-reply).
   */
  onSend: (content: string, sessionId: string | null, replyToId?: string | null) => Promise<void> | void;
  onTyping: () => void;
  onStopTyping: () => void;
  /** Edit one of your own messages. Optional: without it the action menu hides Edit. */
  onEditMessage?: (messageId: string, content: string) => Promise<void> | void;
  onRetry: (entryId: string) => void;
  onDismissError: () => void;
  /** What a linked session asked, so a bubble can quote its question. */
  questionBySessionId?: Record<string, { text: string; category: string }>;
  /** The question "Say more" just carried in — quoted above the composer until sent. */
  questionContext?: ChatQuestionContext | null;
  onClearQuestionContext?: () => void;
  /** Tap the quoted question on a bubble: jump back to that question and its answers. */
  onOpenQuestion?: (sessionId: string) => void;
  /**
   * What a shared highlight quoted, so the bubble can show the passage.
   * `book_id` is null when the book was deleted — the quote stays readable but the
   * jump back into the book is gone.
   */
  highlightById?: Record<string, { quote_text: string; book_id: string | null; book_title: string | null }>;
  /** Tap the quoted passage on a bubble: open the reader at the highlight. */
  onOpenHighlight?: (highlightId: string) => void;
}

const TOAST_MS = 2_000;
const COMPOSER_MAX_HEIGHT = 132;
/** Hold this long without moving to open the action menu. */
const LONG_PRESS_MS = 450;
/** A horizontal drag past this triggers the reply; beyond this the drag stops moving. */
const SWIPE_TRIGGER_PX = 52;
const SWIPE_MAX_PX = 82;
/** Small enough that a tap never reads as either gesture. */
const MOVE_SLOP_PX = 10;
const HIGHLIGHT_MS = 1_400;

const statusRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '5px',
  fontSize: '0.7rem',
  fontWeight: 600,
};

const iconButtonStyle: React.CSSProperties = {
  width: '34px',
  height: '34px',
  borderRadius: tokens.radii.full,
  backgroundColor: tokens.colors.bgSurface,
  border: `1px solid ${tokens.colors.borderSubtle}`,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  color: tokens.colors.primaryPinkDeep,
  boxShadow: tokens.shadows.subtle,
  flexShrink: 0,
};

/** The little clock/check/double-check under a bubble this phone sent. */
const Receipt: React.FC<{ delivery: ChatEntry['delivery'] }> = ({ delivery }) => {
  if (delivery === 'sending') {
    return (
      <span data-receipt="sending" title="Sending" style={{ display: 'inline-flex' }}>
        <Clock size={12} aria-hidden="true" />
      </span>
    );
  }
  if (delivery === 'read') {
    return (
      <span data-receipt="read" title="Read" style={{ display: 'inline-flex', color: tokens.colors.primaryPinkDeep }}>
        <CheckCheck size={14} aria-hidden="true" />
      </span>
    );
  }
  return (
    <span data-receipt="sent" title="Sent" style={{ display: 'inline-flex' }}>
      <Check size={13} aria-hidden="true" />
    </span>
  );
};

interface ReplyQuote {
  senderName: string;
  snippet: string;
}

/**
 * Whitespace-folded text, for "is the bubble body just the quote?" — a highlight
 * with no comment sends the quote itself as the message, and the bubble should then
 * show the quote card once, not twice.
 */
function normalizeForCompare(content: string): string {
  return (content || '').replace(/\s+/g, ' ').trim();
}

interface GestureState {
  startX: number;
  startY: number;
  dragging: boolean;
  longPressTimer: number | null;
}

const Bubble: React.FC<{
  entry: ChatEntry;
  mine: boolean;
  onRetry: (entryId: string) => void;
  questionBySessionId?: Record<string, { text: string; category: string }>;
  onOpenQuestion?: (sessionId: string) => void;
  highlightById?: Record<string, { quote_text: string; book_id: string | null; book_title: string | null }>;
  onOpenHighlight?: (highlightId: string) => void;
  /** What this bubble answers, looked up by the transcript; undefined when unknown. */
  replyOf?: ReplyQuote;
  onSwipeReply: (entry: ChatEntry) => void;
  onOpenActions: (entry: ChatEntry) => void;
  onJumpTo: (messageId: string) => void;
  highlighted: boolean;
}> = ({
  entry,
  mine,
  onRetry,
  questionBySessionId,
  onOpenQuestion,
  highlightById,
  onOpenHighlight,
  replyOf,
  onSwipeReply,
  onOpenActions,
  onJumpTo,
  highlighted,
}) => {
  // A horizontal drag in progress: the bubble slides and the reply icon rises.
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const gestureRef = useRef<GestureState | null>(null);

  // System notes (the Discuss tab's automatic lines) read as a quiet centred pill.
  if (entry.type === 'system') {
    return (
      <div
        data-message-id={entry.id}
        data-message-type="system"
        style={{
          alignSelf: 'center',
          maxWidth: '85%',
          padding: '6px 12px',
          borderRadius: tokens.radii.pill,
          backgroundColor: tokens.colors.bgSurfaceSubtle,
          border: `1px solid ${tokens.colors.borderSubtle}`,
          color: tokens.colors.textSecondary,
          fontSize: '0.72rem',
          fontWeight: 600,
          textAlign: 'center',
        }}
      >
        {entry.content}
      </div>
    );
  }

  // A "Say more" message quotes the question it grew from; the quote is the way back
  // to the revealed answers for whichever partner taps it.
  const quoted = entry.session_id ? questionBySessionId?.[entry.session_id]?.text : undefined;

  // A "highlight to chat" message quotes a passage from the couple's book. The quote
  // comes from the highlight row, so it survives even when the book is deleted — the
  // jump away then simply isn't there ("the book is gone").
  const highlight = entry.highlight_id ? highlightById?.[entry.highlight_id] : undefined;
  const quoteIsBody = Boolean(
    highlight && normalizeForCompare(entry.content) === normalizeForCompare(highlight.quote_text),
  );

  // Swiping and long-pressing live on delivered bubbles only: a pending quote would
  // point at an id the database does not have yet, and a failed one has the retry.
  const interactive = entry.delivery === 'sent' || entry.delivery === 'read';
  const direction = mine ? -1 : 1;

  const endGesture = (applySwipe: boolean) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (gesture?.longPressTimer !== null && gesture) window.clearTimeout(gesture.longPressTimer);
    if (applySwipe && gesture?.dragging && Math.abs(dragX) >= SWIPE_TRIGGER_PX) {
      onSwipeReply(entry);
    }
    setDragging(false);
    setDragX(0);
  };

  const handlePointerDown = (event: React.PointerEvent) => {
    if (!interactive) return;
    const gesture: GestureState = {
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      longPressTimer: window.setTimeout(() => {
        if (gestureRef.current === gesture && !gesture.dragging) {
          gestureRef.current = null;
          gesture.longPressTimer = null;
          onOpenActions(entry);
        }
      }, LONG_PRESS_MS),
    };
    gestureRef.current = gesture;
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (!gesture.dragging) {
      if (Math.abs(dx) > MOVE_SLOP_PX && Math.abs(dx) >= Math.abs(dy)) {
        // A clearly-horizontal drag owns the gesture; the long press is off.
        gesture.dragging = true;
        setDragging(true);
        if (gesture.longPressTimer !== null) {
          window.clearTimeout(gesture.longPressTimer);
          gesture.longPressTimer = null;
        }
      } else if (Math.abs(dy) > MOVE_SLOP_PX) {
        // Scrolling past a bubble must not answer it.
        endGesture(false);
        return;
      } else {
        return;
      }
    }
    // Swipe toward the transcript centre: left on your bubbles, right on theirs.
    const projected = Math.max(0, Math.min(dx * direction, SWIPE_MAX_PX)) * direction;
    setDragX(projected);
  };

  const handlePointerUp = () => endGesture(true);
  const handlePointerCancel = () => endGesture(false);

  const handleContextMenu = (event: React.MouseEvent) => {
    if (!interactive) return;
    event.preventDefault();
    endGesture(false);
    onOpenActions(entry);
  };

  const swipeProgress = Math.min(1, Math.abs(dragX) / SWIPE_TRIGGER_PX);

  return (
    <div
      style={{
        position: 'relative',
        alignSelf: mine ? 'flex-end' : 'flex-start',
        maxWidth: '78%',
      }}
    >
      {dragging && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: '50%',
            transform: `translateY(-50%) scale(${0.7 + swipeProgress * 0.3})`,
            opacity: 0.25 + swipeProgress * 0.75,
            [mine ? 'right' : 'left']: '-34px',
            width: '26px',
            height: '26px',
            borderRadius: tokens.radii.full,
            backgroundColor: swipeProgress >= 1 ? tokens.colors.primaryPink : tokens.colors.bgSurface,
            border: `1px solid ${tokens.colors.borderSubtle}`,
            color: swipeProgress >= 1 ? tokens.colors.textWhite : tokens.colors.textMuted,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background-color 0.1s ease',
          }}
        >
          <ReplyIcon size={13} />
        </span>
      )}

      <div
        data-message-row={entry.id}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onContextMenu={handleContextMenu}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: mine ? 'flex-end' : 'flex-start',
          gap: '2px',
          transform: dragX ? `translateX(${dragX}px)` : undefined,
          // While a drag owns the bubble the page must not fight it for the gesture.
          touchAction: 'pan-y',
        }}
      >
        <div
          data-message-id={entry.id}
          data-mine={mine ? 'true' : 'false'}
          data-message-type={entry.type}
          data-highlighted={highlighted ? 'true' : undefined}
          style={{
            padding: '8px 12px',
            borderRadius: mine ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
            backgroundColor: mine ? tokens.colors.primaryPink : tokens.colors.bgSurface,
            color: tokens.colors.textPrimary,
            border: mine ? '1px solid transparent' : `1px solid ${tokens.colors.borderSubtle}`,
            boxShadow: highlighted
              ? `0 0 0 2px ${tokens.colors.primaryPinkDeep}, ${tokens.shadows.subtle}`
              : tokens.shadows.subtle,
            transition: 'box-shadow 0.3s ease',
            // Newlines are paragraphs the sender typed: the bubble keeps them.
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            fontSize: '0.87rem',
            lineHeight: 1.45,
          }}
        >
          {entry.session_id && (
            <button
              type="button"
              data-question-link={entry.session_id}
              aria-label="Open this question"
              onClick={() => onOpenQuestion?.(entry.session_id as string)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '6px',
                width: '100%',
                margin: '0 0 6px 0',
                padding: '6px 9px',
                borderRadius: tokens.radii.sm,
                border: 'none',
                backgroundColor: mine ? 'rgba(255, 255, 255, 0.55)' : tokens.colors.accentSageSoft,
                color: mine ? tokens.colors.textPrimary : tokens.colors.accentSageDeep,
                cursor: 'pointer',
                fontFamily: tokens.typography.fontFamily,
                fontSize: '0.74rem',
                fontWeight: 700,
                lineHeight: 1.4,
                textAlign: 'left',
              }}
            >
              <MessageSquare size={12} style={{ flexShrink: 0, marginTop: '2px' }} aria-hidden="true" />
              <span
                style={{
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {quoted ?? 'A question you both answered'}
              </span>
            </button>
          )}

          {entry.reply_to_id && (
            <button
              type="button"
              data-reply-quote={entry.reply_to_id}
              aria-label="Jump to the original message"
              title="Jump to the original message"
              onClick={() => onJumpTo(entry.reply_to_id as string)}
              style={{
                display: 'block',
                width: '100%',
                margin: '0 0 6px 0',
                padding: '5px 8px',
                borderRadius: tokens.radii.sm,
                border: 'none',
                borderLeft: `3px solid ${tokens.colors.primaryPinkDeep}`,
                backgroundColor: mine ? 'rgba(255, 255, 255, 0.55)' : tokens.colors.bgCanvas,
                cursor: replyOf ? 'pointer' : 'default',
                fontFamily: tokens.typography.fontFamily,
                textAlign: 'left',
              }}
            >
              <span
                style={{
                  display: 'block',
                  fontSize: '0.68rem',
                  fontWeight: 800,
                  color: tokens.colors.primaryPinkDeep,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {replyOf?.senderName ?? 'Original message'}
              </span>
              <span
                style={{
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  fontSize: '0.76rem',
                  fontWeight: 500,
                  color: tokens.colors.textSecondary,
                  lineHeight: 1.35,
                }}
              >
                {replyOf?.snippet ?? 'This message is further back in your chat.'}
              </span>
            </button>
          )}

          {entry.highlight_id && (
            highlight?.book_id ? (
              <button
                type="button"
                data-highlight-link={entry.highlight_id}
                aria-label="Open this passage in the book"
                onClick={() => onOpenHighlight?.(entry.highlight_id as string)}
                style={{
                  display: 'block',
                  width: '100%',
                  margin: '0 0 6px 0',
                  padding: '6px 9px',
                  borderRadius: tokens.radii.sm,
                  border: 'none',
                  borderLeft: `3px solid ${tokens.colors.primaryGreenDeep}`,
                  backgroundColor: mine ? 'rgba(255, 255, 255, 0.55)' : tokens.colors.primaryGreenSoft,
                  cursor: 'pointer',
                  fontFamily: tokens.typography.fontFamily,
                  textAlign: 'left',
                }}
              >
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    fontSize: '0.66rem',
                    fontWeight: 800,
                    color: tokens.colors.primaryGreenDeep,
                    marginBottom: '2px',
                  }}
                >
                  <BookOpen size={11} aria-hidden="true" />
                  {highlight?.book_title ? `from ${highlight.book_title}` : 'from your book'}
                </span>
                <span
                  data-highlight-quote
                  style={{
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    fontSize: '0.78rem',
                    fontStyle: 'italic',
                    fontWeight: 500,
                    lineHeight: 1.4,
                    color: tokens.colors.textPrimary,
                  }}
                >
                  “{highlight?.quote_text ?? 'A passage you highlighted'}”
                </span>
              </button>
            ) : (
              <div
                data-highlight-link-dead={entry.highlight_id}
                style={{
                  display: 'block',
                  width: '100%',
                  margin: '0 0 6px 0',
                  padding: '6px 9px',
                  borderRadius: tokens.radii.sm,
                  border: 'none',
                  borderLeft: `3px solid ${tokens.colors.borderSoft}`,
                  backgroundColor: mine ? 'rgba(255, 255, 255, 0.4)' : tokens.colors.bgSurfaceSubtle,
                  fontFamily: tokens.typography.fontFamily,
                  textAlign: 'left',
                }}
              >
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    fontSize: '0.66rem',
                    fontWeight: 800,
                    color: tokens.colors.textMuted,
                    marginBottom: '2px',
                  }}
                >
                  <BookOpen size={11} aria-hidden="true" />
                  Book deleted — the quote stays
                </span>
                <span
                  style={{
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    fontSize: '0.78rem',
                    fontStyle: 'italic',
                    fontWeight: 500,
                    lineHeight: 1.4,
                    color: tokens.colors.textSecondary,
                  }}
                >
                  “{highlight?.quote_text ?? entry.content}”
                </span>
              </div>
            )
          )}

          {quoteIsBody ? null : entry.content}
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '3px',
              marginLeft: '8px',
              float: 'right',
              marginTop: '6px',
              fontSize: '0.62rem',
              fontWeight: 600,
              color: mine ? '#7A4159' : tokens.colors.textMuted,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {entry.edited_at && (
              <span data-edited="true" style={{ fontStyle: 'italic' }}>edited</span>
            )}
            {formatMessageTime(entry.created_at)}
            {mine && entry.delivery !== 'failed' && <Receipt delivery={entry.delivery} />}
          </span>
        </div>

        {mine && entry.delivery === 'failed' && (
          <button
            type="button"
            data-retry-message={entry.id}
            onClick={() => onRetry(entry.id)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              color: tokens.colors.primaryPinkDeep,
              fontSize: '0.68rem',
              fontWeight: 700,
              fontFamily: tokens.typography.fontFamily,
            }}
          >
            <CircleAlert size={12} aria-hidden="true" />
            Not sent — tap to retry
          </button>
        )}
      </div>
    </div>
  );
};

/**
 * The Chat tab: the couple's live conversation, in the shape of a messenger.
 *
 * Bubbles from this phone sit on the right in Nooki's blush pink, the partner's on the
 * left in white; the transcript is split into days, receipts show sent/read, and the
 * list keeps itself pinned to the newest message.
 *
 * Replying is a swipe (left on your bubbles, right on theirs) or a long press, and
 * editing your own words lives in the long-press menu. There is no delete and there
 * are no reactions: the log is permanent, in two voices.
 *
 * The composer sends on Enter, the way a laptop keyboard does it, and breaks the
 * line on Shift+Enter. The send button sends either way.
 *
 * The partner's name, presence and the two call buttons live in the conversation bar at
 * the top of the tab. The call buttons are deliberately inert for now.
 */
export const ChatView: React.FC<ChatViewProps> = ({
  messages,
  currentUserId,
  partnerName,
  partnerOnline,
  partnerLastSeenAt,
  partnerTyping,
  loading,
  error,
  onSend,
  onTyping,
  onStopTyping,
  onEditMessage,
  onRetry,
  onDismissError,
  questionBySessionId,
  questionContext = null,
  onClearQuestionContext,
  onOpenQuestion,
  highlightById,
  onOpenHighlight,
}) => {
  const [draft, setDraft] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<ChatEntry | null>(null);
  const [editing, setEditing] = useState<ChatEntry | null>(null);
  const [actionTarget, setActionTarget] = useState<ChatEntry | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  // Minute granularity: enough for "Today"/"Yesterday" to roll over, and cheap.
  const now = useNow(60_000);

  const messageById = useMemo(() => {
    const map = new Map<string, ChatEntry>();
    for (const message of messages) map.set(message.id, message);
    return map;
  }, [messages]);

  // Auto-scroll: pin to the newest message whenever the transcript grows or the typing
  // indicator changes, which is also what happens when the tab opens. An edit or a
  // receipt does not change the count, so it never yanks the reader back down.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [messages.length, partnerTyping, loading]);

  const showComingSoon = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
  }, []);

  const resizeInput = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight || 0, COMPOSER_MAX_HEIGHT)}px`;
  }, []);

  // Landing here from "Say more" means the next thing typed is about that question:
  // put the cursor in the box so naming it is one motion, not two.
  useEffect(() => {
    if (questionContext) inputRef.current?.focus();
  }, [questionContext]);

  const clearReply = useCallback(() => setReplyTarget(null), []);

  const startReply = useCallback((entry: ChatEntry) => {
    setEditing(null);
    setActionTarget(null);
    setReplyTarget(entry);
    inputRef.current?.focus();
  }, []);

  // Choosing Edit swaps the composer into edit mode: the box starts with the message's
  // own words, and the send button becomes a save. Reply and edit never coexist.
  const startEdit = useCallback((entry: ChatEntry) => {
    setReplyTarget(null);
    setActionTarget(null);
    setEditing(entry);
    setDraft(entry.content);
    window.setTimeout(() => {
      inputRef.current?.focus();
      resizeInput();
    }, 0);
  }, [resizeInput]);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    setDraft('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    inputRef.current?.focus();
  }, []);

  const jumpToMessage = useCallback((messageId: string) => {
    const element = listRef.current?.querySelector(`[data-message-id="${messageId}"]`);
    if (!element) return;
    (element as HTMLElement).scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    setHighlightId(messageId);
    if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightId((current) => (current === messageId ? null : current));
    }, HIGHLIGHT_MS);
  }, []);

  const replySenderName = useCallback((entry: ChatEntry): string => {
    if (entry.sender_id === currentUserId) return 'You';
    return entry.sender_id ? partnerName : '';
  }, [currentUserId, partnerName]);

  // Sending the draft, whatever asked for it: the send button, or Enter on a
  // laptop keyboard. Shift+Enter stays a paragraph break.
  const sendDraft = useCallback(async () => {
    const content = draft;
    if (!content.trim()) return;

    if (editing) {
      // Saving an unchanged message is just closing the composer.
      if (content !== editing.content) await onEditMessage?.(editing.id, content);
      setEditing(null);
      setDraft('');
      onStopTyping();
      if (inputRef.current) inputRef.current.style.height = 'auto';
      inputRef.current?.focus();
      return;
    }

    setDraft('');
    onStopTyping();
    if (inputRef.current) inputRef.current.style.height = 'auto';
    // Both attachments are one-shot: the question and the quote live on the bubble
    // itself after this one message, so the banners clear as soon as it is sent.
    await onSend(content, questionContext?.sessionId ?? null, replyTarget?.id ?? null);
    onClearQuestionContext?.();
    setReplyTarget(null);
    inputRef.current?.focus();
  }, [draft, editing, onSend, onEditMessage, onStopTyping, onClearQuestionContext, questionContext, replyTarget]);

  const handleSubmit = useCallback((event: React.FormEvent) => {
    event.preventDefault();
    void sendDraft();
  }, [sendDraft]);

  const groups = groupMessagesByDay(messages, now);
  const statusColor = partnerTyping
    ? tokens.colors.primaryPinkDeep
    : partnerOnline
      ? tokens.colors.primaryGreenDeep
      : tokens.colors.textMuted;
  const statusText = partnerTyping
    ? 'typing…'
    : partnerOnline
      ? 'Online'
      : formatLastSeen(partnerLastSeenAt, now);

  // Only a delivered message of yours, in your own words, is editable: nothing pending,
  // nothing failed (that is what retry is for), nothing the partner typed.
  const canEditAction = (entry: ChatEntry): boolean => (
    Boolean(onEditMessage)
    && entry.sender_id === currentUserId
    && entry.type === 'text'
    && (entry.delivery === 'sent' || entry.delivery === 'read')
  );

  const replyingToName = replyTarget ? replySenderName(replyTarget) : '';

  return (
    <section
      data-screen="chat"
      aria-label="Chat"
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}
    >
      {/* Conversation bar: who you are talking to, whether they are around, and the
          call buttons (still inert — they only say so for now). */}
      <header
        data-chat-header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '4px 14px 10px 14px',
          flexShrink: 0,
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: '38px',
            height: '38px',
            borderRadius: tokens.radii.full,
            backgroundColor: tokens.colors.primaryPinkSoft,
            color: tokens.colors.primaryPinkDeep,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 800,
            fontSize: '1rem',
            flexShrink: 0,
          }}
        >
          {getInitial(partnerName)}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            data-partner-name
            style={{
              fontSize: '1rem',
              fontWeight: 800,
              color: tokens.colors.textPrimary,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {partnerName}
          </div>
          <div data-partner-status data-status={partnerTyping ? 'typing' : partnerOnline ? 'online' : 'offline'} style={{ ...statusRowStyle, color: statusColor }}>
            <span
              aria-hidden="true"
              style={{
                width: '6px',
                height: '6px',
                borderRadius: tokens.radii.full,
                backgroundColor: statusColor,
                flexShrink: 0,
              }}
            />
            {statusText}
          </div>
        </div>

        <button type="button" aria-label="Voice call" onClick={() => showComingSoon('Voice calls are coming soon 💕')} style={iconButtonStyle}>
          <Phone size={15} aria-hidden="true" />
        </button>
        <button type="button" aria-label="Video call" onClick={() => showComingSoon('Video calls are coming soon 📹')} style={iconButtonStyle}>
          <Video size={16} aria-hidden="true" />
        </button>
      </header>

      {toast && (
        <div
          data-toast
          role="status"
          style={{
            position: 'absolute',
            top: '54px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 5,
            padding: '7px 14px',
            borderRadius: tokens.radii.pill,
            backgroundColor: tokens.colors.textPrimary,
            color: tokens.colors.textWhite,
            fontSize: '0.72rem',
            fontWeight: 600,
            boxShadow: tokens.shadows.soft,
            whiteSpace: 'nowrap',
          }}
        >
          {toast}
        </div>
      )}

      {/* The transcript. */}
      <div
        data-chat-messages
        ref={listRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          padding: '8px 14px 10px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: '7px',
        }}
      >
        {loading && !messages.length && (
          <p style={{ textAlign: 'center', color: tokens.colors.textMuted, fontSize: '0.76rem' }}>
            Loading your messages…
          </p>
        )}

        {!loading && !messages.length && (
          <p
            data-chat-empty
            style={{
              margin: 'auto',
              textAlign: 'center',
              color: tokens.colors.textMuted,
              fontSize: '0.78rem',
              maxWidth: '220px',
              lineHeight: 1.5,
            }}
          >
            {`No messages yet. Say hi to ${partnerName} 👋`}
          </p>
        )}

        {groups.map((group) => (
          <React.Fragment key={group.key}>
            <div
              data-day-divider={group.key}
              style={{
                alignSelf: 'center',
                margin: '6px 0 2px 0',
                padding: '3px 12px',
                borderRadius: tokens.radii.pill,
                backgroundColor: tokens.colors.bgSurfaceSubtle,
                border: `1px solid ${tokens.colors.borderSubtle}`,
                color: tokens.colors.textMuted,
                fontSize: '0.66rem',
                fontWeight: 700,
              }}
            >
              {group.label}
            </div>
            {group.messages.map((entry) => (
              <Bubble
                key={entry.id}
                entry={entry}
                mine={entry.sender_id === currentUserId}
                onRetry={onRetry}
                questionBySessionId={questionBySessionId}
                highlightById={highlightById}
                onOpenHighlight={onOpenHighlight}
                onOpenQuestion={onOpenQuestion}
                replyOf={entry.reply_to_id ? {
                  senderName: messageById.has(entry.reply_to_id)
                    ? replySenderName(messageById.get(entry.reply_to_id) as ChatEntry)
                    : 'Original message',
                  snippet: messageById.get(entry.reply_to_id)?.content
                    ?? 'This message is further back in your chat.',
                } : undefined}
                onSwipeReply={startReply}
                onOpenActions={setActionTarget}
                onJumpTo={jumpToMessage}
                highlighted={highlightId === entry.id}
              />
            ))}
          </React.Fragment>
        ))}

        {partnerTyping && (
          <div
            data-typing-indicator
            role="status"
            aria-label={`${partnerName} is typing`}
            style={{
              alignSelf: 'flex-start',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              padding: '10px 13px',
              borderRadius: '16px 16px 16px 4px',
              backgroundColor: tokens.colors.bgSurface,
              border: `1px solid ${tokens.colors.borderSubtle}`,
              boxShadow: tokens.shadows.subtle,
            }}
          >
            <span className="nooki-typing-dot" />
            <span className="nooki-typing-dot" />
            <span className="nooki-typing-dot" />
          </div>
        )}
      </div>

      {error && (
        <div
          data-chat-error
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            margin: '0 14px 6px 14px',
            padding: '7px 10px',
            borderRadius: tokens.radii.sm,
            backgroundColor: tokens.colors.primaryPinkSoft,
            color: tokens.colors.primaryPinkDeep,
            fontSize: '0.72rem',
            fontWeight: 600,
          }}
        >
          <span style={{ flex: 1 }}>{error}</span>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={onDismissError}
            style={{
              background: 'none',
              border: 'none',
              color: 'inherit',
              fontFamily: tokens.typography.fontFamily,
              fontSize: '0.68rem',
              fontWeight: 800,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* The question "Say more" carried in: quoted above the composer until the next
          message is sent with it or it is dismissed. */}
      {questionContext && (
        <div
          data-chat-question-context
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            margin: '0 14px 6px 14px',
            padding: '8px 10px 8px 12px',
            borderRadius: tokens.radii.md,
            backgroundColor: tokens.colors.accentSageSoft,
            border: `1px solid ${tokens.colors.accentSage}`,
            flexShrink: 0,
          }}
        >
          <MessageSquare size={14} color={tokens.colors.accentSageDeep} style={{ flexShrink: 0 }} aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <span
              style={{
                display: 'block',
                fontSize: '0.62rem',
                fontWeight: 800,
                color: tokens.colors.accentSageDeep,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Saying more about
            </span>
            <span
              style={{
                display: 'block',
                fontSize: '0.76rem',
                fontWeight: 700,
                color: tokens.colors.textPrimary,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {questionContext.questionText || 'your question'}
            </span>
          </div>
          <button
            type="button"
            aria-label="Remove the question link"
            onClick={onClearQuestionContext}
            style={{
              width: '24px',
              height: '24px',
              borderRadius: tokens.radii.full,
              border: 'none',
              backgroundColor: 'transparent',
              color: tokens.colors.accentSageDeep,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Swipe-to-reply lands here: who you are answering and what they said. */}
      {replyTarget && (
        <div
          data-reply-context
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            margin: '0 14px 6px 14px',
            padding: '8px 10px 8px 12px',
            borderRadius: tokens.radii.md,
            backgroundColor: tokens.colors.primaryPinkSoft,
            border: `1px solid ${tokens.colors.primaryPink}`,
            flexShrink: 0,
          }}
        >
          <ReplyIcon size={14} color={tokens.colors.primaryPinkDeep} style={{ flexShrink: 0 }} aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <span
              style={{
                display: 'block',
                fontSize: '0.62rem',
                fontWeight: 800,
                color: tokens.colors.primaryPinkDeep,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {`Replying to ${replyingToName || 'a note'}`}
            </span>
            <span
              style={{
                display: 'block',
                fontSize: '0.76rem',
                fontWeight: 700,
                color: tokens.colors.textPrimary,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {replyTarget.content}
            </span>
          </div>
          <button
            type="button"
            aria-label="Clear reply"
            onClick={clearReply}
            style={{
              width: '24px',
              height: '24px',
              borderRadius: tokens.radii.full,
              border: 'none',
              backgroundColor: 'transparent',
              color: tokens.colors.primaryPinkDeep,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Edit mode: the box holds the original words and the send button saves. */}
      {editing && (
        <div
          data-edit-context
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            margin: '0 14px 6px 14px',
            padding: '8px 10px 8px 12px',
            borderRadius: tokens.radii.md,
            backgroundColor: tokens.colors.primaryPinkSoft,
            border: `1px solid ${tokens.colors.primaryPink}`,
            flexShrink: 0,
          }}
        >
          <Pencil size={14} color={tokens.colors.primaryPinkDeep} style={{ flexShrink: 0 }} aria-hidden="true" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <span
              style={{
                display: 'block',
                fontSize: '0.62rem',
                fontWeight: 800,
                color: tokens.colors.primaryPinkDeep,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Editing message
            </span>
            <span
              style={{
                display: 'block',
                fontSize: '0.76rem',
                fontWeight: 700,
                color: tokens.colors.textPrimary,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {editing.content}
            </span>
          </div>
          <button
            type="button"
            aria-label="Cancel edit"
            onClick={cancelEdit}
            style={{
              width: '24px',
              height: '24px',
              borderRadius: tokens.radii.full,
              border: 'none',
              backgroundColor: 'transparent',
              color: tokens.colors.primaryPinkDeep,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Composer. Enter sends the message; Shift+Enter starts a new paragraph. */}
      <form
        data-chat-composer
        onSubmit={handleSubmit}
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'flex-end',
          gap: '8px',
          padding: '8px 14px calc(10px + env(safe-area-inset-bottom, 0px)) 14px',
          backgroundColor: tokens.colors.bgCanvas,
        }}
      >
        <textarea
          data-chat-input
          aria-label="Message"
          title="Enter sends · Shift+Enter starts a new paragraph"
          placeholder={questionContext ? 'Say more…' : `Message ${partnerName}…`}
          rows={1}
          value={draft}
          ref={inputRef}
          onChange={(event) => {
            setDraft(event.target.value);
            resizeInput();
            if (event.target.value.trim()) onTyping();
            else onStopTyping();
          }}
          onKeyDown={(event) => {
            // Enter sends, the way every messenger on a laptop does it. Shift+Enter
            // is the paragraph break. While an IME is composing (a Japanese or
            // Chinese keyboard picking a character) Enter belongs to the IME.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void sendDraft();
              return;
            }
            if (event.key === 'Escape' && (editing || replyTarget)) {
              event.preventDefault();
              if (editing) cancelEdit();
              else clearReply();
            }
          }}
          onBlur={onStopTyping}
          style={{
            flex: 1,
            minWidth: 0,
            maxHeight: `${COMPOSER_MAX_HEIGHT}px`,
            resize: 'none',
            padding: '10px 14px',
            borderRadius: tokens.radii.lg,
            border: `1px solid ${tokens.colors.borderSoft}`,
            backgroundColor: tokens.colors.bgSurface,
            color: tokens.colors.textPrimary,
            fontFamily: tokens.typography.fontFamily,
            fontSize: '0.85rem',
            lineHeight: 1.4,
            outline: 'none',
          }}
        />
        <button
          type="submit"
          aria-label={editing ? 'Save edit' : 'Send message'}
          disabled={!draft.trim()}
          style={{
            width: '42px',
            height: '42px',
            borderRadius: tokens.radii.full,
            border: 'none',
            backgroundColor: draft.trim() ? tokens.colors.primaryPink : tokens.colors.borderSoft,
            color: tokens.colors.textWhite,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: draft.trim() ? 'pointer' : 'default',
            boxShadow: draft.trim() ? tokens.shadows.highlightPink : 'none',
            flexShrink: 0,
            transition: 'background-color 0.15s ease',
          }}
        >
          {editing ? <Check size={17} aria-hidden="true" /> : <Send size={17} aria-hidden="true" />}
        </button>
      </form>

      {/* Long press (or a right click) opens the only two actions a message gets:
          answer it, or correct it if it is yours. There is no delete and no reaction —
          those were asked away on purpose. */}
      {actionTarget && (
        <div
          data-actions-backdrop
          onClick={() => setActionTarget(null)}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 20,
            backgroundColor: 'rgba(87, 55, 70, 0.22)',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            padding: '0 20px 24px 20px',
          }}
        >
          <div
            data-message-actions={actionTarget.id}
            role="menu"
            onClick={(event) => event.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: '260px',
              borderRadius: tokens.radii.lg,
              backgroundColor: tokens.colors.bgSurface,
              border: `1px solid ${tokens.colors.borderSubtle}`,
              boxShadow: tokens.shadows.soft,
              overflow: 'hidden',
            }}
          >
            <button
              type="button"
              role="menuitem"
              aria-label="Reply"
              data-action-reply
              onClick={() => startReply(actionTarget)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                width: '100%',
                padding: '13px 16px',
                border: 'none',
                borderBottom: canEditAction(actionTarget) ? `1px solid ${tokens.colors.borderSubtle}` : 'none',
                backgroundColor: 'transparent',
                color: tokens.colors.textPrimary,
                fontFamily: tokens.typography.fontFamily,
                fontSize: '0.85rem',
                fontWeight: 700,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <ReplyIcon size={16} color={tokens.colors.primaryPinkDeep} aria-hidden="true" />
              Reply
            </button>
            {canEditAction(actionTarget) && (
              <button
                type="button"
                role="menuitem"
                aria-label="Edit"
                data-action-edit
                onClick={() => startEdit(actionTarget)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  width: '100%',
                  padding: '13px 16px',
                  border: 'none',
                  backgroundColor: 'transparent',
                  color: tokens.colors.textPrimary,
                  fontFamily: tokens.typography.fontFamily,
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <Pencil size={16} color={tokens.colors.primaryPinkDeep} aria-hidden="true" />
                Edit
              </button>
            )}
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setActionTarget(null)}
              style={{
                display: 'block',
                width: '100%',
                padding: '10px 16px',
                border: 'none',
                borderTop: `1px solid ${tokens.colors.borderSubtle}`,
                backgroundColor: 'transparent',
                color: tokens.colors.textMuted,
                fontFamily: tokens.typography.fontFamily,
                fontSize: '0.74rem',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
};

export default ChatView;
