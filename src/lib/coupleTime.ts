/**
 * Calendar and clock helpers for the Home tab.
 *
 * Pure functions only: no React, no network, no storage. Calendar maths uses UTC
 * ordinals so daylight-saving shifts can never turn a duration into 0 days or 32.
 */

export interface CalendarDate {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
}

export interface TogetherDuration {
  years: number;
  months: number;
  days: number;
  /** The anniversary is still in the future: `days` counts down to it instead. */
  isFuture: boolean;
}

export interface PartnerClock {
  /** Local wall clock for the partner, e.g. "5:14 PM". */
  time: string;
  /** Short weekday in the partner's timezone, e.g. "Tue". */
  weekday: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function cachedFormatter(key: string, build: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  const existing = dateFormatterCache.get(key);
  if (existing) return existing;
  const formatter = build();
  dateFormatterCache.set(key, formatter);
  return formatter;
}

export function daysInMonth(year: number, month: number): number {
  // Month is 1-12; day 0 of the next UTC month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function toOrdinal(date: CalendarDate): number {
  return Math.round(Date.UTC(date.year, date.month - 1, date.day) / MS_PER_DAY);
}

function addMonths(date: CalendarDate, months: number): CalendarDate {
  const total = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  // A 31st anniversary reads as the 28th/29th/30th in shorter months instead of jumping forward.
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
}

/** Parses a plain `YYYY-MM-DD` date without timezone conversion. */
export function parseIsoDate(value: string | null | undefined): CalendarDate | null {
  if (!value) return null;
  const match = ISO_DATE.exec(value.trim());
  if (!match) return null;
  const parsed: CalendarDate = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (parsed.month < 1 || parsed.month > 12) return null;
  if (parsed.day < 1 || parsed.day > daysInMonth(parsed.year, parsed.month)) return null;
  return parsed;
}

/**
 * Whole calendar years, months and days between the anniversary and `now`.
 * `now` is compared on the viewer's own calendar day, which is what a person counting
 * "2 years, 1 month, 4 days" expects to see on their phone.
 */
export function getTogetherDuration(anniversary: string | null | undefined, now: Date = new Date()): TogetherDuration {
  const start = parseIsoDate(anniversary);
  if (!start) return { years: 0, months: 0, days: 0, isFuture: false };

  const end = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  const startOrdinal = toOrdinal(start);
  const endOrdinal = toOrdinal(end);

  if (endOrdinal < startOrdinal) {
    return { years: 0, months: 0, days: startOrdinal - endOrdinal, isFuture: true };
  }

  let months = (end.year - start.year) * 12 + (end.month - start.month);
  if (toOrdinal(addMonths(start, months)) > endOrdinal) months -= 1;
  const days = endOrdinal - toOrdinal(addMonths(start, months));

  return { years: Math.floor(months / 12), months: months % 12, days, isFuture: false };
}

/** Compact readout used on the Home tab: "2Y 1M 4D". */
export function formatTogetherDuration(duration: TogetherDuration): string {
  return `${duration.years}Y ${duration.months}M ${duration.days}D`;
}

/**
 * The partner's current wall-clock time and weekday in their own timezone, or `null`
 * when their timezone is missing or not understood by this browser (legacy rows can
 * hold anything).
 */
export function getPartnerClock(timezone: string | null | undefined, now: Date = new Date()): PartnerClock | null {
  if (!timezone) return null;
  try {
    const time = cachedFormatter(`time:${timezone}`, () => new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })).format(now)
      // Some ICU builds separate "PM" with a narrow no-break space; keep one plain space everywhere.
      .replace(/[\u00a0\u202f]/g, ' ');

    const weekday = cachedFormatter(`weekday:${timezone}`, () => new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
    })).format(now);

    return { time, weekday };
  } catch {
    // Unknown/unsupported timezone: callers degrade to a quiet sentence instead of crashing.
    return null;
  }
}

/** Compact header readout: "5:14 PM Tue". */
export function formatPartnerClock(clock: PartnerClock): string {
  return `${clock.time} ${clock.weekday}`;
}

/** "Online", "Last seen 5m ago", "Last seen 3d ago", "Last seen 5 Oct". */
export function formatLastSeen(lastSeenAt: string | Date | null | undefined, now: Date = new Date()): string {
  const seen = lastSeenAt instanceof Date ? lastSeenAt : lastSeenAt ? new Date(lastSeenAt) : null;
  if (!seen || Number.isNaN(seen.getTime())) return 'Offline';

  const seconds = Math.floor((now.getTime() - seen.getTime()) / 1000);
  if (seconds < 60) return 'Last seen just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Last seen ${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last seen ${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `Last seen ${days}d ago`;

  const sameYear = seen.getFullYear() === now.getFullYear();
  const date = new Intl.DateTimeFormat('en-GB', sameYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' }).format(seen);
  return `Last seen ${date}`;
}


/** "Sam" -> "S". Used for the compact header and avatars. */
export function getInitial(name: string | null | undefined): string {
  const trimmed = (name || '').trim();
  return trimmed ? trimmed[0].toUpperCase() : '?';
}
