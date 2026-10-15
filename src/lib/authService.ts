import { requireSupabase } from './supabaseClient';
import { parseIsoDate } from './coupleTime';
import { REPEAT_FREQUENCIES } from '../types/database';
import type { Profile, Couple, CoupleEvent, RepeatFrequency } from '../types/database';

export interface AuthUser {
  id: string;
  email: string;
}

interface AuthResult {
  user: AuthUser | null;
  error?: string;
  requiresEmailConfirmation?: boolean;
}

export async function getCurrentAuthUser(): Promise<AuthUser | null> {
  const client = requireSupabase();
  // No saved session is expected on the first visit, not a database/auth failure.
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw new Error(sessionError.message);
  if (!sessionData.session) return null;
  const { data, error } = await client.auth.getUser();
  if (error) throw new Error(error.message);
  return data.user ? { id: data.user.id, email: data.user.email || '' } : null;
}

export async function signUpWithEmail(email: string, password: string): Promise<AuthResult> {
  const { data, error } = await requireSupabase().auth.signUp({ email: email.trim(), password });
  if (error) return { user: null, error: error.message };
  if (!data.user) return { user: null, error: 'Sign up failed. Please try again.' };
  return {
    user: { id: data.user.id, email: data.user.email || email.trim() },
    requiresEmailConfirmation: !data.session,
  };
}

export async function signInWithEmail(email: string, password: string): Promise<AuthResult> {
  const { data, error } = await requireSupabase().auth.signInWithPassword({ email: email.trim(), password });
  if (error) return { user: null, error: error.message };
  if (!data.user || !data.session) return { user: null, error: 'Sign in failed. Please try again.' };
  return { user: { id: data.user.id, email: data.user.email || email.trim() } };
}

export async function signOutUser(): Promise<void> {
  const { error } = await requireSupabase().auth.signOut();
  if (error) throw new Error(error.message);
}

export async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await requireSupabase()
    .from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  return data as Profile | null;
}

export async function saveOnboardingProfile(userId: string, name: string, timezone: string): Promise<Profile> {
  // Never overwrite existing membership or creation timestamps on a profile retry.
  const { data, error } = await requireSupabase().from('profiles')
    .upsert({ id: userId, name: name.trim(), timezone, last_seen_at: new Date().toISOString() })
    .select('*').single();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Your profile could not be saved. Please try again.');
  return data as Profile;
}

/**
 * Presence covers "in the app right now"; this timestamp is what the partner's Home tab
 * falls back to as "Last seen ...". Allowed by the existing "update own profile" RLS policy.
 */
export async function touchLastSeen(userId: string): Promise<void> {
  const { error } = await requireSupabase()
    .from('profiles').update({ last_seen_at: new Date().toISOString() }).eq('id', userId);
  if (error) throw new Error(error.message);
}

/**
 * A missing table or function means a migration has not been applied yet; that is an owner
 * problem, not something the person using the app can fix. PostgREST reports an absent RPC
 * as 42883 ("could not find the function"), which is how a project without the Discuss
 * migration answers `question_categories`, `pick_question` and `ask_question`.
 */
export function describeDatabaseError(error: { message: string; code?: string }): string {
  const missingTable = error.code === '42P01'
    || /relation .*(couple_events|messages|questions|question_sessions|answers|answer_comments|couple_settings).* does not exist/i.test(error.message);
  const missingFunction = error.code === '42883' || /could not find the function/i.test(error.message);
  if (missingTable || missingFunction) {
    return 'The database needs an update. Please ask the app owner to apply the Supabase migrations.';
  }
  return error.message;
}

export interface CoupleEventInput {
  title: string;
  /** Plain `YYYY-MM-DD` calendar date. */
  date: string;
  /** How often it comes back: 'none' fires once, on its own date. */
  repeatFrequency: RepeatFrequency;
}

function validateEventInput(input: CoupleEventInput): CoupleEventInput {
  const title = (input.title || '').trim();
  if (!title) throw new Error('Please give this event a name.');
  if (title.length > 120) throw new Error('Event names can be up to 120 characters.');
  if (!parseIsoDate(input.date)) throw new Error('Please choose a valid date.');
  const repeatFrequency = REPEAT_FREQUENCIES.includes(input.repeatFrequency) ? input.repeatFrequency : 'none';
  return { title, date: input.date, repeatFrequency };
}

export async function fetchCoupleEvents(coupleId: string): Promise<CoupleEvent[]> {
  const { data, error } = await requireSupabase().from('couple_events')
    .select('*').eq('couple_id', coupleId).order('event_date', { ascending: true });
  if (error) throw new Error(describeDatabaseError(error));
  return (data ?? []) as CoupleEvent[];
}

