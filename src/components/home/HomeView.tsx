import React from 'react';
import { TodayCard } from './TodayCard';
import { useNow } from '../../hooks/useNow';
import type { CoupleEvent } from '../../types/database';

interface HomeViewProps {
  events: CoupleEvent[];
  anniversaryDate: string | null;
  eventsLoading: boolean;
  eventsError: string | null;
  onOpenCalendar: () => void;
}

/**
 * Home tab — the centre tab and the default screen.
 *
 * It shows the Today card: today's date, anything happening today, and what is coming
 * within the next day. Everything else (browsing months, adding and editing events)
 * happens inside the calendar modal, so the tab stays a quick summary.
 */
export const HomeView: React.FC<HomeViewProps> = ({
  events,
  anniversaryDate,
  eventsLoading,
  eventsError,
  onOpenCalendar,
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
      padding: '4px 22px 22px 22px',
      display: 'flex',
      flexDirection: 'column',
      gap: '14px',
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
  </section>
  );
};

export default HomeView;
