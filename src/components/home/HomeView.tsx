import React from 'react';
import { Clock, Heart } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { useNow } from '../../hooks/useNow';
import {
  formatDayOffset,
  formatLastSeen,
  formatTogetherDuration,
  getInitial,
  getPartnerClock,
  getTogetherDuration,
} from '../../lib/coupleTime';
import type { Couple, Profile } from '../../types/database';

interface HomeViewProps {
  /** Partner 1 — the person holding this phone. */
  profile: Profile;
  /** Partner 2 — the person on the other side of the distance. */
  partner: Profile;
  couple: Couple;
  /** Live from Supabase Realtime presence; false falls back to the stored timestamp. */
  partnerOnline: boolean;
}

// One shared soft-card shell keeps the stack airy and consistent.
const cardStyle: React.CSSProperties = {
  backgroundColor: tokens.colors.bgSurface,
  borderRadius: tokens.radii.card,
  boxShadow: tokens.shadows.card,
  padding: '22px 20px',
};

interface PartnerRowProps {
  name: string;
  tint: string;
  ink: string;
  badge?: string;
  /** Undefined for the phone owner, who has no presence dot. */
  online?: boolean;
  status: string;
}

const PartnerRow: React.FC<PartnerRowProps> = ({ name, tint, ink, badge, online, status }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
    <div
      style={{
        width: '38px',
        height: '38px',
        borderRadius: tokens.radii.full,
        backgroundColor: tint,
        color: ink,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 800,
        fontSize: '0.92rem',
        flexShrink: 0,
      }}
    >
      {getInitial(name)}
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flex: 1, minWidth: 0 }}>
      <span
        style={{
          fontSize: '0.96rem',
          fontWeight: 700,
          color: tokens.colors.textPrimary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {name}
      </span>
      {badge && (
        <span
          style={{
            fontSize: '0.6rem',
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: tokens.colors.textMuted,
            backgroundColor: tokens.colors.bgSurfaceSubtle,
            padding: '2px 7px',
            borderRadius: tokens.radii.pill,
            flexShrink: 0,
          }}
        >
          {badge}
        </span>
      )}
      {online !== undefined && (
        <span
          aria-hidden="true"
          data-presence={online ? 'online' : 'offline'}
          style={{
            width: '7px',
            height: '7px',
            borderRadius: tokens.radii.full,
            backgroundColor: online ? tokens.colors.primaryGreenDeep : tokens.colors.borderSoft,
            flexShrink: 0,
          }}
        />
      )}
      <span
        style={{
          fontSize: '0.74rem',
          fontWeight: 500,
          color: online ? tokens.colors.primaryGreenDeep : tokens.colors.textMuted,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {status}
      </span>
    </div>
  </div>
);

export const HomeView: React.FC<HomeViewProps> = ({ profile, partner, couple, partnerOnline }) => {
  // A live clock drives the everyday counter, the partner's wall time and "last seen" labels.
  const now = useNow(1000);
  const together = getTogetherDuration(couple.anniversary_date, now);
  const partnerClock = getPartnerClock(partner.timezone, now);
  const dayOffsetLabel = partnerClock ? formatDayOffset(partnerClock.dayOffset) : null;
  const anniversaryToday = !together.isFuture && together.years === 0 && together.months === 0 && together.days === 0;

  return (
    <section
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '4px 22px 26px 22px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
      }}
    >
      {/* 1. Couple header: both names and how long they have been together */}
      <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
        <div
          style={{
            width: '44px',
            height: '44px',
            borderRadius: tokens.radii.full,
            backgroundColor: tokens.colors.primaryPinkSoft,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: tokens.colors.primaryPinkDeep,
          }}
        >
          <Heart size={22} fill={tokens.colors.primaryPink} strokeWidth={1.5} />
        </div>

        <h1
          style={{
            margin: 0,
            fontSize: '1.32rem',
            fontWeight: 800,
            letterSpacing: '-0.02em',
            lineHeight: 1.3,
            color: tokens.colors.textPrimary,
            textAlign: 'center',
          }}
        >
          {profile.name} <span style={{ color: tokens.colors.primaryPinkDeep }}>&amp;</span> {partner.name}
        </h1>

        {anniversaryToday ? (
          <p style={{ margin: 0, fontSize: '0.82rem', fontWeight: 700, color: tokens.colors.primaryPinkDeep }}>
            Happy anniversary — today is your day
          </p>
        ) : (
          <p style={{ margin: 0, fontSize: '0.8rem', color: tokens.colors.textMuted }}>
            {together.isFuture ? 'Counting down ' : 'Together for '}
            <span style={{ fontSize: '0.98rem', fontWeight: 800, color: tokens.colors.textPrimary, letterSpacing: '0.02em' }}>
              {formatTogetherDuration(together)}
            </span>
          </p>
        )}
      </div>

      {/* 2. Partner status: partner 1 is this phone, partner 2 carries the presence dot */}
      <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <PartnerRow
          name={profile.name}
          tint={tokens.colors.primaryPinkSoft}
          ink={tokens.colors.primaryPinkDeep}
          badge="You"
          status="This phone"
        />
        <div style={{ height: '1px', backgroundColor: tokens.colors.borderSubtle }} />
        <PartnerRow
          name={partner.name}
          tint={tokens.colors.primaryGreenSoft}
          ink={tokens.colors.primaryGreenDeep}
          online={partnerOnline}
          status={partnerOnline ? 'Online' : formatLastSeen(partner.last_seen_at, now)}
        />
      </div>

      {/* 3. The partner's local time — deliberately never the reader's own clock */}
      <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div
          style={{
            width: '36px',
            height: '36px',
            borderRadius: tokens.radii.full,
            backgroundColor: tokens.colors.accentLavenderSoft,
            color: tokens.colors.accentLavenderDeep,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <Clock size={18} strokeWidth={2.2} />
        </div>
        <p style={{ margin: 0, fontSize: '0.88rem', color: tokens.colors.textSecondary }}>
          {partnerClock ? (
            <>
              It&rsquo;s{' '}
              <span style={{ fontSize: '0.98rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
                {partnerClock.time}
              </span>{' '}
              for {partner.name}
              {dayOffsetLabel && <span style={{ color: tokens.colors.textMuted }}> &middot; {dayOffsetLabel}</span>}
            </>
          ) : (
            <>We can&rsquo;t read {partner.name}&rsquo;s time zone yet.</>
          )}
        </p>
      </div>
    </section>
  );
};

export default HomeView;
