/**
 * Dash Duel's deterministic runner rules. This module is deliberately free of React,
 * timers and network calls: the browser predicts a run here, while PostgreSQL replays
 * the exact same course and input log before accepting progress or a result.
 */

export const DASH_TICK_MS = 120;
export const DASH_MID_TICK_MS = 105;
export const DASH_FAST_TICK_MS = 90;
export const DASH_SPEEDUP_TICK = 300;
export const DASH_FAST_TICK = 600;
export const DASH_MAX_TICKS = 900;
export const DASH_VISIBLE_TICKS = 28;
export const DASH_BEAT_MS = 2_000;
export const DASH_COURSE_VERSION = 2;
export const DASH_LEVELS = ['easy', 'steady', 'spicy'] as const;
export type DashLevel = typeof DASH_LEVELS[number];
export type DashLane = 0 | 1 | 2;
/** Actions a player can make now. Dash Duel is lane-dodging only. */
export type DashActionName = 'left' | 'right';
/** `jump` is understood only when replaying an unfinished version-one course. */
export type DashReplayActionName = DashActionName | 'jump';
export type DashEnd = 'barrier' | 'cap' | 'forfeit' | 'opponent-crash';

export type DashCourseEvent =
  | { tick: number; kind: 'barrier'; lanes: DashLane[]; jumpable?: boolean }
  | { tick: number; kind: 'heart'; lane: DashLane };

/** Input ticks are zero-based; course event ticks are one-based. */
export interface DashAction {
  tick: number;
  /** Old saved runs may contain `jump`; new controls can only write left/right. */
  action: DashReplayActionName;
}

export interface DashState {
  lane: DashLane;
  hearts: number;
  /** Number of simulation ticks attempted, including a collision tick. */
  ticks: number;
  /** Survived distance. A collision tick does not add a metre. */
  distance: number;
  /** Legacy-only replay state; never exposed as a control or animation. */
  jumpTicks: number;
  ended: DashEnd | null;
}

export interface DashReplayResult extends DashState {}

export function isDashLevel(value: unknown): value is DashLevel {
  return typeof value === 'string' && (DASH_LEVELS as readonly string[]).includes(value);
}

/** True for controls that are available in current Dash Duel runs. */
export function isDashAction(value: unknown): value is DashActionName {
  return value === 'left' || value === 'right';
}

/** Keep saved version-one action logs replayable without enabling the old control. */
export function isDashReplayAction(value: unknown): value is DashReplayActionName {
  return isDashAction(value) || value === 'jump';
}

/** Duration of one 1-based simulation tick; later sections move more quickly. */
export function dashTickDuration(tick: number): number {
  if (tick <= DASH_SPEEDUP_TICK) return DASH_TICK_MS;
  if (tick <= DASH_FAST_TICK) return DASH_MID_TICK_MS;
  return DASH_FAST_TICK_MS;
}

/** Wall-clock milliseconds needed to complete `ticks` at Dash Duel's speed curve. */
export function dashElapsedMs(ticks: number): number {
  const completed = Math.min(Math.max(Math.floor(ticks), 0), DASH_MAX_TICKS);
  if (completed <= DASH_SPEEDUP_TICK) return completed * DASH_TICK_MS;
  if (completed <= DASH_FAST_TICK) {
    return DASH_SPEEDUP_TICK * DASH_TICK_MS
      + (completed - DASH_SPEEDUP_TICK) * DASH_MID_TICK_MS;
  }
  return DASH_SPEEDUP_TICK * DASH_TICK_MS
    + (DASH_FAST_TICK - DASH_SPEEDUP_TICK) * DASH_MID_TICK_MS
    + (completed - DASH_FAST_TICK) * DASH_FAST_TICK_MS;
}

/**
 * Reverse the speed curve to find the largest legitimate tick count for elapsed time.
 * The small tick allowance absorbs network/UI scheduling jitter, just as the SQL referee
 * does. This keeps faster later ticks fair without permitting a client to fast-forward.
 */
export function dashTickBudget(elapsedMs: number, slackTicks = 6): number {
  const elapsed = Math.max(Math.floor(elapsedMs), 0);
  const slack = Math.floor(slackTicks);
  let low = 0;
  let high = DASH_MAX_TICKS;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (dashElapsedMs(middle) <= elapsed) low = middle;
    else high = middle - 1;
  }
  return Math.min(Math.max(low + slack, 0), DASH_MAX_TICKS);
}

/** The upcoming course item travels down from the top edge into the runner's hit zone. */
export function dashObstacleTopPct(ticksUntilEvent: number, horizon = DASH_VISIBLE_TICKS): number {
  const safeHorizon = Math.max(horizon, 1);
  const gap = Math.max(1, Math.min(ticksUntilEvent, safeHorizon));
  return 8 + (1 - gap / safeHorizon) * 75;
}

export function dashSpeedPhase(ticksCompleted: number): 'steady' | 'quicker' | 'fast' {
  if (ticksCompleted < DASH_SPEEDUP_TICK) return 'steady';
  if (ticksCompleted < DASH_FAST_TICK) return 'quicker';
  return 'fast';
}

/** CSS runway markings use a matching three-step visual cue for the speed ramp. */
export function dashRoadDurationMs(ticksCompleted: number): number {
  const phase = dashSpeedPhase(ticksCompleted);
  return phase === 'steady' ? 1_200 : phase === 'quicker' ? 950 : 700;
}

