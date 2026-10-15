/**
 * The Tetris duel's game core: pure, deterministic, and shared by the phone and the
 * database.
 *
 * A run is nothing but a piece sequence plus the list of taps the player made. Both the
 * phone and the database replay those two to arrive at the same board, the same score and
 * the same top-out — which is how the database can verify a score it never watched (see
 * `supabase/migrations/202610150011_tetris_duel.sql`). That only works while this file
 * stays free of randomness, timers and DOM access, and while every rule here has a twin in
 * SQL: if you change a constant or a rule, change it in both places, or honest runs will
 * be disqualified.
 *
 * The rules are the reference implementation's — github.com/KPaccarizi/_Tetris_Game, a
 * Pygame coding-challenge entry — with the pygame loop rewritten as a tick simulation so
 * it can be replayed: a 10×16 well, the same seven tetrominoes spawning at (5, 1),
 * rotation about the piece's first cell, the same `{1:100, 2:300, 3:700, 4:1500}` line
 * scores, and gravity that quickens as lines are cleared (the reference nudges its
 * `anim_speed` up by three per cleared line; here that becomes a level table).
 *
 * Three places deliberately part company with the reference, and all three are noted in
 * the README:
 *   · the reference's row-collapse leaves a stale copy of the top row behind after a
 *     clear. Here the rows that scroll in are empty, as they have to be.
 *   · the reference ends a run when any cell of the top row is filled. Here a run ends
 *     when a freshly spawned piece has nowhere to go — the usual rule, and one that
 *     cannot be skewed by which piece happens to be next.
 *   · the reference lets a rotation wander off the top of the board (Python happily
 *     indexes `field[-1]`). Here it is simply refused, like any other illegal move.
 *
 * One tick is 50ms, so a five-minute run is 6000 ticks.
 */

/** Board width in cells. Mirrored by `tetris_replay`'s `cols`. */
export const TETRIS_COLS = 10;
/** Board height in cells. */
export const TETRIS_ROWS = 16;
/** How long one step of the clock takes, in milliseconds. */
export const TETRIS_TICK_MS = 50;
/** How long a single run may last before it ends on its own. */
export const TETRIS_RUN_SECONDS = 300;
/** The longest a run can be, in ticks. Mirrored by `tetris_max_ticks`. */
export const TETRIS_RUN_TICKS = Math.floor((TETRIS_RUN_SECONDS * 1000) / TETRIS_TICK_MS);
/** How long the phone may go quiet (locked, backgrounded, offline) before the run is lost. */
export const TETRIS_GRACE_SECONDS = 30;
/** How often the phone reports its progress while a ranked run is live. */
export const TETRIS_BEAT_MS = 2000;
/** How many pieces the database deals per duel. Both partners play the same sequence. */
export const TETRIS_PIECE_COUNT = 600;
/** Column the middle of a new piece sits in. */
export const TETRIS_SPAWN_X = 5;
/** Row a new piece's origin sits in. */
export const TETRIS_SPAWN_Y = 1;
/** The level the speed curve stops at, reached at a hundred lines. */
export const TETRIS_MAX_LEVEL = 10;
/** How many taps may be acted on in a single tick. */
export const TETRIS_INPUTS_PER_TICK = 2;
/** How many taps may wait for the next tick. The rest are dropped, not banked. */
export const TETRIS_QUEUE = 2;
/** Points for clearing 0, 1, 2, 3 or 4 rows at once. The reference's own table. */
export const TETRIS_LINE_SCORE = [0, 100, 300, 700, 1500];
/**
 * Ticks a piece waits before it falls one row, by level. Level rises one step per ten
 * lines, so a run starts at 0.75s a row and bottoms out at 0.15s. Mirrored exactly by
 * `tetris_replay`'s `gravity`.
 */
export const TETRIS_GRAVITY = [15, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3];

/**
 * The seven tetrominoes, as cell offsets from the piece's origin. The first cell of each
 * is the pivot the piece turns around, which is the reference's own rule, and why a piece
 * keeps its shape as it rotates rather than drifting across the well.
 *
 * Mirrored by `tetris_replay`'s `shapes`.
 */
