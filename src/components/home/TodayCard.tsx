import React from 'react';
import { CalendarDays, Heart } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import {
  formatLongDate,
  formatShortDate,
  getItemsForDate,
  getUpcomingGroups,
  toDateKey,
  type CalendarItem,
} from '../../lib/calendar';
import type { CoupleEvent } from '../../types/database';

/** How far ahead the card looks for "upcoming" items, in days. */
export const UPCOMING_WINDOW_DAYS = 1;

interface TodayCardProps {
  /** Live "today", so the card rolls over at midnight with the header. */
  today: Date;
  events: CoupleEvent[];
  anniversaryDate: string | null;
  loading?: boolean;
  error?: string | null;
  onOpenCalendar: () => void;
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '8px',
  padding: '4px 0',
};

/** Automatic dates (anniversary, monthsary) get a soft heart; events get a tiny dot. */
const Marker: React.FC<{ item: CalendarItem }> = ({ item }) => {
  if (item.kind === 'event') {
    return (
      <span
        aria-hidden="true"
        style={{
          width: '6px',
          height: '6px',
          marginTop: '6px',
          borderRadius: tokens.radii.full,
          backgroundColor: tokens.colors.primaryGreenDeep,
          flexShrink: 0,
        }}
      />
    );
  }
  return (
    <Heart
      aria-hidden="true"
      size={12}
      fill={item.kind === 'anniversary' ? tokens.colors.primaryPink : 'none'}
      color={tokens.colors.primaryPinkDeep}
      style={{ marginTop: '4px', flexShrink: 0 }}
      strokeWidth={2}
    />
  );
};

const ItemRow: React.FC<{ item: CalendarItem }> = ({ item }) => (
  <li style={rowStyle}>
    <Marker item={item} />
    <span style={{ minWidth: 0 }}>
      <span style={{ fontSize: '0.84rem', fontWeight: 600, color: tokens.colors.textPrimary, wordBreak: 'break-word' }}>
        {item.title}
      </span>
      {item.detail && (
        <span style={{ display: 'block', fontSize: '0.71rem', color: tokens.colors.textMuted }}>
          {item.detail}
        </span>
      )}
    </span>
  </li>
);

/**
 * The Today card: today's date, whatever is happening today, and what is coming within
 * the next day. The full calendar lives behind the calendar button in the corner.
 */
export const TodayCard: React.FC<TodayCardProps> = ({
  today,
  events,
  anniversaryDate,
  loading,
  error,
  onOpenCalendar,
}) => {
  const todayKey = toDateKey(today);
  const todayItems = getItemsForDate(todayKey, events, anniversaryDate);
  const upcoming = getUpcomingGroups(today, UPCOMING_WINDOW_DAYS, events, anniversaryDate);
  const hasAnything = todayItems.length > 0 || upcoming.length > 0;

  return (
    <section
      data-card="today"
      style={{
        backgroundColor: tokens.colors.bgSurface,
        borderRadius: tokens.radii.lg,
        boxShadow: tokens.shadows.card,
        padding: '14px 16px 12px 16px',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
        <div style={{ minWidth: 0 }}>
          <span
            style={{
              fontSize: '0.64rem',
              fontWeight: 700,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: tokens.colors.textMuted,
            }}
          >
            Today
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
            {formatLongDate(todayKey)}
          </h2>
        </div>

        <button
          type="button"
          onClick={onOpenCalendar}
          aria-label="View calendar"
          title="View calendar"
          style={{
            width: '32px',
            height: '32px',
            borderRadius: tokens.radii.full,
            backgroundColor: tokens.colors.primaryPinkSoft,
            border: 'none',
            color: tokens.colors.primaryPinkDeep,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <CalendarDays size={16} strokeWidth={2.2} />
        </button>
      </div>

      {error && (
        <p role="alert" style={{ margin: '8px 0 0 0', fontSize: '0.75rem', color: '#DC2626' }}>
          {error}
        </p>
      )}

      {!error && loading && (
        <p style={{ margin: '8px 0 0 0', fontSize: '0.76rem', color: tokens.colors.textMuted }}>
          Loading your dates…
        </p>
      )}

      {!error && !loading && (
        <div style={{ marginTop: '6px' }}>
          {todayItems.length > 0 ? (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-today-items>
              {todayItems.map((item) => <ItemRow key={item.id} item={item} />)}
            </ul>
          ) : (
            <p style={{ margin: '2px 0 0 0', fontSize: '0.77rem', color: tokens.colors.textMuted }} data-today-empty>
              Nothing on today — a quiet one, just the two of you.
            </p>
          )}

          {/* Upcoming is visually separated and quieter, so today always reads first. */}
          {upcoming.length > 0 && (
            <div
              data-upcoming
              style={{
                marginTop: '8px',
                paddingTop: '8px',
                borderTop: `1px solid ${tokens.colors.borderSubtle}`,
              }}
            >
              <span
                style={{
                  fontSize: '0.64rem',
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  color: tokens.colors.textMuted,
                }}
              >
                {upcoming.length === 1 && upcoming[0].daysAway === 1 ? 'Tomorrow' : `Next ${UPCOMING_WINDOW_DAYS} days`}
              </span>
              {upcoming.map((group) => (
                <ul key={group.date} style={{ listStyle: 'none', margin: '1px 0 0 0', padding: 0 }}>
                  {upcoming.length > 1 && group.daysAway !== 1 && (
                    <li style={{ fontSize: '0.68rem', color: tokens.colors.textMuted, paddingTop: '2px' }}>
                      {formatShortDate(group.date)}
                    </li>
                  )}
                  {group.items.map((item) => (
                    <li key={item.id} style={{ ...rowStyle, opacity: 0.92 }}>
                      <Marker item={item} />
                      <span style={{ minWidth: 0 }}>
                        <span style={{ fontSize: '0.81rem', fontWeight: 600, color: tokens.colors.textSecondary }}>
                          {item.title}
                        </span>
                        {item.detail && (
                          <span style={{ display: 'block', fontSize: '0.7rem', color: tokens.colors.textMuted }}>
                            {item.detail}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              ))}
            </div>
          )}

          {!hasAnything && (
            <button
              type="button"
              onClick={onOpenCalendar}
              style={{
                marginTop: '6px',
                padding: 0,
                background: 'none',
                border: 'none',
                color: tokens.colors.primaryPinkDeep,
                fontSize: '0.75rem',
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: tokens.typography.fontFamily,
              }}
            >
              Add a date to your calendar
            </button>
          )}
        </div>
      )}
    </section>
  );
};

export default TodayCard;
