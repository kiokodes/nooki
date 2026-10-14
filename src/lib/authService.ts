import { requireSupabase } from './supabaseClient';
import type { Profile, Couple } from '../types/database';

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
