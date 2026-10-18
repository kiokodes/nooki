import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchDailyDecisionState,
  subscribeToDailyDecision,
  submitDailyDecisionChoice,
  type DailyDecisionChannel,
} from '../lib/dailyDecisionService';
import type { DailyDecisionSnapshot } from '../types/database';

interface UseDailyDecisionOptions {
  coupleId: string | null;
  userId: string | null;
}

export interface DailyDecisionState extends DailyDecisionSnapshot {
  loading: boolean;
  busy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  submitChoice: (optionIndex: number) => Promise<void>;
}

interface ScopedSnapshot {
  scope: string;
  value: DailyDecisionSnapshot;
}

const EMPTY_SNAPSHOT: DailyDecisionSnapshot = {
  today: '',
  question: null,
  my_choice: null,
  partner_choice: null,
  partner_responded: false,
  both_answered: false,
  agreed: false,
};

/**
 * The one daily decision for this couple, fetched through the database's privacy-safe RPC.
 * A live change only triggers a reload; the client never decides when a partner's choice
 * should become visible.
 */
export function useDailyDecision({ coupleId, userId }: UseDailyDecisionOptions): DailyDecisionState {
  const scope = coupleId && userId ? `${coupleId}:${userId}` : null;
  const scopeRef = useRef(scope);

  const [snapshot, setSnapshot] = useState<ScopedSnapshot | null>(null);
  const [busyScope, setBusyScope] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null);
  const reloadTimer = useRef<number | null>(null);

  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!scope) return;
    const target = scope;
    try {
      const value = await fetchDailyDecisionState();
      if (scopeRef.current === target) {
        setSnapshot({ scope: target, value });
        setFailure(null);
      }
    } catch (error) {
      if (scopeRef.current === target) {
        setFailure({
          scope: target,
          message: error instanceof Error ? error.message : 'Today’s decision could not be loaded. Please try again.',
        });
      }
    }
  }, [scope]);

  useEffect(() => {
    if (!scope || !coupleId) return;
    let cancelled = false;
    let channel: DailyDecisionChannel | null = null;
    const loadSilently = () => {
      if (!cancelled) void refresh();
    };
    const queueReload = () => {
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current);
      reloadTimer.current = window.setTimeout(() => {
        reloadTimer.current = null;
        loadSilently();
      }, 250);
    };

    // This is the initial read from the external database; its async result supplies the scoped snapshot.
    // eslint-disable-next-line react/set-state-in-effect
    void refresh();
    try {
      channel = subscribeToDailyDecision(coupleId, { onChange: queueReload });
    } catch {
      // The submission path still refreshes directly; a missing socket should not block a choice.
    }

    // If the app stays open across UTC midnight, fetch the next scheduled prompt then.
    const nextUtcMidnight = new Date();
    nextUtcMidnight.setUTCHours(24, 0, 0, 0);
    const midnightTimer = window.setTimeout(
      loadSilently,
      Math.max(1_000, nextUtcMidnight.getTime() - Date.now() + 1_000),
    );
    // Progress status ("partner has replied") deliberately contains no answer payload,
    // so the hidden response row may not emit a Realtime event to the other device.
    // A light foreground refresh keeps that status live without opening the answer.
    const progressTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadSilently();
    }, 10_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') loadSilently();
    };
    window.addEventListener('focus', loadSilently);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      if (scopeRef.current === scope) scopeRef.current = null;
      channel?.close();
      window.clearTimeout(midnightTimer);
      window.clearInterval(progressTimer);
      window.removeEventListener('focus', loadSilently);
      document.removeEventListener('visibilitychange', onVisible);
      if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current);
      reloadTimer.current = null;
    };
  }, [coupleId, refresh, scope]);

  const submitChoice = useCallback(async (optionIndex: number): Promise<void> => {
    if (!scope) return;
    const target = scope;
    setBusyScope(target);
    setFailure(null);
    try {
      await submitDailyDecisionChoice(optionIndex);
      await refresh();
    } catch (error) {
      if (scopeRef.current === target) {
        setFailure({
          scope: target,
          message: error instanceof Error ? error.message : 'Your choice could not be saved. Please try again.',
        });
      }
    } finally {
      setBusyScope((currentScope) => currentScope === target ? null : currentScope);
    }
  }, [refresh, scope]);

  const current = snapshot?.scope === scope ? snapshot.value : EMPTY_SNAPSHOT;
  const error = failure?.scope === scope ? failure.message : null;
  const loading = Boolean(scope && snapshot?.scope !== scope && failure?.scope !== scope);
  const busy = busyScope === scope;
  return { ...current, loading, busy, error, refresh, submitChoice };
}
