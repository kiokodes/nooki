/**
 * Epistles — the long, sealed letters a couple writes each other, kept apart from
 * the chat.
 *
 * Pure functions only: no React, no network, no clock of its own. The database keeps
 * the letter (`epistles`), and everything the screen says — what state an envelope is
 * in, how long it still has to wait, the words on the wax, the way a letter is cut
 * into paragraphs for the reading — is derived here, so the wording can be checked
 * without a phone in someone's hand.
 */

import { toDateKey } from './calendar';
import type { Epistle } from '../types/database';

/** The most a letter may carry. Long-form is the point; a book is not. */
export const EPISTLE_BODY_LIMIT = 20_000;
/** The most a letter's name may carry, the same rule the database keeps. */
export const EPISTLE_TITLE_LIMIT = 80;

/**
 * Where a letter stands in its life. `mine`/`theirs` say whose paper it is:
 * a draft and a recalled letter belong to their author alone, a waiting letter
 * stands sealed in the partner's mailbox, and an opened letter is a keepsake
 * for both.
 */
export type EpistleState =
  | 'draft'            // mine: still being written, nobody else can see it
  | 'sealed-unopened'  // theirs, or mine: sealed, wax intact, openable today
  | 'sealed-waiting'   // theirs: sealed for a chosen day that has not come yet
  | 'opened';          // the seal is broken: final, kept, readable by both

/** The letter's own calendar day key (`YYYY-MM-DD`) it was written on. */
export function epistleDateKey(epistle: Pick<Epistle, 'created_at'>, now: Date = new Date()): string {
  const parsed = new Date(epistle.created_at);
  return Number.isNaN(parsed.getTime()) ? toDateKey(now) : toDateKey(parsed);
}

/** True when the letter's chosen day has come (or it never had one). */
export function isEpistleOpenable(
  epistle: Pick<Epistle, 'sealed_at' | 'opens_at'>,
  todayKey: string,
): boolean {
  if (!epistle.sealed_at) return false;
  if (!epistle.opens_at) return true;
  return epistle.opens_at <= todayKey;
}

/**
 * The state of one letter, on one phone's calendar day. A sealed letter with an
 * open-day still ahead is `sealed-waiting` for the partner — they can see it
 * standing there, and the seal refuses until the day.
 */
export function epistleState(
  epistle: Epistle,
  todayKey: string,
): EpistleState {
  if (!epistle.sealed_at) return 'draft';
  if (epistle.opened_at) return 'opened';
  // A still-unopened letter of my own is mine to recall and rework, however long it waits.
  if (!isEpistleOpenable(epistle, todayKey)) return 'sealed-waiting';
  return 'sealed-unopened';
}

/**
 * Whole days from `todayKey` until the letter's open day: 0 when it opens today,
 * 1 for tomorrow, and never negative — a letter whose day passed while nobody
 * was looking is simply ready.
 */
export function daysUntilOpen(opensAt: string, todayKey: string): number {
  if (!opensAt || opensAt <= todayKey) return 0;
  const today = new Date(`${todayKey}T12:00:00`);
  const opens = new Date(`${opensAt}T12:00:00`);
  if (Number.isNaN(today.getTime()) || Number.isNaN(opens.getTime())) return 0;
  return Math.round((opens.getTime() - today.getTime()) / 86_400_000);
}

/**
 * The words an envelope wears while it waits: "Opens today", "Opens tomorrow",
 * "Opens in 3 days", or the date itself once it is more than a week away.
 */
export function formatOpensIn(opensAt: string, todayKey: string): string {
  const days = daysUntilOpen(opensAt, todayKey);
  if (days <= 0) return 'Opens today';
  if (days === 1) return 'Opens tomorrow';
  if (days <= 7) return `Opens in ${days} days`;
  return `Opens ${formatEpistleDate(opensAt)}`;
}

