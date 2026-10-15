/**
 * The Snake duel's game core: pure, deterministic, and shared by the phone and the
 * database.
 *
 * A run is nothing but a food sequence plus the list of direction changes the player
 * made. Both the phone and the database replay those two to arrive at the same snake,
 * the same score and the same crash — which is how the database can verify a score it
 * never watched (see `supabase/migrations/202610150010_snake_duel.sql`). That only
 * works while this file stays free of randomness, timers and DOM access, and while
 * every rule here has a twin in SQL: if you change a constant or a rule, change it in
 * both places, or honest runs will be disqualified.
 *
 * The board is 20×20 cells (the size the Coding Challenges spec suggests), the snake
 * starts four cells long in the middle travelling right, and one tick is 160ms — so a
 * run lasts at most 1500 ticks, or four minutes.
 */

/** Board width in cells. Mirrored by `snake_replay`'s `cols`. */
export const SNAKE_COLS = 20;
/** Board height in cells. */
export const SNAKE_ROWS = 20;
/** How long one step of the snake takes, in milliseconds. */
export const SNAKE_TICK_MS = 160;
/** How long a single run may last before it ends on its own. */
export const SNAKE_RUN_SECONDS = 240;
/** The longest a run can be, in ticks. Mirrored by `snake_max_ticks`. */
export const SNAKE_RUN_TICKS = Math.floor((SNAKE_RUN_SECONDS * 1000) / SNAKE_TICK_MS);
/** How long the phone may go quiet (locked, backgrounded, offline) before the run is lost. */
export const SNAKE_GRACE_SECONDS = 30;
/** How often the phone reports its progress while a ranked run is live. */
export const SNAKE_BEAT_MS = 2000;
/** The snake's length when a run starts. */
export const SNAKE_START_LENGTH = 4;
/** How many cells of food the database deals out per run. */
export const SNAKE_FOOD_COUNT = 200;

export type SnakeDirection = 'up' | 'down' | 'left' | 'right';

export const SNAKE_DIRECTIONS: SnakeDirection[] = ['up', 'down', 'left', 'right'];

export interface SnakePoint {
  x: number;
  y: number;
}

/** One direction change, applied on the tick it names. */
export interface SnakeChange {
  tick: number;
  dir: SnakeDirection;
}

/** How a run ended: a wall, the snake's own body, the four-minute cap, or a forfeit. */
export type SnakeEnd = 'wall' | 'self' | 'cap' | 'forfeit';

export interface SnakeState {
  /** Body cells, head first. */
  body: SnakePoint[];
  /** The direction the snake is travelling in right now. */
  dir: SnakeDirection;
  /** Presses queued for the next ticks, oldest first. */
  pending: SnakeDirection[];
  /** The food the database dealt for this run, in the order it appears. */
  foods: SnakePoint[];
  /** Index into `foods` of the food currently on the board. */
  nextFood: number;
  score: number;
  /** How many ticks have been simulated. */
  ticks: number;
  /** Null while the snake is alive; set once the run is over. */
  ended: SnakeEnd | null;
}

export function isSnakeDirection(value: unknown): value is SnakeDirection {
  return typeof value === 'string' && (SNAKE_DIRECTIONS as string[]).includes(value);
}

export function snakeDirectionDelta(dir: SnakeDirection): { dx: number; dy: number } {
  switch (dir) {
    case 'up': return { dx: 0, dy: -1 };
    case 'down': return { dx: 0, dy: 1 };
    case 'left': return { dx: -1, dy: 0 };
    default: return { dx: 1, dy: 0 };
  }
}

/** Turning straight back into your own neck is not a move — the key press is ignored. */
export function isOppositeDirection(a: SnakeDirection, b: SnakeDirection): boolean {
  const { dx, dy } = snakeDirectionDelta(a);
  const other = snakeDirectionDelta(b);
  return dx === -other.dx && dy === -other.dy;
}

export function snakeCellId(point: SnakePoint): number {
  return point.y * SNAKE_COLS + point.x;
}

/** The cells the snake starts on: four across the middle, heading right. */
export function snakeStartBody(): SnakePoint[] {
  const x = Math.floor(SNAKE_COLS / 2);
  const y = Math.floor(SNAKE_ROWS / 2);
  return Array.from({ length: SNAKE_START_LENGTH }, (_, i) => ({ x: x - i, y }));
}

export function createSnakeState(foods: SnakePoint[]): SnakeState {
  return {
    body: snakeStartBody(),
    dir: 'right',
    pending: [],
    foods,
    nextFood: 0,
    score: 0,
    ticks: 0,
    ended: null,
  };
}

/** The food on the board right now, or null once the dealt sequence runs out. */
export function snakeFood(state: SnakeState): SnakePoint | null {
  return state.foods[state.nextFood] ?? null;
}

/**
 * Buffer a press. The queue is capped at two so a flurry of taps cannot bank a turn
 * that fires long after the player made it.
 */
export function queueSnakeDirection(state: SnakeState, dir: SnakeDirection): SnakeState {
  if (state.ended || state.pending.length >= 2) return state;
  return { ...state, pending: [...state.pending, dir] };
}

