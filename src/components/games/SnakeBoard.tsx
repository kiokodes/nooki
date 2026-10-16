import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  SNAKE_BEAT_MS, SNAKE_COLS, SNAKE_ROWS, SNAKE_RUN_TICKS, SNAKE_TICK_MS,
  advanceSnakeTo, createSnakeState, queueSnakeDirection, replaySnake, snakeEndLabel, snakeFood,
  snakeTickBudget, type SnakeChange, type SnakeDirection, type SnakePoint, type SnakeState,
} from '../../lib/snake';

export interface SnakeBoardProps {
  /** The food sequence the database dealt, in the order it appears. */
  foods: SnakePoint[];
  /** Where an already-live run had got to, when this phone is picking one back up. */
  resume?: { ticks: number; dirs: SnakeChange[] } | null;
  /** A practice run: nothing is reported, nothing counts, and leaving costs nothing. */
  warmUp?: boolean;
  /** True while the server still counts this run as live. When it turns false the board stops. */
  live?: boolean;
  onBeat?: (ticks: number, changes: SnakeChange[]) => Promise<unknown>;
  onFinish?: (ticks: number, changes: SnakeChange[]) => Promise<unknown>;
  /** Leaving on purpose. A ranked run's parent asks first; a warm-up just closes. */
  onExit: () => void;
  /** Offered on the end card when the parent can deal a fresh warm-up. */
  onRestart?: () => void;
}

const KEY_DIRECTIONS: Record<string, SnakeDirection> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', a: 'left', s: 'down', d: 'right', W: 'up', A: 'left', S: 'down', D: 'right',
};

/**
 * The frame loop, with a timer fallback: jsdom has no `requestAnimationFrame`, and a board
 * that cannot be rendered under test is a board whose rules are never checked.
 */
const scheduleFrame = (run: () => void): number => (
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : (setTimeout(run, 16) as unknown as number)
);
const cancelFrame = (id: number) => {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
  else clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
};

/** Cells are laid out in percentages, so the board fits whatever width it is given. */
const cellStyle = (cell: SnakePoint): React.CSSProperties => ({
  left: `${(cell.x / SNAKE_COLS) * 100}%`,
  top: `${(cell.y / SNAKE_ROWS) * 100}%`,
  width: `${100 / SNAKE_COLS}%`,
  height: `${100 / SNAKE_ROWS}%`,
});

/**
 * The snake itself. The simulation is the pure core in `lib/snake.ts` and it is driven by
 * real time, not by animation frames: each frame walks the snake forward to however many
 * ticks the clock says have passed, so a phone that was locked, backgrounded or reloading
 * comes back to a snake that has already travelled on. There is no pause to give.
 *
 * A ranked run reports its progress every couple of seconds. The database keeps the clock
 * and decides the score, so nothing here is trusted: the board can only ever tell the
 * truth about its own run.
 */
