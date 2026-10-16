import React from 'react';
import { TodayCard } from './TodayCard';
import { DailyGameCard } from './DailyGameCard';
import { HomeNookiCompanions } from './HomeNookiCompanions';
import { MissYouButton, type MissYouButtonProps } from './MissYouButton';
import { useNow } from '../../hooks/useNow';
import { tokens } from '../../tokens/designTokens';
import type { CoupleEvent } from '../../types/database';

interface HomeViewProps {
  events: CoupleEvent[];
  anniversaryDate: string | null;
  eventsLoading: boolean;
  eventsError: string | null;
  onOpenCalendar: () => void;
  userName?: string;
  partnerName?: string;
  /** Realtime presence for the other partner; this phone is already active on Home. */
  partnerOnline?: boolean;
  userWins?: number;
  partnerWins?: number;
  dailyStatus?: string;
  dailyLabel?: string;
  onPlayDailyGame?: () => void;
  /**
   * The "I miss you" button in the corner of the nook. Omitted (or hidden) whenever the
   * couple is not both paired and apart — the button is for the partner who is alone.
   */
  missYou?: MissYouButtonProps;
}

/**
 * Home tab — the centre tab and the default screen.
 *
 * It shows:
 * - The Today card: today's date, anything happening today, and what is coming within the next day.
 * - The Daily game card: a "Today's challenge" card with a play button and a
 *   scoreboard showing wins for each partner (saved match wins).
 * - A shared cozy nook, with a small top-right caption, presence-aware companion art, and
 *   the "I miss you" button in the top-left corner. The button belongs to the half of the
 *   couple who is in the app alone (see `useMissYou`): it is only rendered while the partner
 *   is away, and each tap is counted for that partner to open later.
 */
export const HomeView: React.FC<HomeViewProps> = ({
  events,
  anniversaryDate,
  eventsLoading,
  eventsError,
  onOpenCalendar,
  userName,
  partnerName,
  partnerOnline = false,
  userWins = 0,
  partnerWins = 0,
  onPlayDailyGame,
  dailyStatus,
  dailyLabel,
  missYou,
}) => {
  // Minute granularity is plenty for a date, and it keeps the tab from re-rendering every second.
  const today = useNow(60_000);

  return (
    <section
      data-screen="home"
      aria-label="Home"
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        padding: '4px 16px 12px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <TodayCard
        today={today}
        events={events}
        anniversaryDate={anniversaryDate}
        loading={eventsLoading}
        error={eventsError}
        onOpenCalendar={onOpenCalendar}
      />

      <DailyGameCard
        userName={userName}
        partnerName={partnerName}
        userWins={userWins}
        partnerWins={partnerWins}
        onPlay={onPlayDailyGame}
        status={dailyStatus}
        playLabel={dailyLabel}
      />

      {/* Cozy living nook — our shared little space. Watch-only, never interactive. */}
      <div
        data-scene-placeholder
        data-area="animated-scene"
        data-nooki-nook="cozy"
        data-partner-online={partnerOnline ? 'true' : 'false'}
        role="region"
        aria-label="Our little nook — watch the Nookis sharing a cozy moment"
        className="nooki-cozy-nook"
        style={{
          flex: '1 1 145px',
          minHeight: '145px',
          width: '100%',
          borderRadius: tokens.radii.lg,
          backgroundColor: '#FFFBF2',
          border: `1px solid ${tokens.colors.borderSubtle}`,
          boxShadow: tokens.shadows.subtle,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          overflow: 'hidden',
          padding: '10px 8px 16px 8px',
        }}
      >
        {/* Subtle floor + vignette — purely decorative, inside the nook */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: '26px',
            background: 'linear-gradient(180deg, rgba(240,232,220,0) 0%, rgba(240,232,220,0.55) 100%)',
            borderTop: '1px solid rgba(240,232,220,0.7)',
            pointerEvents: 'none',
          }}
        />
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(ellipse 85% 70% at 50% 42%, rgba(255,255,255,0.9) 0%, rgba(255,251,242,0) 72%)',
            pointerEvents: 'none',
          }}
        />
        <div
          data-nooki-caption
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: '10px',
            right: '12px',
            zIndex: 2,
            display: 'inline-flex',
            alignItems: 'center',
            padding: '5px 9px',
            borderRadius: tokens.radii.pill,
            backgroundColor: 'rgba(255,255,255,0.82)',
            border: `1px solid ${tokens.colors.borderSubtle}`,
            boxShadow: tokens.shadows.subtle,
            color: tokens.colors.textMuted,
            fontFamily: tokens.typography.fontFamily,
            fontSize: '8.5px',
            fontWeight: 700,
            letterSpacing: '0.7px',
            lineHeight: 1.1,
            textTransform: 'uppercase',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          Our little nook
        </div>
        {/* The one thing in the nook that is clickable: "I miss you", for when the
            partner is away and this phone is the only one in the app. */}
        {missYou && <MissYouButton {...missYou} />}
        <HomeNookiCompanions
          ambient
          partnerOnline={partnerOnline}
          expression={partnerOnline ? 'affectionate' : 'happy'}
        />
      </div>
    </section>
  );
};

export default HomeView;
