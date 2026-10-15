import React from 'react';
import { TodayCard } from './TodayCard';
import { DailyGameCard } from './DailyGameCard';
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
  userWins?: number;
  partnerWins?: number;
  onPlayDailyGame?: () => void;
}

/**
 * Home tab — the centre tab and the default screen.
 *
 * It shows:
 * - The Today card: today's date, anything happening today, and what is coming within the next day.
 * - The Daily game card: a placeholder "Today's challenge" card with a play button and a
 *   scoreboard showing wins for each partner (0 to 0 for now).
 * - An empty rounded area at the bottom of the screen, reserved for a future animated scene.
 */
export const HomeView: React.FC<HomeViewProps> = ({
  events,
  anniversaryDate,
  eventsLoading,
  eventsError,
  onOpenCalendar,
  userName,
  partnerName,
  userWins = 0,
  partnerWins = 0,
  onPlayDailyGame,
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
      />

      {/* Empty rounded area at the bottom of the screen, reserved for a future animated scene */}
      <div
        data-scene-placeholder
        data-area="animated-scene"
        role="region"
        aria-label="Reserved for future animated scene"
        style={{
          flex: '1 1 80px',
          minHeight: '80px',
          width: '100%',
          borderRadius: tokens.radii.lg,
          backgroundColor: tokens.colors.bgSurfaceSubtle,
          border: `1.5px dashed ${tokens.colors.borderSoft}`,
          boxShadow: tokens.shadows.subtle,
        }}
      />
    </section>
  );
};

export default HomeView;
