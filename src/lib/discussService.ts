import { requireSupabase } from './supabaseClient';
import { describeDatabaseError } from './authService';
import { COMMENT_MAX_LENGTH, canonicalCategory, coerceAnswerValue, toQuestion } from './questionFormat';
import type {
  AnswerComment,
  AnswerValue,
  CoupleSettings,
  Question,
  QuestionAnswer,
  QuestionSession,
} from '../types/database';

/**
 * Discuss transport: the shared question library plus this couple's private sessions.
 *
 * Three rules live in the database, not here, and this file is written so it cannot
 * accidentally work around them:
 *
 * - **The reveal.** `answers` rows are only readable by the partner once the session is
 *   complete, so a fetch made too early simply returns fewer rows. Nothing in the app
 *   decides when an answer becomes visible.
 * - **The comments.** Each partner gets one, only after the reveal. A second thought
 *   moves to the chat ("Say more"), linked back here by `messages.session_id`.
 * - **The 18+ gate.** Adult rows are invisible to a couple until both partners have
 *   `adult_questions_enabled`, so the library this file can read is already the one the
 *   couple is allowed to see.
 *
 * The questions themselves are never bundled with the app: every one comes from the
 * `questions` table the owner imports from their CSV.
 */

/** How many past sessions the history list keeps in memory. */
export const HISTORY_LIMIT = 100;

export interface CategoryCount {
  category: string;
  total: number;
  /** Questions in this category the couple has not asked yet. */
  remaining: number;
  adult: boolean;
  /** Remaining questions per seriousness level, keyed 1-5. */
  byLevel: Record<number, number>;
}

export interface PickedQuestion {
  question: Question | null;
  remaining: number;
  total: number;
  adultEnabled: boolean;
}

function toSession(row: Record<string, unknown>): QuestionSession {
  return {
    id: String(row.id),
    couple_id: String(row.couple_id),
    question_id: String(row.question_id),
    started_by: row.started_by == null ? null : String(row.started_by),
    created_at: String(row.created_at),
    answer_count: Number(row.answer_count ?? 0),
    completed_at: row.completed_at == null ? null : String(row.completed_at),
  };
}

/**
 * An `answers` row does not carry its question, so the stored value is kept as it is; the
 * screen that knows the input type tightens it with `parseAnswerValue` when rendering.
 */
function toAnswer(row: Record<string, unknown>): QuestionAnswer {
  return {
    id: String(row.id),
    session_id: String(row.session_id),
    user_id: String(row.user_id),
    answer: coerceAnswerValue(row.answer),
    created_at: String(row.created_at),
  };
}

function toComment(row: Record<string, unknown>): AnswerComment {
  return {
    id: String(row.id),
    session_id: String(row.session_id),
    user_id: String(row.user_id),
    comment: String(row.comment ?? ''),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at ?? row.created_at),
  };
}

function toSettings(row: Record<string, unknown>): CoupleSettings {
  return {
    couple_id: String(row.couple_id),
    user_id: String(row.user_id),
    adult_questions_enabled: Boolean(row.adult_questions_enabled),
    updated_at: String(row.updated_at),
  };
}

/**
 * What the browse screen shows: every category this couple may see, how much of it is
 * left, and how that remainder splits across the five seriousness levels.
 */
export async function fetchQuestionCategories(): Promise<CategoryCount[]> {
  const { data, error } = await requireSupabase().rpc('question_categories');
  if (error) throw new Error(describeDatabaseError(error));
  return (data ?? []).map((row: Record<string, unknown>) => {
    const byLevel: Record<number, number> = {};
    const levels = (row.by_level ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(levels)) {
      const level = Number(key);
      if (Number.isFinite(level)) byLevel[level] = Number(value ?? 0);
    }
    return {
      category: canonicalCategory(row.category),
      total: Number(row.total ?? 0),
      remaining: Number(row.remaining ?? 0),
      adult: Boolean(row.adult),
      byLevel,
    };
  });
}

/**
 * One random question the couple has not asked yet. Both arguments null is "Surprise me";
 * a category and/or a level narrows it. `question` is null when nothing matches.
 */