/**
 * Simulate one tick: take the next usable direction out of the queue, move the head,
 * eat any food under it (which lengthens the snake by a cell) and end the run if the
 * head met a wall or the body.
 *
 * `applied` is the change the snake actually accepted, which is what the phone records
 * as the run's history — a press that was ignored is never logged, so the database's
 * replay can apply the log as-is.
 */
export function stepSnake(state: SnakeState): { state: SnakeState; applied: SnakeChange | null } {
  if (state.ended) return { state, applied: null };
  const tick = state.ticks;
  let dir = state.dir;
  let applied: SnakeChange | null = null;
  let pending = state.pending;

  while (pending.length) {
    const [next, ...rest] = pending;
    pending = rest;
    if (next === dir) continue;
    if (isOppositeDirection(dir, next)) continue;
    dir = next;
    applied = { tick, dir: next };
    break;
  }

  const { dx, dy } = snakeDirectionDelta(dir);
  const head = state.body[0];
  const next = { x: head.x + dx, y: head.y + dy };
  const ticks = tick + 1;

  if (next.x < 0 || next.x >= SNAKE_COLS || next.y < 0 || next.y >= SNAKE_ROWS) {
    return { state: { ...state, dir, pending, ticks, ended: 'wall' }, applied };
  }

  const food = snakeFood(state);
  const eats = food !== null && food.x === next.x && food.y === next.y;
  // The tail cell vacates on the same tick, so moving into it is legal — unless the
  // snake is growing, because then the tail stays put.
  const held = eats ? state.body : state.body.slice(0, -1);
  const body = [next, ...held];
  if (held.some((cell) => cell.x === next.x && cell.y === next.y)) {
    return { state: { ...state, dir, pending, ticks, ended: 'self' }, applied };
  }

  return {
    state: {
      ...state,
      body,
      dir,
      pending,
      nextFood: eats ? state.nextFood + 1 : state.nextFood,
      score: eats ? state.score + 1 : state.score,
      ticks,
      ended: ticks >= SNAKE_RUN_TICKS ? 'cap' : null,
    },
    applied,
  };
}

/**
 * Advance the snake until it has caught up with `target` ticks, or died, or hit the
 * cap. This is what makes the run unpausable: time spent with the phone locked or the
 * tab in the background is walked forward in one go, with the snake simply travelling
 * on in whatever direction it was last pointing.
 */
export function advanceSnakeTo(state: SnakeState, target: number): { state: SnakeState; changes: SnakeChange[] } {
  let current = state;
  const changes: SnakeChange[] = [];
  const goal = Math.min(target, SNAKE_RUN_TICKS);
  while (!current.ended && current.ticks < goal) {
    const { state: next, applied } = stepSnake(current);
    if (applied) changes.push(applied);
    current = next;
  }
  return { state: current, changes };
}

/**
 * Rebuild a run from its history: the database's food sequence, the direction changes
 * that were reported, and how many ticks they cover. Used when a phone picks a live
 * run back up after a reload, and as the reference implementation the SQL replay has to
 * agree with.
 */
export function replaySnake(foods: SnakePoint[], ticks: number, changes: SnakeChange[]): SnakeState {
  let state = createSnakeState(foods);
  const byTick = new Map<number, SnakeDirection>();
  for (const change of changes) {
    // A change already applied at this tick is impossible on a well-formed log; the
    // first one wins so a malformed log cannot replay differently here than in SQL.
    if (!byTick.has(change.tick)) byTick.set(change.tick, change.dir);
  }
  const goal = Math.min(Math.max(ticks, 0), SNAKE_RUN_TICKS);
  while (!state.ended && state.ticks < goal) {
    const queued = byTick.get(state.ticks);
    if (queued) state = queueSnakeDirection(state, queued);
    state = stepSnake(state).state;
  }
  return state;
}

/**
 * How many ticks a run may have reported after `elapsedMs` of real time. The server
 * checks the same ceiling; the phone uses it to prove it has not been sped up.
 */
export function snakeTickBudget(elapsedMs: number): number {
  return Math.min(Math.max(Math.floor(elapsedMs / SNAKE_TICK_MS), 0), SNAKE_RUN_TICKS);
}

/**
 * Food for a practice run. Ranked runs never use this: their food is dealt by the
 * database, which is what makes the score it replays out of it beyond argument. A
 * warm-up is meant to be free of all that, so a little randomness here is the point.
 */
export function dealPracticeFoods(count = SNAKE_FOOD_COUNT): SnakePoint[] {
  return Array.from({ length: count }, () => ({
    x: Math.floor(Math.random() * SNAKE_COLS),
    y: Math.floor(Math.random() * SNAKE_ROWS),
  }));
}

/** A short label for how a run ended, in the couple's own words. */
export function snakeEndLabel(end: SnakeEnd | 'alive' | null): string {
  switch (end) {
    case 'wall': return 'The snake hit the wall';
    case 'self': return 'The snake bit itself';
    case 'cap': return 'Four minutes up';
    case 'forfeit': return 'You left the run';
    default: return 'Still slithering';
  }
}
