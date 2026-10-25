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
 * How many characters a letter holds, counted the way the database counts them.
 * `char_length` counts code points, so an emoji is one character; JavaScript's `.length`
 * counts UTF-16 units and says two. The desk and the table's CHECK must agree, or a letter
 * of emoji is cut short on the phone before the database ever sees it.
 */
export function epistleCharCount(text: string): number {
  return [...text].length;
}

/** How many characters past the limit a letter runs: 0 while it still fits. */
export function epistleOverflow(body: string): number {
  return Math.max(0, epistleCharCount(body.trim()) - EPISTLE_BODY_LIMIT);
}

/**
 * The sentence the desk shows when a letter is too long. It says what happened plainly:
 * nothing was cut, nothing was sent, and shortening it is all it takes.
 */
export function epistleOverflowMessage(overflow: number): string {
  return `A letter holds up to ${EPISTLE_BODY_LIMIT.toLocaleString('en-US')} characters, and this one is `
    + `${overflow.toLocaleString('en-US')} past that. Nothing was cut from what you wrote — shorten it and it will save.`;
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

/**
 * The keepsakes, sorted into the two directions a mailbox tab shows: the letters
 * received from the partner, and the letters sent to them. Order within each side
 * is untouched — newest first, as they arrived.
 */
export function splitKeepsakes(
  keepsakes: Epistle[],
  userId: string,
): { received: Epistle[]; sent: Epistle[] } {
  const received: Epistle[] = [];
  const sent: Epistle[] = [];
  for (const letter of keepsakes) {
    (letter.sender_id === userId ? sent : received).push(letter);
  }
  return { received, sent };
}

/**
 * True when the letter's words may be shown on this phone: one's own letters always
 * (even unsealed drafts of them), the partner's only once the seal is broken. An
 * openable-but-unopened letter answers false on purpose — its words wait for the
 * ceremony, never for a quiet read.
 */
export function isEpistleReadable(
  epistle: Pick<Epistle, 'sender_id' | 'opened_at'>,
  userId: string,
): boolean {
  if (epistle.sender_id === userId) return true;
  return epistle.opened_at !== null;
}

/**
 * The name a reply starts life with: the answered letter's name, prefixed once. An
 * answer to an answer keeps the single prefix — a correspondence is not a nest of
 * ever-deeper names.
 */
export function replySubject(parentTitle: string | null | undefined): string {
  const clean = (parentTitle ?? '').trim();
  if (!clean) return '';
  return /^re:/i.test(clean) ? clean : `Re: ${clean}`;
}

/** The answered letter, looked up among the letters this phone may see. */
export function replyParent(
  letter: Pick<Epistle, 'reply_to_id'>,
  byId: Map<string, Epistle>,
): Epistle | null {
  if (!letter.reply_to_id) return null;
  return byId.get(letter.reply_to_id) ?? null;
}

/**
 * The correspondence behind a letter, oldest first: the answered letter, the letter
 * it answered, and so on back to the one that started it all. A cycle (which the
 * database's self-reply rule makes near-impossible) simply ends the walk instead of
 * looping forever.
 */
export function replyAncestors(letter: Epistle, byId: Map<string, Epistle>): Epistle[] {
  const chain: Epistle[] = [];
  const seen = new Set<string>([letter.id]);
  let current = replyParent(letter, byId);
  while (current && !seen.has(current.id)) {
    chain.unshift(current);
    seen.add(current.id);
    current = replyParent(current, byId);
  }
  return chain;
}

/**
 * Every letter that answers this one, directly or further down the chain, newest
 * first — so the first of them is always the latest word on the subject.
 */
export function replyDescendants(letterId: string, rows: Epistle[]): Epistle[] {
  const children = new Map<string, Epistle[]>();
  for (const row of rows) {
    if (!row.reply_to_id) continue;
    const list = children.get(row.reply_to_id) ?? [];
    list.push(row);
    children.set(row.reply_to_id, list);
  }
  const found: Epistle[] = [];
  const queue = [...(children.get(letterId) ?? [])];
  const seen = new Set<string>([letterId]);
  while (queue.length > 0) {
    const next = queue.shift() as Epistle;
    if (seen.has(next.id)) continue;
    seen.add(next.id);
    found.push(next);
    queue.push(...(children.get(next.id) ?? []));
  }
  return sortEpistlesNewestFirst(found);
}

/**
 * How many letters the whole correspondence holds, this one included: the letters
 * behind it plus every answer beneath the one that started it all.
 */
export function threadSize(letter: Epistle, rows: Epistle[], byId?: Map<string, Epistle>): number {
  const map = byId ?? new Map(rows.map((row) => [row.id, row]));
  const ancestors = replyAncestors(letter, map);
  const root = ancestors.length > 0 ? ancestors[0] : letter;
  return 1 + replyDescendants(root.id, rows).length;
}

/**
 * The first line or two of a letter, flattened for reply banners and thread lists:
 * newlines become spaces, overlong thoughts end in an ellipsis.
 */
export function letterExcerpt(body: string, maxLength = 90): string {
  const first = letterParagraphs(body)[0] ?? '';
  const flat = first.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLength) return flat;
  return `${flat.slice(0, maxLength - 1).trimEnd()}…`;
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
  // Titles are names, not prose: an over-long one is trimmed to the allowed length.
  const cleanTitle = [...title.trim()].slice(0, EPISTLE_TITLE_LIMIT).join('');
  // The letter itself is never cut down to size. A body past the limit is handed back
  // whole so the desk can say how far past it is, and the callers refuse to save it; a
  // quietly shortened letter would be words the writer never agreed to lose.
  const cleanBody = body.trim();
  if (!cleanBody) return null;
  return { title: cleanTitle || null, body: cleanBody };
}
