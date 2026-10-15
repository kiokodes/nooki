import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  TETRIS_BEAT_MS, TETRIS_COLS, TETRIS_ROWS, TETRIS_RUN_TICKS, TETRIS_TICK_MS,
  advanceTetrisTo, createTetrisState, queueTetrisAction, replayTetris, tetrisEndLabel,
  tetrisGhostCells, tetrisLevel, tetrisNextKind, tetrisSpawnCells, tetrisTickBudget,
  type TetrisAction, type TetrisInput, type TetrisState,
} from '../../lib/tetris';

export interface TetrisBoardProps {
  /** The piece sequence the database dealt for this duel, in the order they appear. */
  pieces: number[];
  /** Where an already-live run had got to, when this phone is picking one back up. */
  resume?: { ticks: number; inputs: TetrisInput[] } | null;
  /** A practice run: nothing is reported, nothing counts, and leaving costs nothing. */
  warmUp?: boolean;
  /** True while the server still counts this run as live. When it turns false the board stops. */
  live?: boolean;
  onBeat?: (ticks: number, inputs: TetrisInput[]) => Promise<unknown>;
  onFinish?: (ticks: number, inputs: TetrisInput[]) => Promise<unknown>;
  /** Leaving on purpose. A ranked run's parent asks first; a warm-up just closes. */
  onExit: () => void;
  /** Offered on the end card when the parent can deal a fresh warm-up. */
  onRestart?: () => void;
}

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
const cellStyle = (x: number, y: number): React.CSSProperties => ({
  left: `${(x / TETRIS_COLS) * 100}%`,
  top: `${(y / TETRIS_ROWS) * 100}%`,
  width: `${100 / TETRIS_COLS}%`,
  height: `${100 / TETRIS_ROWS}%`,
});

/** How far a finger has to travel before it counts as a move, and as a slam. */
const SWIPE_CELL = 22;
const SWIPE_DROP = 44;

/**
 * The well itself. The simulation is the pure core in `lib/tetris.ts` and it is driven by
 * real time, not by animation frames: each frame walks the run forward to however many
 * ticks the clock says have passed, so a phone that was locked, backgrounded or reloading
 * comes back to a well that has already filled up without anyone steering. There is no
 * pause to give.
 *
 * A ranked run reports its progress every couple of seconds. The database keeps the clock
 * and decides the score, so nothing here is trusted: the board can only ever tell the truth
 * about its own run.
 */