/** The dateline of a letter or envelope: "20 October 2026", in words. */
export function formatEpistleDate(key: string): string {
  const parsed = /^\d{4}-\d{2}-\d{2}/.test(key) ? new Date(`${key.slice(0, 10)}T12:00:00`) : new Date(key);
  if (Number.isNaN(parsed.getTime())) return key;
  return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * A letter's dateline, the way real letters carry one: where it was written,
 * and the day — "Lagos, Nigeria · 20 October 2026". `when` is a `YYYY-MM-DD`
 * day key or an ISO timestamp; the town is left off when nobody saved one.
 */
export function formatDateline(place: string | null | undefined, when: string): string {
  const day = formatEpistleDate(when);
  const town = (place ?? '').trim();
  return town ? `${town} · ${day}` : day;
}

/** The wax carries the writer's initial, the way a signet does. */
export function waxInitial(name: string | null | undefined): string {
  const first = (name ?? '').trim().charAt(0).toUpperCase();
  return first || '♥';
}

/** How many whole words the letter carries — the honest counter on the writing desk. */
export function countWords(body: string): number {
  const trimmed = body.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * A letter is cut for the reading on blank lines: one blank line starts a new
 * paragraph, a single line break is only the writer's wrap. Empty paragraphs
 * disappear; the reading never shows a hole.
 */
export function letterParagraphs(body: string): string[] {
  return body
    .split(/\n(?:\s*\n)+/)
    .map((paragraph) => paragraph.replace(/\s+\n/g, '\n').trim())
    .filter((paragraph) => paragraph.length > 0);
}

export interface EpistleSections {
  /** The partner's letters whose seal can be broken today: the mailbox's number. */
  unopened: Epistle[];
  /** The partner's letters still waiting for their chosen day: anticipation, not a task. */
  waiting: Epistle[];
  /** My letters standing in their mailbox, still unopened. */
  mine: Epistle[];
  /** The letters already opened — the keepsakes, newest first. */
  keepsakes: Epistle[];
  /** My unfinished drafts, newest first. */
  drafts: Epistle[];
}

/**
 * One sort for the whole mailbox: newest first, by the moment the letter began —
 * a draft from today stands above a keepsake from last spring only if it was
 * written after it. (`created_at`, not `sealed_at`: a recalled and resealed
 * letter keeps its first place, which is the letter's own.)
 */
export function sortEpistlesNewestFirst(rows: Epistle[]): Epistle[] {
  return [...rows].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

/**
 * The whole mailbox, sorted into the shelves it shows. `todayKey` is this phone's
 * own calendar day — "waiting" is judged where the reader stands, and the
 * database has the final word when the seal is actually broken.
 */
export function sectionEpistles(rows: Epistle[], userId: string, todayKey: string): EpistleSections {
  const mine: Epistle[] = [];
  const unopened: Epistle[] = [];
  const waiting: Epistle[] = [];
  const keepsakes: Epistle[] = [];
  const drafts: Epistle[] = [];

  for (const epistle of sortEpistlesNewestFirst(rows)) {
    if (epistle.sender_id === userId) {
      if (!epistle.sealed_at) drafts.push(epistle);
      else if (epistle.opened_at) keepsakes.push(epistle);
      else mine.push(epistle);
    } else if (!epistle.sealed_at) {
      // Unreachable under the database's rules — a partner's draft is never sent
      // to this phone — but a stray one is nobody's business, so it is dropped.
      continue;
    } else if (epistle.opened_at) {
      keepsakes.push(epistle);
    } else if (isEpistleOpenable(epistle, todayKey)) {
      unopened.push(epistle);
    } else {
      waiting.push(epistle);
    }
  }

  return { unopened, waiting, mine, keepsakes, drafts };
}

/** The envelope's accessible name, so a screen reader reads the letter, not the box. */
export function epistleAriaLabel(epistle: Epistle, senderName: string, state: EpistleState): string {
  const who = (senderName || '').trim() || 'Your partner';
  const title = epistle.title?.trim() ? `, “${epistle.title.trim()}”` : '';
  switch (state) {
    case 'draft': return `Draft letter${title} — continue writing`;
    case 'sealed-unopened': return `Sealed letter from ${who}${title} — tap to break the seal`;
    case 'sealed-waiting': return `A letter from ${who}${title} — sealed until its day`;
    case 'opened': return `Letter from ${who}${title} — read again`;
  }
}

/**
 * Trim a letter the way the database will accept it: a name without edges, a body
 * that is something rather than nothing. Returns null when there is no letter yet,
 * so the writing desk knows not to save.
 */
export function cleanEpistleDraft(title: string, body: string): { title: string | null; body: string } | null {
  const cleanTitle = title.trim().slice(0, EPISTLE_TITLE_LIMIT);
  const cleanBody = body.trim().slice(0, EPISTLE_BODY_LIMIT);
  if (!cleanBody) return null;
  return { title: cleanTitle || null, body: cleanBody };
}