export async function pickQuestion(
  category: string | null = null,
  seriousness: number | null = null,
): Promise<PickedQuestion> {
  const { data, error } = await requireSupabase().rpc('pick_question', {
    p_category: category,
    p_seriousness: seriousness,
  });
  if (error) throw new Error(describeDatabaseError(error));
  const result = (data ?? {}) as Record<string, unknown>;
  if (result.success === false) {
    throw new Error(typeof result.error === 'string' ? result.error : 'That question could not be picked.');
  }
  const question = result.question as Record<string, unknown> | null;
  return {
    question: question ? toQuestion(question) : null,
    remaining: Number(result.remaining ?? 0),
    total: Number(result.total ?? 0),
    adultEnabled: Boolean(result.adult_enabled),
  };
}

/**
 * "Ask my partner": creates the session both partners will answer. Idempotent, so a double
 * tap returns the session that already exists rather than failing.
 */
export async function askPartner(questionId: string): Promise<{ sessionId: string; alreadyAsked: boolean }> {
  const { data, error } = await requireSupabase().rpc('ask_question', { p_question: questionId });
  if (error) throw new Error(describeDatabaseError(error));
  const result = (data ?? {}) as Record<string, unknown>;
  if (result.success === false || !result.session_id) {
    throw new Error(typeof result.error === 'string' ? result.error : 'That question could not be sent.');
  }
  return { sessionId: String(result.session_id), alreadyAsked: Boolean(result.already_asked) };
}