export const TETRIS_SHAPES: readonly (readonly (readonly [number, number])[])[] = [
  [[-1, 0], [-2, 0], [0, 0], [1, 0]], // I
  [[0, -1], [-1, -1], [-1, 0], [0, 0]], // O
  [[-1, 0], [-1, 1], [0, 0], [0, -1]], // S
  [[0, 0], [-1, 0], [0, 1], [-1, -1]], // Z
  [[0, 0], [0, -1], [0, 1], [-1, -1]], // J
  [[0, 0], [0, -1], [0, 1], [1, -1]], // L
  [[0, 0], [0, -1], [0, 1], [-1, 0]], // T
];

export type TetrisAction = 'left' | 'right' | 'rotate' | 'down' | 'drop';

export const TETRIS_ACTIONS: TetrisAction[] = ['left', 'right', 'rotate', 'down', 'drop'];

/** One tap, applied on the tick it names. */
export interface TetrisInput {
  tick: number;
  action: TetrisAction;
}

/** How a run ended: the well filled up, the five minutes ran out, or a forfeit. */
export type TetrisEnd = 'top' | 'cap' | 'forfeit';

/** The two ways a duel can be decided. */
export type TetrisMode = 'sprint' | 'survival';

export const TETRIS_MODES: TetrisMode[] = ['sprint', 'survival'];

export interface TetrisPoint {
  x: number;
  y: number;
}

export interface TetrisState {
  /** The well, row by row: 0 for an empty cell, otherwise the piece's kind plus one. */
  field: number[];
  /** The pieces the database dealt for this duel, in the order they appear. */
  pieces: number[];
  /** How many pieces have been spawned so far. */
  piece: number;
  /** The four cells of the piece in play. */
  cells: TetrisPoint[];
  /** Which tetromino the piece in play is, 0–6. */
  kind: number;
  /** Ticks since the piece last fell a row on its own. */
  fall: number;
  lines: number;
  score: number;
  /** How many pieces have come to rest. Drives the UI's board redraw, nothing else. */
  locks: number;
  /** How many ticks have been simulated. */
  ticks: number;
  /** Taps queued for the next tick, oldest first. */
  pending: TetrisAction[];
  /** Null while the run is alive; set once it is over. */
  ended: TetrisEnd | null;
}

export function isTetrisAction(value: unknown): value is TetrisAction {
  return typeof value === 'string' && (TETRIS_ACTIONS as string[]).includes(value);
}

export function isTetrisMode(value: unknown): value is TetrisMode {
  return typeof value === 'string' && (TETRIS_MODES as string[]).includes(value);
}

/** The level a run is on: one step per ten lines, and it stops at ten. */
export function tetrisLevel(lines: number): number {
  return Math.min(Math.max(Math.floor(lines / 10), 0), TETRIS_MAX_LEVEL);
}

/** Ticks a piece waits before falling a row, at the level this run has reached. */
export function tetrisGravityTicks(lines: number): number {
  return TETRIS_GRAVITY[tetrisLevel(lines)] ?? TETRIS_GRAVITY[TETRIS_MAX_LEVEL];
}

export function tetrisCellId(point: TetrisPoint): number {
  return point.y * TETRIS_COLS + point.x;
}

/** Where a piece of this kind appears: the reference's spawn, in the middle near the top. */
export function tetrisSpawnCells(kind: number): TetrisPoint[] {
  const shape = TETRIS_SHAPES[kind] ?? TETRIS_SHAPES[0];
  return shape.map(([x, y]) => ({ x: TETRIS_SPAWN_X + x, y: TETRIS_SPAWN_Y + y }));
}

export function createTetrisState(pieces: number[]): TetrisState {
  const dealt = pieces.length ? pieces : [];
  const kind = dealt[0] ?? 0;
  return {
    field: new Array<number>(TETRIS_COLS * TETRIS_ROWS).fill(0),
    pieces: dealt,
    piece: 0,
    cells: dealt.length ? tetrisSpawnCells(kind) : [],
    kind,
    fall: 0,
    lines: 0,
    score: 0,
    locks: 0,
    ticks: 0,
    pending: [],
    // No pieces dealt means nothing to play: the run is over before it starts.
    ended: dealt.length ? null : 'cap',
  };
}

