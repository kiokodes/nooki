/**
 * "I miss you" transport: the three things a phone does with `miss_you_taps`.
 *
 * Reading is the couple's own rows; every write goes through the database's functions —
 * one counts a tap, the other hands the waiting taps over and resets them in the same
 * step, so nothing can be marked received without having been shown.
 */

import { requireSupabase } from './supabaseClient';
import { describeDatabaseError } from './authService';
import { toDateKey } from './calendar';
import type { MissYouTap } from '../types/database';

/** Rerun before deploying. */
const MISS_YOU_MIGRATION = 'supabase/migrations/202610150016_miss_you.sql';

/** How far back a peek looks. Anything older than this is not worth a heart. */
export const MISS_YOU_HISTORY_DAYS = 14;

/** The `YYYY-MM-DD` key of the day `days` ago, in the reader's own calendar. */
export function dayKeyDaysAgo(days: number, now: Date = new Date()): string {
  // setDate, not an 86 400 000 ms subtraction: a DST weekend is not 24 hours long.
  const date = new Date(now.getTime());
  date.setDate(date.getDate() - days);
  return toDateKey(date);
}

/**
 * A project that has not run the migration answers with no function or no table rather than
 * an error worth showing a partner, so it is named as the missing migration it is.
 */
function isMissingMigration(error: { message: string; code?: string }): boolean {
  return error.code === '42P01'
    || error.code === '42883'
    || /could not find the (function|table)/i.test(error.message)
    || /relation .*miss_you_taps.* does not exist/i.test(error.message);
}

function missingMigration(): Error {
  return new Error(`The database needs an update. Please ask the app owner to apply ${MISS_YOU_MIGRATION}.`);
}

/**
 * Records one tap under the caller's own day and returns how many of their taps the partner
 * has not opened yet — the number on the button.
 */
export async function recordMissYouTap(tapDate: string): Promise<number> {
  const { data, error } = await requireSupabase().rpc('record_miss_you_tap', { p_tap_date: tapDate });
  if (error) {
    // A project that has not run the migration has no function to call at all.
    if (isMissingMigration(error)) throw missingMigration();
    throw new Error(describeDatabaseError(error));
  }
  return typeof data === 'number' ? data : 0;
}

/**
 * The couple's recent taps, both partners'. The caller's own rows give the number on the
 * button; the partner's rows are what the heart is made of.
 */
export async function fetchMissYouTaps(coupleId: string, sinceKey: string): Promise<MissYouTap[]> {
  const { data, error } = await requireSupabase().from('miss_you_taps')
    .select('*')
    .eq('couple_id', coupleId)
    .gte('tap_date', sinceKey)
    .order('tap_date', { ascending: true });
  if (error) {
    if (isMissingMigration(error)) throw missingMigration();
    throw new Error(describeDatabaseError(error));
  }
  return (data ?? []) as MissYouTap[];
}

/**
 * Opens the partner's waiting taps: the database marks them received (the reset) and hands
 * back what was waiting, so the caller can word the message from the same answer.
 */
export async function receiveMissYouTaps(senderId: string): Promise<{ tap_date: string; tap_count: number; newly_delivered: number }[]> {
  const { data, error } = await requireSupabase().rpc('receive_miss_you_taps', { p_sender_id: senderId });
  if (error) {
    if (isMissingMigration(error)) throw missingMigration();
    throw new Error(describeDatabaseError(error));
  }
  return (data ?? []) as { tap_date: string; tap_count: number; newly_delivered: number }[];
}
