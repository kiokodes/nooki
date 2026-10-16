import React, { useEffect, useState } from 'react';
import { Heart } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';

export interface MissYouButtonProps {
  /** Rendered only while the partner is away — the one half of the couple who is alone. */
  visible: boolean;
  /** Taps this phone has sent that the partner has not opened yet. */
  sentCount: number;
  /** Named in the accessible label, so the tap is clearly *for* them. */
  partnerName?: string;
  /** A sentence from a tap the database refused; cleared by the next tap that lands. */
  error?: string | null;
  onTap: () => void;
}

/** Honours the platform's reduced-motion setting without a replay of the puff. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  ));

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, []);

  return reduced;
}

/**
 * The little "I miss you" button in the top-left of the nook.
 *
 * It lives where the companions stand, and only while the partner is away: tapping it is
 * for the person sitting in the app alone. Each tap leaves one tap behind for the partner
 * to open later, so the button shows how many are still waiting for them; the heart that
 * drifts up out of the pill is the receipt that the tap landed.
 */
export const MissYouButton: React.FC<MissYouButtonProps> = ({
  visible,
  sentCount,
  partnerName,
  error,
  onTap,
}) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  // Bumped per tap so the puff restarts; the number itself is the record.
  const [puffs, setPuffs] = useState(0);

  if (!visible) return null;

  const who = (partnerName || '').trim() || 'your partner';
  const waiting = sentCount === 1 ? '1 tap waiting to be opened' : `${sentCount} taps waiting to be opened`;
  const label = sentCount > 0
    ? `I miss you — ${waiting} by ${who}`
    : `I miss you — leave a tap for ${who} to open later`;

  const handleTap = () => {
    if (!prefersReducedMotion) setPuffs((current) => current + 1);
    onTap();
  };

  return (
    <div
      data-miss-you="corner"
      style={{
        position: 'absolute',
        top: '10px',
        left: '12px',
        zIndex: 3,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: '4px',
        maxWidth: '138px',
        fontFamily: tokens.typography.fontFamily,
      }}
    >
      <button
        type="button"
        data-miss-you-button
        data-miss-you-count={sentCount}
        className="nooki-miss-you-button"
        onClick={handleTap}
        aria-label={label}
        title={label}
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          padding: '5px 9px 5px 7px',
          minHeight: '26px',
          borderRadius: tokens.radii.pill,
          border: '1px solid rgba(249, 168, 212, 0.55)',
          backgroundColor: 'rgba(255, 255, 255, 0.9)',
          color: tokens.colors.primaryPinkDeep,
          fontFamily: 'inherit',
          fontSize: '8.5px',
          fontWeight: 700,
          letterSpacing: '0.7px',
          lineHeight: 1.1,
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
          cursor: 'pointer',
          outline: 'none',
          boxShadow: tokens.shadows.subtle,
          transition: 'transform 0.15s ease, background-color 0.15s ease',
        }}
      >
        <Heart size={10} strokeWidth={2.6} fill="currentColor" aria-hidden="true" />
        <span>I miss you</span>
        {sentCount > 1 && (
          <span className="nooki-miss-you-badge" data-miss-you-badge aria-hidden="true">
            {sentCount > 99 ? '99+' : sentCount}
          </span>
        )}
        {puffs > 0 && (
          <span key={puffs} className="nooki-miss-you-puff" data-miss-you-puff aria-hidden="true">
            <Heart size={13} strokeWidth={2.4} fill="currentColor" />
          </span>
        )}
      </button>
      {error && (
        <span
          data-miss-you-error
          role="status"
          style={{
            fontSize: '8.5px',
            fontWeight: 600,
            lineHeight: 1.35,
            color: tokens.colors.textMuted,
          }}
        >
          {error}
        </span>
      )}
    </div>
  );
};

export default MissYouButton;
