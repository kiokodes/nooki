import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CheckCheck, CircleAlert, Clock, Phone, Send, Video } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { useNow } from '../../hooks/useNow';
import { getInitial, formatLastSeen } from '../../lib/coupleTime';
import { formatMessageTime, groupMessagesByDay } from '../../lib/chatTime';
import type { ChatEntry } from '../../types/database';

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
  onSend: (content: string) => Promise<void> | void;
  onTyping: () => void;
  onStopTyping: () => void;
  onRetry: (entryId: string) => void;
  onDismissError: () => void;
}

const TOAST_MS = 2_000;
const COMPOSER_MAX_HEIGHT = 132;

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

const Bubble: React.FC<{
  entry: ChatEntry;
  mine: boolean;
  onRetry: (entryId: string) => void;
}> = ({ entry, mine, onRetry }) => {
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

  return (
    <div
      style={{
        alignSelf: mine ? 'flex-end' : 'flex-start',
        maxWidth: '78%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: mine ? 'flex-end' : 'flex-start',
        gap: '2px',
      }}
    >
      <div
        data-message-id={entry.id}
        data-mine={mine ? 'true' : 'false'}
        data-message-type={entry.type}
        style={{
          padding: '8px 12px',
          borderRadius: mine ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
          backgroundColor: mine ? tokens.colors.primaryPink : tokens.colors.bgSurface,
          color: tokens.colors.textPrimary,
          border: mine ? '1px solid transparent' : `1px solid ${tokens.colors.borderSubtle}`,
          boxShadow: tokens.shadows.subtle,
          // Newlines are paragraphs the sender typed: the bubble keeps them.
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          fontSize: '0.87rem',
          lineHeight: 1.45,
        }}
      >
        {entry.content}
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
  );
};

/**
 * The Chat tab: the couple's live conversation, in the shape of a messenger.
 *
 * Bubbles from this phone sit on the right in Nooki's blush pink, the partner's on the
 * left in white; the transcript is split into days, receipts show sent/read, and the
 * list keeps itself pinned to the newest message.
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
  onRetry,
  onDismissError,
}) => {
  const [draft, setDraft] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  // Minute granularity: enough for "Today"/"Yesterday" to roll over, and cheap.
  const now = useNow(60_000);

  // Auto-scroll: pin to the newest message whenever the transcript or the typing
  // indicator changes, which is also what happens when the tab opens.
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
  }, []);

  const resizeInput = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight || 0, COMPOSER_MAX_HEIGHT)}px`;
  }, []);

  const handleSubmit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    const content = draft;
    // Enter starts a new paragraph, so the send button is the only way to send.
    if (!content.trim()) return;
    setDraft('');
    onStopTyping();
    if (inputRef.current) inputRef.current.style.height = 'auto';
    await onSend(content);
    inputRef.current?.focus();
  }, [draft, onSend, onStopTyping]);

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
              <Bubble key={entry.id} entry={entry} mine={entry.sender_id === currentUserId} onRetry={onRetry} />
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

      {/* Composer. Enter inserts a paragraph break; only the send button sends. */}
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
          placeholder={`Message ${partnerName}…`}
          rows={1}
          value={draft}
          ref={inputRef}
          onChange={(event) => {
            setDraft(event.target.value);
            resizeInput();
            if (event.target.value.trim()) onTyping();
            else onStopTyping();
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
          aria-label="Send message"
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
          <Send size={17} aria-hidden="true" />
        </button>
      </form>
    </section>
  );
};

export default ChatView;
