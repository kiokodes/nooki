import { supabase, isSupabaseConfigured } from './supabaseClient';
import type { Profile, Couple } from '../types/database';

export interface MockUser {
  id: string;
  email: string;
  password?: string;
}

const STORAGE_USERS_KEY = 'nooki_mock_users';
const STORAGE_PROFILES_KEY = 'nooki_mock_profiles';
const STORAGE_COUPLES_KEY = 'nooki_mock_couples';
const STORAGE_CURRENT_USER_ID = 'nooki_current_user_id';

function load<T>(key: string, defaultValue: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : defaultValue;
  } catch {
    return defaultValue;
  }
}

function save<T>(key: string, data: T) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (err) {
    console.error('Storage write error', err);
  }
}

export function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export async function getCurrentAuthUser(): Promise<MockUser | null> {
  if (isSupabaseConfigured && supabase) {
    const { data } = await supabase.auth.getUser();
    if (data?.user) {
      return { id: data.user.id, email: data.user.email || '' };
    }
    return null;
  }

  // Local fallback
  const currentId = localStorage.getItem(STORAGE_CURRENT_USER_ID);
  if (!currentId) return null;
  const users = load<MockUser[]>(STORAGE_USERS_KEY, []);
  return users.find((u) => u.id === currentId) || null;
}

export async function signUpWithEmail(email: string, password: string): Promise<{ user: MockUser; error?: string }> {
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return { user: null as any, error: error.message };
    if (!data.user) return { user: null as any, error: 'Sign up failed' };
    return { user: { id: data.user.id, email: data.user.email || email } };
  }

  // Local fallback
  const users = load<MockUser[]>(STORAGE_USERS_KEY, []);
  const existing = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    return { user: null as any, error: 'An account with this email already exists. Please sign in.' };
  }

  const newUser: MockUser = {
    id: `usr_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    email,
    password,
  };
  users.push(newUser);
  save(STORAGE_USERS_KEY, users);
  localStorage.setItem(STORAGE_CURRENT_USER_ID, newUser.id);
  return { user: newUser };
}

export async function signInWithEmail(email: string, password: string): Promise<{ user: MockUser; error?: string }> {
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { user: null as any, error: error.message };
    if (!data.user) return { user: null as any, error: 'Sign in failed' };
    return { user: { id: data.user.id, email: data.user.email || email } };
  }

  // Local fallback
  const users = load<MockUser[]>(STORAGE_USERS_KEY, []);
  const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!user || user.password !== password) {
    return { user: null as any, error: 'Invalid email or password.' };
  }

  localStorage.setItem(STORAGE_CURRENT_USER_ID, user.id);
  return { user };
}

export async function signOutUser(): Promise<void> {
  if (isSupabaseConfigured && supabase) {
    await supabase.auth.signOut();
  }
  localStorage.removeItem(STORAGE_CURRENT_USER_ID);
}

export async function fetchProfile(userId: string): Promise<Profile | null> {
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();
    if (error || !data) return null;
    return data as Profile;
  }

  const profiles = load<Profile[]>(STORAGE_PROFILES_KEY, []);
  return profiles.find((p) => p.id === userId) || null;
}

export async function saveOnboardingProfile(userId: string, name: string, timezone: string): Promise<Profile> {
  const profileData: Profile = {
    id: userId,
    couple_id: null,
    name,
    timezone,
    last_seen_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase
      .from('profiles')
      .upsert(profileData)
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    return data as Profile;
  }

  const profiles = load<Profile[]>(STORAGE_PROFILES_KEY, []);
  const index = profiles.findIndex((p) => p.id === userId);
  if (index >= 0) {
    profiles[index] = { ...profiles[index], name, timezone, last_seen_at: new Date().toISOString() };
  } else {
    profiles.push(profileData);
  }
  save(STORAGE_PROFILES_KEY, profiles);
  return profileData;
}

export async function fetchCouple(coupleId: string): Promise<{ couple: Couple; partner: Profile | null } | null> {
  if (isSupabaseConfigured && supabase) {
    const { data: couple, error: coupleError } = await supabase
      .from('couples')
      .select('*')
      .eq('id', coupleId)
      .single();
    if (coupleError || !couple) return null;

    const { data: user } = await supabase.auth.getUser();
    const currentUid = user?.user?.id;

    const { data: partnerData } = await supabase
      .from('profiles')
      .select('*')
      .eq('couple_id', coupleId)
      .neq('id', currentUid || '')
      .maybeSingle();

    return {
      couple: couple as Couple,
      partner: partnerData ? (partnerData as Profile) : null,
    };
  }

  const couples = load<Couple[]>(STORAGE_COUPLES_KEY, []);
  const couple = couples.find((c) => c.id === coupleId);
  if (!couple) return null;

  const currentId = localStorage.getItem(STORAGE_CURRENT_USER_ID);
  const profiles = load<Profile[]>(STORAGE_PROFILES_KEY, []);
  const partner = profiles.find((p) => p.couple_id === coupleId && p.id !== currentId) || null;

  return { couple, partner };
}

export async function createCouple(userId: string, anniversaryDate: string): Promise<{ couple: Couple; profile: Profile }> {
  const inviteCode = generateInviteCode();
  const coupleId = `cpl_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

  const newCouple: Couple = {
    id: coupleId,
    invite_code: inviteCode,
    anniversary_date: anniversaryDate || null,
    created_at: new Date().toISOString(),
    breakup_requested_by: null,
    breakup_requested_at: null,
  };

  if (isSupabaseConfigured && supabase) {
    const { data: createdCouple, error: cError } = await supabase
      .from('couples')
      .insert({
        invite_code: inviteCode,
        anniversary_date: anniversaryDate || null,
      })
      .select('*')
      .single();
    if (cError) throw new Error(cError.message);

    const { data: updatedProfile, error: pError } = await supabase
      .from('profiles')
      .update({ couple_id: createdCouple.id })
      .eq('id', userId)
      .select('*')
      .single();
    if (pError) throw new Error(pError.message);

    return { couple: createdCouple as Couple, profile: updatedProfile as Profile };
  }

  // Local fallback
  const couples = load<Couple[]>(STORAGE_COUPLES_KEY, []);
  couples.push(newCouple);
  save(STORAGE_COUPLES_KEY, couples);

  const profiles = load<Profile[]>(STORAGE_PROFILES_KEY, []);
  const pIndex = profiles.findIndex((p) => p.id === userId);
  if (pIndex >= 0) {
    profiles[pIndex].couple_id = coupleId;
    save(STORAGE_PROFILES_KEY, profiles);
    return { couple: newCouple, profile: profiles[pIndex] };
  }

  throw new Error('User profile not found');
}

