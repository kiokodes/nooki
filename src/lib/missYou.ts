/**
 * "I miss you" — the small button in the nook, for the half of the couple sitting in the
 * app alone.
 *
 * Pure functions only: no React, no network, no clock of its own. The database keeps one
 * row per sender per own calendar day (`miss_you_taps`), and everything the screen says —
 * how many taps are waiting, and the sentence the heart carries — is derived here, so the
 * wording can be checked without a phone in someone's hand.
 */

import { toDateKey } from './calendar';
import type { MissYouOpenedTap, MissYouTap } from '../types/database';

export interface MissYouBatch {
  /** Taps the partner has not been shown yet: what the heart is for. */
  count: number;
  /** The whole day's taps for the newest day in the batch, received ones included. */
  dayTotal: number;
  /** Every waiting tap was recorded on the reader's own calendar day. */
  allToday: boolean;
  /** The newest tap day in the batch, so two identical batches on different days differ. */
  lastDate: string;
}

/** The local calendar day key (`YYYY-MM-DD`) a tap is recorded under. */
export function tapDateKey(now: Date = new Date()): string {
  return toDateKey(now);
}

/** Taps still waiting for the partner, out of one sender's rows. */
export function waitingTaps(rows: MissYouTap[]): number {
  return rows.reduce((sum, row) => sum + Math.max(0, row.tap_count - row.delivered_count), 0);
}

/**
 * The batch to draw a heart for, from what `receive_miss_you_taps` handed back — the same
 * answer that marked it received, so the wording and the reset can never disagree. Rows may
 * cover several days (a partner away for a long weekend); the taps are then summed and the
 * wording stops claiming "today" — see `formatMissYouMessage`.
 *
 * Nothing waiting is nothing to open, and the function is only reached when something was.
 */
export function openedBatch(rows: MissYouOpenedTap[], todayKey: string): MissYouBatch | null {
  const waiting = rows.filter((row) => row.newly_delivered > 0);
  if (!waiting.length) return null;

  const newest = waiting.reduce((latest, row) => (row.tap_date > latest ? row.tap_date : latest), waiting[0].tap_date);
  return {
    count: waiting.reduce((sum, row) => sum + row.newly_delivered, 0),
    // Only meaningful while the batch is all one day; the wording never uses it otherwise.
    dayTotal: waiting.reduce((sum, row) => sum + row.tap_count, 0),
    allToday: waiting.every((row) => row.tap_date === todayKey),
    lastDate: newest,
  };
}

/**
 * The sentence under the heart.
 *
 * One tap is a soft hello ("Hi, Ana missed you"); several on the same day are counted
 * ("Ana missed you 4 times today"). When part of the day was already opened earlier, the
 * wait that is left is added up as "more times today", because the count resets the moment
 * the partner receives it. Taps left over from earlier days lose the "today" claim.
 */
export function formatMissYouMessage(senderName: string, batch: MissYouBatch): string {
  const name = (senderName || '').trim() || 'Your partner';
  if (batch.count <= 1) return `Hi, ${name} missed you`;
  if (batch.allToday && batch.count >= batch.dayTotal) return `${name} missed you ${batch.count} times today`;
  if (batch.allToday) return `${name} missed you ${batch.count} more times today`;
  return `${name} missed you ${batch.count} times`;
}
