import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

test('Word Wheel database: shared puzzle, independent clocks, async submissions and expiry', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
  } });
  let db;
  try {
    const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
    db = await installTestBackend(supabase);
    // The puzzle bank is a seed file, applied once after the schema migration.
    await db.exec(await readFile(new URL('../supabase/seed/word_puzzles.sql', import.meta.url), 'utf8'));

    const auth = await server.ssrLoadModule('/src/lib/authService.ts');
    const games = await server.ssrLoadModule('/src/lib/gamesService.ts');
    const a = (await auth.signUpWithEmail('word-a@test.com', 'password')).user;
    await auth.saveOnboardingProfile(a.id, { name: 'A', location: null, timezone: 'Africa/Lagos' });
    const { couple } = await auth.createCouple(a.id, '2020-01-01');
    const b = (await auth.signUpWithEmail('word-b@test.com', 'password')).user;
    await auth.saveOnboardingProfile(b.id, { name: 'B', location: null, timezone: 'Africa/Lagos' });
    await auth.joinCoupleWithCode(b.id, couple.invite_code);
    const login = (who) => auth.signInWithEmail(`word-${who}@test.com`, 'password');
    const match = async (id) => (await games.fetchGames()).matches.find((item) => item.id === id);
    const backdateStart = async (id, userId, seconds) => {
      await db.exec('RESET ROLE');
      await db.exec(`UPDATE public.word_round_results SET started_at = now() - interval '${seconds} seconds' WHERE round_id = '${id}' AND user_id = '${userId}'`);
    };
    const backdateCreation = async (id, seconds) => {
      await db.exec('RESET ROLE');
      await db.exec(`UPDATE public.word_rounds SET created_at = now() - interval '${seconds} seconds' WHERE id = '${id}'`);
    };
    const startBoth = async (id) => {
      await login('a');
      const startedA = await games.startWordAttempt(id);
      assert.equal(startedA.status, 'running');
      assert.equal(startedA.mine.started, true);
      assert.equal(startedA.partner.started, false, 'the first start leaves the other clock untouched');
      await login('b');
      const startedB = await games.startWordAttempt(id);
      assert.equal(startedB.status, 'running');
      assert.equal(startedB.mine.started, true);
      assert.equal(startedB.partner.started, true);
      assert.equal(startedB.partner.started_at, null, 'the partner start timestamp remains sealed');
      assert.deepEqual(startedB.words, startedA.words, 'both phones receive the same immutable hidden list');
      return startedB;
    };

    await login('a');
    const roundId = await games.startWordRound('medium', 180);
    const opened = await match(roundId);
    assert.equal(opened.game, 'word-wheel');
    assert.equal(opened.word.difficulty, 'medium');
    assert.equal(opened.word.duration_seconds, 180);
    assert.equal(opened.word.words_total, 13, 'medium 3-minute pack size');
    assert.equal(opened.word.letters.length, 7);
    assert.equal(opened.word.grand_word.length, 7);
    assert.equal(opened.word.start_at, null);
    assert.equal(opened.word.mine.started, false);
    assert.equal(opened.word.partner.started, false);
    assert.equal(opened.finished, false);

    await login('b');
    assert.equal(await games.startWordRound('hard', 60), roundId, 'an open round resumes instead of replacing the puzzle');
    const waiting = await match(roundId);
    assert.equal(waiting.word.difficulty, 'medium', 'the first partner sets the difficulty');
    assert.equal(waiting.word.duration_seconds, 180);
    await assert.rejects(games.submitWordRound(roundId, waiting.word.words.slice(0, 2), 1000), /Start your own Word Wheel clock first/);

    // A starts alone, then B starts two minutes later. Both attempts keep a full
    // duration, and A can even submit before B has started.
    await login('a');
    const firstStart = await games.startWordAttempt(roundId);
    assert.equal(firstStart.status, 'running');
    assert.equal(firstStart.mine.started, true);
    assert.equal(firstStart.partner.started, false);
    assert.ok(firstStart.mine.started_at);
    await backdateStart(roundId, a.id, 120);
    await login('a');
    const clockA = await match(roundId);
    const targets = clockA.word.words;
    assert.equal(clockA.word.partner.started, false);
    const submittedA = await games.submitWordRound(roundId, [targets[0], targets[1], targets[0], 'zzz', 'notaword'], 42_000);
    assert.deepEqual(submittedA.mine.words.sort(), [targets[0], targets[1]].sort(), 'only real targets survive; duplicates and junk are dropped');
    assert.equal(submittedA.mine.count, 2);
    assert.equal(submittedA.mine.finished_ms, 42_000);
    assert.equal(submittedA.partner.count, 0, 'the partner result stays sealed while the round is live');
    assert.equal(submittedA.partner.started, false);
    assert.equal(submittedA.partner.submitted, false);
    assert.equal(submittedA.status, 'running');

    await login('b');
    const startedB = await games.startWordAttempt(roundId);
    assert.equal(startedB.status, 'running');
    assert.equal(startedB.mine.started, true);
    assert.equal(startedB.partner.started, true);
    assert.equal(startedB.partner.started_at, null, 'B cannot see A\'s exact start before settlement');
    assert.ok(Date.parse(startedB.mine.started_at) - Date.parse(clockA.word.mine.started_at) >= 119_000,
      'the second attempt starts substantially later than the first');
    assert.ok(180_000 - (Date.now() - Date.parse(startedB.mine.started_at)) > 179_000,
      'the late player still has the complete three-minute clock');
    const submittedB = await games.submitWordRound(roundId, [targets[0], targets[2]], 30_000);
    assert.equal(submittedB.status, 'finished');
    assert.equal(submittedB.winner_id, b.id, 'equal word counts compare each player\'s own elapsed time');
    assert.equal(submittedB.partner.count, 2);
    assert.equal(submittedB.partner.finished_ms, 42_000);
    const settled = await match(roundId);
    assert.equal(settled.finished, true);
    assert.equal(settled.winner_id, b.id);
    assert.equal(settled.word.partner.words.length, 2);
    assert.equal((await games.fetchGames()).wins[b.id], 1);

    // A full list beats a shorter list even when the shorter list was finished faster.
    await login('a');
    const clearId = await games.startWordRound('easy', 60);
    const clearStart = await startBoth(clearId);
    await login('a');
    const cleared = await games.submitWordRound(clearId, clearStart.words, 50_000);
    assert.equal(cleared.status, 'running', 'one finished phone waits for the other');
    await login('b');
    const shorter = await games.submitWordRound(clearId, clearStart.words.slice(0, 4), 5_000);
    assert.equal(shorter.winner_id, a.id, 'most words wins before the tie-break');
    assert.equal(shorter.mine.count, 4);

    // An exact tie on words and personal elapsed time is a draw.
    await login('a');
    const drawId = await games.startWordRound('easy', 60);
    const drawStart = await startBoth(drawId);
    await login('a');
    await games.submitWordRound(drawId, drawStart.words.slice(0, 3), 20_000);
    await login('b');
    const draw = await games.submitWordRound(drawId, drawStart.words.slice(0, 3), 20_000);
    assert.equal(draw.status, 'finished');
    assert.equal(draw.winner_id, null);

    // A started attempt that never submits is zero-filled after its own deadline + grace.
    await login('a');
    const sweepId = await games.startWordRound('easy', 60);
    const sweepStart = await startBoth(sweepId);
    await backdateStart(sweepId, b.id, 200);
    await login('a');
    await games.submitWordRound(sweepId, sweepStart.words.slice(0, 1), 12_000);
    await login('b');
    const swept = await match(sweepId);
    assert.equal(swept.finished, true);
    assert.equal(swept.winner_id, a.id);
    assert.equal(swept.word.mine.count, 0, 'only the missing attempt reports zero');

    // A player who starts near the end of the seven-day join window still gets the
    // full personal duration; the challenge-age cutoff applies only to unstarted slots.
    await login('a');
    const lateStartId = await games.startWordRound('easy', 60);
    await games.startWordAttempt(lateStartId);
    await backdateCreation(lateStartId, 7 * 24 * 60 * 60 - 60);
    await login('b');
    const lateStart = await games.startWordAttempt(lateStartId);
    assert.equal(lateStart.mine.started, true);
    assert.ok(60_000 - (Date.now() - Date.parse(lateStart.mine.started_at)) > 59_000,
      'the attempt started close to expiry still gets a full minute');
    await backdateCreation(lateStartId, 8 * 24 * 60 * 60);
    const stillPlaying = await match(lateStartId);
    assert.equal(stillPlaying.word.status, 'running');
    assert.equal(stillPlaying.word.mine.started, true);
    assert.equal(stillPlaying.word.mine.submitted, false, 'challenge age cannot truncate a started attempt');
    await backdateStart(lateStartId, a.id, 200);
    await backdateStart(lateStartId, b.id, 200);
    await login('a');
    assert.equal((await match(lateStartId)).finished, true, 'each personal deadline eventually settles');

    // An unstarted partner is also zero-filled if the creator's attempt is submitted
    // but the challenge is left open for longer than seven days.
    await login('a');
    const staleRunningId = await games.startWordRound('easy', 60);
    await games.startWordAttempt(staleRunningId);
    await games.submitWordRound(staleRunningId, ['picture', 'cut'], 12_000);
    await backdateCreation(staleRunningId, 8 * 24 * 60 * 60);
    await login('b');
    const staleRunning = await match(staleRunningId);
    assert.equal(staleRunning.finished, true);
    assert.equal(staleRunning.winner_id, a.id);
    assert.equal(staleRunning.word.mine.count, 0, 'a partner who never starts counts as zero after seven days');
    assert.equal(staleRunning.word.mine.started, false);

    // A challenge that nobody starts is cancelled at the same seven-day threshold.
    await login('a');
    const staleWaitingId = await games.startWordRound('hard', 300);
    await backdateCreation(staleWaitingId, 8 * 24 * 60 * 60);
    await login('b');
    assert.equal(await match(staleWaitingId), undefined, 'a dormant challenge cannot block new ones forever');

    // A fresh lobby can still be cancelled before either side starts.
    await login('a');
    const cancelId = await games.startWordRound('hard', 300);
    await games.cancelWordRound(cancelId);
    assert.equal(await match(cancelId), undefined);
  } finally {
    await server.close();
    await db?.close();
  }
});