/** Which tetromino comes next, for the preview beside the well. */
export function tetrisNextKind(state: TetrisState): number | null {
  if (!state.pieces.length) return null;
  return state.pieces[(state.piece + 1) % state.pieces.length] ?? null;
}

/** True if any of these cells is out of the well or already taken. */
export function tetrisCollides(state: TetrisState, cells: TetrisPoint[]): boolean {
  for (const cell of cells) {
    if (cell.x < 0 || cell.x >= TETRIS_COLS || cell.y < 0 || cell.y >= TETRIS_ROWS) return true;
    if (state.field[tetrisCellId(cell)]) return true;
  }
  return false;
}

/**
 * Where the piece would land if it were dropped now. Drawn as a shadow under the piece;
 * it takes no part in the run and the database never sees it.
 */
export function tetrisGhostCells(state: TetrisState): TetrisPoint[] {
  let cells = state.cells;
  for (;;) {
    const moved = cells.map((cell) => ({ x: cell.x, y: cell.y + 1 }));
    if (tetrisCollides(state, moved)) return cells;
    cells = moved;
  }
}

/**
 * Bring a piece to rest: stamp it into the well, drop out any full rows, score them, and
 * spawn the next piece — or end the run if the next piece has nowhere to go.
 */
function tetrisLock(state: TetrisState): TetrisState {
  const field = state.field.slice();
  for (const cell of state.cells) {
    if (cell.x < 0 || cell.x >= TETRIS_COLS || cell.y < 0 || cell.y >= TETRIS_ROWS) continue;
    field[tetrisCellId(cell)] = state.kind + 1;
  }
  // Collapse from the bottom up, keeping every row that is not full. Rows that scroll in
  // at the top arrive empty — the reference leaves a stale copy behind instead.
  const next = new Array<number>(TETRIS_COLS * TETRIS_ROWS).fill(0);
  let write = TETRIS_ROWS - 1;
  let cleared = 0;
  for (let row = TETRIS_ROWS - 1; row >= 0; row -= 1) {
    let full = true;
    for (let col = 0; col < TETRIS_COLS; col += 1) {
      if (!field[row * TETRIS_COLS + col]) { full = false; break; }
    }
    if (full) { cleared += 1; continue; }
    for (let col = 0; col < TETRIS_COLS; col += 1) {
      next[write * TETRIS_COLS + col] = field[row * TETRIS_COLS + col];
    }
    write -= 1;
  }
  const lines = state.lines + cleared;
  const piece = state.piece + 1;
  const kind = state.pieces[piece % state.pieces.length] ?? 0;
  const cells = tetrisSpawnCells(kind);
  const settled: TetrisState = {
    ...state,
    field: next,
    lines,
    score: state.score + (TETRIS_LINE_SCORE[cleared] ?? 0),
    piece,
    kind,
    cells,
    fall: 0,
    locks: state.locks + 1,
  };
  return { ...settled, ended: tetrisCollides(settled, cells) ? 'top' : null };
}

/**
 * One tap. A tap that cannot be carried out is ignored, and nothing else happens. A hard
 * drop slides the piece to its resting place and asks the caller to lock it — one piece
 * comes to rest per tick, so a second tap in the same tick never lands on the fresh piece.
 */
