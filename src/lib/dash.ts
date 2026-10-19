/**
 * Dash Duel's deterministic runner rules. This module is deliberately free of React,
 * timers and network calls: the browser predicts a run here, while PostgreSQL replays
 * the exact same course and input log before accepting progress or a result.
 */

export const DASH_TICK_MS = 120;
export const DASH_MAX_TICKS = 900;
export const DASH_BEAT_MS = 2_000;
export const DASH_COURSE_VERSION = 1;
export const DASH_LEVELS = ['easy', 'steady', 'spicy'] as const;
export type DashLevel = typeof DASH_LEVELS[number];
export type DashLane = 0 | 1 | 2;
export type DashActionName = 'left' | 'right' | 'jump';
export type DashEnd = 'barrier' | 'cap' | 'forfeit' | 'opponent-crash';

export type DashCourseEvent =
  | { tick: number; kind: 'barrier'; lanes: DashLane[]; jumpable: boolean }
  | { tick: number; kind: 'heart'; lane: DashLane };

/** Input ticks are zero-based; course event ticks are one-based. */
export interface DashAction {
  tick: number;
  action: DashActionName;
}

export interface DashState {
  lane: DashLane;
  hearts: number;
  /** Number of simulation ticks attempted, including a collision tick. */
  ticks: number;
  /** Survived distance. A collision tick does not add a metre. */
  distance: number;
  /** Remaining airborne collision checks, including the next tick. */
  jumpTicks: number;
  ended: DashEnd | null;
}

export interface DashReplayResult extends DashState {}

export function isDashLevel(value: unknown): value is DashLevel {
  return typeof value === 'string' && (DASH_LEVELS as readonly string[]).includes(value);
}

export function isDashAction(value: unknown): value is DashActionName {
  return value === 'left' || value === 'right' || value === 'jump';
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
 * Advance exactly one tick. Movement input is applied before a same-tick course event;
 * jumping covers the command tick plus the next two collision checks.
 */
export function stepDash(
  state: DashState,
  course: readonly DashCourseEvent[],
  action?: DashActionName,
): { state: DashState; applied: DashAction | null } {
  if (state.ended) return { state, applied: null };

  let lane = state.lane;
  let jumpTicks = state.jumpTicks;
  let applied: DashAction | null = null;

  if (action === 'left' || action === 'right') {
    const changed = laneAfterChange(lane, action);
    if (changed !== lane) {
      lane = changed;
      applied = { tick: state.ticks, action };
    }
  } else if (action === 'jump' && jumpTicks === 0) {
    jumpTicks = 3;
    applied = { tick: state.ticks, action };
  }

  const eventTick = state.ticks + 1;
  const event = course.find((item) => item.tick === eventTick);
  const airborne = jumpTicks > 0;
  let hearts = state.hearts;
  let distance = state.distance;
  let ended: DashEnd | null = null;

  if (event?.kind === 'heart' && event.lane === lane) {
    hearts += 1;
  } else if (event?.kind === 'barrier'
    && event.lanes.includes(lane)
    && !(event.jumpable && airborne)) {
    ended = 'barrier';
  }

  if (!ended) {
    distance += 1;
    if (eventTick >= DASH_MAX_TICKS) ended = 'cap';
  }

  // A jump is active on exactly three ticks. Collision is resolved before its counter
  // decreases, so a jump command on an obstacle's tick clears that obstacle.
  jumpTicks = Math.max(jumpTicks - 1, 0);

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
): DashReplayResult {
  const byTick = new Map<number, DashActionName>();
  for (const action of actions) {
    if (!byTick.has(action.tick)) byTick.set(action.tick, action.action);
  }
  let state = createDashState();
  const goal = Math.min(Math.max(Math.floor(ticks), 0), DASH_MAX_TICKS);
  while (!state.ended && state.ticks < goal) {
    const action = byTick.get(state.ticks);
    state = stepDash(state, course, action).state;
  }
  return state;
}

/** Number of 120ms ticks a server is allowed to accept after real elapsed time. */
export function dashTickBudget(elapsedMs: number, slackTicks = 6): number {
  return Math.min(Math.max(Math.floor(elapsedMs / DASH_TICK_MS) + slackTicks, 0), DASH_MAX_TICKS);
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
      course.push({ tick, kind: 'barrier', lanes, jumpable: true });
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
    : `barrier across ${event.lanes.map((lane) => ['left', 'centre', 'right'][lane]).join(' and ')} lane${event.lanes.length === 1 ? '' : 's'}${event.jumpable ? ', jumpable' : ''}`;
}

export function dashLevelLabel(level: DashLevel): string {
  return level === 'easy' ? 'Easy route' : level === 'spicy' ? 'Spicy route' : 'Steady route';
}
