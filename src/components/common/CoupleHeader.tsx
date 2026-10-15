import React from 'react';
import { Settings } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { useNow } from '../../hooks/useNow';
import {
  formatLastSeen,
  formatPartnerClock,
  formatTogetherDuration,
  getInitial,
  getPartnerClock,
  getTogetherDuration,
} from '../../lib/coupleTime';
import type { Couple, Profile } from '../../types/database';

interface CoupleHeaderProps {
  /** Partner 1 — the person holding this phone. */
  profile: Profile;
  /** Partner 2 — the person on the other side of the distance. */
  partner: Profile;
  couple: Couple;
  /** Live from Supabase Realtime presence; false greys the dot out. */
  partnerOnline: boolean;
  onOpenSettings: () => void;
}

/**
 * The global app header, present on every tab.
 *
 * It carries the couple's initials (space is at a premium, and full names live in the
 * Home tab's personalisation), a presence dot that doubles as the online ticker, the
 * partner's local time ("5:14 PM Tue"), and how long they have been together.
 * It owns its own one-second tick so only this header re-renders as time passes.
 */
export const CoupleHeader: React.FC<CoupleHeaderProps> = ({
  profile,
  partner,
  couple,
  partnerOnline,
  onOpenSettings,
}) => {
  const now = useNow(1000);
  const together = getTogetherDuration(couple.anniversary_date, now);
  const partnerClock = getPartnerClock(partner.timezone, now);
  const lastSeen = partnerOnline ? `${partner.name} is online` : formatLastSeen(partner.last_seen_at, now);
  const initials = `${getInitial(profile.name)} & ${getInitial(partner.name)}`;

  return (
    <header
      style={{
        padding: 'calc(12px + env(safe-area-inset-top, 0px)) 18px 8px 18px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', flex: 1, minWidth: 0, marginRight: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 }}>
          <span
            data-couple-initials={initials}
            aria-label={`${profile.name} and ${partner.name}`}
            title={`${profile.name} & ${partner.name}`}
            style={{
              fontSize: '1.08rem',
              fontWeight: 800,
              color: tokens.colors.textPrimary,
              letterSpacing: '0.01em',
              whiteSpace: 'nowrap',
            }}
          >
            {initials}
          </span>

          {/* Presence ticker: green while the partner is in the app, grey once they leave. */}
          <span
            className="nooki-presence-dot"
            data-presence={partnerOnline ? 'online' : 'offline'}
            role="img"
            aria-label={lastSeen}
            title={lastSeen}
            style={{
              width: '7px',
              height: '7px',
              borderRadius: tokens.radii.full,
              backgroundColor: partnerOnline ? tokens.colors.primaryGreenDeep : tokens.colors.borderSoft,
              flexShrink: 0,
            }}
          />

          {partnerClock && (
            <span
              style={{
                fontSize: '0.73rem',
                fontWeight: 600,
                color: tokens.colors.textMuted,
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {formatPartnerClock(partnerClock)}
            </span>
          )}
        </div>

        {couple.anniversary_date && (
          <span style={{ fontSize: '0.72rem', color: tokens.colors.textMuted }}>
            Together for {formatTogetherDuration(together)}
          </span>
        )}
      </div>

      <button
        onClick={onOpenSettings}
        aria-label="Settings"
        style={{
          width: '34px',
          height: '34px',
          borderRadius: tokens.radii.full,
          backgroundColor: tokens.colors.bgSurface,
          border: `1px solid ${tokens.colors.borderSubtle}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          color: tokens.colors.textSecondary,
          boxShadow: tokens.shadows.subtle,
          flexShrink: 0,
        }}
      >
        <Settings size={16} />
      </button>
    </header>
  );
};

export default CoupleHeader;