function tetrisApply(state: TetrisState, action: TetrisAction): { state: TetrisState; locked: boolean } {
  if (state.ended || !state.cells.length) return { state, locked: false };
  switch (action) {
    case 'left':
    case 'right': {
      const step = action === 'left' ? -1 : 1;
      const moved = state.cells.map((cell) => ({ x: cell.x + step, y: cell.y }));
      return { state: tetrisCollides(state, moved) ? state : { ...state, cells: moved }, locked: false };
    }
    case 'down': {
      const moved = state.cells.map((cell) => ({ x: cell.x, y: cell.y + 1 }));
      // Soft drop only rests the gravity clock; it never locks the piece. That is what
      // the hard drop is for, and it keeps a panicked player from ending their own run.
      return { state: tetrisCollides(state, moved) ? state : { ...state, cells: moved, fall: 0 }, locked: false };
    }
    case 'rotate': {
      const pivot = state.cells[0];
      const turned = state.cells.map((cell) => {
        const rx = cell.x - pivot.x;
        const ry = cell.y - pivot.y;
        return { x: pivot.x - ry, y: pivot.y + rx };
      });
      return { state: tetrisCollides(state, turned) ? state : { ...state, cells: turned }, locked: false };
    }
    default: {
      let cells = state.cells;
      for (;;) {
        const moved = cells.map((cell) => ({ x: cell.x, y: cell.y + 1 }));
        if (tetrisCollides(state, moved)) break;
        cells = moved;
      }
      return { state: { ...state, cells }, locked: true };
    }
  }
}

/**
 * Buffer a tap. The queue is capped, so a flurry of taps cannot bank moves that fire
 * long after the player made them — and a tap the queue had no room for was never played,
 * so it is never reported either.
 */
export function queueTetrisAction(state: TetrisState, action: TetrisAction): TetrisState {
  if (state.ended || state.pending.length >= TETRIS_QUEUE) return state;
  if (!isTetrisAction(action)) return state;
  return { ...state, pending: [...state.pending, action] };
}

/**
 * Simulate one tick: act on the taps waiting for it, then let gravity have its say,
 * locking the piece and spawning the next one if it can fall no further.
 *
 * `applied` is every tap the tick acted on, which is what the phone records as the run's
 * history — including the ones that changed nothing, because the replay has to walk the
 * same list through the same rules to land on the same board.
 */
export function stepTetris(state: TetrisState): { state: TetrisState; applied: TetrisInput[] } {
  if (state.ended) return { state, applied: [] };
  const tick = state.ticks;
  const applied: TetrisInput[] = [];
  let current = state;
  let used = 0;
  let locked = false;
  while (current.pending.length && used < TETRIS_INPUTS_PER_TICK) {
    const [action, ...pending] = current.pending;
    applied.push({ tick, action });
    used += 1;
    const next = tetrisApply({ ...current, pending }, action);
    current = next.state;
    locked = next.locked;
    // A hard drop is the last word this tick has: one piece comes to rest per tick.
    if (locked) break;
  }
  if (!locked) {
    const fall = current.fall + 1;
    if (fall >= tetrisGravityTicks(current.lines)) {
      const moved = current.cells.map((cell) => ({ x: cell.x, y: cell.y + 1 }));
      if (tetrisCollides(current, moved)) locked = true;
      else current = { ...current, cells: moved, fall: 0 };
    } else {
      current = { ...current, fall };
    }
  }
  // One place in the whole run where a piece comes to rest, and the database has the same
  // one: see `tetris_replay`.
  if (locked) current = tetrisLock(current);
  current = { ...current, ticks: tick + 1 };
  if (!current.ended && current.ticks >= TETRIS_RUN_TICKS) current = { ...current, ended: 'cap' };
  return { state: current, applied };
}

/**
 * Advance the run until it has caught up with `target` ticks, or topped out, or hit the
 * cap. This is what makes a run unpausable: time spent with the phone locked or the tab in
 * the background is walked forward in one go, with pieces simply stacking up wherever they
 * were last headed.
 */
export function advanceTetrisTo(
  state: TetrisState,
  target: number,
): { state: TetrisState; applied: TetrisInput[] } {
  let current = state;
  const applied: TetrisInput[] = [];
  const goal = Math.min(target, TETRIS_RUN_TICKS);
  while (!current.ended && current.ticks < goal) {
    const { state: next, applied: used } = stepTetris(current);
    if (used.length) applied.push(...used);
    current = next;
  }
  return { state: current, applied };
}

