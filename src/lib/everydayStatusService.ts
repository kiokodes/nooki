import { requireSupabase } from './supabaseClient';

export const moods = ['Happy', 'Calm', 'Tired', 'Stressed', 'Sad', 'Missing you'] as const;
export const activities = ['Working', 'Studying', 'Resting', 'Out and about', 'Free to talk'] as const;
export interface EverydayStatus {
  user_id: string;
  couple_id: string;
  mood: string | null;
  activity: string | null;
  note: string;
  updated_at: string;
  expires_at: string;
  acknowledged_at: string | null;
}
function check(error: { message: string; code?: string } | null) {
  if (!error) return;
  if (['42P01', '42883', 'PGRST202', 'PGRST205'].includes(error.code ?? '')) {
    throw new Error('Daily check-ins need a database update: apply 202610180005_everyday_status.sql.');
  }
  throw new Error(error.message);
}
export async function fetchEverydayStatuses(coupleId: string): Promise<EverydayStatus[]> {
  const { data, error } = await requireSupabase().from('everyday_status').select('*').eq('couple_id', coupleId);
  check(error);
  return data ?? [];
}
export async function saveEverydayStatus(mood: string, activity: string, note: string, hours: number) {
  const { error } = await requireSupabase().rpc('save_everyday_status', {
    p_mood: mood || null, p_activity: activity || null, p_note: note, p_hours: hours,
  });
  check(error);
}
export async function clearEverydayStatus() {
  const { error } = await requireSupabase().rpc('clear_everyday_status');
  check(error);
}
export async function acknowledgeEverydayStatus(row: EverydayStatus) {
  const { error } = await requireSupabase().rpc('acknowledge_everyday_status', {
    p_user_id: row.user_id, p_updated_at: row.updated_at,
  });
  check(error);
}
