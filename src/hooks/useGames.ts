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

export function useGames(coupleId: string | null, userId: string | null) {
  const scope = `${coupleId}:${userId}`;
  const current = useRef(scope);
  useEffect(() => { current.current = scope; }, [scope]);
  const [stored, setStored] = useState<{ scope: string; data: GamesSnapshot } | null>(null);
  const [selected, setSelected] = useState<{ scope: string; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    if (!coupleId || !userId) return;
    const version = ++request.current;
    try {
      const data = await fetchGames();
      if (current.current === scope && version === request.current) { setStored({ scope, data }); setError(null); }
    } catch (e) { if (current.current === scope && version === request.current) setError((e as Error).message); }
  }, [scope, coupleId, userId]);
  useEffect(() => {
    // Network reads update state asynchronously, not during effect setup.
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 2000);
    return () => { clearTimeout(initial); clearInterval(timer); };
  }, [refresh]);
  const data = stored?.scope === scope ? stored.data : null;
  /** Matches still waiting on this phone — the Games tab badge, like the chat's. */
  const pendingCount = useMemo(
    () => (data ? data.matches.filter((match) => needsMyMove(match, userId)).length : 0),
    [data, userId],
  );
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try { await action(); await refresh(); }
    catch (e) { if (current.current === scope) setError((e as Error).message); }
    finally { lock.current = false; setBusy(false); }
  };
  const match = data?.matches.find(m => selected?.scope === scope && m.id === selected.id);
  /**
   * True while this phone is in the middle of a ranked snake run. The app asks before
   * letting a tab change end it: a live run that is left behind is a forfeit.
   */
  const snakeLive = Boolean(match && !match.finished && match.game === 'snake' && match.snake?.mine?.status === 'running');
  /**
   * Progress reports. These deliberately skip the shared busy flag: they happen every
   * couple of seconds behind the board's back, and must not disable the buttons or wipe
   * an error the couple needs to read. The board reports its own connection trouble.
   */
  const beat = useCallback(async (matchId: string, ticks: number, changes: SnakeChange[]): Promise<SnakeRun> =>
    beatSnakeRun(matchId, ticks, changes), []);
  const finish = useCallback(async (matchId: string, ticks: number, changes: SnakeChange[]): Promise<SnakeRun> => {
    const entry = await finishSnakeRun(matchId, ticks, changes);
    await refresh();
    return entry;
  }, [refresh]);
  return {
    data, error, busy, refresh, pendingCount, match, snakeLive,
    select: (id: string | null) => setSelected(id ? { scope, id } : null),
    start: (game: GameId, daily = false, bestOf = 3) => run(async () => {
      const id = await startGame(game, daily, bestOf);
      if (current.current === scope) setSelected({ scope, id });
    }),
    play: (match: GameMatch, move: string) => run(async () => { await playGame(match, move); }),
    /** Start (or resume) the couple's open chess match in the chosen situational mode. */
    startChess: (mode: ChessMode) => run(async () => {
      const id = await startChess(mode);
      if (current.current === scope) setSelected({ scope, id });
    }),
    /** One chess move (or `resign`) through the database referee. */
    playChess: (match: GameMatch, move: string) => run(async () => { await playChess(match, move); }),
    /** Deal the food and start this phone's one run. Resuming a live run hands the same one back. */
    startSnake: (matchId: string) => run(async () => { await startSnakeRun(matchId); }),
    beat,
    finish,
    /**
     * Walking out of a live run. Best effort by design: if the call cannot get through,
     * the run is lost to the grace window anyway, so the caller carries on.
     */
    forfeitSnake: (matchId: string) => run(async () => { await forfeitSnakeRun(matchId); }),
  };
}
export type GamesState = ReturnType<typeof useGames>;
