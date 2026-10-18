import React from 'react';
import { Gamepad2, Play } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { getInitial } from '../../lib/coupleTime';

interface DailyGameCardProps {
  /** Partner 1 — the person holding this phone. */
  userName?: string;
  /** Partner 2 — the partner on the other end of the distance. */
  partnerName?: string;
  /** Completed-match wins for Partner 1. */
  userWins?: number;
  /** Completed-match wins for Partner 2. */
  partnerWins?: number;
  onPlay?: () => void;
}

/** The deliberately small Home card: eyebrow, action, then the couple's score. */
export const DailyGameCard: React.FC<DailyGameCardProps> = ({
  userName = 'You',
  partnerName = 'Partner',
  userWins = 0,
  partnerWins = 0,
  onPlay,
}) => {
  const firstInitial = getInitial(userName);
  const secondInitial = getInitial(partnerName);

  return (
    <section
      data-card="daily-game"
      aria-label="Daily game"
      style={{
        minWidth: 0,
        minHeight: '82px',
        boxSizing: 'border-box',
        backgroundColor: tokens.colors.bgSurface,
        borderRadius: tokens.radii.lg,
        boxShadow: tokens.shadows.card,
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        gap: '10px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
        <span
          style={{
            minWidth: 0,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '0.62rem',
            fontWeight: 800,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: tokens.colors.accentLavenderDeep,
            whiteSpace: 'nowrap',
          }}
        >
          <Gamepad2 size={12} strokeWidth={2.2} aria-hidden="true" />
          Daily game
        </span>
        <button
          type="button"
          data-action="play-daily-game"
          aria-label="Play the daily game"
          onClick={onPlay}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '4px',
            padding: '6px 9px',
            borderRadius: tokens.radii.pill,
            border: 'none',
            backgroundColor: tokens.colors.primaryPink,
            color: tokens.colors.textWhite,
            boxShadow: tokens.shadows.highlightPink,
            fontSize: '0.7rem',
            fontWeight: 800,
            cursor: 'pointer',
            fontFamily: tokens.typography.fontFamily,
            flexShrink: 0,
          }}
        >
          <Play size={10} fill={tokens.colors.textWhite} strokeWidth={2.2} aria-hidden="true" />
          <span>Play</span>
        </button>
      </div>

      <div
        data-scoreboard
        role="group"
        aria-label={`Daily game score: ${userName || 'You'} ${userWins} to ${partnerWins} ${partnerName || 'Partner'}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
          padding: '6px 8px',
          borderRadius: tokens.radii.md,
          backgroundColor: tokens.colors.bgSurfaceSubtle,
          border: `1px solid ${tokens.colors.borderSubtle}`,
          color: tokens.colors.textPrimary,
          fontSize: '0.78rem',
          fontWeight: 800,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}
      >
        <span data-score-initial="self">{firstInitial}</span>
        <span>{`${userWins}–${partnerWins}`}</span>
        <span data-score-initial="partner">{secondInitial}</span>
      </div>
    </section>
  );
};

export default DailyGameCard;
