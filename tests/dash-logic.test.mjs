import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

test('Dash core: three lanes, tick ordering, jump window, hearts, replay and route safety', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const dash = await server.ssrLoadModule('/src/lib/dash.ts');
    const { createDashState, stepDash, replayDash, dealPracticeDashCourse, DASH_MAX_TICKS } = dash;

    const start = createDashState();
    assert.equal(start.lane, 1, 'a run starts in the centre lane');
    const left = stepDash(start, [{ tick: 1, kind: 'barrier', lanes: [0], jumpable: true }], 'left');
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

    const fourBarriers = [1, 2, 3, 4].map((tick) => ({ tick, kind: 'barrier', lanes: [1], jumpable: true }));
    const jumpReplay = replayDash(fourBarriers, 8, [{ tick: 0, action: 'jump' }, { tick: 1, action: 'jump' }]);
    assert.equal(jumpReplay.ended, 'barrier', 'an airborne jump cannot be extended by another jump');
    assert.equal(jumpReplay.ticks, 4);
    assert.equal(jumpReplay.distance, 3, 'the initial jump clears exactly three collision checks');
    assert.equal(jumpReplay.jumpTicks, 0);

    const heartCourse = [
      { tick: 1, kind: 'heart', lane: 0 },
      { tick: 2, kind: 'heart', lane: 1 }
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
    }
  } finally {
    await server.close();
  }
});
