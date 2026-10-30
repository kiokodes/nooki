import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ageUpRaiseChild,
  decideRaiseChildMoment,
  fetchRaiseChildAlbum,
  fetchRaiseChildState,
  openRaiseChildGift,
  replyToRaiseChildLetter,
  saveRaiseChildSetup,
  startNewRaiseChild,
  submitRaiseChildVote,
  subscribeToRaiseChild,
  type RaiseChildAlbumEntry,
  type RaiseChildSnapshot,
  type SetupInput,
} from '../lib/raiseChildService';

interface UseRaiseChildOptions {
  coupleId: string | null;
  userId: string | null;
}

export interface RaiseChildState {
  snapshot: RaiseChildSnapshot | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  album: RaiseChildAlbumEntry[];
  albumLoading: boolean;
  clearError: () => void;
  refresh: () => Promise<void>;
  saveSetup: (input: SetupInput) => Promise<void>;
  vote: (momentId: string, choiceIndex: number) => Promise<void>;
  /** The lead parent settles a split with their own pick. */
  decide: (momentId: string) => Promise<void>;
  openGift: (giftId: string) => Promise<void>;
  ageUp: () => Promise<void>;
  loadAlbum: (options?: { before?: string | null }) => Promise<void>;
  reply: (note: string) => Promise<void>;
  startNewChild: () => Promise<void>;
}

interface ScopedSnapshot {
  scope: string;
  value: RaiseChildSnapshot;
}

/**
 * One family, as this parent is allowed to see it. Every action re-reads the database's
 * answer rather than guessing, and a realtime nudge only ever triggers a re-read: the
 * phone never decides when a partner's pick becomes visible.
 */
export function useRaiseChild({ coupleId, userId }: UseRaiseChildOptions): RaiseChildState {
  const scope = coupleId && userId ? `${coupleId}:${userId}` : null;
  const scopeRef = useRef(scope);

  const [snapshot, setSnapshot] = useState<ScopedSnapshot | null>(null);
  const [busyScope, setBusyScope] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null);
  const [albumState, setAlbumState] = useState<{ scope: string; entries: RaiseChildAlbumEntry[] } | null>(null);
  const [albumLoading, setAlbumLoading] = useState(false);
  const reloadTimer = useRef<number | null>(null);

  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!scope) return;
    try {
      const next = await fetchRaiseChildState();
      if (scopeRef.current !== scope) return;
      setSnapshot({ scope, value: next });
      setFailure((current) => (current?.scope === scope ? null : current));
    } catch (error) {
      if (scopeRef.current !== scope) return;
      setFailure({ scope, message: error instanceof Error ? error.message : 'The family could not be loaded.' });
    }
  }, [scope]);

  useEffect(() => {
    if (!scope) return;
    void refresh();
  }, [scope, refresh]);

  // One shared subscription per family; a change schedules a single re-read.
  const familyId = snapshot?.scope === scope ? snapshot.value.family?.id ?? null : null;
  useEffect(() => {
    if (!scope || !familyId) return;
    const channel = subscribeToRaiseChild(familyId, {
      onChange: () => {
        if (reloadTimer.current !== null) return;
        reloadTimer.current = window.setTimeout(() => {
          reloadTimer.current = null;
          void refresh();
        }, 400);
      },
    });
    return () => {
      channel.close();
      if (reloadTimer.current !== null) {
        window.clearTimeout(reloadTimer.current);
        reloadTimer.current = null;
      }
    };
  }, [scope, familyId, refresh]);

  const run = useCallback(async (work: () => Promise<RaiseChildSnapshot>): Promise<void> => {
    if (!scope) return;
    setBusyScope(scope);
    setFailure((current) => (current?.scope === scope ? null : current));
    try {
      const next = await work();
      if (scopeRef.current !== scope) return;
      setSnapshot({ scope, value: next });
    } catch (error) {
      if (scopeRef.current !== scope) return;
      setFailure({ scope, message: error instanceof Error ? error.message : 'That did not go through. Please try again.' });
    } finally {
      setBusyScope((current) => (current === scope ? null : current));
    }
  }, [scope]);

  const saveSetup = useCallback((input: SetupInput) => run(() => saveRaiseChildSetup(input)), [run]);
  const vote = useCallback((momentId: string, choiceIndex: number) => run(() => submitRaiseChildVote(momentId, choiceIndex)), [run]);
  const decide = useCallback((momentId: string) => run(() => decideRaiseChildMoment(momentId)), [run]);
  const openGift = useCallback((giftId: string) => run(() => openRaiseChildGift(giftId)), [run]);
  const ageUp = useCallback(() => run(() => ageUpRaiseChild()), [run]);
  const startNewChild = useCallback(() => run(() => startNewRaiseChild()), [run]);

  const loadAlbum = useCallback(async (options: { before?: string | null } = {}): Promise<void> => {
    if (!scope) return;
    setAlbumLoading(true);
    try {
      const entries = await fetchRaiseChildAlbum(40, options.before ?? null);
      if (scopeRef.current !== scope) return;
      setAlbumState((current) => ({
        scope,
        entries: options.before && current?.scope === scope ? [...current.entries, ...entries] : entries,
      }));
    } catch (error) {
      if (scopeRef.current !== scope) return;
      setFailure({ scope, message: error instanceof Error ? error.message : 'The album could not be loaded.' });
    } finally {
      setAlbumLoading(false);
    }
  }, [scope]);

  const reply = useCallback(async (note: string): Promise<void> => {
    if (!scope) return;
    setBusyScope(scope);
    setFailure((current) => (current?.scope === scope ? null : current));
    try {
      await replyToRaiseChildLetter(note);
      const next = await fetchRaiseChildState();
      if (scopeRef.current !== scope) return;
      setSnapshot({ scope, value: next });
      setAlbumState(null);
    } catch (error) {
      if (scopeRef.current !== scope) return;
      setFailure({ scope, message: error instanceof Error ? error.message : 'That note did not go through.' });
    } finally {
      setBusyScope((current) => (current === scope ? null : current));
    }
  }, [scope]);

  return {
    snapshot: snapshot?.scope === scope ? snapshot.value : null,
    loading: Boolean(scope) && snapshot?.scope !== scope && failure?.scope !== scope,
    busy: busyScope === scope,
    error: failure?.scope === scope ? failure.message : null,
    album: albumState?.scope === scope ? albumState.entries : [],
    albumLoading,
    clearError: () => setFailure((current) => (current?.scope === scope ? null : current)),
    refresh,
    saveSetup,
    vote,
    decide,
    openGift,
    ageUp,
    loadAlbum,
    reply,
    startNewChild,
  };
}
