import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

test('Dash core: top-to-bottom obstacles, lane-only dodging, speed ramp, hearts, replay and route safety', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const dash = await server.ssrLoadModule('/src/lib/dash.ts');
    const {
      createDashState,
      stepDash,
      replayDash,
      dealPracticeDashCourse,
      dashTickDuration,
      dashElapsedMs,
      dashTickBudget,
      dashObstacleTopPct,
      dashSpeedPhase,
      DASH_MAX_TICKS,
      isDashAction,
    } = dash;

    const start = createDashState();
    assert.equal(start.lane, 1, 'a run starts in the centre lane');
    const left = stepDash(start, [{ tick: 1, kind: 'barrier', lanes: [0] }], 'left');
    assert.equal(left.state.lane, 0);
    assert.deepEqual(left.applied, { tick: 0, action: 'left' });
    assert.equal(left.state.ended, 'barrier', 'lane input at tick zero takes effect before the tick-one obstacle');
    assert.equal(left.state.distance, 0, 'the collision tick is not distance');
    assert.equal(left.state.ticks, 1, 'the collision tick is still included in attempted ticks');

    const bounded = stepDash(start, [], 'left');
    const leftEdge = stepDash(bounded.state, [], 'left');
    assert.equal(leftEdge.state.lane, 0);
    const ignored = stepDash(leftEdge.state, [], 'left');
    assert.equal(ignored.state.lane, 0);
    assert.equal(ignored.applied, null, 'an out-of-bounds lane change is ignored');

    const attemptedJump = stepDash(start, [{ tick: 1, kind: 'barrier', lanes: [1], jumpable: true }], 'jump');
    assert.equal(attemptedJump.state.ended, 'barrier', 'new runs cannot jump through a barrier');
    assert.equal(attemptedJump.applied, null, 'jump is not a current player action');
    assert.equal(isDashAction('jump'), false);

    // Keep a previously-open version-one run replayable across the mechanics update.
    const oldCourse = [1, 2, 3, 4].map((tick) => ({ tick, kind: 'barrier', lanes: [1], jumpable: true }));
    const legacy = replayDash(oldCourse, 8, [{ tick: 0, action: 'jump' }], true);
    assert.equal(legacy.ended, 'barrier');
    assert.equal(legacy.ticks, 4);
    assert.equal(legacy.distance, 3, 'legacy replay keeps its already-saved three-tick jump');

    const heartCourse = [
      { tick: 1, kind: 'heart', lane: 0 },
      { tick: 2, kind: 'heart', lane: 1 },
    ];
    const hearts = replayDash(heartCourse, 2, [
      { tick: 0, action: 'left' },
      { tick: 1, action: 'right' },
    ]);
    assert.equal(hearts.hearts, 2, 'a same-tick lane change collects a heart in the new lane');
    assert.equal(hearts.distance, 2);

    const capped = replayDash([], DASH_MAX_TICKS + 20, []);
    assert.equal(capped.ended, 'cap');
    assert.equal(capped.ticks, DASH_MAX_TICKS);
    assert.equal(capped.distance, DASH_MAX_TICKS);

    assert.equal(dashTickDuration(1), 120);
    assert.equal(dashTickDuration(300), 120);
    assert.equal(dashTickDuration(301), 105, 'the middle section advances faster');
    assert.equal(dashTickDuration(600), 105);
    assert.equal(dashTickDuration(601), 90, 'the final section is fastest');
    assert.equal(dashTickDuration(900), 90);
    assert.equal(dashElapsedMs(300), 36_000);
    assert.equal(dashElapsedMs(600), 67_500);
    assert.equal(dashElapsedMs(900), 94_500);
    assert.equal(dashTickBudget(0), 6, 'the referee budget includes its scheduling slack');
    assert.equal(dashTickBudget(35_999, 0), 299);
    assert.equal(dashTickBudget(36_000, 0), 300);
    assert.equal(dashTickBudget(36_104, 0), 300);
    assert.equal(dashTickBudget(36_105, 0), 301);
    assert.equal(dashTickBudget(67_500, 0), 600);
    assert.equal(dashTickBudget(67_590, 0), 601);
    assert.equal(dashTickBudget(94_500, 0), 900);
    assert.equal(dashSpeedPhase(0), 'steady');
    assert.equal(dashSpeedPhase(300), 'quicker');
    assert.equal(dashSpeedPhase(600), 'fast');

    const firstObstacleTop = dashObstacleTopPct(28);
    const nearObstacleTop = dashObstacleTopPct(1);
    assert.equal(firstObstacleTop, 8, 'far obstacles enter at the top edge');
    assert.ok(nearObstacleTop > firstObstacleTop && nearObstacleTop > 75 && nearObstacleTop < 85,
      'obstacles descend toward the runner at the bottom');

    let randomState = 123456;
    const random = () => {
      randomState = (randomState * 48271) % 2147483647;
      return randomState / 2147483647;
    };
    const route = dealPracticeDashCourse('spicy', random);
    assert.ok(route.length > 60 && route.length < 130);
    assert.equal(route[0].tick >= 29, true, 'the course has an opening stretch');
    assert.deepEqual(route.map((event) => event.tick), route.map((event) => event.tick).slice().sort((a, b) => a - b));
    assert.equal(new Set(route.map((event) => event.tick)).size, route.length, 'at most one event occupies each tick');
    for (const event of route.filter((item) => item.kind === 'barrier')) {
      assert.ok(event.lanes.length === 1 || event.lanes.length === 2, 'every barrier leaves at least one safe lane');
      assert.equal(new Set(event.lanes).size, event.lanes.length);
      assert.equal('jumpable' in event, false, 'new obstacles are dodge-only');
    }
  } finally {
    await server.close();
  }
});
