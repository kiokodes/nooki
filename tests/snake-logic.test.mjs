import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

/**
 * The Snake core is the single source of truth for how a run plays out, so it is worth
 * hammering on its own: the phone and the database must agree tick for tick, a logged
 * run must replay to exactly the snake that was played, and time spent away has to move
 * the snake on rather than pause it.
 */
test('snake core: movement, food, collisions, replay and catch-up', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const {
      SNAKE_COLS, SNAKE_ROWS, SNAKE_RUN_TICKS, SNAKE_TICK_MS, SNAKE_START_LENGTH,
      createSnakeState, stepSnake, queueSnakeDirection, advanceSnakeTo, replaySnake,
      snakeTickBudget, snakeFood, snakeCellId, isOppositeDirection,
    } = await server.ssrLoadModule('/src/lib/snake.ts');

    const ids = (state) => state.body.map(snakeCellId);
    const point = (id) => ({ x: id % SNAKE_COLS, y: Math.floor(id / SNAKE_COLS) });
    const play = (state, ticks) => {
      let current = state;
      const changes = [];
      for (let i = 0; i < ticks; i += 1) {
        const { state: next, applied } = stepSnake(current);
        if (applied) changes.push(applied);
        current = next;
      }
      return { state: current, changes };
    };

    // --- A fresh run -----------------------------------------------------------------
    const start = createSnakeState([]);
    assert.equal(SNAKE_COLS, 20);
    assert.equal(SNAKE_ROWS, 20);
    assert.equal(SNAKE_TICK_MS, 160);
    assert.equal(SNAKE_RUN_TICKS, 1500, 'a four-minute run at 160ms a tick');
    assert.equal(start.body.length, SNAKE_START_LENGTH);
    assert.deepEqual(start.body[0], { x: 10, y: 10 }, 'the snake starts in the middle');
    assert.deepEqual(start.body[3], { x: 7, y: 10 });
    assert.equal(start.dir, 'right');
    assert.equal(start.score, 0);
    assert.equal(snakeFood(start), null, 'no food dealt means no food on the board');

    // --- Sliding along without food keeps the length and moves only the cells ---------
    const slid = play(start, 3).state;
    assert.deepEqual(slid.body, [{ x: 13, y: 10 }, { x: 12, y: 10 }, { x: 11, y: 10 }, { x: 10, y: 10 }]);
    assert.equal(slid.ticks, 3);

    // --- Food ahead is eaten: a point, a longer snake, the next food in play ----------
    const fed = createSnakeState([{ x: 11, y: 10 }, { x: 14, y: 10 }, { x: 2, y: 2 }]);
    const eaten = play(fed, 1).state;
    assert.equal(eaten.score, 1);
    assert.equal(eaten.body.length, 5, 'eating grows the snake by a cell');
    assert.equal(eaten.nextFood, 1);
    assert.deepEqual(snakeFood(eaten), { x: 14, y: 10 }, 'the next food takes over');

    // --- Walls end the run, on the tick the head would leave the board ----------------
    const toTheWall = play(createSnakeState([]), 40).state;
    assert.equal(toTheWall.ended, 'wall');
    assert.equal(toTheWall.ticks, 10, 'cell 19 is the last one; the tenth tick is the wall');

    // --- Turning back into your own neck is ignored -----------------------------------
    assert.equal(isOppositeDirection('right', 'left'), true);
    assert.equal(isOppositeDirection('up', 'down'), true);
    assert.equal(isOppositeDirection('right', 'up'), false);
    const reversed = stepSnake(queueSnakeDirection(start, 'left')).state;
    assert.equal(reversed.dir, 'right', 'a reversal is dropped');
    assert.equal(reversed.body[0].x, 11, 'and the snake still moves right');

    // --- Two presses queue in order, one turning point per tick -----------------------
    const queued = queueSnakeDirection(queueSnakeDirection(start, 'up'), 'left');
    const first = stepSnake(queued);
    assert.equal(first.state.dir, 'up');
    assert.deepEqual(first.applied, { tick: 0, dir: 'up' });
    assert.deepEqual(first.state.body[0], { x: 10, y: 9 });
    const second = stepSnake(first.state);
    assert.equal(second.state.dir, 'left');
    assert.deepEqual(second.applied, { tick: 1, dir: 'left' });
    assert.deepEqual(second.state.body[0], { x: 9, y: 9 });
    // A third press before the next tick is dropped rather than banked for later.
    let crammed = createSnakeState([]);
    for (const dir of ['up', 'left', 'down', 'right']) crammed = queueSnakeDirection(crammed, dir);
    assert.deepEqual(crammed.pending, ['up', 'left']);

    // --- The tail vacates its cell, so a short snake can chase itself in a 2×2 loop ---
    let looping = createSnakeState([]);
    for (const dir of ['down', 'left', 'up', 'right', 'down', 'left', 'up']) {
      looping = stepSnake(queueSnakeDirection(looping, dir)).state;
    }
    assert.equal(looping.body.length, SNAKE_START_LENGTH, 'no food was eaten, so no growth');
    assert.equal(looping.ended, null, 'the tail moved on in time, so the loop is survivable');
    assert.deepEqual(ids(looping), [snakeCellId({ x: 9, y: 10 }), snakeCellId({ x: 9, y: 11 }), snakeCellId({ x: 10, y: 11 }), snakeCellId({ x: 10, y: 10 })]);

    // --- A body that is still in the way ends the run ---------------------------------
    const coiled = {
      ...createSnakeState([]),
      body: [
        { x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }, { x: 3, y: 4 }, { x: 4, y: 4 }, { x: 5, y: 4 }, { x: 6, y: 4 },
      ],
      dir: 'up',
    };
    assert.equal(stepSnake(coiled).state.ended, 'self', 'the head ran into its own body');

    // --- A run stops at the four-minute cap -------------------------------------------
    const nearlyDone = { ...createSnakeState([]), ticks: SNAKE_RUN_TICKS - 1 };
    assert.equal(stepSnake(nearlyDone).state.ended, 'cap');
    assert.equal(advanceSnakeTo(nearlyDone, SNAKE_RUN_TICKS + 500).state.ticks, SNAKE_RUN_TICKS, 'the cap is never passed');

    // --- Replaying a logged run rebuilds the identical snake --------------------------
    // A scripted comb: up the first column, one cell across, then the next column back
    // the other way, and so on. It stays inside the board and never crosses itself, so the
    // run survives long enough to eat the food we plant along the way.
    const presses = new Map();
    let clock = 0;
    for (let i = 0; i < 10; i += 1) presses.set(clock++, 'up');
    let downwards = true;
    while (clock < 90) {
      presses.set(clock++, 'right');
      for (let i = 0; i < 19; i += 1) presses.set(clock++, downwards ? 'down' : 'up');
      downwards = !downwards;
    }
    const runScript = (foods, limit) => {
      let state = createSnakeState(foods);
      const log = [];
      const route = [];
      while (!state.ended && state.ticks < limit) {
        const press = presses.get(state.ticks);
        if (press) state = queueSnakeDirection(state, press);
        const { state: next, applied } = stepSnake(state);
        if (applied) log.push(applied);
        state = next;
        route.push(snakeCellId(state.body[0]));
      }
      return { state, log, route };
    };
    const dry = runScript([], 90);
    assert.equal(dry.state.ended, null, 'the scripted route survives its ninety ticks');
    const route = [...new Set(dry.route)];
    const planted = [6, 14, 22, 30, 38].map((step) => point(route[step]));
    assert.equal(planted.length, 5);

    const live = runScript(planted, 90);
    assert.equal(live.state.score, 5, 'every planted food was eaten');
    assert.equal(live.state.nextFood, 5);
    assert.ok(live.log.length >= 5, 'the run turned several times');
    assert.ok(live.state.body.length > SNAKE_START_LENGTH, 'and it grew on the way');

    const replayed = replaySnake(planted, live.state.ticks, live.log);
    assert.deepEqual(ids(replayed), ids(live.state), 'the replay ends on the very same cells');
    assert.equal(replayed.score, live.state.score);
    assert.equal(replayed.ticks, live.state.ticks);
    assert.equal(replayed.ended, live.state.ended);
    assert.equal(replayed.dir, live.state.dir);
    // A history written twice for one tick cannot make the replay diverge either.
    const doubled = replaySnake(planted, live.state.ticks, [...live.log, ...live.log]);
    assert.deepEqual(ids(doubled), ids(live.state));
    // Replaying fewer ticks than were played stops short, it does not invent a snake.
    const shortened = replaySnake(planted, 10, live.log);
    assert.equal(shortened.ticks, 10);

    // --- Time away moves the snake on; it never pauses it ------------------------------
    const away = advanceSnakeTo(createSnakeState([]), 8);
    assert.equal(away.state.ticks, 8, 'the missing ticks were all walked forward');
    assert.deepEqual(away.changes, [], 'nobody was steering, so nothing was logged');
    assert.deepEqual(away.state.body[0], { x: 18, y: 10 });
    // Away for longer than the board is wide: the catch-up ends where the crash happened.
    const ranOut = advanceSnakeTo(createSnakeState([]), 40).state;
    assert.equal(ranOut.ended, 'wall');
    assert.equal(ranOut.ticks, 10);

    // --- The tick ceiling the server enforces ------------------------------------------
    assert.equal(snakeTickBudget(0), 0);
    assert.equal(snakeTickBudget(159), 0);
    assert.equal(snakeTickBudget(160), 1);
    assert.equal(snakeTickBudget(160 * 100), 100);
    assert.equal(snakeTickBudget(SNAKE_TICK_MS * (SNAKE_RUN_TICKS + 500)), SNAKE_RUN_TICKS, 'the cap holds');
    assert.equal(snakeTickBudget(-5), 0);
  } finally {
    await server.close();
  }
});
