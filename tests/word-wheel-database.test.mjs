import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

test('Word Wheel database: one shared wheel, both-ready start, filtered words and tie-break', async () => {
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
    const backdate = async (id, seconds) => {
      await db.exec('RESET ROLE');
      await db.exec(`UPDATE public.word_rounds SET start_at = now() - interval '${seconds} seconds' WHERE id = '${id}'`);
    };
    const readyBoth = async (id) => {
      await login('a');
      const first = await games.readyWordRound(id);
      assert.equal(first.status, 'waiting', 'one ready phone cannot start alone');
      await login('b');
      const both = await games.readyWordRound(id);
      assert.equal(both.status, 'running');
      assert.ok(both.start_at && Date.parse(both.start_at) > Date.now(), 'the server sets a shared start a few seconds ahead');
      assert.deepEqual(both.words, first.words, 'both phones receive the same immutable hidden list');
      return both;
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
    assert.equal(opened.word.mine.ready, false);
    assert.equal(opened.word.partner.ready, false);
    assert.equal(opened.finished, false);

    await login('b');
    assert.equal(await games.startWordRound('hard', 60), roundId, 'an open round resumes instead of replacing the puzzle');
    const waiting = await match(roundId);
    assert.equal(waiting.word.difficulty, 'medium', 'the first partner sets the difficulty');
    assert.equal(waiting.word.duration_seconds, 180);
    await assert.rejects(games.submitWordRound(roundId, waiting.word.words.slice(0, 2), 1000), /not started/);

    const started = await readyBoth(roundId);
    await backdate(roundId, 120);
    await login('a');
    const targets = started.words;
    const submittedA = await games.submitWordRound(roundId, [targets[0], targets[1], targets[0], 'zzz', 'notaword'], 42_000);
    assert.deepEqual(submittedA.mine.words.sort(), [targets[0], targets[1]].sort(), 'only real targets survive; duplicates and junk are dropped');
    assert.equal(submittedA.mine.count, 2);
    assert.equal(submittedA.mine.finished_ms, 42_000);
    assert.equal(submittedA.partner.count, 0, 'the partner result stays sealed while the round is live');
    assert.equal(submittedA.partner.submitted, false);
    assert.equal(submittedA.status, 'running');

    const retried = await games.submitWordRound(roundId, targets, 1_000);
    assert.equal(retried.mine.count, 2, 'a retry cannot improve an already stored result');

    await login('b');
    const submittedB = await games.submitWordRound(roundId, [targets[0], targets[2]], 30_000);
    assert.equal(submittedB.status, 'finished');
    assert.equal(submittedB.winner_id, b.id, 'equal word counts: the earlier last-found word wins');
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
    const clearStart = await readyBoth(clearId);
    await backdate(clearId, 60);
    await login('a');
    const cleared = await games.submitWordRound(clearId, clearStart.words, 50_000);
    assert.equal(cleared.status, 'running', 'one finished phone waits for the other');
    await login('b');
    const shorter = await games.submitWordRound(clearId, clearStart.words.slice(0, 4), 5_000);
    assert.equal(shorter.winner_id, a.id, 'most words wins before the tie-break');
    assert.equal(shorter.mine.count, 4);

    // An exact tie on words and time is a draw.
    await login('a');
    const drawId = await games.startWordRound('easy', 60);
    const drawStart = await readyBoth(drawId);
    await backdate(drawId, 60);
    await login('a');
    await games.submitWordRound(drawId, drawStart.words.slice(0, 3), 20_000);
    await login('b');
    const draw = await games.submitWordRound(drawId, drawStart.words.slice(0, 3), 20_000);
    assert.equal(draw.status, 'finished');
    assert.equal(draw.winner_id, null);

    // A phone that never reports is counted as zero after the grace window; the sweep
    // runs inside games_state, so either partner's refresh settles the round.
    await login('a');
    const sweepId = await games.startWordRound('easy', 60);
    const sweepStart = await readyBoth(sweepId);
    await backdate(sweepId, 200);
    await login('a');
    await games.submitWordRound(sweepId, sweepStart.words.slice(0, 1), 12_000);
    await login('b');
    const swept = await match(sweepId);
    assert.equal(swept.finished, true);
    assert.equal(swept.winner_id, a.id);
    assert.equal(swept.word.mine.count, 0, 'the missing phone reports zero, not a guessed score');

    // A lobby can be dropped before it starts and disappears from Games.
    await login('a');
    const cancelId = await games.startWordRound('hard', 300);
    await games.cancelWordRound(cancelId);
    assert.equal(await match(cancelId), undefined);
  } finally {
    await server.close();
  }
});
