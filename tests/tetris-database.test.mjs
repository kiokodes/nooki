import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

/**
 * The Tetris duel, end to end, against a real Postgres.
 *
 * The point of the duel is that neither phone is trusted: a run is the pieces the database
 * dealt plus the taps the phone reported, and the database replays those to work out the
 * score. So this test plays a real run on the phone's side of the wire, keeps the phone's
 * own replay of it, and asserts the database arrived at exactly the same number — the one
 * failure mode that would quietly disqualify honest runs. Then it checks the rules around
 * it: one run each, the same pieces for both partners, sealed scores until both are in,
 * both ways of settling a duel, leaving as a forfeit, and the grace window.
 */
test('tetris duel: verified runs, shared pieces, both modes, forfeits and the grace window', async () => {
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
    const core = await server.ssrLoadModule('/src/lib/tetris.ts');
    const { createTetrisState, stepTetris, queueTetrisAction, replayTetris, TETRIS_RUN_TICKS, TETRIS_PIECE_COUNT } = core;

    const a = (await auth.signUpWithEmail('a@test.com', 'password')).user;
    await auth.saveOnboardingProfile(a.id, 'A', 'Africa/Lagos');
    const { couple } = await auth.createCouple(a.id, '2020-01-01');
    const b = (await auth.signUpWithEmail('b@test.com', 'password')).user;
    await auth.saveOnboardingProfile(b.id, 'B', 'Pacific/Auckland');
    await auth.joinCoupleWithCode(b.id, couple.invite_code);
    const login = (who) => auth.signInWithEmail(`${who}@test.com`, 'password');
    const match = async (id) => (await games.fetchGames()).matches.find((m) => m.id === id);

    /**
     * The phone's half of a run: stand every piece on end in the next column, so four rows
     * clear at a time and the well keeps coming back empty. Nothing here is a cheat — it is
     * the same core the browser runs, which is exactly why the two scores have to agree.
     */
    const playRun = (pieces, limit) => {
      const script = [];
      for (let col = 0; col < 10; col += 1) {
        script.push('rotate');
        for (let move = 0; move < Math.abs(col - 4); move += 1) script.push(col < 4 ? 'left' : 'right');
        script.push('drop');
      }
      let state = createTetrisState(pieces);
      const inputs = [];
      let at = 0;
      while (!state.ended && state.ticks < limit) {
        const queued = queueTetrisAction(state, script[at % script.length]);
        if (queued !== state) at += 1;
        const step = stepTetris(queued);
        inputs.push(...step.applied);
        state = step.state;
      }
      return { state, inputs };
    };
    /** Give a live run the elapsed real time it needs to report the ticks it played. */
    const backdate = (id, userId, seconds, column = 'started_at') => db.exec(
      `UPDATE public.game_matches SET tetris = jsonb_set(tetris, '{${userId},${column}}', to_jsonb(now() - interval '${seconds} seconds')) WHERE id = '${id}'`,
    );
    /** Deal a known sequence, so a run can be crafted rather than left to chance. */
    const dealPieces = (id, userId, pieces) => db.exec(
      `UPDATE public.game_matches SET tetris = jsonb_set(tetris, '{${userId},pieces}', '${JSON.stringify(pieces)}'::jsonb) WHERE id = '${id}'`,
    );

    // --- A duel is started once and picked back up, not restarted ---------------------
    await login('a');
    const duel = await games.startGame('tetris', false, 3, 'sprint');
    assert.equal(await games.startGame('tetris', false, 3, 'sprint'), duel, 'one open sprint per couple');
    await assert.rejects(games.startGame('tetris', false, 3), /needs a mode/, 'a Tetris duel is started in a mode');
    await assert.rejects(games.startGame('tetris', false, 3, 'longest'), /Invalid game settings/, 'and only in one of the two');
    // The other mode is a different duel, not a rematch of this one.
    const survival = await games.startGame('tetris', false, 3, 'survival');
    assert.notEqual(survival, duel, 'a sprint and a survival can both be open');
    const opened = await match(duel);
    assert.equal(opened.game, 'tetris');
    assert.equal(opened.finished, false);
    assert.equal(opened.tetris.mode, 'sprint', 'the mode is part of what both phones see');
    assert.equal(opened.tetris.mine, null, 'this phone has not played');
    assert.equal(opened.tetris.partner.status, 'waiting');

    // --- Nobody can claim a score: the database deals the pieces and keeps the clock ---
    const run = await games.startTetrisRun(duel);
    assert.equal(run.status, 'running');
    assert.equal(run.ticks, 0);
    assert.equal(run.inputs.length, 0);
    assert.equal(run.pieces.length, TETRIS_PIECE_COUNT);
    assert.ok(run.pieces.every((kind) => kind >= 0 && kind < 7), 'every piece is one of the seven');
    assert.ok(run.deadline > run.started_at, 'the run has a deadline');
    await assert.rejects(games.beatTetrisRun(duel, 5000, []), /faster than real time/, 'a phone cannot outrun the clock');

    // --- Both partners play the same pieces, so the duel is like for like --------------
    // Dealt once, when the first run began, and handed to the second partner untouched:
    // the same sequence is the only fair way to compare two runs played days apart.
    const dealt = run.pieces;
    await login('b');
    const bRun = await games.startTetrisRun(duel);
    assert.deepEqual(bRun.pieces, dealt, 'one sequence for the whole duel');
    assert.notDeepEqual(dealt, new Array(TETRIS_PIECE_COUNT).fill(dealt[0]), 'and it really was dealt at random');

    // --- Playing it out, with the phone's own replay as the reference ------------------
    await login('a');
    const pieces = new Array(600).fill(0);          // ten bars stand up and clear the well
    await dealPieces(duel, a.id, pieces);
    await backdate(duel, a.id, 320);
    const played = playRun(pieces, TETRIS_RUN_TICKS);
    const phone = replayTetris(pieces, played.state.ticks, played.inputs);
    assert.equal(played.state.ended, 'cap', 'the run played out to the five minutes');
    assert.ok(phone.score > 0, 'and cleared a great many rows doing it');
    assert.ok(phone.lines > 10);

    const beated = await games.beatTetrisRun(duel, 200, played.inputs.filter((i) => i.tick < 200));
    assert.equal(beated.ticks, 200);
    assert.equal(beated.status, 'running', 'a progress report does not end the run');
    await assert.rejects(games.beatTetrisRun(duel, 100, []), /older than the last one/, 'a run cannot be rewound');
    await assert.rejects(games.beatTetrisRun(duel, 400, [{ tick: 150, action: 'left' }]), /out of order/, 'the history is append-only');
    await assert.rejects(games.beatTetrisRun(duel, 400, [{ tick: 400, action: 'left' }]), /out of order/, 'a tap cannot be logged for a tick not yet reached');
    await assert.rejects(games.beatTetrisRun(duel, 400, [{ tick: 250, action: 'sideways' }]), /cannot be read/, 'nor one the board does not have');

    const settled = await games.finishTetrisRun(duel, played.state.ticks, played.inputs.filter((i) => i.tick >= 200));
    assert.equal(settled.status, 'done');
    assert.equal(settled.score, phone.score, 'the database scored the run exactly as the phone did');
    assert.equal(settled.lines, phone.lines, 'and cleared the same number of rows');
    assert.equal(settled.ticks, played.state.ticks, 'and stopped on the very same tick');
    assert.equal(settled.ended, played.state.ended, 'and knows how it ended');

    // --- One run each, and it is already spent ----------------------------------------
    await assert.rejects(games.startTetrisRun(duel), /already played your run/, 'no second attempt');

    // --- A blind duel: the partner sees that a run is in, never what it scored ---------
    await login('b');
    const beforePlaying = await match(duel);
    assert.equal(beforePlaying.finished, false);
    assert.equal(beforePlaying.tetris.partner.status, 'done', 'B can see that A has played');
    assert.equal('score' in beforePlaying.tetris.partner, false, 'but not what A scored');
    assert.deepEqual(Object.keys(beforePlaying.tetris.partner).sort(), ['ended', 'status'], 'nor any of A’s run');

    // --- The partner's run tops out early, and the higher score takes the sprint --------
    await dealPieces(duel, b.id, new Array(600).fill(6));   // every piece down one column
    await backdate(duel, b.id, 200);
    const bPlayed = playRun(new Array(600).fill(6), 1200);
    assert.equal(bPlayed.state.ended, 'top', 'stacking one column buries you');
    const bSettled = await games.finishTetrisRun(duel, bPlayed.state.ticks, bPlayed.inputs);
    assert.equal(
      bSettled.score,
      replayTetris(new Array(600).fill(6), bPlayed.state.ticks, bPlayed.inputs).score,
      'a topped-out run is scored by the same replay, not by how it feels',
    );
    const finished = await match(duel);
    assert.equal(finished.finished, true);
    assert.equal(finished.winner_id, a.id, 'the higher score takes a sprint');
    assert.equal(finished.tetris.mine.score, bSettled.score, 'now the scores are open to both');
    assert.equal(finished.tetris.partner.score, settled.score);
    assert.ok(finished.tetris.partner.lines > 0, 'and so are the rows each of them cleared');
    const afterFirst = await games.fetchGames();
    assert.equal(afterFirst.wins[a.id] ?? 0, 1, 'a duel win lands on the scoreboard');

    // --- Survival: the run that lasted longer wins, whatever it scored --------------------
    await login('a');
    await games.startTetrisRun(survival);
    await dealPieces(survival, a.id, new Array(600).fill(6));
    await backdate(survival, a.id, 200);
    const quickPlayed = playRun(new Array(600).fill(6), 1200);
    await games.finishTetrisRun(survival, quickPlayed.state.ticks, quickPlayed.inputs);
    assert.equal((await match(survival)).finished, false, 'the duel waits for the partner');
    await login('b');
    await games.startTetrisRun(survival);
    await dealPieces(survival, b.id, pieces);
    await backdate(survival, b.id, 320);
    const longPlayed = playRun(pieces, TETRIS_RUN_TICKS);
    await games.finishTetrisRun(survival, longPlayed.state.ticks, longPlayed.inputs);
    const survived = await match(survival);
    assert.equal(survived.finished, true);
    assert.equal(survived.winner_id, b.id, 'the partner who kept stacking longer takes it');
    assert.ok(longPlayed.state.ticks > quickPlayed.state.ticks, 'having lasted more ticks');

    // --- Leaving is a forfeit, there and then, even with no run from the partner -------
    const second = await games.startGame('tetris', false, 3, 'sprint');
    await login('a');
    await games.startTetrisRun(second);
    const beforeForfeit = await games.fetchGames();
    await games.forfeitTetrisRun(second);
    const forfeited = await games.fetchGames();
    const lost = forfeited.matches.find((m) => m.id === second);
    assert.equal(lost.finished, true, 'the duel ends the moment someone walks out');
    assert.equal(lost.winner_id, b.id, 'the partner who stayed takes it');
    assert.equal(lost.tetris.mine.status, 'forfeit');
    assert.equal(lost.tetris.mine.ended, 'forfeit');
    assert.equal(forfeited.wins[b.id] ?? 0, (beforeForfeit.wins[b.id] ?? 0) + 1, 'a forfeit is a win for the other side');
    await login('b');
    const winnerSees = await match(second);
    assert.equal(winnerSees.tetris.partner.status, 'forfeit');
    assert.equal(winnerSees.tetris.partner.score, lost.tetris.mine.score, 'the revealed score is what the leaver had reached');

    // --- A phone that goes quiet loses the run (the 30-second grace) -------------------
    const third = await games.startGame('tetris', false, 3, 'sprint');
    await login('a');
    await games.startTetrisRun(third);
    await backdate(third, a.id, 45, 'last_seen');
    await login('b');
    const swept = await match(third);
    assert.equal(swept.finished, true, 'the sweep runs when either partner reads the state');
    assert.equal(swept.winner_id, b.id, 'and the partner takes the duel');
    assert.equal(swept.tetris.partner.status, 'forfeit');
    assert.equal(swept.tetris.partner.ended, 'forfeit');
    assert.ok(Number(swept.tetris.partner.score) >= 0, 'the score it had reached is kept');
    // A report that arrives after the grace cannot revive the run.
    await login('a');
    const late = await games.beatTetrisRun(third, 10, []);
    assert.equal(late.status, 'forfeit', 'the late report is told the run is already lost');

    // --- A phone that keeps reporting when the five minutes are up simply stops there ---
    const fourth = await games.startGame('tetris', false, 3, 'sprint');
    await login('a');
    const clocked = await games.startTetrisRun(fourth);
    await dealPieces(fourth, a.id, pieces);
    await backdate(fourth, a.id, 90);
    const clockedPlayed = playRun(pieces, 900);
    await games.beatTetrisRun(fourth, clockedPlayed.state.ticks, clockedPlayed.inputs);
    await db.exec(`UPDATE public.game_matches SET tetris = jsonb_set(tetris, '{${a.id},deadline}', to_jsonb(now() - interval '1 second')) WHERE id = '${fourth}'`);
    await login('b');
    const timedOut = await match(fourth);
    assert.equal(timedOut.tetris.partner.status, 'done', 'the run ends where it stood rather than being lost');
    assert.equal(timedOut.tetris.partner.ended, 'cap');
    assert.equal('score' in timedOut.tetris.partner, false, 'and it is still sealed while B has not played');
    await login('a');
    const mineAfterTime = await match(fourth);
    assert.equal(mineAfterTime.tetris.mine.status, 'done');
    assert.equal(mineAfterTime.tetris.mine.ended, 'cap');
    assert.equal(
      mineAfterTime.tetris.mine.score,
      replayTetris(pieces, clockedPlayed.state.ticks, clockedPlayed.inputs).score,
      'and the score is the replayed truth, not a claim',
    );
    assert.ok(clocked.pieces.length === TETRIS_PIECE_COUNT);

    // --- Safe to rerun on a live project: the migration leaves the duels alone ---------
    const migration = await readFile(new URL('../supabase/migrations/202610150011_tetris_duel.sql', import.meta.url), 'utf8');
    const beforeRerun = await games.fetchGames();
    const beforeMigration = beforeRerun.matches.map((item) => [item.id, item.finished, item.winner_id]);
    await db.exec(migration);
    await db.exec(migration);
    await login('a');
    const afterMigration = await games.fetchGames();
    assert.deepEqual(
      afterMigration.matches.map((item) => [item.id, item.finished, item.winner_id]),
      beforeMigration,
      'rerunning the migration preserves every duel',
    );
    assert.deepEqual(afterMigration.wins, beforeRerun.wins, 'and the scoreboard it fed');
    const stillSealed = afterMigration.matches.find((item) => item.id === fourth);
    assert.equal(stillSealed.tetris.mine.score, mineAfterTime.tetris.mine.score, 'including the scores it derived');

    // --- Other couples cannot touch it, and the table is never exposed -----------------
    const outsider = (await auth.signUpWithEmail('c@test.com', 'password')).user;
    await auth.saveOnboardingProfile(outsider.id, 'C', 'UTC');
    await assert.rejects(games.fetchGames(), /Pair/);
    await assert.rejects(games.startTetrisRun(fourth), /Pair/);
    await assert.rejects(games.beatTetrisRun(fourth, 1, []), /Pair/);
    const direct = await supabase.rpc('tetris_beat', { p_id: fourth, p_ticks: 1, p_inputs: [] });
    assert.ok(direct.error, 'an unpaired account cannot report a run either');
  } finally {
    await db?.close();
    await server.close();
  }
});
