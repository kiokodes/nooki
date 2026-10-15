/**
 * Calendar and recurrence rules for the Today card and the full calendar.
 *
 * Pure functions only: no React, no network, no "now" of its own. Everything is derived
 * from the couple's anniversary and their `couple_events` rows, so both partners always
 * see the same picture.
 */

import { daysInMonth, parseIsoDate, type CalendarDate } from './coupleTime';
import type { CoupleEvent } from '../types/database';

export type CalendarItemKind = 'anniversary' | 'monthsary' | 'event';

export interface CalendarItem {
  /** Stable key for React lists: event id, or a derived key for automatic dates. */
  id: string;
  kind: CalendarItemKind;
  title: string;
  /** Quiet second line, e.g. "73 months together". */
  detail?: string;
  /** The date this item actually falls on (repeating events resolve to an occurrence). */
  date: string;
  /** Present for user events so they can be edited or deleted. */
  event?: CoupleEvent;
}

const MS_PER_DAY = 86_400_000;

/** Local calendar date of a JS Date as `YYYY-MM-DD` (no timezone conversion). */
export function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function toOrdinal(key: string): number {
  const date = parseIsoDate(key);
  return date ? Math.round(Date.UTC(date.year, date.month - 1, date.day) / MS_PER_DAY) : Number.NaN;
}

/** Shifts a year/month pair by whole months, rolling the year over as needed. */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + delta;
  const nextYear = Math.floor(total / 12);
  return { year: nextYear, month: total - nextYear * 12 + 1 };
}

/** A day inside a short month reads as that month's last day instead of overflowing. */
export function clampDay(year: number, month: number, day: number): number {
  return Math.min(day, daysInMonth(year, month));
}

/**
 * Weeks of date keys for a month, Monday first. The grid is padded with the neighbouring
 * months' days so the first and last weeks are always complete.
 */
export function getMonthGrid(year: number, month: number): string[][] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  // getUTCDay(): 0 = Sunday. Shift so Monday is 0.
  const leading = (first.getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(year, month - 1, 1 - leading));

  const totalDays = daysInMonth(year, month);
  const weeks = Math.ceil((leading + totalDays) / 7);
  const grid: string[][] = [];
  for (let week = 0; week < weeks; week += 1) {
    const row: string[] = [];
    for (let day = 0; day < 7; day += 1) {
      const cell = new Date(start.getTime() + (week * 7 + day) * MS_PER_DAY);
      row.push(`${cell.getUTCFullYear()}-${String(cell.getUTCMonth() + 1).padStart(2, '0')}-${String(cell.getUTCDate()).padStart(2, '0')}`);
    }
    grid.push(row);
  }
  return grid;
}

export function isSameMonth(key: string, year: number, month: number): boolean {
  const date = parseIsoDate(key);
  return Boolean(date && date.year === year && date.month === month);
}

/** Month name plus year for the calendar header, e.g. "October 2026". */
export function formatMonthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, 1)));
}

export function formatMonthShort(month: number): string {
  return new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(2026, month - 1, 1)));
}

/** "Thursday, 15 October" — the Today card's headline. */
export function formatLongDate(key: string): string {
  const date = parseIsoDate(key);
  if (!date) return '';
  const at = new Date(Date.UTC(date.year, date.month - 1, date.day));
  const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(at);
  const dayAndMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(at);
  return `${weekday}, ${dayAndMonth}`;
}

/** "15 Oct" — compact labels inside lists. */
export function formatShortDate(key: string): string {
  const date = parseIsoDate(key);
  if (!date) return '';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(date.year, date.month - 1, date.day)));
}

export function addDaysToKey(key: string, days: number): string {
  const date = parseIsoDate(key);
  if (!date) return key;
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * MS_PER_DAY);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function wholeMonthsBetween(from: CalendarDate, to: CalendarDate): number {
  let months = (to.year - from.year) * 12 + (to.month - from.month);
  const clamped = { year: from.year, month: from.month, day: from.day };
  // Count a month only once its day has been reached.
  const total = clamped.year * 12 + (clamped.month - 1) + months;
  const shiftedYear = Math.floor(total / 12);
  const shiftedMonth = total - shiftedYear * 12 + 1;
  const shiftedDay = Math.min(clamped.day, daysInMonth(shiftedYear, shiftedMonth));
  if (to.day < shiftedDay) months -= 1;
  return Math.max(0, months);
}