export function createDashState(): DashState {
  return { lane: 1, hearts: 0, ticks: 0, distance: 0, jumpTicks: 0, ended: null };
}

function laneAfterChange(lane: DashLane, action: DashActionName): DashLane {
  if (action === 'left' && lane > 0) return (lane - 1) as DashLane;
  if (action === 'right' && lane < 2) return (lane + 1) as DashLane;
  return lane;
}

/**
 * Advance one tick. Lane input is applied before the same-tick event. Legacy jumps are
 * replayed only for an already-open v1 course; new courses and controls are dodge-only.
 */
export function stepDash(
  state: DashState,
  course: readonly DashCourseEvent[],
  action?: DashReplayActionName,
  allowLegacyJump = false,
): { state: DashState; applied: DashAction | null } {
  if (state.ended) return { state, applied: null };

  let lane = state.lane;
  let jumpTicks = allowLegacyJump ? state.jumpTicks : 0;
  let applied: DashAction | null = null;

  if (action === 'left' || action === 'right') {
    const changed = laneAfterChange(lane, action);
    if (changed !== lane) {
      lane = changed;
      applied = { tick: state.ticks, action };
    }
  } else if (allowLegacyJump && action === 'jump' && jumpTicks === 0) {
    jumpTicks = 3;
    applied = { tick: state.ticks, action };
  }

  const eventTick = state.ticks + 1;
  const event = course.find((item) => item.tick === eventTick);
  const airborne = allowLegacyJump && jumpTicks > 0;
  let hearts = state.hearts;
  let distance = state.distance;
  let ended: DashEnd | null = null;

  if (event?.kind === 'heart' && event.lane === lane) {
    hearts += 1;
  } else if (event?.kind === 'barrier'
    && event.lanes.includes(lane)
    && !(allowLegacyJump && event.jumpable && airborne)) {
    ended = 'barrier';
  }

  if (!ended) {
    distance += 1;
    if (eventTick >= DASH_MAX_TICKS) ended = 'cap';
  }

  // Kept solely so an in-progress v1 replay can be reconstructed after an app update.
  jumpTicks = allowLegacyJump ? Math.max(jumpTicks - 1, 0) : 0;

  return {
    state: {
      lane,
      hearts,
      ticks: eventTick,
      distance,
      jumpTicks,
      ended,
    },
    applied,
  };
}

/** Reconstruct the canonical run state from a course, tick count and saved action log. */
export function replayDash(
  course: readonly DashCourseEvent[],
  ticks: number,
  actions: readonly DashAction[],
  allowLegacyJump = false,
): DashReplayResult {
  const byTick = new Map<number, DashReplayActionName>();
  for (const action of actions) {
    if (!byTick.has(action.tick)) byTick.set(action.tick, action.action);
  }
  let state = createDashState();
  const goal = Math.min(Math.max(Math.floor(ticks), 0), DASH_MAX_TICKS);
  while (!state.ended && state.ticks < goal) {
    const action = byTick.get(state.ticks);
    state = stepDash(state, course, action, allowLegacyJump).state;
  }
  return state;
}

const LEVEL_RULES: Record<DashLevel, { opening: number; middle: number; late: number; heartChance: number; doubleChance: number }> = {
  easy: { opening: 13, middle: 12, late: 11, heartChance: 0.18, doubleChance: 0.2 },
  steady: { opening: 11, middle: 10, late: 9, heartChance: 0.11, doubleChance: 0.38 },
  spicy: { opening: 10, middle: 9, late: 8, heartChance: 0.08, doubleChance: 0.56 },
};

/**
 * A local-only course for free play. Ranked/challenge courses are dealt by SQL; passing
 * a seeded random function makes this helper useful for deterministic tests as well.
 */
export function dealPracticeDashCourse(
  level: DashLevel = 'steady',
  random: () => number = Math.random,
): DashCourseEvent[] {
  const rules = LEVEL_RULES[level];
  const course: DashCourseEvent[] = [];
  let tick = 30;
  while (tick <= DASH_MAX_TICKS) {
    if (random() < rules.heartChance) {
      course.push({ tick, kind: 'heart', lane: Math.floor(random() * 3) as DashLane });
    } else {
      const first = Math.floor(random() * 3) as DashLane;
      const lanes: DashLane[] = [first];
      if (random() < rules.doubleChance) lanes.push(((first + 1 + Math.floor(random() * 2)) % 3) as DashLane);
      course.push({ tick, kind: 'barrier', lanes });
    }
    const cadence = tick < 300 ? rules.opening : tick < 600 ? rules.middle : rules.late;
    tick += cadence + Math.floor(random() * 3) - 1;
  }
  return course;
}

/** A compact accessibility-friendly description for a course event. */
export function dashEventLabel(event: DashCourseEvent): string {
  return event.kind === 'heart'
    ? `heart in ${['left', 'centre', 'right'][event.lane]} lane`
    : `barrier across ${event.lanes.map((lane) => ['left', 'centre', 'right'][lane]).join(' and ')} lane${event.lanes.length === 1 ? '' : 's'}`;
}

export function dashLevelLabel(level: DashLevel): string {
  return level === 'easy' ? 'Easy route' : level === 'spicy' ? 'Spicy route' : 'Steady route';
}