/**
 * Rebuild a run from its history: the database's piece sequence, the taps that were
 * reported, and how many ticks they cover. Used when a phone picks a live run back up
 * after a reload, and as the reference implementation the SQL replay has to agree with.
 */
export function replayTetris(pieces: number[], ticks: number, inputs: TetrisInput[]): TetrisState {
  let state = createTetrisState(pieces);
  const byTick = new Map<number, TetrisAction[]>();
  for (const input of inputs) {
    if (!Number.isInteger(input.tick) || input.tick < 0 || !isTetrisAction(input.action)) continue;
    const queued = byTick.get(input.tick);
    if (queued) queued.push(input.action);
    else byTick.set(input.tick, [input.action]);
  }
  const goal = Math.min(Math.max(ticks, 0), TETRIS_RUN_TICKS);
  while (!state.ended && state.ticks < goal) {
    const queued = byTick.get(state.ticks) ?? [];
    // The queue cap bites here exactly as it did on the phone, so a tap the phone dropped
    // is a tap the replay drops too.
    for (const action of queued.slice(0, TETRIS_QUEUE)) state = queueTetrisAction(state, action);
    state = stepTetris(state).state;
  }
  return state;
}

/**
 * How many ticks a run may have reported after `elapsedMs` of real time. The server
 * checks the same ceiling; the phone uses it to prove it has not been sped up.
 */
export function tetrisTickBudget(elapsedMs: number): number {
  return Math.min(Math.max(Math.floor(elapsedMs / TETRIS_TICK_MS), 0), TETRIS_RUN_TICKS);
}

/**
 * Pieces for a practice run. Ranked runs never use this: their sequence is dealt by the
 * database and shared by both partners, which is what makes the score it replays out of it
 * beyond argument. A warm-up is meant to be free of all that, so a little randomness here
 * is the point.
 */
export function dealPracticePieces(count = TETRIS_PIECE_COUNT): number[] {
  return Array.from({ length: count }, () => Math.floor(Math.random() * TETRIS_SHAPES.length));
}

/** A short label for how a run ended, in the couple's own words. */
export function tetrisEndLabel(end: TetrisEnd | 'alive' | null): string {
  switch (end) {
    case 'top': return 'The well filled up';
    case 'cap': return 'Five minutes up';
    case 'forfeit': return 'You left the run';
    default: return 'Still stacking';
  }
}

/** The one-line difference between the two modes, for the gate and the library card. */
export function tetrisModeLabel(mode: TetrisMode): string {
  return mode === 'sprint' ? 'Highest score in five minutes' : 'Last one stacking wins';
}

export interface TetrisSideSummary {
  status: 'waiting' | 'running' | 'done' | 'forfeit';
  score: number;
  ticks: number;
}

/**
 * Who won a duel, in the words of whoever is holding the phone: `'mine'`, `'theirs'` or
 * `'draw'`, or `null` while it is still open. The database decides this for real
 * (`tetris_settle`); the phone and the preview use the same arithmetic to show the same
 * result, and the database test holds the two against each other.
 */
export function tetrisDecide(
  mode: TetrisMode,
  mine: TetrisSideSummary | null,
  theirs: TetrisSideSummary | null,
): 'mine' | 'theirs' | 'draw' | null {
  if (!mine || !theirs) return null;
  if (mine.status === 'forfeit' || theirs.status === 'forfeit') {
    if (mine.status === 'forfeit' && theirs.status === 'forfeit') return 'draw';
    return mine.status === 'forfeit' ? 'theirs' : 'mine';
  }
  if (mine.status !== 'done' || theirs.status !== 'done') return null;
  if (mode === 'sprint') {
    if (mine.score === theirs.score) return 'draw';
    return mine.score > theirs.score ? 'mine' : 'theirs';
  }
  // Survival: whoever stayed alive longer. A score tie-break only when both runs lasted
  // exactly as long, which in practice means both ran the clock out.
  if (mine.ticks !== theirs.ticks) return mine.ticks > theirs.ticks ? 'mine' : 'theirs';
  if (mine.score === theirs.score) return 'draw';
  return mine.score > theirs.score ? 'mine' : 'theirs';
}
