import { requireSupabase } from './supabaseClient';
import { describeDatabaseError } from './authService';
import type { DailyDecisionQuestion, DailyDecisionSnapshot } from '../types/database';

/** Apply before deploying: the owner-uploaded question pool and private response RPCs. */
export const DAILY_DECISION_MIGRATION = 'supabase/migrations/202610180001_daily_decision_pool.sql';

function isMissingMigration(error: { message: string; code?: string }): boolean {
  return error.code === '42P01'
    || error.code === '42883'
    || error.code === 'PGRST202'
    || /daily_decision_(questions|assignments|responses|state|choice|chat_links|take_to_chat)/i.test(error.message)
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

function countOf(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function toQuestion(value: unknown): DailyDecisionQuestion | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') throw new Error('Today’s decision is not formatted correctly. Please ask the app owner to check its three options.');
  const row = value as Record<string, unknown>;
  const id = Number(row.id);
  const options = Array.isArray(row.options) ? row.options.map((option) => String(option ?? '').trim()) : [];
  if (!Number.isInteger(id) || typeof row.question !== 'string' || options.length !== 3 || options.some((option) => !option)) {
    throw new Error('Today’s decision is not formatted correctly. Please ask the app owner to check its three options.');
  }
  return {
    id,
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
    exhausted: Boolean(row.exhausted),
    remaining: countOf(row.remaining),
    total: countOf(row.total),
  };
}

/**
 * Today's decision for this couple. The database randomly assigns one pool
 * question the couple has never been given, saves that assignment so both
 * partners see the same question all day, and decides which answers are
 * visible; this RPC never returns a sealed pick, and the phone never sees
 * the rest of the pool.
 */
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

/**
 * "Take to chat": the server posts one short line with a link back to today's decision,
 * so the chat stays a conversation and the three options stay on the card. Tapping it
 * twice reuses the same message.
 */
export async function takeDailyDecisionToChat(): Promise<{ message_id: string; question_id: number | null }> {
  const { data, error } = await requireSupabase().rpc('daily_decision_take_to_chat');
  if (error) {
    if (isMissingMigration(error)) throw missingMigration();
    throw new Error(describeDatabaseError(error));
  }
  const row = (data ?? {}) as Record<string, unknown>;
  const questionId = Number(row.question_id);
  return {
    message_id: typeof row.message_id === 'string' ? row.message_id : '',
    question_id: Number.isInteger(questionId) ? questionId : null,
  };
}

/**
 * Which chat messages are about a daily decision, so a bubble can offer the way back.
 * Reads the couple's own links only; row level security filters everything else.
 */
export async function fetchDailyDecisionChatLinks(messageIds: string[]): Promise<Record<string, string>> {
  const ids = messageIds.filter(Boolean).slice(0, 200);
  if (!ids.length) return {};
  const { data, error } = await requireSupabase()
    .from('daily_decision_chat_links')
    .select('message_id, question_id')
    .in('message_id', ids);
  if (error) {
    // A missing table only means the link layer is not deployed yet: the chat still works.
    if (isMissingMigration(error)) return {};
    throw new Error(describeDatabaseError(error));
  }
  const links: Record<string, string> = {};
  for (const entry of (data ?? []) as Array<{ message_id?: unknown; question_id?: unknown }>) {
    const messageId = typeof entry.message_id === 'string' ? entry.message_id : '';
    const questionId = entry.question_id === null || entry.question_id === undefined ? '' : String(entry.question_id);
    if (messageId && questionId) links[messageId] = questionId;
  }
  return links;
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
