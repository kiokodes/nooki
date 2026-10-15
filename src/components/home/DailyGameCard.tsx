import React, { useState } from 'react';
import { Gamepad2, Play, Trophy } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';

interface DailyGameCardProps {
  /** Partner 1 — the person holding this phone. */
  userName?: string;
  /** Partner 2 — the partner on the other end of the distance. */
  partnerName?: string;
  /** Wins for Partner 1 (0 for now). */
  userWins?: number;
  /** Wins for Partner 2 (0 for now). */
  partnerWins?: number;
  onPlay?: () => void;
}

/**
 * Daily game card — a placeholder "Today's challenge" card on the Home tab
 * with a play button and a head-to-head scoreboard showing wins for each
 * partner (0 to 0 for now).
 */
export const DailyGameCard: React.FC<DailyGameCardProps> = ({
  userName = 'You',
  partnerName = 'Partner',
  userWins = 0,
  partnerWins = 0,
  onPlay,
}) => {
  const [noticeVisible, setNoticeVisible] = useState(false);
  const firstLabel = userName.trim() || 'You';
  const secondLabel = partnerName.trim() || 'Partner';

  return (
    <section
      data-card="daily-game"
      aria-label="Today's challenge"
      style={{
        backgroundColor: tokens.colors.bgSurface,
        borderRadius: tokens.radii.lg,
        boxShadow: tokens.shadows.card,
        padding: '14px 16px',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              fontSize: '0.64rem',
              fontWeight: 700,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: tokens.colors.accentLavenderDeep,
            }}
          >
            <Gamepad2 size={12} strokeWidth={2.2} aria-hidden="true" />
            Daily game
          </span>
          <h2
            style={{
              margin: '1px 0 0 0',
              fontSize: '0.98rem',
              fontWeight: 800,
              color: tokens.colors.textPrimary,
              letterSpacing: '-0.01em',
            }}
          >
            {"Today's challenge"}
          </h2>
          <p
            data-daily-game-status
            style={{
              margin: '1px 0 0 0',
              fontSize: '0.75rem',
              color: tokens.colors.textMuted,
            }}
          >
            {noticeVisible
              ? 'Daily challenges are coming soon — stay tuned!'
              : 'A quick head-to-head for the two of you.'}
          </p>
        </div>

        <button
          type="button"
          data-action="play-daily-game"
          aria-label="Play Today's challenge"
          onClick={() => {
            setNoticeVisible(true);
            onPlay?.();
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 14px',
            borderRadius: tokens.radii.pill,
            border: 'none',
            backgroundColor: tokens.colors.primaryPink,
            color: tokens.colors.textWhite,
            boxShadow: tokens.shadows.highlightPink,
            fontSize: '0.78rem',
            fontWeight: 800,
            cursor: 'pointer',
            fontFamily: tokens.typography.fontFamily,
            flexShrink: 0,
          }}
        >
          <Play size={12} fill={tokens.colors.textWhite} strokeWidth={2.2} aria-hidden="true" />
          <span>Play</span>
        </button>
      </div>

      {/* Head-to-head scoreboard showing wins for each partner (0 to 0 for now) */}
      <div
        data-scoreboard
        role="group"
        aria-label={`Scoreboard: ${firstLabel} ${userWins} wins, ${secondLabel} ${partnerWins} wins (${userWins} to ${partnerWins})`}
        style={{
          marginTop: '10px',
          padding: '8px 12px',
          borderRadius: tokens.radii.md,
          backgroundColor: tokens.colors.bgSurfaceSubtle,
          border: `1px solid ${tokens.colors.borderSubtle}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
        }}
      >
        <div
          data-partner-score="self"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            minWidth: 0,
            flex: 1,
          }}
        >
          <span
            style={{
              fontSize: '0.78rem',
              fontWeight: 700,
              color: tokens.colors.textPrimary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '100%',
            }}
          >
            {firstLabel}
          </span>
          <span style={{ fontSize: '0.69rem', fontWeight: 600, color: tokens.colors.textMuted }}>
            {userWins} {userWins === 1 ? 'win' : 'wins'}
          </span>
        </div>

        <div
          data-score-tally
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            padding: '3px 10px',
            borderRadius: tokens.radii.pill,
            backgroundColor: tokens.colors.accentLavenderSoft,
            color: tokens.colors.accentLavenderDeep,
            fontSize: '0.76rem',
            fontWeight: 800,
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
          }}
        >
          <Trophy size={11} strokeWidth={2.2} aria-hidden="true" />
          <span>{`${userWins} to ${partnerWins}`}</span>
        </div>

        <div
          data-partner-score="partner"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            minWidth: 0,
            flex: 1,
          }}
        >
          <span
            style={{
              fontSize: '0.78rem',
              fontWeight: 700,
              color: tokens.colors.textPrimary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '100%',
            }}
          >
            {secondLabel}
          </span>
          <span style={{ fontSize: '0.69rem', fontWeight: 600, color: tokens.colors.textMuted }}>
            {partnerWins} {partnerWins === 1 ? 'win' : 'wins'}
          </span>
        </div>
      </div>
    </section>
  );
};

export default DailyGameCard;
