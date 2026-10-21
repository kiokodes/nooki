/**
 * Epistles transport: the things a phone does with `epistles`.
 *
 * Reading and everyday writing are the couple's own rows under the table's policies:
 * an author drafts, reworks, recalls and discards their own unopened letters, and
 * both partners read every sealed letter in their couple. The one write the partner
 * ever makes — breaking the seal — goes through the database's `open_epistle`, so
 * "is it the day yet?" is answered by the server's clock, not this phone's.
 */

import { requireSupabase } from './supabaseClient';
import { describeDatabaseError } from './authService';
import type { Epistle } from '../types/database';

/** Rerun before deploying. */
const EPISTLES_MIGRATION = 'supabase/migrations/202610200001_epistles.sql';
/** Rerun before deploying replies. */
const EPISTLE_REPLIES_MIGRATION = 'supabase/migrations/202610210001_epistle_replies.sql';

/**
 * A project that has not run the migration answers with no function or no table rather
 * than an error worth showing a partner, so it is named as the missing migration it is.
 */
function isMissingMigration(error: { message: string; code?: string }): boolean {
  return error.code === '42P01'
    || error.code === '42883'
    || /could not find the (function|table)/i.test(error.message)
    || /relation .*epistles.* does not exist/i.test(error.message)
    || /relation .*open_epistle.* does not exist/i.test(error.message);
}

function missingMigration(): Error {
  return new Error(`The database needs an update. Please ask the app owner to apply ${EPISTLES_MIGRATION}.`);
}

/**
 * A project that ran the letters migration but not the replies one answers a reply
 * with an unknown column rather than an error worth showing, so it is named as the
 * missing migration it is.
 */
function isMissingRepliesMigration(error: { message: string; code?: string }): boolean {
  return error.code === '42703' && /reply_to_id/i.test(error.message);
}

function missingRepliesMigration(): Error {
  return new Error(`The database needs an update. Please ask the app owner to apply ${EPISTLE_REPLIES_MIGRATION}.`);
}

function throwDescribed(error: { message: string; code?: string }): never {
  if (isMissingMigration(error)) throw missingMigration();
  throw new Error(describeDatabaseError(error));
}

/** The couple's letters: both partners' sealed letters and this phone's own drafts. */
export async function fetchEpistles(coupleId: string): Promise<Epistle[]> {
  const { data, error } = await requireSupabase().from('epistles')
    .select('*')
    .eq('couple_id', coupleId)
    .order('created_at', { ascending: false });
  if (error) throwDescribed(error);
  return (data ?? []) as Epistle[];
}

export interface EpistleDraftInput {
  title: string | null;
  body: string;
  /**
   * The answered letter's id. Left out while the letter starts its own
   * correspondence — and on a save, `undefined` leaves the link untouched while
   * `null` clears it back to a letter of its own.
   */
  replyToId?: string | null;
}

/** Starts a letter as a draft — the author's alone until it is sealed. */
export async function createEpistleDraft(coupleId: string, senderId: string, { title, body, replyToId }: EpistleDraftInput): Promise<Epistle> {
  const { data, error } = await requireSupabase().from('epistles')
    .insert({
      couple_id: coupleId,
      sender_id: senderId,
      title: title || null,
      body,
      // Named only for actual replies, so a project without the replies migration
      // keeps accepting ordinary letters and fails loudly only on a reply.
      ...(replyToId ? { reply_to_id: replyToId } : {}),
    })
    .select()
    .single();
  if (error) {
    if (isMissingRepliesMigration(error)) throw missingRepliesMigration();
    throwDescribed(error);
  }
  return data as Epistle;
}

/** Saves a draft's words. Only the author, and only while it is still theirs. */
export async function saveEpistleDraft(id: string, { title, body, replyToId }: EpistleDraftInput): Promise<Epistle> {
  const { data, error } = await requireSupabase().from('epistles')
    .update({
      title: title || null,
      body,
      ...(replyToId !== undefined ? { reply_to_id: replyToId } : {}),
    })
    .eq('id', id)
    .select()
    .single();
  if (error) {
    if (isMissingRepliesMigration(error)) throw missingRepliesMigration();
    throwDescribed(error);
  }
  return data as Epistle;
}

/**
 * Seals the letter and sends it on its way. `opensAt` is the calendar day before
 * which the partner's seal refuses to break — null for "as soon as they like".
 */
export async function sealEpistle(id: string, opensAt: string | null): Promise<Epistle> {
  const { data, error } = await requireSupabase().from('epistles')
    .update({ sealed_at: new Date().toISOString(), opens_at: opensAt })
    .eq('id', id)
    .select()
    .single();
  if (error) throwDescribed(error);
  return data as Epistle;
}

/**
 * Takes a still-unopened letter back off the mantelpiece and turns it back into a
 * draft: the wax is lifted, the open day is forgotten, the words stay. Once the
 * partner has broken the seal this refuses — a read letter is final.
 */
export async function recallEpistle(id: string): Promise<Epistle> {
  const { data, error } = await requireSupabase().from('epistles')
    .update({ sealed_at: null, opens_at: null })
    .eq('id', id)
    .select()
    .single();
  if (error) throwDescribed(error);
  return data as Epistle;
}

/** Discards a draft. A sealed letter is a keepsake and cannot be deleted. */
export async function deleteEpistleDraft(id: string): Promise<void> {
  const { error } = await requireSupabase().from('epistles')
    .delete()
    .eq('id', id);
  if (error) throwDescribed(error);
}

/**
 * Breaks the seal: the one letter-opening the database performs itself, so a
 * scheduled letter cannot be opened early by naming a different day. Returns the
 * letter as the database now holds it.
 */
export async function openEpistle(id: string): Promise<Epistle> {
  const { data, error } = await requireSupabase().rpc('open_epistle', { p_epistle_id: id });
  if (error) {
    if (isMissingMigration(error)) throw missingMigration();
    throw new Error(describeDatabaseError(error));
  }
  // A set-returning function hands back a list with the one letter in it.
  const letter = Array.isArray(data) ? data[0] : data;
  if (!letter) throw new Error('That letter could not be found.');
  return letter as Epistle;
}
