import React from 'react';
import { CheckCheck, Play } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';

interface DailyDecisionCardProps {
  onPlay?: () => void;
}

/** A compact Home card that opens the couple's private, matching-choice decision. */
export const DailyDecisionCard: React.FC<DailyDecisionCardProps> = ({ onPlay }) => (
  <section
    data-card="daily-decision"
    aria-label="Today's decision"
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
      justifyContent: 'center',
      gap: '10px',
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
      <span
        style={{
          minWidth: 0,
          flex: '1 1 auto',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          fontSize: '0.62rem',
          fontWeight: 800,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: tokens.colors.accentSageDeep,
          whiteSpace: 'normal',
          lineHeight: 1.2,
        }}
      >
        <CheckCheck size={12} strokeWidth={2.2} aria-hidden="true" />
        <span style={{ minWidth: 0 }}>Today’s decision</span>
      </span>
      <button
        type="button"
        data-action="play-daily-decision"
        aria-label="Play today's decision"
        onClick={onPlay}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '4px',
          padding: '6px 9px',
          borderRadius: tokens.radii.pill,
          border: 'none',
          backgroundColor: tokens.colors.accentSageDeep,
          color: tokens.colors.textWhite,
          boxShadow: tokens.shadows.subtle,
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
  </section>
);

export default DailyDecisionCard;