export function TetrisBoard({
  pieces, resume = null, warmUp = false, live = true, onBeat, onFinish, onExit, onRestart,
}: TetrisBoardProps) {
  // The run is built once. Every later snapshot from the server is ignored on purpose:
  // re-reading it would rewind a well that is already filling up on this screen.
  const [initial] = useState<TetrisState>(() => (
    resume ? replayTetris(pieces, resume.ticks, resume.inputs) : createTetrisState(pieces)
  ));
  const [state, setState] = useState<TetrisState>(initial);
  const [ended, setEnded] = useState<TetrisState['ended']>(initial.ended);
  const [connection, setConnection] = useState<'waiting' | 'live' | 'trouble'>('waiting');
  /** A finished run the database has not acknowledged yet: it is retried until it has. */
  const [unsavedFinish, setUnsavedFinish] = useState<{ ticks: number; inputs: TetrisInput[] } | null>(null);
  const [awayNote, setAwayNote] = useState<string | null>(null);
  const stateRef = useRef(initial);
  /** Taps the server has not been told about yet. */
  const unsentRef = useRef<TetrisInput[]>([]);
  /** The run has been reported as finished; never finish the same run twice. */
  const appliedRef = useRef(false);
  const gestureRef = useRef<{ x: number; y: number; at: number; dropped: boolean } | null>(null);
  const onBeatRef = useRef(onBeat);
  const onFinishRef = useRef(onFinish);
  useEffect(() => { onBeatRef.current = onBeat; onFinishRef.current = onFinish; });
  // This phone's own clock, anchored so that a run picked back up continues from where it
  // was reported — never from wall-clock arithmetic, which a wrong phone clock would skew.
  const [anchor] = useState(() => performance.now() - initial.ticks * TETRIS_TICK_MS);

  const tap = useCallback((action: TetrisAction) => {
    if (stateRef.current.ended) return;
    stateRef.current = queueTetrisAction(stateRef.current, action);
    setState(stateRef.current);
  }, []);

  const finishRun = useCallback((final: TetrisState) => {
    if (appliedRef.current) return;
    appliedRef.current = true;
    setEnded(final.ended);
    if (warmUp || !onFinishRef.current) return;
    const inputs = unsentRef.current;
    unsentRef.current = [];
    setUnsavedFinish({ ticks: final.ticks, inputs });
    void Promise.resolve(onFinishRef.current(final.ticks, inputs))
      .then(() => setUnsavedFinish(null))
      .catch(() => setConnection('trouble'));
  }, [warmUp]);

  /**
   * A topped-out well is a score, not a forfeit — so a finish that could not get through
   * keeps trying. The database reads a run that stops reporting as someone who walked away,
   * and losing a fair run to a dropped signal would be the one way this game could lie.
   * Reporting the same ending twice is harmless: the second call is told it is already in.
   */
  useEffect(() => {
    const report = onFinishRef.current;
    if (!unsavedFinish || warmUp || !report) return;
    const timer = setInterval(() => {
      void Promise.resolve(report(unsavedFinish.ticks, unsavedFinish.inputs))
        .then(() => { setUnsavedFinish(null); setConnection('live'); })
        .catch(() => setConnection('trouble'));
    }, TETRIS_BEAT_MS);
    return () => clearInterval(timer);
  }, [unsavedFinish, warmUp]);

  // --- The clock: one tick per 50ms of real time, all of it -------------------------
  useEffect(() => {
    if (!live || ended) return;
    let frame = 0;
    const tick = () => {
      frame = scheduleFrame(tick);
      const goal = tetrisTickBudget(performance.now() - anchor);
      const current = stateRef.current;
      if (current.ended || current.ticks >= goal) return;
      const { state: next, applied } = advanceTetrisTo(current, goal);
      if (applied.length) unsentRef.current.push(...applied);
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
      const inputs = unsentRef.current;
      // How much of the queue is going out with this report, counted *before* the call:
      // the array is the live one and the board keeps pushing to it while the report is on
      // the wire, so counting afterwards would quietly drop everything tapped mid-flight —
      // and a tap the server never hears is a replay that no longer matches what was played.
      const reported = inputs.length;
      void Promise.resolve(onBeatRef.current(stateRef.current.ticks, inputs))
        .then(() => {
          // Anything tapped while that report was in flight stays for the next one.
          unsentRef.current = unsentRef.current.slice(reported);
          setConnection('live');
        })
        .catch(() => setConnection('trouble'));
    }, TETRIS_BEAT_MS);
    return () => clearInterval(timer);
  }, [warmUp, live, ended]);

  // --- Keyboard ----------------------------------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = KEY_ACTIONS[event.key];
      if (!action) return;
      event.preventDefault();
      tap(action);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tap]);

  // --- Coming back from a locked phone or a backgrounded tab -----------------------
  // There is no pause, so time out of sight is walked forward the moment the board is
  // running again — the pieces simply kept falling.
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
      if (seconds >= 2) setAwayNote(`You were away ${seconds}s — the pieces kept falling.`);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);
  useEffect(() => {
    if (!awayNote) return;
    const timer = setTimeout(() => setAwayNote(null), 5000);
    return () => clearTimeout(timer);
  }, [awayNote]);

  // The well only changes when a piece comes to rest, so the hundred and sixty cells
  // behind the piece are drawn once per lock rather than twenty times a second.
  const settled = useMemo(() => state.field.map((kind, id) => (
    <div key={id} className={kind ? `tetris-settled tetris-kind-${kind}` : 'tetris-settled tetris-empty'} />
  )), [state.locks]); // eslint-disable-line react-hooks/exhaustive-deps

  const ghost = ended ? [] : tetrisGhostCells(state);
  const next = tetrisNextKind(state);
  const secondsLeft = Math.ceil(((TETRIS_RUN_TICKS - state.ticks) * TETRIS_TICK_MS) / 1000);
  const level = tetrisLevel(state.lines);
  const status = ended
    ? `${tetrisEndLabel(ended)} — ${state.score} points locked in.`
      + (unsavedFinish ? ' Saving your score…' : '')
    : warmUp
      ? `Warm-up · ${state.score} points`
      : connection === 'trouble'
        ? `Not reaching the server — you have 30 seconds before this run is lost. Score ${state.score}.`
        : `Score ${state.score}`;

  return (
    <div className="tetris-run" data-mode={warmUp ? 'warm-up' : 'duel'}>
      <div className="tetris-hud">
        <div className="tetris-score">
          <span>{warmUp ? 'Warm-up points' : 'Points'}</span>
          <strong data-tetris-score={state.score}>{state.score}</strong>
        </div>
        <div className="tetris-hud-side">
          <span>Lines {state.lines} · Level {level}</span>
          <span>{state.ended ? 'Run over' : `${secondsLeft}s left`}</span>
          {warmUp ? <span className="tetris-pill">Not counted</span> : (
            <span className={`tetris-pill tetris-pill-${connection}`} data-tetris-connection={connection}>
              {connection === 'live' ? 'Live' : connection === 'trouble' ? 'No signal' : 'Starting…'}
            </span>
          )}
        </div>
      </div>
      <div className="tetris-cap" aria-hidden="true">
        <i style={{ width: `${(state.ticks / TETRIS_RUN_TICKS) * 100}%` }} />
      </div>

      <div className="tetris-stage">
        <div
          className="tetris-board"
          role="group"
          aria-label="Tetris board"
          data-tetris-board
          onTouchStart={(event) => {
            const touch = event.touches[0];
            gestureRef.current = { x: touch.clientX, y: touch.clientY, at: Date.now(), dropped: false };
          }}
          onTouchMove={(event) => {
            const from = gestureRef.current;
            if (!from) return;
            const touch = event.touches[0];
            const dx = touch.clientX - from.x;
            const dy = touch.clientY - from.y;
            // A downward swipe slams the piece: the one gesture worth its own rule.
            if (!from.dropped && dy > SWIPE_DROP && dy > Math.abs(dx)) {
              from.dropped = true;
              tap('drop');
              return;
            }
            if (Math.abs(dx) < SWIPE_CELL) return;
            tap(dx > 0 ? 'right' : 'left');
            // Re-anchor, so one long drag can walk the piece across the well.
            gestureRef.current = { ...from, x: touch.clientX, y: touch.clientY, dropped: true };
          }}
          onTouchEnd={() => {
            const from = gestureRef.current;
            gestureRef.current = null;
            if (!from || from.dropped) return;
            // A tap that went nowhere is a rotation: the move players reach for most.
            if (Date.now() - from.at < 300) tap('rotate');
          }}
        >
          {settled}
          {ghost.map((cell) => (
            <div key={`ghost-${cell.x}:${cell.y}`} className="tetris-cell tetris-ghost" style={cellStyle(cell.x, cell.y)} />
          ))}
          {state.cells.map((cell) => (
            <div
              key={`piece-${cell.x}:${cell.y}`}
              className={`tetris-cell tetris-kind-${state.kind + 1}`}
              style={cellStyle(cell.x, cell.y)}
            />
          ))}
        </div>

        <div className="tetris-next" aria-label="Next piece">
          <span>Next</span>
          <div className="tetris-next-box">
            {next !== null && tetrisSpawnCells(next).map((cell) => (
              <div
                key={`next-${cell.x}:${cell.y}`}
                className={`tetris-cell tetris-kind-${next + 1}`}
                style={{ left: `${(cell.x - 3) * 25}%`, top: `${(cell.y + 1) * 25}%`, width: '25%', height: '25%' }}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="tetris-pad">
        <div className="tetris-pad-row">
          <button type="button" aria-label="Turn the piece" onClick={() => tap('rotate')}>⟳<small>Turn</small></button>
          <button type="button" aria-label="Slam the piece down" onClick={() => tap('drop')}>⤓<small>Slam</small></button>
        </div>
        <div className="tetris-pad-row">
          <button type="button" aria-label="Move left" onClick={() => tap('left')}>◀</button>
          <button type="button" aria-label="Move down" onClick={() => tap('down')}>▼</button>
          <button type="button" aria-label="Move right" onClick={() => tap('right')}>▶</button>
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
        <button type="button" className="tetris-restart" onClick={onRestart}>Play again</button>
      )}
      <button type="button" className="game-back tetris-exit" onClick={onExit}>
        {warmUp ? '← End warm-up' : '← Leave run (forfeits)'}
      </button>
    </div>
  );
}

const KEY_ACTIONS: Record<string, TetrisAction> = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'down', ArrowUp: 'rotate',
  ' ': 'drop', Spacebar: 'drop',
  a: 'left', d: 'right', s: 'down', w: 'rotate',
  A: 'left', D: 'right', S: 'down', W: 'rotate',
};

export default TetrisBoard;
