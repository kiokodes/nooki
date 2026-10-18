import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

/**
 * A retried run report that overlaps the one before it.
 *
 * The wire drops the answer to a progress report; the phone retries. Its retry — or the
 * finish that follows — hands over taps the server has already logged. The referee used
 * to refuse the whole report for that ("out of order"), so a run that had honestly ended
 * could never be marked done: the duel never settled, and it sat in the couple's ongoing
 * games after both partners had played until the grace window erased it. A tap already in
 * the log is now skipped; a tap that contradicts the log is still refused.
 */
test('duel reports: an overlapping retry is skipped, not refused, and the duel still settles', async () => {
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

    const a = (await auth.signUpWithEmail('a@test.com', 'password')).user;
    await auth.saveOnboardingProfile(a.id, { name: 'A', location: null, timezone: 'Africa/Lagos' });
    const { couple } = await auth.createCouple(a.id, '2020-01-01');
    const b = (await auth.signUpWithEmail('b@test.com', 'password')).user;
    await auth.saveOnboardingProfile(b.id, { name: 'B', location: null, timezone: 'Pacific/Auckland' });
    await auth.joinCoupleWithCode(b.id, couple.invite_code);
    const login = (who) => auth.signInWithEmail(`${who}@test.com`, 'password');
    const match = async (id) => (await games.fetchGames()).matches.find((m) => m.id === id);
    /** Give a live run the elapsed real time it needs to report the ticks it played. */
    const backdate = (id, userId, column) => db.exec(
      `UPDATE public.game_matches SET tetris = jsonb_set(tetris, '{${userId},${column}}', to_jsonb(now() - interval '60 seconds')) WHERE id = '${id}'`,
    );

    // --- Tetris: a finish that repeats the taps already on file is accepted ------------
    await login('a');
    const duel = await games.startTetris('sprint');
    await games.startTetrisRun(duel);
    await backdate(duel, a.id, 'started_at');
    // The heartbeat carried these taps first; its answer was dropped on the wire.
    await games.beatTetrisRun(duel, 40, [{ tick: 10, action: 'left' }, { tick: 20, action: 'rotate' }]);

    // A tap for a tick already passed that is NOT on file is still out of order.
    await assert.rejects(
      games.beatTetrisRun(duel, 60, [{ tick: 15, action: 'drop' }]),
      /out of order/,
      'a tap that contradicts the log is still refused',
    );

    // The finish the phone sends next repeats the logged taps (the board cannot know the
    // beat landed) and adds the taps made after. Before this fix: 'out of order', forever.
    const finished = await games.finishTetrisRun(duel, 80, [
      { tick: 10, action: 'left' }, { tick: 20, action: 'rotate' }, { tick: 60, action: 'drop' },
    ]);
    assert.equal(finished.status, 'done', 'the overlapping retry is skipped, not refused');
    assert.equal(finished.ticks, 80);

    // The log holds each tap exactly once — a resend never re-writes history.
    const logged = (await match(duel)).tetris.mine.inputs;
    assert.deepEqual(logged, [[10, 'left'], [20, 'rotate'], [60, 'drop']], 'each tap is on file once');

    // The partner plays too, and the duel settles — nothing is left in ongoing games.
    await login('b');
    await games.startTetrisRun(duel);
    await backdate(duel, b.id, 'started_at');
    await games.beatTetrisRun(duel, 40, [{ tick: 10, action: 'left' }]);
    await games.finishTetrisRun(duel, 80, [{ tick: 10, action: 'left' }, { tick: 30, action: 'right' }]);
    const settled = await match(duel);
    assert.equal(settled.finished, true, 'both runs in — the duel settles, and leaves the ongoing list');

    // --- Snake: the same bargain, on the other board ---------------------------------
    await login('a');
    const snake = await games.startGame('snake', 3);
    await games.startSnakeRun(snake);
    await db.exec(
      `UPDATE public.game_matches SET snake = jsonb_set(snake, '{${a.id},started_at}', to_jsonb(now() - interval '60 seconds')) WHERE id = '${snake}'`,
    );
    await games.beatSnakeRun(snake, 40, [{ tick: 10, dir: 'up' }, { tick: 20, dir: 'left' }]);
    await assert.rejects(
      games.beatSnakeRun(snake, 60, [{ tick: 15, dir: 'down' }]),
      /out of order/,
      'a snake turn that contradicts the log is still refused',
    );
    const snakeDone = await games.finishSnakeRun(snake, 80, [
      { tick: 10, dir: 'up' }, { tick: 20, dir: 'left' }, { tick: 60, dir: 'down' },
    ]);
    assert.equal(snakeDone.status, 'done', 'a snake finish may repeat turns already on file');
    const snakeLogged = (await match(snake)).snake.mine.dirs;
    assert.deepEqual(snakeLogged, [[10, 'up'], [20, 'left'], [60, 'down']], 'and each turn is on file once');
  } finally {
    await db?.close();
    await server.close();
  }
});
