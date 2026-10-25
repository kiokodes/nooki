import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cleanEpistleDraft,
  epistleOverflow,
  epistleOverflowMessage,
  sectionEpistles,
} from '../lib/epistle';
import {
  createEpistleDraft,
  deleteEpistleDraft,
  fetchEpistles,
  openEpistle,
  recallEpistle,
  saveEpistleDraft,
  sealEpistle,
} from '../lib/epistleService';
import { toDateKey } from '../lib/calendar';
import { requireSupabase } from '../lib/supabaseClient';
import type { Epistle } from '../types/database';

interface UseEpistlesOptions {
  /** The shared couple, or null while the account is still unpaired. */
  coupleId: string | null;
  /** The signed-in account: whose the drafts are and whose seal is broken. */
  userId: string | null;
  /** False while the splash is up or the account is not ready yet. */
  active: boolean;
}

export interface EpistlesState {
  /** Every letter this phone may see, newest first. The mailbox is derived from it. */
  letters: Epistle[];
  loading: boolean;
  error: string | null;
  /** The partner's sealed letters that can be opened right now: the mailbox's number. */
  unopenedCount: number;
  /** The partner's letters still waiting for their chosen day. */
  waitingCount: number;
  /** My sealed letters still standing unopened in their mailbox. */
  mineCount: number;
  /** My unfinished drafts. */
  draftCount: number;
  /** The current calendar day key, so the derived shelves follow the clock. */
  todayKey: string;

  /** Creates a draft and returns the row the database now holds. */
  createDraft: (title: string, body: string, replyToId?: string | null) => Promise<Epistle>;
  /** Saves a draft's words and returns the saved row. */
  saveDraft: (id: string, title: string, body: string, replyToId?: string | null) => Promise<Epistle>;
  /** Seals a letter: it stands in the partner's mailbox from this moment. */
  seal: (id: string, opensAt: string | null) => Promise<Epistle>;
  /** Takes a still-unopened letter back to draft. */
  recall: (id: string) => Promise<Epistle>;
  /** Breaks the seal on the partner's letter — the database's own ceremony. */
  open: (id: string) => Promise<Epistle>;
  /** Discards a draft. */
  removeDraft: (id: string) => Promise<void>;
  /** Clears the error line. */
  clearError: () => void;
}

/**
 * The couple's letters, alive while the app is awake.
 *
 * One fetch for the mailbox, kept fresh by Realtime: a letter sealed on the other
 * side of the world appears in this mailbox the moment it happens, the way a chat
 * message does. Every action goes to the database first and replaces the row with
 * the answer, so this phone's mailbox never half-matches what is stored.
 */