export async function joinCoupleWithCode(userId: string, code: string): Promise<{ couple: Couple; profile: Profile }> {
  const cleanCode = code.trim().toUpperCase();

  if (isSupabaseConfigured && supabase) {
    const { data: rpcRes, error: rpcError } = await supabase.rpc('join_couple', { code: cleanCode });
    if (rpcError) throw new Error(rpcError.message);
    if (!rpcRes.success) throw new Error(rpcRes.error || 'Failed to join couple');

    const coupleInfo = await fetchCouple(rpcRes.couple_id);
    const profile = await fetchProfile(userId);
    return { couple: coupleInfo!.couple, profile: profile! };
  }

  // Local fallback
  const couples = load<Couple[]>(STORAGE_COUPLES_KEY, []);
  const couple = couples.find((c) => c.invite_code.toUpperCase() === cleanCode);
  if (!couple) {
    throw new Error('Invalid invite code. Please check and try again.');
  }

  const profiles = load<Profile[]>(STORAGE_PROFILES_KEY, []);
  const members = profiles.filter((p) => p.couple_id === couple.id);
  if (members.length >= 2) {
    throw new Error('This couple already has 2 partners.');
  }

  const pIndex = profiles.findIndex((p) => p.id === userId);
  if (pIndex < 0) throw new Error('User profile not found');

  profiles[pIndex].couple_id = couple.id;
  save(STORAGE_PROFILES_KEY, profiles);

  return { couple, profile: profiles[pIndex] };
}

export async function requestOrConfirmBreakup(userId: string, coupleId: string): Promise<{ status: 'requested' | 'waiting' | 'ended'; message: string }> {
  if (isSupabaseConfigured && supabase) {
    const { data, error } = await supabase.rpc('request_or_confirm_breakup');
    if (error) throw new Error(error.message);
    return { status: data.status, message: data.message };
  }

  // Local fallback
  const couples = load<Couple[]>(STORAGE_COUPLES_KEY, []);
  const cIndex = couples.findIndex((c) => c.id === coupleId);
  if (cIndex < 0) throw new Error('Couple not found');

  const couple = couples[cIndex];

  if (!couple.breakup_requested_by) {
    couple.breakup_requested_by = userId;
    couple.breakup_requested_at = new Date().toISOString();
    save(STORAGE_COUPLES_KEY, couples);
    return {
      status: 'requested',
      message: 'Breakup requested. Waiting for your partner to agree.',
    };
  }

  if (couple.breakup_requested_by === userId) {
    return {
      status: 'waiting',
      message: 'You have already requested to end the couple. Waiting for partner confirmation.',
    };
  }

  // Mutual agreement met! Remove couple and free both partners
  couples.splice(cIndex, 1);
  save(STORAGE_COUPLES_KEY, couples);

  const profiles = load<Profile[]>(STORAGE_PROFILES_KEY, []);
  profiles.forEach((p) => {
    if (p.couple_id === coupleId) {
      p.couple_id = null;
    }
  });
  save(STORAGE_PROFILES_KEY, profiles);

  return {
    status: 'ended',
    message: 'Couple ended by mutual agreement. Both partners are now free to create or join a new couple.',
  };
}

export async function cancelBreakup(coupleId: string): Promise<void> {
  if (isSupabaseConfigured && supabase) {
    const { error } = await supabase.rpc('cancel_breakup_request');
    if (error) throw new Error(error.message);
    return;
  }

  const couples = load<Couple[]>(STORAGE_COUPLES_KEY, []);
  const couple = couples.find((c) => c.id === coupleId);
  if (couple) {
    couple.breakup_requested_by = null;
    couple.breakup_requested_at = null;
    save(STORAGE_COUPLES_KEY, couples);
  }
}
