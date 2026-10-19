import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  beatDashRun, beatSnakeRun, beatTetrisRun, cancelWordRound, fetchGames, finishDashRun, finishSnakeRun,
  finishTetrisRun, forfeitDashRun, forfeitSnakeRun, forfeitTetrisRun, playChess, playConnectFour, playGame,
  readyWordRound, startChess, startConnectFour, startDash, startDashRun, startGame, startSnakeRun, startTetris,
  startTetrisRun, startWordAttempt, startWordRound, submitWordRound,
  type DashMatchMode, type DashRun, type GameId, type GameMatch, type GamesSnapshot, type SnakeRun,
  type TetrisRun, type WordRound,
} from '../lib/gamesService';
import type { ChessMode } from '../lib/chess';
import type { SnakeChange } from '../lib/snake';
import type { TetrisInput, TetrisMode } from '../lib/tetris';
import type { DashLevel, DashAction } from '../lib/dash';
import type { WordDuration, WordLevel } from '../lib/wordWheel';

/**
 * True while this phone still owes a move in a match: the Games tab badge.
 *
 * Rock-paper-scissors waits for a locked-in pick from each side, so it is this
 * phone's move until it has locked its own pick in. Chess hands the turn back and
 * forth. A duel — Snake or Tetris — waits for one run from each partner: it is this
 * phone's move until it has played its run, and while that run is still live.
 */
export function needsMyMove(match: GameMatch, userId: string | null): boolean {
  if (!userId || match.finished) return false;
  if (match.game === 'chess') return match.turn_id === userId;
  if (match.game === 'snake') return !match.snake?.mine || match.snake.mine.status === 'running';
  if (match.game === 'tetris') return !match.tetris?.mine || match.tetris.mine.status === 'running';
  if (match.game === 'dash-duel') return !match.dash?.mine || match.dash.mine.status === 'running';
  if (match.game === 'word-wheel') {
    const round = match.word;
    if (!round) return true;
    // Each partner starts and finishes their own clock independently; a sweep may
    // have already zero-filled an attempt that never started.
    return !round.mine.submitted && (!round.mine.started || round.status === 'running');
  }
  if (match.game === 'connect-four') return match.turn_id === userId;
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
  /**
   * Which game this phone is in the middle of a ranked run in, if any — `'snake'`,
   * `'tetris'` or `null`. The app asks before letting a tab change end one: a live run
   * that is left behind is a forfeit.
   */
  const duelLive: 'snake' | 'tetris' | 'dash-duel' | null = match && !match.finished
    && match.game === 'snake' && match.snake?.mine?.status === 'running' ? 'snake'
    : match && !match.finished && match.game === 'tetris' && match.tetris?.mine?.status === 'running' ? 'tetris'
      : match && !match.finished && match.game === 'dash-duel' && match.dash?.mine?.status === 'running' ? 'dash-duel'
        : null;
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
  /** Tetris progress reports: the same heartbeat, carrying the taps instead of the turns. */
  const beatTetris = useCallback(async (matchId: string, ticks: number, inputs: TetrisInput[]): Promise<TetrisRun> =>
    beatTetrisRun(matchId, ticks, inputs), []);
  const finishTetris = useCallback(async (matchId: string, ticks: number, inputs: TetrisInput[]): Promise<TetrisRun> => {
    const entry = await finishTetrisRun(matchId, ticks, inputs);
    await refresh();
    return entry;
  }, [refresh]);
  /** Dash progress reports do not take the shared UI lock; the board keeps steering. */
  const beatDash = useCallback(async (matchId: string, ticks: number, actions: DashAction[]): Promise<DashRun> =>
    beatDashRun(matchId, ticks, actions), []);
  const finishDash = useCallback(async (matchId: string, ticks: number, actions: DashAction[]): Promise<DashRun> => {
    const entry = await finishDashRun(matchId, ticks, actions);
    await refresh();
    return entry;
  }, [refresh]);
  return {
    data, error, busy, refresh, pendingCount, match, duelLive,
    errorGame: activeFailure?.game ?? null,
    pendingGame: busy ? pending.game : null,
    // Retrying a failed start must actually start/resume the game, not just read Games.
    retry: () => activeFailure ? run(activeFailure.action, activeFailure.game) : refresh(),
    select: (id: string | null) => { setFailure(null); setSelected(id ? { scope, id } : null); },
    start: (game: GameId, bestOf = 3) => run(async () => {
      const id = await startGame(game, bestOf);
      if (current.current === scope) setSelected({ scope, id });
    }, game),
    play: (match: GameMatch, move: string) => run(async () => { await playGame(match, move); }, match.game),
    startConnectFour: () => run(async () => { const id = await startConnectFour(); if (current.current === scope) setSelected({ scope, id }); }, 'connect-four'),
    playConnectFour: (match: GameMatch, column: number) => run(async () => { await playConnectFour(match, column); }, 'connect-four'),
    /** Open (or resume) a Tetris duel in the chosen mode: sprint or survival. */
    startTetrisDuel: (mode: TetrisMode) => run(async () => {
      const id = await startTetris(mode);
      if (current.current === scope) setSelected({ scope, id });
    }, 'tetris'),
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
    /**
     * Walking out of a live run. Best effort by design: if the call cannot get through,
     * the run is lost to the grace window anyway, so the caller carries on.
     */
    forfeitSnake: (matchId: string) => run(async () => { await forfeitSnakeRun(matchId); }, 'snake'),
    /** Hand this phone the duel's pieces and start its one run. Same resuming rule as snake. */
    startTetris: (matchId: string) => run(async () => { await startTetrisRun(matchId); }, 'tetris'),
    beatTetris,
    finishTetris,
    forfeitTetris: (matchId: string) => run(async () => { await forfeitTetrisRun(matchId); }, 'tetris'),
    /** Open/resume a shared Dash course in challenge or presence-gated live-together mode. */
    startDashDuel: (mode: DashMatchMode, level: DashLevel) => run(async () => {
      const id = await startDash(mode, level);
      if (current.current === scope) setSelected({ scope, id });
    }, 'dash-duel'),
    startDash: (matchId: string) => run(async () => { await startDashRun(matchId); }, 'dash-duel'),
    beatDash,
    finishDash,
    forfeitDash: (matchId: string) => run(async () => { await forfeitDashRun(matchId); }, 'dash-duel'),
    /** Set or resume the couple's asynchronous Word Wheel challenge with these settings. */
    startWordRound: (level: WordLevel, seconds: WordDuration) => run(async () => {
      const id = await startWordRound(level, seconds);
      if (current.current === scope) setSelected({ scope, id });
    }, 'word-wheel'),
    /** Start this phone's own timed attempt; the partner can start later. */
    startWordAttempt: (matchId: string) => run(async () => { await startWordAttempt(matchId); }, 'word-wheel'),
    /** Legacy alias for clients that still show the old ready button. */
    readyWord: (matchId: string) => run(async () => { await readyWordRound(matchId); }, 'word-wheel'),
    /**
     * A timed-round result is submitted behind the board's back, like a duel
     * heartbeat: it must not take the shared lock or disable the exit button.
     */
    submitWord: useCallback(async (matchId: string, words: string[], finishedMs: number): Promise<WordRound> => {
      const round = await submitWordRound(matchId, words, finishedMs);
      await refresh();
      return round;
    }, [refresh]),
    cancelWord: (matchId: string) => run(async () => { await cancelWordRound(matchId); }, 'word-wheel'),
  };
}
export type GamesState = ReturnType<typeof useGames>;
