import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

/**
 * The Snake duel, end to end, against a real Postgres.
 *
 * The point of the duel is that neither phone is trusted: a run is the food the database
 * dealt plus the direction changes the phone reported, and the database replays those to
 * work out the score. So this test plays a real run on the phone's side of the wire, keeps
 * the phone's own replay of it, and asserts the database arrived at exactly the same
 * number — then checks the rules that surround it: one run each, sealed scores until both
 * are in, leaving is a forfeit, and a phone that goes quiet loses the run.
 */
test('snake duel: verified runs, sealed scores, one attempt, forfeits and the grace window', async () => {
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
    const snake = await server.ssrLoadModule('/src/lib/snake.ts');
    const { createSnakeState, stepSnake, queueSnakeDirection, replaySnake, snakeFood, snakeDirectionDelta, isOppositeDirection, SNAKE_COLS, SNAKE_ROWS, SNAKE_FOOD_COUNT, SNAKE_RUN_TICKS } = snake;

    const a = (await auth.signUpWithEmail('a@test.com', 'password')).user;
    await auth.saveOnboardingProfile(a.id, { name: 'A', location: null, timezone: 'Africa/Lagos' });
    const { couple } = await auth.createCouple(a.id, '2020-01-01');
    const b = (await auth.signUpWithEmail('b@test.com', 'password')).user;
    await auth.saveOnboardingProfile(b.id, { name: 'B', location: null, timezone: 'Pacific/Auckland' });
    await auth.joinCoupleWithCode(b.id, couple.invite_code);
    const login = (who) => auth.signInWithEmail(`${who}@test.com`, 'password');
    const match = async (id) => (await games.fetchGames()).matches.find((m) => m.id === id);

    /**
     * The phone's half of a run: chase the food, one turn per tick, and keep the same
     * record of it the board would send. Nothing here is a cheat — it is the same core the
     * browser runs, which is exactly why the two scores have to agree.
     */
    const playRun = (foods, limit) => {
      let state = createSnakeState(foods);
      const changes = [];
      while (!state.ended && state.ticks < limit) {
        const head = state.body[0];
        const food = snakeFood(state);
        let best = state.dir;
        let bestScore = -Infinity;
        for (const dir of ['up', 'down', 'left', 'right']) {
          if (isOppositeDirection(state.dir, dir)) continue;
          const { dx, dy } = snakeDirectionDelta(dir);
          const next = { x: head.x + dx, y: head.y + dy };
          const held = state.body.slice(0, -1);
          if (next.x < 0 || next.x >= SNAKE_COLS || next.y < 0 || next.y >= SNAKE_ROWS) continue;
          if (held.some((cell) => cell.x === next.x && cell.y === next.y)) continue;
          const distance = food ? -Math.abs(next.x - food.x) - Math.abs(next.y - food.y) : 0;
          if (distance > bestScore) { bestScore = distance; best = dir; }
        }
        if (best !== state.dir) state = queueSnakeDirection(state, best);
        const step = stepSnake(state);
        if (step.applied) changes.push(step.applied);
        state = step.state;
      }
      return { state, changes };
    };
    /** Give a live run the elapsed real time it needs to report the ticks it played. */
    const backdate = (id, userId, seconds, column = 'started_at') => db.exec(
      `UPDATE public.game_matches SET snake = jsonb_set(snake, '{${userId},${column}}', to_jsonb(now() - interval '${seconds} seconds')) WHERE id = '${id}'`,
    );

    // --- A duel is started once and picked back up, not restarted ---------------------
    await login('a');
    const duel = await games.startGame('snake', 3);
    assert.equal(await games.startGame('snake', 3), duel, 'one open duel per couple');
    const opened = await match(duel);
    assert.equal(opened.game, 'snake');
    assert.equal(opened.finished, false);
    assert.equal(opened.snake.mine, null, 'this phone has not played');
    assert.equal(opened.snake.partner.status, 'waiting');

    // --- Nobody can claim a score: the database deals the food and keeps the clock ----
    const run = await games.startSnakeRun(duel);
    assert.equal(run.status, 'running');
    assert.equal(run.ticks, 0);
    assert.equal(run.dirs.length, 0);
    assert.equal(run.foods.length, SNAKE_FOOD_COUNT);
    assert.ok(run.foods.every(([x, y]) => x >= 0 && x < SNAKE_COLS && y >= 0 && y < SNAKE_ROWS), 'food is on the board');
    assert.ok(run.deadline > run.started_at, 'the run has a deadline');
    await assert.rejects(games.beatSnakeRun(duel, 5000, []), /faster than real time/, 'a phone cannot outrun the clock');

    // --- Playing it out, with the phone's own replay as the reference ------------------
    await backdate(duel, a.id, 200);
    const played = playRun(games.snakePoints(run.foods), SNAKE_RUN_TICKS);
    const phoneScore = replaySnake(games.snakePoints(run.foods), played.state.ticks, played.changes).score;
    assert.ok(played.state.ended, 'the run played out to an end');
    assert.ok(phoneScore > 0, 'the run ate something worth counting');
    const beated = await games.beatSnakeRun(duel, 60, played.changes.filter((c) => c.tick < 60));
    assert.equal(beated.ticks, 60);
    assert.equal(beated.status, 'running', 'a progress report does not end the run');
    await assert.rejects(games.beatSnakeRun(duel, 40, []), /older than the last one/, 'a run cannot be rewound');
    await assert.rejects(games.beatSnakeRun(duel, 90, [{ tick: 30, dir: 'up' }]), /out of order/, 'the history is append-only');
    const settled = await games.finishSnakeRun(duel, played.state.ticks, played.changes.filter((c) => c.tick >= 60));
    assert.equal(settled.status, 'done');
    assert.equal(settled.score, phoneScore, 'the database scored the run exactly as the phone did');
    assert.equal(settled.ticks, played.state.ticks, 'and stopped on the very same tick');
    assert.equal(settled.ended, played.state.ended, 'and knows how it ended');

    // --- One run each, and it is already spent ----------------------------------------
    await assert.rejects(games.startSnakeRun(duel), /already played your run/, 'no second attempt');

    // --- A blind duel: the partner sees that a run is in, never what it scored ---------
    await login('b');
    const beforePlaying = await match(duel);
    assert.equal(beforePlaying.finished, false);
    assert.equal(beforePlaying.snake.partner.status, 'done', 'B can see that A has played');
    assert.equal('score' in beforePlaying.snake.partner, false, 'but not what A scored');
    assert.deepEqual(Object.keys(beforePlaying.snake.partner).sort(), ['ended', 'status'], 'nor any of A\'s run');

    // --- B plays too, and the higher score takes the duel -----------------------------
    const bRun = await games.startSnakeRun(duel);
    await backdate(duel, b.id, 200);
    const bPlayed = playRun(games.snakePoints(bRun.foods), SNAKE_RUN_TICKS);
    const bSettled = await games.finishSnakeRun(duel, bPlayed.state.ticks, bPlayed.changes);
    const finished = await match(duel);
    assert.equal(finished.finished, true);
    const scores = { [a.id]: settled.score, [b.id]: bSettled.score };
    const expected = scores[a.id] > scores[b.id] ? a.id : scores[b.id] > scores[a.id] ? b.id : null;
    assert.equal(finished.winner_id, expected, 'the highest score wins, and a tie is a draw');
    assert.equal(finished.snake.mine.score, scores[b.id], 'now the scores are open to both');
    assert.equal(finished.snake.partner.score, scores[a.id]);
    const playedOnce = await games.fetchGames();
    assert.equal(playedOnce.wins[expected] ?? 0, expected ? 1 : 0, 'a duel win lands on the scoreboard');

    // --- Leaving is a forfeit, there and then, even with no run from the partner -------
    const second = await games.startGame('snake', 3);
    assert.notEqual(second, duel, 'a finished duel does not block a new one');
    await login('a');
    await games.startSnakeRun(second);
    await games.forfeitSnakeRun(second);
    const forfeited = await games.fetchGames();
    const lost = forfeited.matches.find((m) => m.id === second);
    assert.equal(lost.finished, true, 'the duel ends the moment someone walks out');
    assert.equal(lost.winner_id, b.id, 'the partner who stayed takes it');
    assert.equal(lost.snake.mine.status, 'forfeit');
    assert.equal(lost.snake.mine.ended, 'forfeit');
    assert.equal(forfeited.wins[b.id] ?? 0, (playedOnce.wins[b.id] ?? 0) + 1, 'a forfeit is a win for the other side');
    await login('b');
    const winnerSees = await match(second);
    assert.equal(winnerSees.snake.partner.status, 'forfeit');
    assert.equal(winnerSees.snake.partner.score, lost.snake.mine.score, 'the revealed score is what the leaver had reached');

    // --- A phone that goes quiet loses the run (the 30-second grace) -------------------
    const third = await games.startGame('snake', 3);
    await login('a');
    const quiet = await games.startSnakeRun(third);
    await backdate(third, a.id, 45, 'last_seen');
    await login('b');
    const swept = await match(third);
    assert.equal(swept.finished, true, 'the sweep runs when either partner reads the state');
    assert.equal(swept.winner_id, b.id, 'and the partner takes the duel');
    assert.equal(swept.snake.partner.status, 'forfeit');
    assert.equal(swept.snake.partner.ended, 'forfeit');
    assert.ok(Number(swept.snake.partner.score) >= 0, 'the score it had reached is kept');
    // A report that arrives after the grace cannot revive the run.
    await login('a');
    const late = await games.beatSnakeRun(third, 10, []);
    assert.equal(late.status, 'forfeit', 'the late report is told the run is already lost');
    assert.equal(quiet.foods.length, SNAKE_FOOD_COUNT);

    // --- A phone that keeps reporting when the four minutes are up simply stops there --
    const fourth = await games.startGame('snake', 3);
    await login('a');
    const long = await games.startSnakeRun(fourth);
    await backdate(fourth, a.id, 90);
    const longPlayed = playRun(games.snakePoints(long.foods), 400);
    await games.beatSnakeRun(fourth, longPlayed.state.ticks, longPlayed.changes);
    await db.exec(`UPDATE public.game_matches SET snake = jsonb_set(snake, '{${a.id},deadline}', to_jsonb(now() - interval '1 second')) WHERE id = '${fourth}'`);
    await login('b');
    const timedOut = await match(fourth);
    assert.equal(timedOut.snake.partner.status, 'done', 'the run ends where it stood rather than being lost');
    assert.equal(timedOut.snake.partner.ended, 'cap');
    assert.equal('score' in timedOut.snake.partner, false, 'and it is still sealed while B has not played');
    await login('a');
    const mineAfterTime = await match(fourth);
    assert.equal(mineAfterTime.snake.mine.status, 'done');
    assert.equal(mineAfterTime.snake.mine.ended, 'cap');
    assert.equal(
      mineAfterTime.snake.mine.score,
      replaySnake(games.snakePoints(long.foods), longPlayed.state.ticks, longPlayed.changes).score,
      'and the score is the replayed truth, not a claim',
    );

    // --- Safe to rerun on a live project: the retirement migration leaves duels alone ---
    const migration = await readFile(new URL('../supabase/migrations/202610180002_remove_daily_games_and_tic_tac_toe.sql', import.meta.url), 'utf8');
    const beforeRerun = await games.fetchGames();
    const beforeMigration = beforeRerun.matches.map((item) => [item.id, item.finished, item.winner_id]);
    await db.exec(migration);
    await db.exec(migration);
    await login('a');
    const afterMigration = await games.fetchGames();
    assert.deepEqual(
      afterMigration.matches.map((item) => [item.id, item.finished, item.winner_id]),
      beforeMigration,
      'rerunning the retirement migration preserves every duel',
    );
    assert.deepEqual(afterMigration.wins, beforeRerun.wins, 'and the scoreboard it fed');
    const stillSealed = afterMigration.matches.find((item) => item.id === fourth);
    assert.equal(stillSealed.snake.mine.score, mineAfterTime.snake.mine.score, 'including the scores it derived');

    // --- Other couples cannot touch it, and the table is never exposed -----------------
    const outsider = (await auth.signUpWithEmail('c@test.com', 'password')).user;
    await auth.saveOnboardingProfile(outsider.id, { name: 'C', location: null, timezone: 'UTC' });
    await assert.rejects(games.fetchGames(), /Pair/);
    await assert.rejects(games.startSnakeRun(fourth), /Pair/);
    await assert.rejects(games.beatSnakeRun(fourth, 1, []), /Pair/);
    const direct = await supabase.rpc('snake_beat', { p_id: fourth, p_ticks: 1, p_dirs: [] });
    assert.ok(direct.error, 'an unpaired account cannot report a run either');
  } finally {
    await db?.close();
    await server.close();
  }
});
