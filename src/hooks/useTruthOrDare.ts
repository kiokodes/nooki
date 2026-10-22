import { useCallback, useEffect, useRef, useState } from 'react';
import {
  acceptTodRound,
  chooseTodPrompt,
  completeTodPrompt,
  confirmTodAge,
  endTodRound,
  fetchTodState,
  pauseTodRound,
  resumeTodRound,
  startTodRound,
  subscribeToTod,
  type TodPromptType,
  type TodSnapshot,
  type TodTheme,
} from '../lib/truthOrDare';

interface UseTruthOrDareOptions {
  coupleId: string | null;
  userId: string | null;
  partnerId: string | null;
}

interface ScopedSnapshot {
  scope: string;
  value: TodSnapshot;
}

export interface TruthOrDareState {
  snapshot: TodSnapshot | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  confirmAge: (minimumAge: 18 | 20) => Promise<void>;
  startRound: (theme: TodTheme) => Promise<void>;
  acceptRound: (roundId: string) => Promise<void>;
  choosePrompt: (roundId: string, type: TodPromptType) => Promise<void>;
  completePrompt: (roundId: string, result: 'done' | 'skip') => Promise<void>;
  pauseRound: (roundId: string) => Promise<void>;
  resumeRound: (roundId: string) => Promise<void>;
  endRound: (roundId: string) => Promise<void>;
}

/** The database is the referee; Realtime is the nudge that both phones reload the room. */
export function useTruthOrDare({ coupleId, userId, partnerId }: UseTruthOrDareOptions): TruthOrDareState {
  const scope = coupleId && userId ? `${coupleId}:${userId}` : null;
  const scopeRef = useRef(scope);
  const [loaded, setLoaded] = useState<ScopedSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = loaded?.scope === scope ? loaded.value : null;

  useEffect(() => { scopeRef.current = scope; }, [scope]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!scope) return;
    const target = scope;
    try {
      const value = await fetchTodState();
      if (scopeRef.current === target) {
        setLoaded({ scope: target, value });
        setError(null);
      }
    } catch (cause) {
      if (scopeRef.current === target) {
        setError(cause instanceof Error ? cause.message : 'Truth or Dare could not be loaded.');
      }
    }
  }, [scope]);

  useEffect(() => {
    if (!coupleId || !userId || !partnerId || !scope) return;
    let cancelled = false;
    let channel: ReturnType<typeof subscribeToTod> | null = null;
    let reloadTimer: number | null = null;
    const loadSilently = () => {
      if (!cancelled) void refresh();
    };
    const queueReload = () => {
      if (reloadTimer !== null) window.clearTimeout(reloadTimer);
      reloadTimer = window.setTimeout(() => {
        reloadTimer = null;
        loadSilently();
      }, 180);
    };

    // The initial fetch is an external read; show its scoped loading state until it resolves.
    // eslint-disable-next-line react/set-state-in-effect
    setLoading(true);
    void refresh().finally(() => { if (!cancelled) setLoading(false); });
    try {
      channel = subscribeToTod(coupleId, userId, partnerId, queueReload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Live Truth or Dare updates are unavailable.');
    }

    // Realtime is primary. A foreground refresh is a small safety net for a phone that
    // slept through a socket reconnect or returned from another app.
    const fallback = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadSilently();
    }, 15_000);
    const onVisible = () => { if (document.visibilityState === 'visible') loadSilently(); };
    window.addEventListener('focus', loadSilently);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      channel?.close();
      window.clearInterval(fallback);
      window.removeEventListener('focus', loadSilently);
      document.removeEventListener('visibilitychange', onVisible);
      if (reloadTimer !== null) window.clearTimeout(reloadTimer);
    };
  }, [coupleId, partnerId, refresh, scope, userId]);

  const run = useCallback(async (action: () => Promise<unknown>): Promise<void> => {
    if (!scope) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That action could not be saved. Please try again.');
    } finally {
      setBusy(false);
    }
  }, [refresh, scope]);

  return {
    snapshot: current,
    loading,
    busy,
    error,
    refresh,
    confirmAge: (minimumAge) => run(() => confirmTodAge(minimumAge)),
    startRound: (theme) => run(() => startTodRound(theme)),
    acceptRound: (roundId) => run(() => acceptTodRound(roundId)),
    choosePrompt: (roundId, type) => run(() => chooseTodPrompt(roundId, type)),
    completePrompt: (roundId, result) => run(() => completeTodPrompt(roundId, result)),
    pauseRound: (roundId) => run(() => pauseTodRound(roundId)),
    resumeRound: (roundId) => run(() => resumeTodRound(roundId)),
    endRound: (roundId) => run(() => endTodRound(roundId)),
  };
}
