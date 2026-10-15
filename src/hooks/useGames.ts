import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  beatSnakeRun, fetchGames, finishSnakeRun, forfeitSnakeRun, playChess, playGame, startChess, startGame, startSnakeRun,
  type GameId, type GameMatch, type GamesSnapshot, type SnakeRun,
} from '../lib/gamesService';
import type { ChessMode } from '../lib/chess';
import type { SnakeChange } from '../lib/snake';

/**
 * True while this phone still owes a move in a match: the Games tab badge.
 *
 * Tic-tac-toe hands the turn back and forth, so it is this phone's move when the
 * turn points at it. Rock-paper-scissors waits for a locked-in pick from each
 * side, so it is this phone's move until it has locked its own pick in.
 * A snake duel waits for one run from each partner: it is this phone's move until
 * it has played its run, and while that run is still live.
 */
export function needsMyMove(match: GameMatch, userId: string | null): boolean {
  if (!userId || match.finished) return false;
  if (match.game === 'tic-tac-toe') return match.turn_id === userId;
  if (match.game === 'chess') return match.turn_id === userId;
  if (match.game === 'snake') return !match.snake?.mine || match.snake.mine.status === 'running';
  return !match.my_pick;
}

interface PendingAction { scope: string; game: GameId | null }
interface FailedAction extends PendingAction { message: string; action: () => Promise<void> }

export function useGames(coupleId: string | null, userId: string | null) {
  const scope = `${coupleId}:${userId}`;
  const current = useRef(scope);
  useEffect(() => {
    current.current = scope;
    return () => { current.current = ''; };
  }, [scope]);
  const [stored, setStored] = useState<{ scope: string; data: GamesSnapshot } | null>(null);
  const [selected, setSelected] = useState<{ scope: string; id: string } | null>(null);
  const [connectionError, setConnectionError] = useState<{ scope: string; message: string } | null>(null);
  const [failure, setFailure] = useState<FailedAction | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const lock = useRef<PendingAction | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    if (!coupleId || !userId) return;
    const version = ++request.current;
    try {
      const data = await fetchGames();
      if (current.current === scope && version === request.current) {
        setStored({ scope, data });
        // A successful read says nothing about whether the last action worked.
        // In particular, an old database can read Games but cannot start Snake.
        setConnectionError(null);
      }
    } catch (e) {
      if (current.current === scope && version === request.current) {
        setConnectionError({ scope, message: (e as Error).message });
      }
    }
  }, [scope, coupleId, userId]);
  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => {
      // The action refresh must not be superseded by a background read.
      if (!document.hidden && lock.current?.scope !== scope) void refresh();
    }, 2000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [refresh, scope]);
  const data = stored?.scope === scope ? stored.data : null;
  const activeFailure = failure?.scope === scope ? failure : null;
  const error = activeFailure?.message ?? (connectionError?.scope === scope ? connectionError.message : null);
  const busy = pending?.scope === scope;
  /** Matches still waiting on this phone — the Games tab badge, like the chat's. */
  const pendingCount = useMemo(
    () => (data ? data.matches.filter((match) => needsMyMove(match, userId)).length : 0),
    [data, userId],
  );
  const run = async (action: () => Promise<void>, game: GameId | null = null) => {
    if (lock.current?.scope === scope) return;
    const ticket = { scope, game };
    lock.current = ticket;
    setPending(ticket);
    setFailure(null);
    try {
      await action();
      if (current.current === scope) await refresh();
    } catch (e) {
      if (current.current === scope) setFailure({ scope, game, message: (e as Error).message, action });
    } finally {
      if (lock.current === ticket) lock.current = null;
      // Clear this ticket even if the account changed, without clearing a newer
      // account's action (or leaving the old account permanently busy on return).
      if (current.current) setPending(active => active === ticket ? null : active);
    }
  };
  const match = data?.matches.find(m => selected?.scope === scope && m.id === selected.id);
  /** A live ranked run must be forfeited before navigating away. */
  const snakeLive = Boolean(match && !match.finished && match.game === 'snake' && match.snake?.mine?.status === 'running');
  /** Progress reports must not disable the controls or wipe an action error. */
  const beat = useCallback(async (matchId: string, ticks: number, changes: SnakeChange[]): Promise<SnakeRun> =>
    beatSnakeRun(matchId, ticks, changes), []);
  const finish = useCallback(async (matchId: string, ticks: number, changes: SnakeChange[]): Promise<SnakeRun> => {
    const entry = await finishSnakeRun(matchId, ticks, changes);
    await refresh();
    return entry;
  }, [refresh]);
  return {
    data, error, busy, refresh, pendingCount, match, snakeLive,
    errorGame: activeFailure?.game ?? null,
    pendingGame: busy ? pending.game : null,
    // Retrying a failed start must actually start/resume the game, not just read Games.
    retry: () => activeFailure ? run(activeFailure.action, activeFailure.game) : refresh(),
    select: (id: string | null) => { setFailure(null); setSelected(id ? { scope, id } : null); },
    start: (game: GameId, daily = false, bestOf = 3) => run(async () => {
      const id = await startGame(game, daily, bestOf);
      if (current.current === scope) setSelected({ scope, id });
    }, game),
    play: (match: GameMatch, move: string) => run(async () => { await playGame(match, move); }, match.game),
    /** Start (or resume) the couple's open chess match in the chosen situational mode. */
    startChess: (mode: ChessMode) => run(async () => {
      const id = await startChess(mode);
      if (current.current === scope) setSelected({ scope, id });
    }, 'chess'),
    /** One chess move (or `resign`) through the database referee. */
    playChess: (match: GameMatch, move: string) => run(async () => { await playChess(match, move); }, 'chess'),
    /** Deal this phone's one run. Resuming a live run hands the same one back. */
    startSnake: (matchId: string) => run(async () => { await startSnakeRun(matchId); }, 'snake'),
    beat,
    finish,
    /** If an exit cannot reach the server, the grace window still forfeits the run. */
    forfeitSnake: (matchId: string) => run(async () => { await forfeitSnakeRun(matchId); }, 'snake'),
  };
}
export type GamesState = ReturnType<typeof useGames>;