export async function createCoupleEvent(
  coupleId: string,
  userId: string,
  input: CoupleEventInput,
): Promise<CoupleEvent> {
  const clean = validateEventInput(input);
  const { data, error } = await requireSupabase().from('couple_events')
    .insert({
      couple_id: coupleId,
      created_by: userId,
      title: clean.title,
      event_date: clean.date,
      repeat_frequency: clean.repeatFrequency,
    })
    .select('*')
    .single();
  if (error) throw new Error(describeDatabaseError(error));
  if (!data) throw new Error('This event could not be saved. Please try again.');
  return data as CoupleEvent;
}

export async function updateCoupleEvent(eventId: string, input: CoupleEventInput): Promise<CoupleEvent> {
  const clean = validateEventInput(input);
  const { data, error } = await requireSupabase().from('couple_events')
    .update({ title: clean.title, event_date: clean.date, repeat_frequency: clean.repeatFrequency })
    .eq('id', eventId)
    .select('*')
    .single();
  if (error) throw new Error(describeDatabaseError(error));
  if (!data) throw new Error('This event could not be updated. Please try again.');
  return data as CoupleEvent;
}

export async function deleteCoupleEvent(eventId: string): Promise<void> {
  const { error } = await requireSupabase().from('couple_events').delete().eq('id', eventId);
  if (error) throw new Error(describeDatabaseError(error));
}

export async function fetchCouple(coupleId: string): Promise<{ couple: Couple; partner: Profile | null } | null> {
  const client = requireSupabase();
  const { data: couple, error: coupleError } = await client
    .from('couples').select('*').eq('id', coupleId).maybeSingle();
  if (coupleError) throw new Error(coupleError.message);
  if (!couple) return null;

  const user = await getCurrentAuthUser();
  if (!user) throw new Error('Please sign in again to load your shared nook.');
  const { data: partner, error: partnerError } = await client.from('profiles')
    .select('*').eq('couple_id', coupleId).neq('id', user.id).maybeSingle();
  if (partnerError) throw new Error(partnerError.message);
  return { couple: couple as Couple, partner: partner as Profile | null };
}

function validateAnniversary(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date) {
    throw new Error('Please select a valid anniversary date.');
  }
}

export function normalizeInviteCode(code: string): string {
  return code.replace(/\s/g, '').toUpperCase();
}

interface RpcResult {
  success: boolean;
  couple_id?: string;
  error?: string;
  status?: string;
  message?: string;
}

async function callRpc(name: string, args?: Record<string, string>): Promise<RpcResult> {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) {
    if (error.code === 'PGRST202') {
      throw new Error('The database needs an update. Please ask the app owner to apply the Supabase migrations.');
    }
    throw new Error(error.message);
  }
  if (!data?.success) throw new Error(data?.error || 'This action failed. Please try again.');
  return data;
}

async function loadPairingResult(userId: string, coupleId?: string): Promise<{ couple: Couple; profile: Profile }> {
  if (!coupleId) throw new Error('The pairing response was incomplete. Please refresh and try again.');
  const [coupleInfo, profile] = await Promise.all([fetchCouple(coupleId), fetchProfile(userId)]);
  if (!coupleInfo || !profile || profile.couple_id !== coupleId) {
    throw new Error('Your connection was saved, but could not be loaded. Please refresh to check it.');
  }
  return { couple: coupleInfo.couple, profile };
}

export async function createCouple(userId: string, anniversaryDate: string): Promise<{ couple: Couple; profile: Profile }> {
  validateAnniversary(anniversaryDate);
  const result = await callRpc('create_couple', { anniversary: anniversaryDate });
  return loadPairingResult(userId, result.couple_id);
}

export async function leavePendingCouple(): Promise<void> {
  await callRpc('leave_pending_couple');
}

export async function updatePendingAnniversary(anniversaryDate: string): Promise<void> {
  validateAnniversary(anniversaryDate);
  await callRpc('update_pending_anniversary', { anniversary: anniversaryDate });
}

export async function joinCoupleWithCode(userId: string, code: string): Promise<{ couple: Couple; profile: Profile }> {
  const cleanCode = normalizeInviteCode(code);
  if (!/^[A-Z0-9]{6}$/.test(cleanCode)) throw new Error('Please enter a valid 6-character invite code.');
  const result = await callRpc('join_couple', { code: cleanCode });
  return loadPairingResult(userId, result.couple_id);
}

export async function requestOrConfirmBreakup(): Promise<{ status: 'requested' | 'waiting' | 'ended'; message: string }> {
  const result = await callRpc('request_or_confirm_breakup');
  const status = result.status === 'waiting_partner' ? 'waiting' : result.status;
  if (status !== 'requested' && status !== 'waiting' && status !== 'ended') {
    throw new Error('Unexpected response. Please refresh to check your couple status.');
  }
  return { status, message: result.message || 'Couple status updated.' };
}

export async function cancelBreakup(): Promise<void> {
  await callRpc('cancel_breakup_request');
}