export function SnakeBoard({
  foods, resume = null, warmUp = false, live = true, onBeat, onFinish, onExit, onRestart,
}: SnakeBoardProps) {
  // The run is built once. Every later snapshot from the server is ignored on purpose:
  // re-reading it would rewind a snake that is already moving on this screen.
  const [initial] = useState<SnakeState>(() => (
    resume ? replaySnake(foods, resume.ticks, resume.dirs) : createSnakeState(foods)
  ));
  const [state, setState] = useState<SnakeState>(initial);
  const [ended, setEnded] = useState<SnakeState['ended']>(initial.ended);
  const [connection, setConnection] = useState<'waiting' | 'live' | 'trouble'>('waiting');
  /** A finished run the database has not acknowledged yet: it is retried until it has. */
  const [unsavedFinish, setUnsavedFinish] = useState<{ ticks: number; changes: SnakeChange[] } | null>(null);
  const [awayNote, setAwayNote] = useState<string | null>(null);
  const stateRef = useRef(initial);
  /** Direction changes the server has not been told about yet. */
  const unsentRef = useRef<SnakeChange[]>([]);
  /** The run has been reported as finished; never finish the same run twice. */
  const appliedRef = useRef(false);
  const touchRef = useRef<SnakePoint | null>(null);
  const onBeatRef = useRef(onBeat);
  const onFinishRef = useRef(onFinish);
  useEffect(() => { onBeatRef.current = onBeat; onFinishRef.current = onFinish; });
  // This phone's own clock, anchored so that a run picked back up continues from where it
  // was reported — never from wall-clock arithmetic, which a wrong phone clock would skew.
  const [anchor] = useState(() => performance.now() - initial.ticks * SNAKE_TICK_MS);

  const steer = useCallback((dir: SnakeDirection) => {
    if (stateRef.current.ended) return;
    stateRef.current = queueSnakeDirection(stateRef.current, dir);
    setState(stateRef.current);
  }, []);

  const finishRun = useCallback((final: SnakeState) => {
    if (appliedRef.current) return;
    appliedRef.current = true;
    setEnded(final.ended);
    if (warmUp || !onFinishRef.current) return;
    const changes = unsentRef.current;
    unsentRef.current = [];
    setUnsavedFinish({ ticks: final.ticks, changes });
    void Promise.resolve(onFinishRef.current(final.ticks, changes))
      .then(() => setUnsavedFinish(null))
      .catch(() => setConnection('trouble'));
  }, [warmUp]);

  /**
   * A crash is a score, not a forfeit — so a finish that could not get through keeps
   * trying. The database reads a run that stops reporting as someone who walked away, and
   * losing a fair run to a dropped signal would be the one way this game could lie.
   * Reporting the same ending twice is harmless: the second call is told it is already in.
   */
  useEffect(() => {
    const report = onFinishRef.current;
    if (!unsavedFinish || warmUp || !report) return;
    const timer = setInterval(() => {
      void Promise.resolve(report(unsavedFinish.ticks, unsavedFinish.changes))
        .then(() => { setUnsavedFinish(null); setConnection('live'); })
        .catch(() => setConnection('trouble'));
    }, SNAKE_BEAT_MS);
    return () => clearInterval(timer);
  }, [unsavedFinish, warmUp]);

  // --- The clock: one tick per 160ms of real time, all of it ------------------------
  useEffect(() => {
    if (!live || ended) return;
    let frame = 0;
    const tick = () => {
      frame = scheduleFrame(tick);
      const goal = snakeTickBudget(performance.now() - anchor);
      const current = stateRef.current;
      if (current.ended || current.ticks >= goal) return;
      const { state: next, changes } = advanceSnakeTo(current, goal);
      // Only the turns the snake actually took are reported: a press that was ignored
      // (straight back into the neck) never happened as far as the replay is concerned.
      if (changes.length) unsentRef.current.push(...changes);
      stateRef.current = next;
      setState(next);
      if (next.ended) finishRun(next);
    };
    frame = scheduleFrame(tick);
    return () => cancelFrame(frame);
  }, [live, ended, anchor, finishRun]);

  // --- Progress reports: the heartbeat the 30-second grace window measures ----------
  useEffect(() => {
    if (warmUp || !live || ended) return;
    const timer = setInterval(() => {
      if (appliedRef.current || !onBeatRef.current) return;
      const changes = unsentRef.current;
      // How much of the queue is going out with this report, counted *before* the call:
      // the array is the live one and the board keeps pushing to it while the report is on
      // the wire, so counting afterwards would quietly drop everything tapped mid-flight —
      // and a tap the server never hears is a replay that no longer matches what was played.
      const reported = changes.length;
      void Promise.resolve(onBeatRef.current(stateRef.current.ticks, changes))
        .then(() => {
          // Anything added while that report was in flight stays for the next one.
          unsentRef.current = unsentRef.current.slice(reported);
          setConnection('live');
        })
        .catch(() => setConnection('trouble'));
    }, SNAKE_BEAT_MS);
    return () => clearInterval(timer);
  }, [warmUp, live, ended]);

  // --- Keyboard ----------------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const dir = KEY_DIRECTIONS[event.key];
      if (!dir) return;
      event.preventDefault();
      steer(dir);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [steer]);

  // --- Coming back from a locked phone or a backgrounded tab -----------------------
  // There is no pause, so time out of sight is walked forward the moment the board is
  // running again — the snake simply carried on without anyone steering it.
  useEffect(() => {
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = performance.now();
        return;
      }
      if (hiddenAt === null) return;
      const seconds = Math.round((performance.now() - hiddenAt) / 1000);
      hiddenAt = null;
      if (seconds >= 2) setAwayNote(`You were away ${seconds}s — the snake kept moving.`);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  useEffect(() => {
    if (!awayNote) return;
    const timer = setTimeout(() => setAwayNote(null), 5000);
    return () => clearTimeout(timer);
  }, [awayNote]);

  const food = snakeFood(state);
  const secondsLeft = Math.ceil(((SNAKE_RUN_TICKS - state.ticks) * SNAKE_TICK_MS) / 1000);
  const status = ended
    ? `${snakeEndLabel(ended)} — ${state.score} food locked in.`
      + (unsavedFinish ? ' Saving your score…' : '')
    : warmUp
      ? `Warm-up · ${state.score} food`
      : connection === 'trouble'
        ? `Not reaching the server — you have 30 seconds before this run is lost. Score ${state.score}.`
        : `Score ${state.score}`;

  return (
    <div className="snake-run" data-mode={warmUp ? 'warm-up' : 'duel'}>
      <div className="snake-hud">
        <div className="snake-score">
          <span>{warmUp ? 'Warm-up food' : 'Food'}</span>
          <strong data-snake-score={state.score}>{state.score}</strong>
        </div>
        <div className="snake-hud-side">
          <span>Length {state.body.length}</span>
          <span>{state.ended ? 'Run over' : `${secondsLeft}s left`}</span>
          {warmUp ? <span className="snake-pill">Not counted</span> : (
            <span className={`snake-pill snake-pill-${connection}`} data-snake-connection={connection}>
              {connection === 'live' ? 'Live' : connection === 'trouble' ? 'No signal' : 'Starting…'}
            </span>
          )}
        </div>
      </div>
      <div className="snake-cap" aria-hidden="true">
        <i style={{ width: `${(state.ticks / SNAKE_RUN_TICKS) * 100}%` }} />
      </div>

      <div
        className="snake-board"
        role="group"
        aria-label="Snake board"
        onTouchStart={(event) => {
          const touch = event.touches[0];
          touchRef.current = { x: touch.clientX, y: touch.clientY };
        }}
        onTouchMove={(event) => {
          const from = touchRef.current;
          if (!from) return;
          const touch = event.touches[0];
          const dx = touch.clientX - from.x;
          const dy = touch.clientY - from.y;
          if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
          steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
          // Re-anchor, so a long drag can steer again and again.
          touchRef.current = { x: touch.clientX, y: touch.clientY };
        }}
        onTouchEnd={() => { touchRef.current = null; }}
      >
        {state.body.map((cell, index) => (
          <div
            key={`${cell.x}:${cell.y}`}
            className={index === 0 ? 'snake-cell snake-head' : 'snake-cell snake-body'}
            style={cellStyle(cell)}
          />
        ))}
        {food && <div className="snake-cell snake-food" style={cellStyle(food)} />}
      </div>

      <div className="snake-dpad">
        <div className="snake-dpad-row">
          <button type="button" aria-label="Steer up" onClick={() => steer('up')}>▲</button>
        </div>
        <div className="snake-dpad-row">
          <button type="button" aria-label="Steer left" onClick={() => steer('left')}>◀</button>
          <button type="button" aria-label="Steer down" onClick={() => steer('down')}>▼</button>
          <button type="button" aria-label="Steer right" onClick={() => steer('right')}>▶</button>
        </div>
      </div>

      <p className="game-status" role="status" aria-live="polite">{status}</p>
      {awayNote && <p className="game-hint" role="status">{awayNote}</p>}
      {!warmUp && !ended && (
        <p className="game-hint">
          No pause, ever: leave this screen and the duel is forfeited, and a phone that goes
          quiet for 30 seconds loses the run.
        </p>
      )}
      {ended && !warmUp && unsavedFinish && connection === 'trouble' && (
        <p className="game-hint" role="status">
          Your score is safe — it just has not reached the server yet, and it will keep trying.
        </p>
      )}
      {ended && warmUp && onRestart && (
        <button type="button" className="snake-restart" onClick={onRestart}>Play again</button>
      )}
      <button type="button" className="game-back snake-exit" onClick={onExit}>
        {warmUp ? '← End warm-up' : '← Leave run (forfeits)'}
      </button>
    </div>
  );
}

export default SnakeBoard;
