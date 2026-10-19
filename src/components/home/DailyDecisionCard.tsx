import React from 'react';
import { CheckCheck, ChevronRight } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import type { DailyDecisionSnapshot } from '../../types/database';

/**
 * The slice of today's decision the Home card needs to pick its one status line.
 * The hook's `DailyDecisionState` satisfies this as-is, so App can hand it straight over.
 */
export type DailyDecisionCardState = Pick<
  DailyDecisionSnapshot,
  'question' | 'my_choice' | 'partner_responded' | 'both_answered' | 'agreed'
> & {
  loading?: boolean;
  error?: string | null;
};

export interface DailyDecisionCardProps {
  onPlay?: () => void;
  state?: DailyDecisionCardState;
  partnerName?: string;
}

type CardStatus = 'loading' | 'unavailable' | 'empty' | 'undecided' | 'waiting' | 'talk-it-out' | 'decided';

/** How loudly the card asks for attention: my move pulses, waiting on my partner only glows. */
type CardAttention = 'action' | 'waiting' | 'none';

/**
 * One status for the card, in the same order the decision sheet reasons about it
 * (see DailyDecisionModal): nothing is claimed about choices until a question has
 * actually loaded, and an error only replaces the card when there is no question
 * to show a choice for. With no state at all (the preview) the card simply invites.
 */
function getCardStatus(state?: DailyDecisionCardState): CardStatus {
  if (!state) return 'undecided';
  if (!state.question) {
    if (state.loading) return 'loading';
    if (state.error) return 'unavailable';
    return 'empty';
  }
  if (state.agreed) return 'decided';
  if (state.both_answered) return 'talk-it-out';
  if (state.my_choice !== null) return 'waiting';
  return 'undecided';
}

function getCardAttention(status: CardStatus): CardAttention {
  if (status === 'undecided' || status === 'talk-it-out') return 'action';
  if (status === 'waiting') return 'waiting';
  return 'none';
}

/** "Jayo" → "Jayo’s", "James" → "James’" — the name the waiting line is about. */
const possessiveName = (name: string): string => (/s$/i.test(name) ? `${name}’` : `${name}’s`);

function getCardSubtext(status: CardStatus, partnerName?: string): string {
  switch (status) {
    case 'undecided':
      return 'Make a decision';
    case 'waiting': {
      const who = (partnerName ?? '').trim() || 'your partner';
      return `Waiting for ${possessiveName(who)} decision`;
    }
    case 'talk-it-out':
      return 'Talk it out';
    case 'decided':
      return 'Decided';
    case 'loading':
      return 'Loading today’s decision…';
    case 'unavailable':
      return 'Decision unavailable · Tap to view';
    case 'empty':
      return 'No decision today';
  }
}

// The Our day card's own shadow (everydayStatus.css), so the pair of Home cards match.
// The glows keep that shadow and add the pink ring the Home nav badge uses for the same
// unanswered decision; the pulsing keyframes in index.css start from ACTION_GLOW, so
// reduced-motion (and no CSS) still leaves the steady glow painted inline here.
const CARD_SHADOW = '0 4px 12px rgba(58, 45, 32, 0.08)';
const ACTION_GLOW = `${CARD_SHADOW}, 0 0 0 2px rgba(236, 72, 153, 0.55), 0 0 14px rgba(249, 168, 212, 0.55)`;
const WAITING_GLOW = `${CARD_SHADOW}, 0 0 0 2px rgba(249, 168, 212, 0.6), 0 0 14px rgba(249, 168, 212, 0.45)`;

/**
 * Home's Today's decision card, mirroring the Our day card beside it: one whole-card
 * button, the two ticks and a small uppercase title at Our day's size, then one short
 * status line. Until the couple agrees the card glows — pulsing with an alert badge
 * while a choice (or a re-choice) is this phone's to make, and glowing steadily while
 * it waits for the partner's decision. Once both picks match it settles back down.
 */
export const DailyDecisionCard: React.FC<DailyDecisionCardProps> = ({ onPlay, state, partnerName }) => {
  const status = getCardStatus(state);
  const attention = getCardAttention(status);

  return (
    <button
      type="button"
      data-card="daily-decision"
      data-action="play-daily-decision"
      data-decision-state={status}
      data-decision-attention={attention}
      aria-haspopup="dialog"
      onClick={onPlay}
      className={attention === 'action' ? 'nooki-decision-card nooki-decision-card--action' : 'nooki-decision-card'}
      style={{
        position: 'relative',
        minWidth: 0,
        minHeight: '82px',
        boxSizing: 'border-box',
        padding: '12px',
        border: 'none',
        borderRadius: '16px',
        backgroundColor: '#FFFBF2',
        color: '#624535',
        boxShadow: attention === 'action' ? ACTION_GLOW : attention === 'waiting' ? WAITING_GLOW : CARD_SHADOW,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: '8px',
        textAlign: 'left',
        fontFamily: tokens.typography.fontFamily,
        cursor: 'pointer',
      }}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '5px',
          fontSize: '0.62rem',
          fontWeight: 800,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          lineHeight: 1.2,
          color: tokens.colors.accentSageDeep,
        }}
      >
        <CheckCheck size={13} strokeWidth={2.2} aria-hidden="true" style={{ flexShrink: 0 }} />
        <span style={{ minWidth: 0 }}>Today’s decision</span>
        <ChevronRight size={14} aria-hidden="true" style={{ marginLeft: 'auto', flexShrink: 0 }} />
      </span>
      <span style={{ fontSize: '11px', lineHeight: 1.4, overflowWrap: 'anywhere' }}>
        {getCardSubtext(status, partnerName)}
      </span>
      {attention === 'action' && (
        <span
          data-decision-alert
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: '-6px',
            right: '-6px',
            width: '18px',
            height: '18px',
            borderRadius: tokens.radii.full,
            backgroundColor: tokens.colors.primaryPinkDeep,
            color: tokens.colors.textWhite,
            border: `2px solid ${tokens.colors.bgCanvas}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '0.68rem',
            fontWeight: 800,
            lineHeight: 1,
          }}
        >
          !
        </span>
      )}
    </button>
  );
};

export default DailyDecisionCard;
