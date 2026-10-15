/**
 * Chat date helpers: day separators and bubble timestamps.
 *
 * Pure functions only: no React, no network, no storage. Days are grouped on the
 * reader's own calendar (two phones in different timezones each group what they see),
 * while the stored timestamps stay UTC ISO strings.
 */

export interface MessageDayGroup<T> {
  /** Local `YYYY-MM-DD` for the day. */
  key: string;
  /** "Today", "Yesterday" or "Mon 12 October". */
  label: string;
  messages: T[];
}

const MS_PER_DAY = 86_400_000;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local calendar day of a timestamp, e.g. "2026-10-15". */
export function dayKey(value: Date | string): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** How many whole local days ago that day was: 0 is today, 1 is yesterday. */
export function dayOffset(key: string, now: Date = new Date()): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const then = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today.getTime() - then.getTime()) / MS_PER_DAY);
}

/** "Today", "Yesterday", "Mon 12 October" — the year only when it is a different one. */
export function formatDayLabel(key: string, now: Date = new Date()): string {
  const offset = dayOffset(key, now);
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Yesterday';
  if (offset === null) return key;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)!;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const parts = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).formatToParts(date);
  // Assembled by hand: the locale's own punctuation differs between browsers.
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return [part('weekday'), part('day'), part('month'), part('year')].filter(Boolean).join(' ');
}

/** Bubble timestamp, e.g. "9:41 PM". */
export function formatMessageTime(value: Date | string): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date).replace(/[\u00a0\u202f]/g, ' ');
}

export function isSameDay(a: Date | string, b: Date | string): boolean {
  const first = dayKey(a);
  return Boolean(first) && first === dayKey(b);
}

/**
 * Splits a chat transcript into day sections without reordering it, so the view can
 * drop a separator between "Yesterday" and "Today" as it renders.
 */
export function groupMessagesByDay<T extends { created_at: string }>(
  messages: T[],
  now: Date = new Date(),
): MessageDayGroup<T>[] {
  const groups: MessageDayGroup<T>[] = [];
  for (const message of messages) {
    const key = dayKey(message.created_at);
    const current = groups[groups.length - 1];
    if (current && current.key === key) {
      current.messages.push(message);
    } else {
      groups.push({ key, label: formatDayLabel(key, now), messages: [message] });
    }
  }
  return groups;
}
