import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  HISTORY_LIMIT,
  askPartner,
  fetchAnswers,
  fetchComments,
  fetchCoupleSettings,
  fetchQuestionCategories,
  fetchQuestionsByIds,
  fetchSessions,
  pickQuestion,
  reviseAnswer,
  saveAdultPreference,
  saveComment,
  submitAnswer,
  subscribeToDiscuss,
  type CategoryCount,
  type DiscussChannel,
} from '../lib/discussService';
import type {
  AnswerComment,
  AnswerValue,
  CoupleSettings,
  Question,
  QuestionAnswer,
  QuestionSession,
} from '../types/database';

interface UseDiscussOptions {
  /** The shared couple, or null while the account is still unpaired. */
  coupleId: string | null;
  /** The signed-in account (this phone). Anything else is the partner's answer. */
  userId: string | null;
}

/** One history row: the session, its question, and whatever this phone may see of it. */
export interface SessionDetail {
  session: QuestionSession;
  /** Null only if the library row was deleted after the session was asked. */
  question: Question | null;
  answers: QuestionAnswer[];
  /** One comment per partner, visible only after the reveal — same rule as answers. */
  comments: AnswerComment[];
  myAnswer: QuestionAnswer | null;
  /** Null until the reveal: the database simply does not send it before then. */
  partnerAnswer: QuestionAnswer | null;
  /**
   * True when the partner's answer exists but is still hidden. This is the only thing
   * known about it — the content stays on the server until both answers are in.
   */
  partnerHasAnswered: boolean;
  revealed: boolean;
  startedByMe: boolean;
}

export interface DiscussState {
  categories: CategoryCount[];
  sessions: SessionDetail[];
  loading: boolean;
  /** An ask, an answer or a comment is on its way. */
  busy: boolean;
  /** The 18+ consent toggle is saving. Separate from busy so discuss operations don't block it. */
  adultSaving: boolean;
  error: string | null;
  /** The library exists but holds no rows: the owner has not imported the CSV yet. */
  libraryEmpty: boolean;
  /** The `questions` table or its RPCs are missing altogether. */
  migrationMissing: boolean;
  adultEnabled: boolean;
  myAdultEnabled: boolean;
  partnerAdultEnabled: boolean;
  /** Sessions still waiting for this phone's answer — the Discuss tab badge. */
  pendingCount: number;
  refresh: () => Promise<void>;
  clearError: () => void;
  /** A random unused question, narrowed by category and seriousness (both optional). */
  pick: (category: string | null, seriousness: number | null) => Promise<PickResult>;
  ask: (questionId: string) => Promise<string | null>;
  submit: (sessionId: string, value: AnswerValue) => Promise<void>;
  revise: (answerId: string, value: AnswerValue) => Promise<void>;
  /** Your one comment under a revealed question; a second thought belongs in the chat. */
  comment: (sessionId: string, text: string) => Promise<void>;
  setAdultEnabled: (enabled: boolean) => Promise<void>;
}

export interface PickResult {
  question: Question | null;
  remaining: number;
  total: number;
}

interface LoadedState {
  /** Which couple this data belongs to, so another couple's history can never flash up. */
  coupleId: string;
  categories: CategoryCount[];
  sessions: SessionDetail[];
  settings: CoupleSettings[];
}

/** Live updates arrive as a "something changed" nudge; one reload covers a burst. */
const RELOAD_DEBOUNCE_MS = 300;

const NO_CATEGORIES: CategoryCount[] = [];
const NO_SESSIONS: SessionDetail[] = [];
const NO_SETTINGS: CoupleSettings[] = [];

function byNewestFirst(a: SessionDetail, b: SessionDetail): number {
  const difference = Date.parse(b.session.created_at) - Date.parse(a.session.created_at);
  return difference !== 0 ? difference : b.session.id.localeCompare(a.session.id);
}

/**
 * The couple's Discuss data: the shared library's shape, their private session history and
 * the 18+ consent of both partners.
 *
 * It lives at app level, like the chat, so a question the partner asks still badges the
 * Discuss tab while this phone is on another screen.
 */
