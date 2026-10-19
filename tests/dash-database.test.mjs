import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

test('Dash Duel database referee: shared routes, async settlement, live crash/cap and expiry', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
  } });
  let db;
  try {
    const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
    db = await installTestBackend(supabase);
    const auth = await server.ssrLoadModule('/src/lib/authService.ts');
    const games = await server.ssrLoadModule('/src/lib/gamesService.ts');
    const dashCore = await server.ssrLoadModule('/src/lib/dash.ts');
    const ramp = await db.query(`SELECT public.dash_tick_duration(1) AS opening,
      public.dash_tick_duration(301) AS middle, public.dash_tick_duration(601) AS fast,
      public.dash_elapsed_ms(300) AS first_ramp, public.dash_elapsed_ms(600) AS second_ramp,
      public.dash_elapsed_ms(900) AS finish`);
    assert.deepEqual(ramp.rows[0], { opening: 120, middle: 105, fast: 90, first_ramp: 36000, second_ramp: 67500, finish: 94500 });
    const budget = await db.query(`SELECT public.dash_budget(now() - interval '36 seconds') AS ticks`);
    assert.equal(budget.rows[0].ticks, 306, 'the server budget follows the accelerated clock plus six ticks of slack');
    const a = (await auth.signUpWithEmail('dash-a@test.com', 'password')).user;
    await auth.saveOnboardingProfile(a.id, { name: 'A', location: null, timezone: 'Africa/Lagos' });
    const { couple } = await auth.createCouple(a.id, '2020-01-01');
    const b = (await auth.signUpWithEmail('dash-b@test.com', 'password')).user;
    await auth.saveOnboardingProfile(b.id, { name: 'B', location: null, timezone: 'Pacific/Auckland' });
    await auth.joinCoupleWithCode(b.id, couple.invite_code);
    const login = (who) => auth.signInWithEmail(`dash-${who}@test.com`, 'password');
    const match = async (id) => (await games.fetchGames()).matches.find((item) => item.id === id);
    const setCourse = async (id, events) => db.exec(
      `UPDATE public.game_matches SET dash=jsonb_set(dash,'{course}','${JSON.stringify(events)}'::jsonb) WHERE id='${id}'`,
    );
    const backdateRun = async (id, userId, seconds = 120) => db.exec(
      `UPDATE public.game_matches SET dash=jsonb_set(dash,'{${userId},started_at}',to_jsonb(now()-interval '${seconds} seconds')) WHERE id='${id}'`,
    );

    const course = [
      { tick: 1, kind: 'heart', lane: 0 },
      { tick: 3, kind: 'barrier', lanes: [1] },
      { tick: 4, kind: 'barrier', lanes: [1] },
      { tick: 5, kind: 'barrier', lanes: [1] },
      { tick: 6, kind: 'barrier', lanes: [0] },
    ];
    const actions = [{ tick: 0, action: 'left' }];

    // The first async challenger chooses the level and gets one immutable shared route.
    await login('a');
    const challenge = await games.startDash('challenge', 'steady');
    assert.equal(await games.startDash('challenge', 'spicy'), challenge, 'an open challenge resumes instead of being replaced');
    const opened = await match(challenge);
    assert.equal(opened.game, 'dash-duel');
    assert.equal(opened.dash.mode, 'challenge');
    assert.equal(opened.dash.level, 'steady', 'the first course creator sets the difficulty');
    assert.equal(opened.dash.created_by, a.id);
    assert.equal(opened.dash.course_version, 2, 'new courses use the dodge-only accelerated rules');
    assert.equal(opened.dash.mine, null);
    assert.equal(opened.dash.partner.status, 'waiting');
    assert.ok(opened.dash.course.length > 60, 'the server dealt the complete shared course');
    assert(opened.dash.course.filter((event) => event.kind === 'barrier').every((event) => !('jumpable' in event)),
      'new server-dealt barriers require lane dodging, not jumping');

    const runA = await games.startDashRun(challenge);
    assert.equal(runA.status, 'running');
    assert.equal(runA.distance, 0);
    const duplicateTick = await supabase.rpc('dash_beat', {
      p_id: challenge, p_ticks: 2, p_actions: [[0, 'left'], [0, 'right']],
    });
    assert.ok(duplicateTick.error, 'two different moves cannot occupy one tick');
    const jumpAction = await supabase.rpc('dash_beat', {
      p_id: challenge, p_ticks: 1, p_actions: [[0, 'jump']],
    });
    assert.ok(jumpAction.error, 'the server rejects new jump inputs');
    const claimedScore = await supabase.rpc('dash_beat', {
      p_id: challenge, p_ticks: 1, p_actions: [], p_distance: 999, p_hearts: 999,
    });
    assert.ok(claimedScore.error, 'the RPC has no client-supplied score arguments');
    await setCourse(challenge, course);
    await backdateRun(challenge, a.id);
    const predicted = dashCore.replayDash(course, 8, actions);
    assert.deepEqual(
      { ended: predicted.ended, ticks: predicted.ticks, distance: predicted.distance, hearts: predicted.hearts },
      { ended: 'barrier', ticks: 6, distance: 5, hearts: 1 },
    );
    const firstBeat = await games.beatDashRun(challenge, 1, [actions[0]]);
    assert.equal(firstBeat.distance, 1);
    assert.equal(firstBeat.hearts, 1);
    const retriedBeat = await games.beatDashRun(challenge, 1, [actions[0]]);
    assert.equal(retriedBeat.distance, 1, 'an identical heartbeat retry is idempotent');
    await assert.rejects(games.beatDashRun(challenge, 1, [{ tick: 0, action: 'right' }]), /different action/);
    const crashedA = await games.beatDashRun(challenge, 8, actions);
    assert.equal(crashedA.status, 'crash', 'the server ends a run at the collision tick even on a heartbeat');
    assert.equal(crashedA.ended, 'barrier');
    assert.equal(crashedA.distance, predicted.distance);
    assert.equal(crashedA.hearts, predicted.hearts);
    assert.equal(crashedA.ticks, predicted.ticks);
    assert.equal((await match(challenge)).finished, false, 'an async crash does not prematurely decide the match');
    const retry = await games.finishDashRun(challenge, 8, actions);
    assert.equal(retry.status, 'crash', 'repeating the terminal report is safe');
    await assert.rejects(games.startDashRun(challenge), /already played your run/);

    // The other phone sees a live, server-confirmed distance, but never the action log.
    await login('b');
    const waitingOnB = await match(challenge);
    assert.equal(waitingOnB.dash.partner.status, 'crash');
    assert.equal(waitingOnB.dash.partner.distance, 5);
    assert.equal(waitingOnB.dash.partner.hearts, 1);
    assert.equal('actions' in waitingOnB.dash.partner, false);
    assert.deepEqual(waitingOnB.dash.course, course, 'both partners see one shared course');

    // B now plays the same course and crashes earlier. Distance outranks hearts, and the
    // first run's score and heart count are reconciled from exactly the shared inputs.
    const runB = await games.startDashRun(challenge);
    assert.equal(runB.status, 'running');
    await backdateRun(challenge, b.id);
    const crashedB = await games.finishDashRun(challenge, 3, []);
    assert.equal(crashedB.status, 'crash');
    const settled = await match(challenge);
    assert.equal(settled.finished, true);
    assert.equal(settled.winner_id, a.id);
    assert.equal(settled.dash.mine.distance, 2);
    assert.equal(settled.dash.partner.distance, 5);
    assert.equal((await games.fetchGames()).wins[a.id], 1);

    // A live-together match exists independently, requires both partners to ready, and
    // writes the exact same server start timestamp to both runs.
    await login('a');
    const live = await games.startDash('together', 'steady');
    assert.notEqual(live, challenge, 'challenge and live-race matches are independent');
    await setCourse(live, [{ tick: 1, kind: 'barrier', lanes: [1] }]);
    const readyA = await games.startDashRun(live);
    assert.equal(readyA.status, 'ready');
    assert.equal((await match(live)).dash.mine.status, 'ready');
    await login('b');
    assert.equal(await games.startDash('together', 'spicy'), live, 'the partner rejoins the same live match');
    const runLiveB = await games.startDashRun(live);
    assert.equal(runLiveB.status, 'running');
    const timestamps = await db.query(`SELECT dash->'${a.id}'->>'started_at' AS a,dash->'${b.id}'->>'started_at' AS b FROM public.game_matches WHERE id='${live}'`);
    assert.equal(timestamps.rows[0].a, timestamps.rows[0].b, 'both live attempts share a start tick');
    await login('a');
    const runLiveA = await match(live);
    assert.equal(runLiveA.dash.mine.status, 'running');
    assert.equal(runLiveA.dash.partner.status, 'running');
    const liveCrash = await games.finishDashRun(live, 1, []);
    assert.equal(liveCrash.status, 'crash');
    const liveResult = await match(live);
    assert.equal(liveResult.finished, true, 'the first live crash settles immediately');
    assert.equal(liveResult.winner_id, b.id);
    assert.equal(liveResult.dash.partner.status, 'done');
    assert.equal(liveResult.dash.partner.ended, 'opponent-crash');

    // Completing the whole route is not a crash-loss in live mode. The other runner may
    // finish their attempt; verified distance then settles the result.
    const capRace = await games.startDash('together', 'steady');
    await setCourse(capRace, [{ tick: 900, kind: 'barrier', lanes: [1] }]);
    await login('a');
    await games.startDashRun(capRace);
    await login('b');
    await games.startDashRun(capRace);
    await backdateRun(capRace, a.id);
    await backdateRun(capRace, b.id);
    await login('a');
    const completedCourse = await games.finishDashRun(capRace, 900, [{ tick: 0, action: 'left' }]);
    assert.equal(completedCourse.status, 'done');
    assert.equal(completedCourse.ended, 'cap');
    assert.equal((await match(capRace)).finished, false, 'the active partner is not awarded a win for a full-course finish');
    await login('b');
    const liveBarrier = await games.finishDashRun(capRace, 900, []);
    assert.equal(liveBarrier.status, 'crash');
    const capResult = await match(capRace);
    assert.equal(capResult.finished, true);
    assert.equal(capResult.winner_id, a.id, 'the runner who completed the course wins by verified distance');

    // Explicit challenge forfeits are zero-valued and the other async partner can still
    // complete the course. If both forfeit, the server records a draw instead of a fake win.
    const forfeits = await games.startDash('challenge', 'easy');
    await login('a');
    await games.startDashRun(forfeits);
    const forfeitA = await games.forfeitDashRun(forfeits);
    assert.equal(forfeitA.status, 'forfeit');
    assert.equal(forfeitA.distance, 0);
    assert.equal(forfeitA.hearts, 0);
    await login('b');
    await games.startDashRun(forfeits);
    await games.forfeitDashRun(forfeits);
    const draw = await match(forfeits);
    assert.equal(draw.finished, true);
    assert.equal(draw.winner_id, null);
    assert.equal(draw.dash.partner.distance, 0);

    // The seven-day sweep settles old open matches and cannot be extended by an offline
    // partner. Old running attempts become zero-score forfeits; no presence grace is used.
    const expired = await games.startDash('challenge', 'steady');
    await db.exec(`UPDATE public.game_matches SET created_at=now()-interval '8 days' WHERE id='${expired}'`);
    const swept = await match(expired);
    assert.equal(swept.finished, true);
    assert.equal(swept.dash.mine.status, 'forfeit');
    assert.equal(swept.dash.partner.status, 'forfeit');
    assert.equal(swept.winner_id, null);

    const badSetting = await supabase.rpc('start_dash', { p_mode: 'challenge', p_level: 'impossible' });
    assert.ok(badSetting.error);
  } finally {
    await db?.close();
    await server.close();
  }
});
