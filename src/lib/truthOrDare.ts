import { requireSupabase } from './supabaseClient';

export type TodTheme = 'random' | 'flirty' | 'spicy';
export type TodPromptType = 'truth' | 'dare';
export type TodMode = 'text' | 'voice' | 'video_call' | 'solo';
export type TodRoundStatus = 'inviting' | 'active' | 'paused' | 'ended';
export type TodAgeSource = 'date_of_birth' | 'confirmation' | 'missing';

export const TOD_THEMES: TodTheme[] = ['random', 'flirty', 'spicy'];
export const TOD_PROMPT_TYPES: TodPromptType[] = ['truth', 'dare'];

/**
 * Spicy is closed until marriage verification exists. Age is deliberately not enough to
 * open it: there is no screen, round or prompt pool that can reach it for now. Content
 * stays in the seed bank so the theme can return without rewriting the prompts.
 */
export const TOD_SPICY_LOCKED = true;
export const TOD_LOCKED_THEME_MESSAGE =
  'Spicy is locked until marriage verification is available.';

export function isTodThemeLocked(theme: TodTheme): boolean {
  return theme === 'spicy' && TOD_SPICY_LOCKED;
}

export interface TodPrompt {
  id: string;
  type: TodPromptType;
  theme: TodTheme;
  intensity: number;
  text: string;
  tags: string[];
  mode: TodMode;
}

export interface TodRound {
  id: string;
  couple_id: string;
  theme: TodTheme;
  created_by: string;
  player_one: string;
  player_two: string;
  turn_id: string;
  status: TodRoundStatus;
  accepted_by: string[];
  current_prompt: TodPrompt | null;
  completed_count: number;
  created_at: string;
  updated_at: string;
}

export interface TodAgeStatus {
  /** 0 means no qualifying date or confirmation; otherwise 18 or 20. */
  tier: 0 | 18 | 20;
  source: TodAgeSource;
}

export interface TodThemeCounts {
  truth: number;
  dare: number;
}

export interface TodSnapshot {
  round: TodRound | null;
  ages: {
    mine: TodAgeStatus;
    partner: TodAgeStatus;
  };
  active_counts: Record<TodTheme, TodThemeCounts>;
}

export const EMPTY_TOD_COUNTS: Record<TodTheme, TodThemeCounts> = {
  random: { truth: 0, dare: 0 },
  flirty: { truth: 0, dare: 0 },
  spicy: { truth: 0, dare: 0 },
};

export function requiredAgeForTheme(theme: TodTheme): 0 | 18 | 20 {
  if (theme === 'flirty') return 18;
  if (theme === 'spicy') return 20;
  return 0;
}

export function bothPartnersMeetAgeRule(theme: TodTheme, mine: TodAgeStatus, partner: TodAgeStatus): boolean {
  if (isTodThemeLocked(theme)) return false;
  const required = requiredAgeForTheme(theme);
  return required === 0 || (mine.tier >= required && partner.tier >= required);
}

/** Intensity steps up every two completed prompts and tops out at five. */
export function intensityForCompletedCount(completedCount: number): number {
  const safeCount = Number.isFinite(completedCount) ? Math.max(0, Math.floor(completedCount)) : 0;
  return Math.min(5, 1 + Math.floor(safeCount / 2));
}

export function isTodTurn(round: TodRound, userId: string | null): boolean {
  return !!userId && round.status === 'active' && round.turn_id === userId;
}

export function hasAcceptedRound(round: TodRound, userId: string | null): boolean {
  return !!userId && round.accepted_by.includes(userId);
}

export function otherTodPlayer(round: TodRound, userId: string): string | null {
  if (round.player_one === userId) return round.player_two;
  if (round.player_two === userId) return round.player_one;
  return null;
}

function databaseError(error: { message: string; code?: string }): Error {
  if (['PGRST202', '42P01', '42703', '42883'].includes(error.code || '')) {
    return new Error('Truth or Dare needs a database update. Apply 202610220001_truth_or_dare.sql and retry.');
  }
  return new Error(error.message);
}

export async function fetchTodState(): Promise<TodSnapshot> {
  const { data, error } = await requireSupabase().rpc('tod_state');
  if (error) throw databaseError(error);
  if (!data || typeof data !== 'object' || !('ages' in data) || !('active_counts' in data)) {
    throw new Error('Truth or Dare returned an incomplete room. Retry the connection.');
  }
  const snapshot = data as TodSnapshot;
  return {
    ...snapshot,
    active_counts: { ...EMPTY_TOD_COUNTS, ...snapshot.active_counts },
  };
}

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) throw databaseError(error);
  return data as T;
}

export const confirmTodAge = (minimumAge: 18 | 20): Promise<void> =>
  rpc<void>('tod_confirm_age', { p_minimum_age: minimumAge });
export const startTodRound = (theme: TodTheme): Promise<string> =>
  rpc<string>('tod_start_round', { p_theme: theme });
export const acceptTodRound = (roundId: string): Promise<void> =>
  rpc<void>('tod_accept_round', { p_round_id: roundId });
export const chooseTodPrompt = (roundId: string, type: TodPromptType): Promise<TodPrompt> =>
  rpc<TodPrompt>('tod_choose_prompt', { p_round_id: roundId, p_type: type });
export const completeTodPrompt = (roundId: string, result: 'done' | 'skip'): Promise<void> =>
  rpc<void>('tod_complete_prompt', { p_round_id: roundId, p_result: result });
export const pauseTodRound = (roundId: string): Promise<void> =>
  rpc<void>('tod_pause_round', { p_round_id: roundId });
export const resumeTodRound = (roundId: string): Promise<void> =>
  rpc<void>('tod_resume_round', { p_round_id: roundId });
export const endTodRound = (roundId: string): Promise<void> =>
  rpc<void>('tod_end_round', { p_round_id: roundId });

export interface TodSubscription {
  close: () => void;
}

export function subscribeToTod(
  coupleId: string,
  userId: string,
  partnerId: string,
  onChange: () => void,
): TodSubscription {
  const client = requireSupabase();
  const channel = client.channel(`truth-or-dare-${coupleId}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'tod_rounds', filter: `couple_id=eq.${coupleId}`,
    }, onChange)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'tod_age_confirmations', filter: `user_id=eq.${userId}`,
    }, onChange)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'tod_age_confirmations', filter: `user_id=eq.${partnerId}`,
    }, onChange)
    .subscribe();

  return {
    close: () => {
      const removed = client.removeChannel(channel);
      if (removed && typeof removed.catch === 'function') removed.catch(() => {});
    },
  };
}
