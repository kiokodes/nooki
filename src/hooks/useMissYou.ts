import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MISS_YOU_HISTORY_DAYS,
  dayKeyDaysAgo,
  fetchMissYouTaps,
  receiveMissYouTaps,
  recordMissYouTap,
} from '../lib/missYouService';
import { batchKey, pendingBatch, tapDateKey, waitingTaps, type MissYouBatch } from '../lib/missYou';
import type { MissYouTap } from '../types/database';

interface UseMissYouOptions {
  /** The shared couple, or null while the account is still unpaired. */
  coupleId: string | null;
  /** The signed-in account (the one who taps). */
  userId: string | null;
  /** The other partner, whose taps are the ones this phone gets to open. */
  partnerId: string | null;
  /** Live presence of the other partner: the button is offered only while they are away. */
  partnerOnline: boolean;
  /** False while the app is hidden or the splash is still up. Nothing is opened unseen. */
  active: boolean;
}

export interface MissYouState {
  /** True when the little button belongs in the nook — paired, and the partner is away. */
  available: boolean;
  /** This phone's taps that the partner has not opened yet: the number on the button. */
  sentCount: number;
  /** The partner's taps waiting to become the big heart, or null. */
  reveal: MissYouBatch | null;
  error: string | null;
  /** One tap. Instant on screen, counted in the database. */
  tap: () => Promise<void>;
  dismissReveal: () => void;
}

interface Snapshot {
  /** The couple + accounts this reading belongs to, so another couple never flashes up. */
  scope: string;
  sentCount: number;
  reveal: MissYouBatch | null;
}

/**
 * The "I miss you" button and the heart it eventually becomes.
 *
 * Two halves, one table. While the partner is away this phone counts taps; when the partner
 * comes back, their phone reads the waiting batch, opens it (one heart, then it fades) and
 * the database marks it received — which is the reset. Only the *waiting* taps are ever
 * counted, so the wording never repeats what was already opened.
 */
export function useMissYou({
  coupleId,
  userId,
  partnerId,
  partnerOnline,
  active,
}: UseMissYouOptions): MissYouState {
  const scope = coupleId && userId && partnerId ? `${coupleId}:${userId}:${partnerId}` : null;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null);
  // A batch is opened once per session, however many times the tabs change hands. Tagged
  // with the scope, because a different couple or account starts from nothing.
  const openedRef = useRef<{ scope: string; keys: Set<string> } | null>(null);
  // Taps can overlap; only the newest answer may move the count on the button.
  const tapSeqRef = useRef(0);
  // Errors are read the same way the snapshot is: only by the couple they belong to.
  const error = failure && failure.scope === scope ? failure.message : null;

  /** Moves the reading for one scope, starting from empty when there is nothing yet. */
  const edit = useCallback((forScope: string, update: (current: Snapshot) => Snapshot) => {
    setSnapshot((current) => update(
      current && current.scope === forScope ? current : { scope: forScope, sentCount: 0, reveal: null },
    ));
  }, []);

  const load = useCallback(async () => {
    if (!scope || !coupleId || !userId || !partnerId) return;
    const rows = await fetchMissYouTaps(coupleId, dayKeyDaysAgo(MISS_YOU_HISTORY_DAYS));
    const mine = rows.filter((row: MissYouTap) => row.sender_id === userId);
    const theirs = rows.filter((row: MissYouTap) => row.sender_id === partnerId);
    const batch = pendingBatch(theirs, tapDateKey());

    if (!openedRef.current || openedRef.current.scope !== scope) {
      openedRef.current = { scope, keys: new Set<string>() };
    }
    const opened = openedRef.current.keys;

    let opening: MissYouBatch | null = null;
    if (batch) {
      const key = batchKey(partnerId, batch);
      if (!opened.has(key)) {
        opened.add(key);
        opening = batch;
        // Receiving is the reset: the database marks the batch as opened in the same step
        // it hands it over, so the next peek finds nothing waiting.
        try {
          await receiveMissYouTaps(partnerId);
        } catch {
          // The heart is already on its way; a failed reset only means it may come again
          // next time the app opens, which is the safe way to be wrong.
        }
      }
    }

    setSnapshot((current) => {
      // A heart that is still on screen is not replaced by a read of the same batch.
      const keepReveal = current && current.scope === scope && !opening ? current.reveal : null;
      return { scope, sentCount: waitingTaps(mine), reveal: opening ?? keepReveal };
    });
    setFailure(null);
  }, [coupleId, partnerId, scope, userId]);

  // Peek when the couple is ready and again whenever the app comes back to the front, which
  // is the moment a partner is most likely to have left something behind.
  useEffect(() => {
    if (!scope || !active) return;
    let cancelled = false;
    void (async () => {
      try {
        await load();
      } catch (err) {
        if (cancelled || !scope) return;
        setFailure({ scope, message: err instanceof Error ? err.message : 'Your miss-yous could not be loaded.' });
      }
    })();
    return () => { cancelled = true; };
  }, [scope, active, load]);

  const tap = useCallback(async () => {
    if (!scope || !partnerId) return;
    // The button is only offered while the partner is away; a stale render must not slip a
    // tap through to someone who is right there.
    if (partnerOnline) return;

    const seq = tapSeqRef.current + 1;
    tapSeqRef.current = seq;
    // Instant on screen: the count moves before the round trip, because the tap already
    // happened in the person's hands.
    edit(scope, (current) => ({ ...current, sentCount: current.sentCount + 1 }));

    try {
      const sentCount = await recordMissYouTap(tapDateKey());
      // The database's answer is the count that is really waiting, once it is the newest.
      if (tapSeqRef.current === seq) edit(scope, (current) => ({ ...current, sentCount }));
      setFailure(null);
    } catch (err) {
      if (tapSeqRef.current === seq) {
        edit(scope, (current) => ({ ...current, sentCount: Math.max(0, current.sentCount - 1) }));
      }
      setFailure({ scope, message: err instanceof Error ? err.message : 'That miss-you could not be sent.' });
    }
  }, [edit, partnerId, partnerOnline, scope]);

  const dismissReveal = useCallback(() => {
    if (!scope) return;
    edit(scope, (current) => ({ ...current, reveal: null }));
  }, [edit, scope]);

  const mine = snapshot && snapshot.scope === scope ? snapshot : null;

  return {
    available: Boolean(scope) && !partnerOnline,
    sentCount: mine?.sentCount ?? 0,
    reveal: mine?.reveal ?? null,
    error,
    tap,
    dismissReveal,
  };
}