export function useEpistles({ coupleId, userId, active }: UseEpistlesOptions): EpistlesState {
  const [letters, setLetters] = useState<Epistle[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [todayKey, setTodayKey] = useState(() => toDateKey(new Date()));

  const scope = coupleId && userId ? `${coupleId}:${userId}` : null;
  const scopeRef = useRef(scope);
  useEffect(() => { scopeRef.current = scope; }, [scope]);

  /** Runs one database action, shows its failure as a sentence, and hands the answer on. */
  const wrap = useCallback(async <T,>(work: () => Promise<T>): Promise<T> => {
    setError(null);
    try {
      return await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Your letter could not be saved.');
      throw err;
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!coupleId) return;
    try {
      const rows = await fetchEpistles(coupleId);
      // Only this couple's letters may ever land: a stale answer outlives the account.
      if (scopeRef.current === scope) setLetters(rows);
    } catch (err) {
      if (scopeRef.current === scope) {
        setError(err instanceof Error ? err.message : 'Your letters could not be opened.');
      }
    }
  }, [coupleId, scope]);

  // First load when the app becomes ready, and a re-read whenever the day turns
  // over: a waiting letter whose day arrived should be ready without a restart.
  useEffect(() => {
    if (!coupleId || !userId || !active) return;
    let cancelled = false;
    setLoading(true);
    refresh().finally(() => { if (!cancelled) setLoading(false); });
    const tick = window.setInterval(() => {
      const key = toDateKey(new Date());
      setTodayKey((current) => {
        if (current !== key) {
          void refresh();
          return key;
        }
        return current;
      });
    }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(tick);
    };
  }, [coupleId, userId, active, refresh]);

  // Realtime: the mailbox listens while it exists, whatever tab the phone is on.
  useEffect(() => {
    if (!coupleId || !userId || !active) return;
    const client = requireSupabase();
    const channel = client
      .channel(`epistles:${coupleId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'epistles', filter: `couple_id=eq.${coupleId}` },
        () => { void refresh(); },
      )
      .subscribe();
    return () => {
      void client.removeChannel(channel);
    };
  }, [coupleId, userId, active, refresh]);

  const createDraft = useCallback((title: string, body: string, replyToId?: string | null): Promise<Epistle> => {
    const clean = cleanEpistleDraft(title, body);
    if (!coupleId || !userId || !clean) return Promise.reject(new Error('Write something before saving.'));
    // Refused, never shortened: the database's CHECK would reject it anyway, and this
    // sentence is kinder than a constraint name.
    const overflow = epistleOverflow(clean.body);
    if (overflow > 0) return Promise.reject(new Error(epistleOverflowMessage(overflow)));
    return wrap(async () => {
      const row = await createEpistleDraft(coupleId, userId, { ...clean, replyToId });
      setLetters((current) => [row, ...current.filter((letter) => letter.id !== row.id)]);
      return row;
    });
  }, [wrap, coupleId, userId]);

  const saveDraft = useCallback((id: string, title: string, body: string, replyToId?: string | null): Promise<Epistle> => {
    const clean = cleanEpistleDraft(title, body);
    if (!clean) return Promise.reject(new Error('Write something before saving.'));
    const overflow = epistleOverflow(clean.body);
    if (overflow > 0) return Promise.reject(new Error(epistleOverflowMessage(overflow)));
    return wrap(async () => {
      const row = await saveEpistleDraft(id, { ...clean, replyToId });
      setLetters((current) => current.map((letter) => (letter.id === id ? row : letter)));
      return row;
    });
  }, [wrap]);

  const seal = useCallback((id: string, opensAt: string | null): Promise<Epistle> => wrap(async () => {
    const row = await sealEpistle(id, opensAt);
    setLetters((current) => current.map((letter) => (letter.id === id ? row : letter)));
    return row;
  }), [wrap]);

  const recall = useCallback((id: string): Promise<Epistle> => wrap(async () => {
    const row = await recallEpistle(id);
    setLetters((current) => current.map((letter) => (letter.id === id ? row : letter)));
    return row;
  }), [wrap]);

  const open = useCallback((id: string): Promise<Epistle> => wrap(async () => {
    const row = await openEpistle(id);
    setLetters((current) => current.map((letter) => (letter.id === id ? row : letter)));
    return row;
  }), [wrap]);

  const removeDraft = useCallback((id: string): Promise<void> => wrap(async () => {
    await deleteEpistleDraft(id);
    setLetters((current) => current.filter((letter) => letter.id !== id));
  }), [wrap]);

  const sections = useMemo(
    () => (coupleId && userId ? sectionEpistles(letters, userId, todayKey) : null),
    [letters, coupleId, userId, todayKey],
  );

  return {
    letters,
    loading,
    error,
    unopenedCount: sections?.unopened.length ?? 0,
    waitingCount: sections?.waiting.length ?? 0,
    mineCount: sections?.mine.length ?? 0,
    draftCount: sections?.drafts.length ?? 0,
    todayKey,
    createDraft,
    saveDraft,
    seal,
    recall,
    open,
    removeDraft,
    clearError: () => setError(null),
  };
}