export function useDiscuss({ coupleId, userId }: UseDiscussOptions): DiscussState {
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adultSaving, setAdultSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reloadTimer = useRef<number | null>(null);

  const current = loaded && loaded.coupleId === coupleId ? loaded : null;

  const load = useCallback(async (): Promise<void> => {
    if (!coupleId) return;
    // The library and the couple's own data are independent reads; run them together.
    const [categories, sessions, settings] = await Promise.all([
      fetchQuestionCategories(),
      fetchSessions(coupleId, HISTORY_LIMIT),
      fetchCoupleSettings(coupleId),
    ]);

    const questionIds = [...new Set(sessions.map((session) => session.question_id))];
    const sessionIds = sessions.map((session) => session.id);
    const [questions, answers, comments] = await Promise.all([
      fetchQuestionsByIds(questionIds),
      fetchAnswers(sessionIds),
      fetchComments(sessionIds),
    ]);

    const questionById = new Map(questions.map((question) => [question.id, question]));
    const details = sessions.map((session): SessionDetail => {
      const question = questionById.get(session.question_id) ?? null;
      const sessionAnswers = answers.filter((answer) => answer.session_id === session.id);
      const revealed = session.completed_at !== null;
      return {
        session,
        question,
        answers: sessionAnswers,
        comments: comments.filter((comment) => comment.session_id === session.id),
        myAnswer: sessionAnswers.find((answer) => answer.user_id === userId) ?? null,
        partnerAnswer: sessionAnswers.find((answer) => answer.user_id !== userId) ?? null,
        // answer_count is public to the couple; the content is not.
        partnerHasAnswered: session.answer_count >= (sessionAnswers.some((answer) => answer.user_id === userId) ? 2 : 1),
        revealed,
        startedByMe: session.started_by === userId,
      };
    }).sort(byNewestFirst);

    setLoaded({ coupleId, categories, sessions: details, settings });
  }, [coupleId, userId]);

  const runLoad = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!coupleId) return;
    if (!options.silent) setLoading(true);
    try {
      await load();
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The question library could not be loaded.';
      setError(message);
    } finally {
      if (!options.silent) setLoading(false);
    }
  }, [coupleId, load]);

  useEffect(() => {
    if (!coupleId) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        await load();
        if (!cancelled) setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'The question library could not be loaded.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [coupleId, load]);

  // --- Live updates ------------------------------------------------------------------
  useEffect(() => {
    if (!coupleId) return;
    let channel: DiscussChannel;
    try {
      channel = subscribeToDiscuss(coupleId, {
        onChange: () => {
          // Re-read instead of patching: what comes back is exactly what row-level
          // security allows this phone to see right now, reveal included.
          if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current);
          reloadTimer.current = window.setTimeout(() => {
            reloadTimer.current = null;
            void runLoad({ silent: true });
          }, RELOAD_DEBOUNCE_MS);
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Live questions are unavailable right now.';
      // Reported outside this effect so the subscription never changes state mid-render.
      queueMicrotask(() => setError(message));
      return;
    }

    return () => {
      channel.close();
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current);
      reloadTimer.current = null;
    };
  }, [coupleId, runLoad]);

  const sessions = current?.sessions ?? NO_SESSIONS;
  const categories = current?.categories ?? NO_CATEGORIES;
  const settings = current?.settings ?? NO_SETTINGS;

  const mySetting = useMemo(
    () => settings.find((row) => row.user_id === userId) ?? null,
    [settings, userId],
  );
  const partnerSetting = useMemo(
    () => settings.find((row) => row.user_id !== userId) ?? null,
    [settings, userId],
  );

  // No categories at all means the library exists but holds no rows yet: the owner has
  // not imported their CSV. A missing table or RPC surfaces as `error` instead.
  const libraryEmpty = !loading && !error && categories.length === 0;

  const migrationMissing = Boolean(error && /database needs an update/i.test(error));

  const pendingCount = useMemo(
    () => sessions.filter((detail) => !detail.revealed && !detail.myAnswer).length,
    [sessions],
  );

  const pick = useCallback(async (category: string | null, seriousness: number | null): Promise<PickResult> => {
    setBusy(true);
    try {
      const result = await pickQuestion(category, seriousness);
      setError(null);
      return { question: result.question, remaining: result.remaining, total: result.total };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'That question could not be picked.';
      setError(message);
      return { question: null, remaining: 0, total: 0 };
    } finally {
      setBusy(false);
    }
  }, []);

  const ask = useCallback(async (questionId: string): Promise<string | null> => {
    setBusy(true);
    try {
      const { sessionId } = await askPartner(questionId);
      setError(null);
      // The new session is on screen immediately, and the partner's phone hears about it.
      await runLoad({ silent: true });
      return sessionId;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That question could not be sent.');
      return null;
    } finally {
      setBusy(false);
    }
  }, [runLoad]);

  const submit = useCallback(async (sessionId: string, value: AnswerValue) => {
    if (!userId) throw new Error('Please sign in again to answer.');
    setBusy(true);
    try {
      await submitAnswer(sessionId, userId, value);
      setError(null);
      await runLoad({ silent: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Your answer could not be saved.';
      setError(message);
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  }, [runLoad, userId]);

  const revise = useCallback(async (answerId: string, value: AnswerValue) => {
    setBusy(true);
    try {
      await reviseAnswer(answerId, value);
      setError(null);
      await runLoad({ silent: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Your answer could not be changed.';
      setError(message);
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  }, [runLoad]);

  const comment = useCallback(async (sessionId: string, text: string) => {
    if (!userId) throw new Error('Please sign in again to comment.');
    setBusy(true);
    try {
      await saveComment(sessionId, userId, text);
      setError(null);
      await runLoad({ silent: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Your comment could not be saved.';
      setError(message);
      throw new Error(message);
    } finally {
      setBusy(false);
    }
  }, [runLoad, userId]);

  const setAdultEnabled = useCallback(async (enabled: boolean) => {
    if (!coupleId || !userId) throw new Error('Please sign in again to change this setting.');
    setAdultSaving(true);
    try {
      const saved = await saveAdultPreference(coupleId, userId, enabled);
      // Show the new state at once, then re-read: turning the category on or off changes
      // which questions this couple may see, so the counts have to come from the server.
      setLoaded((state) => (state && state.coupleId === coupleId
        ? { ...state, settings: [...state.settings.filter((row) => row.user_id !== saved.user_id), saved] }
        : state));
      setError(null);
      await runLoad({ silent: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'That setting could not be saved.';
      setError(message);
      throw new Error(message);
    } finally {
      setAdultSaving(false);
    }
  }, [coupleId, runLoad, userId]);

  return {
    categories,
    sessions,
    loading,
    busy,
    adultSaving,
    error,
    libraryEmpty,
    migrationMissing,
    // Both partners, or nobody: the category closes again the moment one of them opts out.
    adultEnabled: Boolean(mySetting?.adult_questions_enabled && partnerSetting?.adult_questions_enabled),
    myAdultEnabled: Boolean(mySetting?.adult_questions_enabled),
    partnerAdultEnabled: Boolean(partnerSetting?.adult_questions_enabled),
    pendingCount,
    refresh: () => runLoad(),
    clearError: () => setError(null),
    pick,
    ask,
    submit,
    revise,
    comment,
    setAdultEnabled,
  };
}