/**
 * Everything that lands on one calendar day: the couple's anniversary, their monthsary,
 * and any user events (including yearly repeats, which fall on the same day each year).
 */
export function getItemsForDate(
  dateKey: string,
  events: CoupleEvent[],
  anniversaryDate: string | null | undefined,
): CalendarItem[] {
  const day = parseIsoDate(dateKey);
  if (!day) return [];
  const items: CalendarItem[] = [];
  const anniversary = parseIsoDate(anniversaryDate);

  if (anniversary) {
    // A short month borrows the anniversary's day rather than overflowing.
    const anniversaryDay = clampDay(day.year, anniversary.month, anniversary.day);
    const isAnniversaryDay = day.year >= anniversary.year && day.month === anniversary.month && day.day === anniversaryDay;

    if (isAnniversaryDay) {
      const years = day.year - anniversary.year;
      items.push({
        id: `anniversary:${dateKey}`,
        kind: 'anniversary',
        title: 'Anniversary',
        detail: years === 0 ? 'the day it all started' : `${years} ${years === 1 ? 'year' : 'years'} together`,
        date: dateKey,
      });
    } else if (dateKey > (anniversaryDate as string)) {
      const monthsaryDay = clampDay(day.year, day.month, anniversary.day);
      if (day.day === monthsaryDay) {
        const months = wholeMonthsBetween(anniversary, day);
        if (months >= 12 && months % 12 === 0) {
          // Twelve months on from the anniversary is another anniversary, not a monthsary.
          items.push({
            id: `anniversary:${dateKey}`,
            kind: 'anniversary',
            title: 'Anniversary',
            detail: `${months / 12} years together`,
            date: dateKey,
          });
        } else if (months > 0) {
          items.push({
            id: `monthsary:${dateKey}`,
            kind: 'monthsary',
            title: 'Monthsary',
            detail: `${months} months together`,
            date: dateKey,
          });
        }
      }
    }
  }

  for (const event of events) {
    const start = parseIsoDate(event.event_date);
    if (!start) continue;
    const occurs = event.repeats_yearly
      // A yearly repeat can never fall before the date it was created for; Feb 29 borrows Feb 28.
      ? dateKey >= event.event_date && day.month === start.month && day.day === clampDay(day.year, start.month, start.day)
      : dateKey === event.event_date;
    if (!occurs) continue;
    items.push({
      id: event.id,
      kind: 'event',
      title: event.title,
      detail: event.repeats_yearly ? 'every year' : undefined,
      date: dateKey,
      event,
    });
  }

  return items;
}

export interface DayGroup {
  date: string;
  items: CalendarItem[];
  /** 1 = tomorrow, 2 = in two days, ... */
  daysAway: number;
}

/**
 * Items for the days *after* `fromDate`, up to and including `days` ahead. Today itself is
 * excluded so the Today card can show "today" and "upcoming" as two distinct states.
 */
export function getUpcomingGroups(
  fromDate: Date,
  days: number,
  events: CoupleEvent[],
  anniversaryDate: string | null | undefined,
): DayGroup[] {
  const fromKey = toDateKey(fromDate);
  const groups: DayGroup[] = [];
  for (let offset = 1; offset <= days; offset += 1) {
    const date = addDaysToKey(fromKey, offset);
    const items = getItemsForDate(date, events, anniversaryDate);
    if (items.length) groups.push({ date, items, daysAway: offset });
  }
  return groups;
}

/** Dates in a month that have something on them, for the calendar's dot markers. */
export function getMonthItems(
  year: number,
  month: number,
  events: CoupleEvent[],
  anniversaryDate: string | null | undefined,
): Map<string, CalendarItem[]> {
  const map = new Map<string, CalendarItem[]>();
  for (const week of getMonthGrid(year, month)) {
    for (const dateKey of week) {
      const items = getItemsForDate(dateKey, events, anniversaryDate);
      if (items.length) map.set(dateKey, items);
    }
  }
  return map;
}

/** -1 = previous month, 1 = next month, 0 = not a deliberate horizontal swipe. */
export function getSwipeDirection(deltaX: number, deltaY: number, threshold = 45): -1 | 0 | 1 {
  if (Math.abs(deltaX) < threshold) return 0;
  if (Math.abs(deltaX) <= Math.abs(deltaY)) return 0;
  return deltaX < 0 ? 1 : -1;
}
