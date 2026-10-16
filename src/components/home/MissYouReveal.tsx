import React, { useEffect } from 'react';
import { Heart } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { formatMissYouMessage, type MissYouBatch } from '../../lib/missYou';

/** The whole moment: heart in, sentence up, everything out. */
export const MISS_YOU_REVEAL_MS = 4600;
/** The heart's own expand-and-fade, inside that window. */
export const MISS_YOU_HEART_MS = 2600;

export interface MissYouRevealProps {
  /** What the partner left waiting. */
  batch: MissYouBatch;
  /** The partner who tapped — the name the sentence is about. */
  senderName: string;
  onDismiss: () => void;
}

/**
 * The big heart: what the partner sees when they open Nooki after the other one tapped
 * "I miss you" while they were away.
 *
 * It is the load screen's last beat — the splash has just gone, the app is up, and this
 * expands over the top of it with the sentence underneath ("Hi, Ana missed you", or "Ana
 * missed you 4 times today"), then fades away on its own. By the time it has gone the taps
 * have already been marked received in the database, so it is a one-time greeting.
 *
 * Any tap, or Escape, closes it early; reduced-motion readers get the same words with no
 * growth, and the timer still takes it away.
 */
export const MissYouReveal: React.FC<MissYouRevealProps> = ({ batch, senderName, onDismiss }) => {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, MISS_YOU_REVEAL_MS);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onDismiss]);

  return (
    <div
      data-component="miss-you-reveal"
      data-miss-you-count={batch.count}
      data-miss-you-days={batch.allToday ? 'today' : 'earlier'}
      role="status"
      aria-live="polite"
      onClick={onDismiss}
      className="nooki-miss-you-reveal"
      style={{
        position: 'absolute',
        inset: 0,
        // Above the bottom navigation (10), the reader (30) and the calendar (40): the load
        // moment is the last thing to paint, and it is never on screen for long.
        zIndex: 45,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '10px',
        padding: '28px 24px',
        textAlign: 'center',
        cursor: 'pointer',
        // Softly over the load rather than instead of it: the tab behind it is still there,
        // just no longer the thing being looked at.
        background:
          'radial-gradient(ellipse 78% 58% at 50% 42%, rgba(255, 244, 249, 0.94) 0%, rgba(255, 251, 242, 0.9) 72%)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        fontFamily: tokens.typography.fontFamily,
        animationDuration: `${MISS_YOU_REVEAL_MS}ms`,
      }}
    >
      <span
        aria-hidden="true"
        data-miss-you-heart
        className="nooki-miss-you-heart"
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '164px',
          height: '164px',
          animationDuration: `${MISS_YOU_HEART_MS}ms`,
        }}
      >
        <span
          className="nooki-miss-you-glow"
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: tokens.radii.full,
            background: 'radial-gradient(circle at 50% 50%, rgba(249, 168, 212, 0.42) 0%, rgba(249, 168, 212, 0) 68%)',
          }}
        />
        <Heart
          size={132}
          strokeWidth={1.4}
          color={tokens.colors.primaryPinkDeep}
          fill={tokens.colors.primaryPink}
        />
      </span>

      <p
        data-miss-you-message
        className="nooki-miss-you-message"
        style={{
          margin: 0,
          maxWidth: '15em',
          fontSize: '1.06rem',
          fontWeight: 800,
          lineHeight: 1.45,
          color: tokens.colors.primaryPinkDeep,
        }}
      >
        {formatMissYouMessage(senderName, batch)}
      </p>

      <span
        aria-hidden="true"
        style={{
          fontSize: '0.64rem',
          fontWeight: 600,
          letterSpacing: '0.5px',
          color: tokens.colors.textMuted,
          textTransform: 'uppercase',
        }}
      >
        tap to close
      </span>
    </div>
  );
};

export default MissYouReveal;
