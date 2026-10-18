import { requireSupabase } from './supabaseClient';
import { describeDatabaseError } from './authService';
import type { DailyDecisionQuestion, DailyDecisionSnapshot } from '../types/database';

/** Apply before deploying: the owner-uploaded prompt table and private response RPCs. */
export const DAILY_DECISION_MIGRATION = 'supabase/migrations/202610170002_daily_decisions.sql';

function isMissingMigration(error: { message: string; code?: string }): boolean {
  return error.code === '42P01'
    || error.code === '42883'
    || error.code === 'PGRST202'
    || /daily_decision_(questions|responses|state|choice)/i.test(error.message)
       && /does not exist|could not find|schema cache/i.test(error.message);
}

function missingMigration(): Error {
  return new Error(`Daily Decisions needs a database update. Please ask the app owner to apply ${DAILY_DECISION_MIGRATION}.`);
}

function choiceOf(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const choice = Number(value);
  return Number.isInteger(choice) && choice >= 1 && choice <= 3 ? choice : null;
}

function toQuestion(value: unknown): DailyDecisionQuestion | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') throw new Error('Today’s decision is not formatted correctly. Please ask the app owner to check its three options.');
  const row = value as Record<string, unknown>;
  const options = Array.isArray(row.options) ? row.options.map((option) => String(option ?? '').trim()) : [];
  if (typeof row.decision_date !== 'string' || typeof row.question !== 'string' || options.length !== 3 || options.some((option) => !option)) {
    throw new Error('Today’s decision is not formatted correctly. Please ask the app owner to check its three options.');
  }
  return {
    decision_date: row.decision_date,
    question: row.question.trim(),
    options: [options[0], options[1], options[2]],
  };
}

function toSnapshot(value: unknown): DailyDecisionSnapshot {
  if (!value || typeof value !== 'object') {
    throw new Error('Today’s decision could not be loaded. Please try again.');
  }
  const row = value as Record<string, unknown>;
  if (typeof row.today !== 'string') throw new Error('Today’s decision could not be loaded. Please try again.');
  const myChoice = choiceOf(row.my_choice);
  const bothAnswered = Boolean(row.both_answered);
  const partnerChoice = bothAnswered ? choiceOf(row.partner_choice) : null;
  return {
    today: row.today,
    question: toQuestion(row.question),
    my_choice: myChoice,
    partner_choice: partnerChoice,
    partner_responded: Boolean(row.partner_responded),
    both_answered: bothAnswered,
    agreed: bothAnswered && myChoice !== null && partnerChoice !== null && myChoice === partnerChoice,
  };
}

/** The database decides which answers are visible; this RPC never returns a sealed pick. */
export async function fetchDailyDecisionState(): Promise<DailyDecisionSnapshot> {
  const { data, error } = await requireSupabase().rpc('daily_decision_state');
  if (error) {
    if (isMissingMigration(error)) throw missingMigration();
    throw new Error(describeDatabaseError(error));
  }
  return toSnapshot(data);
}

/** Save or revise this partner's choice. Consensus is finalized by the database. */
export async function submitDailyDecisionChoice(optionIndex: number): Promise<void> {
  if (!Number.isInteger(optionIndex) || optionIndex < 1 || optionIndex > 3) {
    throw new Error('Choose one of the three options.');
  }
  const { error } = await requireSupabase().rpc('submit_daily_decision_choice', {
    p_option_index: optionIndex,
  });
  if (error) {
    if (isMissingMigration(error)) throw missingMigration();
    throw new Error(describeDatabaseError(error));
  }
}

export interface DailyDecisionSubscriptionHandlers {
  /** A change is only a nudge; callers re-fetch state through the privacy-safe RPC. */
  onChange: () => void;
  onStatus?: (status: string) => void;
}

export interface DailyDecisionChannel {
  close: () => void;
}

/** Live reply updates, scoped to one couple. RLS still gates response row payloads. */
export function subscribeToDailyDecision(
  coupleId: string,
  handlers: DailyDecisionSubscriptionHandlers,
): DailyDecisionChannel {
  const client = requireSupabase();
  const channel = client.channel(`nooki-daily-decision-${coupleId}`);
  const filter = { schema: 'public', table: 'daily_decision_responses', filter: `couple_id=eq.${coupleId}` };
  channel
    .on('postgres_changes', { ...filter, event: 'INSERT' }, handlers.onChange)
    .on('postgres_changes', { ...filter, event: 'UPDATE' }, handlers.onChange)
    .subscribe((status: string) => handlers.onStatus?.(status));

  return {
    close: () => {
      const removed = client.removeChannel(channel);
      if (removed && typeof removed.catch === 'function') removed.catch(() => {});
    },
  };
}