export async function fetchSessions(coupleId: string, limit: number = HISTORY_LIMIT): Promise<QuestionSession[]> {
  const { data, error } = await requireSupabase().from('question_sessions')
    .select('*')
    .eq('couple_id', coupleId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(describeDatabaseError(error));
  return (data ?? []).map((row: Record<string, unknown>) => toSession(row));
}

export async function fetchQuestionsByIds(questionIds: string[]): Promise<Question[]> {
  if (!questionIds.length) return [];
  const { data, error } = await requireSupabase().from('questions').select('*').in('id', questionIds);
  if (error) throw new Error(describeDatabaseError(error));
  return (data ?? []).map((row: Record<string, unknown>) => toQuestion(row));
}

/**
 * Every answer this phone is allowed to see. Before the reveal that is only your own —
 * the database withholds the partner's row, so there is nothing here to hide.
 */
export async function fetchAnswers(sessionIds: string[]): Promise<QuestionAnswer[]> {
  if (!sessionIds.length) return [];
  const { data, error } = await requireSupabase().from('answers').select('*').in('session_id', sessionIds);
  if (error) throw new Error(describeDatabaseError(error));
  return (data ?? []).map((row: Record<string, unknown>) => toAnswer(row));
}

/** One comment each; sealed sessions simply return nothing, the way sealed answers do. */
export async function fetchComments(sessionIds: string[]): Promise<AnswerComment[]> {
  if (!sessionIds.length) return [];
  const { data, error } = await requireSupabase().from('answer_comments').select('*').in('session_id', sessionIds);
  if (error) throw new Error(describeDatabaseError(error));
  return (data ?? []).map((row: Record<string, unknown>) => toComment(row));
}

export async function submitAnswer(
  sessionId: string,
  userId: string,
  value: AnswerValue,
): Promise<QuestionAnswer> {
  const { data, error } = await requireSupabase().from('answers')
    .insert({ session_id: sessionId, user_id: userId, answer: value })
    .select('*')
    .single();
  if (error) throw new Error(describeDatabaseError(error));
  if (!data) throw new Error('Your answer could not be saved. Please try again.');
  return toAnswer(data as Record<string, unknown>);
}

/** Allowed only while the partner has not answered; the database locks it at the reveal. */
export async function reviseAnswer(
  answerId: string,
  value: AnswerValue,
): Promise<QuestionAnswer> {
  const { data, error } = await requireSupabase().from('answers')
    .update({ answer: value })
    .eq('id', answerId)
    .select('*')
    .single();
  if (error) throw new Error(describeDatabaseError(error));
  if (!data) throw new Error('Your answer could not be changed. Please try again.');
  return toAnswer(data as Record<string, unknown>);
}

/** One comment per partner per session, so a change of heart overwrites the first. */
export async function saveComment(
  sessionId: string,
  userId: string,
  comment: string,
): Promise<AnswerComment> {
  const clean = (comment || '').replace(/\r\n/g, '\n').trim();
  if (!clean) throw new Error('Say something about it first.');
  if (clean.length > COMMENT_MAX_LENGTH) {
    throw new Error(`Comments can be up to ${COMMENT_MAX_LENGTH} characters.`);
  }
  const { data, error } = await requireSupabase().from('answer_comments')
    .upsert(
      { session_id: sessionId, user_id: userId, comment: clean },
      { onConflict: 'session_id,user_id' },
    )
    .select('*')
    .single();
  if (error) throw new Error(describeDatabaseError(error));
  if (!data) throw new Error('Your comment could not be saved. Please try again.');
  return toComment(data as Record<string, unknown>);
}

export async function fetchCoupleSettings(coupleId: string): Promise<CoupleSettings[]> {
  const { data, error } = await requireSupabase().from('couple_settings')
    .select('*')
    .eq('couple_id', coupleId);
  if (error) throw new Error(describeDatabaseError(error));
  return (data ?? []).map((row: Record<string, unknown>) => toSettings(row));
}

/** Your own row only: the 18+ category opens when your partner does the same. */
export async function saveAdultPreference(
  coupleId: string,
  userId: string,
  enabled: boolean,
): Promise<CoupleSettings> {
  const { data, error } = await requireSupabase().from('couple_settings')
    .upsert(
      { couple_id: coupleId, user_id: userId, adult_questions_enabled: enabled },
      { onConflict: 'couple_id,user_id' },
    )
    .select('*')
    .single();
  if (error) throw new Error(describeDatabaseError(error));
  if (!data) throw new Error('That setting could not be saved. Please try again.');
  return toSettings(data as Record<string, unknown>);
}

/** Realtime topic shared by exactly the two members of a couple. */
export function discussTopic(coupleId: string): string {
  return `nooki-discuss-${coupleId}`;
}

export interface DiscussSubscriptionHandlers {
  /** Something in this couple's Discuss data changed; the hook re-reads what it may see. */
  onChange: (source: string) => void;
  onStatus?: (status: string) => void;
}

export interface DiscussChannel {
  close: () => void;
}

/**
 * Live sessions, reveals and comments over one channel.
 *
 * Payloads are used only as a "something changed" signal — the hook re-reads through the
 * normal queries, so what appears on screen is always exactly what row-level security
 * allows this phone to see at that moment.
 */
export function subscribeToDiscuss(
  coupleId: string,
  handlers: DiscussSubscriptionHandlers,
): DiscussChannel {
  const client = requireSupabase();
  const channel = client.channel(discussTopic(coupleId));

  const watched: { table: string; event: 'INSERT' | 'UPDATE'; filter?: string }[] = [
    { table: 'question_sessions', event: 'INSERT', filter: `couple_id=eq.${coupleId}` },
    { table: 'question_sessions', event: 'UPDATE', filter: `couple_id=eq.${coupleId}` },
    { table: 'couple_settings', event: 'INSERT', filter: `couple_id=eq.${coupleId}` },
    { table: 'couple_settings', event: 'UPDATE', filter: `couple_id=eq.${coupleId}` },
    // answers and answer_comments carry no couple_id: RLS decides which rows arrive.
    { table: 'answers', event: 'INSERT' },
    { table: 'answer_comments', event: 'INSERT' },
    { table: 'answer_comments', event: 'UPDATE' },
  ];

  for (const entry of watched) {
    channel.on(
      'postgres_changes',
      entry.filter
        ? { event: entry.event, schema: 'public', table: entry.table, filter: entry.filter }
        : { event: entry.event, schema: 'public', table: entry.table },
      () => handlers.onChange(entry.table),
    );
  }

  channel.subscribe((status: string) => handlers.onStatus?.(status));

  return {
    close: () => {
      const removed = client.removeChannel(channel);
      if (removed && typeof removed.catch === 'function') removed.catch(() => {});
    },
  };
}
