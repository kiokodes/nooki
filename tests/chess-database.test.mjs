import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

/**
 * Chess is refereed by the database (migration 011 mirrors src/lib/chess.ts), so
 * these tests play real games through the RPCs the way two phones would: illegal
 * moves, wrong turns and stale rounds are refused; captures, checkmate and the
 * situational goals are scored by the server, never claimed by a phone.
 */
test('chess database: authoritative moves, turns, checkmate and situational wins', async () => {
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
    await auth.saveOnboardingProfile(a.id, { name: 'A', location: null, timezone: 'UTC' });
    const { couple } = await auth.createCouple(a.id, '2020-01-01');
    const b = (await auth.signUpWithEmail('b@test.com', 'password')).user;
    await auth.saveOnboardingProfile(b.id, { name: 'B', location: null, timezone: 'UTC' });
    await auth.joinCoupleWithCode(b.id, couple.invite_code);
    const login = (who) => auth.signInWithEmail(`${who}@test.com`, 'password');
    const match = async (id) => (await games.fetchGames()).matches.find((m) => m.id === id);
    const play = async (who, id, move) => { await login(who); return games.playChess(await match(id), move); };
    const playRejects = async (who, id, move, pattern) => {
      await login(who);
      await assert.rejects(games.playChess(await match(id), move), pattern);
    };

    // --- Classic: Fool's mate, refereed ------------------------------------------
    await login('a');
    const classic = await games.startChess('classic');
    assert.equal(await games.startChess('classic'), classic, 'the open match is resumed, not duplicated');
    let m = await match(classic);
    assert.equal(m.chess.mode, 'classic');
    assert.equal(m.chess.board.length, 64);
    assert.equal(m.player_x, a.id, 'the starter is White');
    await playRejects('b', classic, 'e7e5', /partner's turn/, 'Black cannot move first');
    await playRejects('a', classic, 'e2e5', /not legal/, 'a pawn cannot jump three squares');
    await playRejects('a', classic, 'e7e5', /not your piece/, 'White cannot move a black pawn');
    await playRejects('a', classic, 'e2e4x', /like e2e4/, 'garbled moves are refused');
    await play('a', classic, 'f2f3');
    await assert.rejects(play('a', classic, 'e2e4'), /partner's turn/, 'no moving twice (as A again via helper)');
    await play('b', classic, 'e7e5');
    await play('a', classic, 'g2g4');
    const mate = await play('b', classic, 'd8h4');
    assert.equal(mate.end_reason, 'checkmate');
    assert.equal(mate.history.at(-1), 'Qh4#');
    m = await match(classic);
    assert.equal(m.finished, true);
    assert.equal(m.winner_id, b.id);
    assert.equal((await games.fetchGames()).wins[b.id], 1, 'the win lands on the scoreboard');
    await playRejects('a', classic, 'e2e4', /finished/);
    // A stale round token is refused, exactly as in play_game.
    await login('a');
    const stale = await supabase.rpc('chess_move', { p_id: classic, p_round: 1, p_move: 'e2e4' });
    assert.ok(stale.error, 'a finished match refuses everything');

    // --- Queen Hunt: only the server's count of the original queen ends it --------
    await login('a');
    const hunt = await games.startChess('queen-hunt');
    for (const [who, move] of [['a', 'e2e4'], ['b', 'd7d5'], ['a', 'e4d5'], ['b', 'd8d5'], ['a', 'b1c3'], ['b', 'g8f6']]) {
      await play(who, hunt, move);
    }
    m = await match(hunt);
    assert.equal(m.finished, false, 'trading pawns in front of the queen is not the hunt');
    assert.deepEqual(m.chess.captures, { white: ['pawn'], black: ['pawn'] });
    const hunted = await play('a', hunt, 'c3d5');
    assert.equal(hunted.end_reason, 'queen-hunt');
    m = await match(hunt);
    assert.equal(m.winner_id, a.id);

    // --- Capture Race: the seventh capture is counted by the server ----------------
    await login('a');
    const race = await games.startChess('capture-race');
    // Bank six captures on the row the way a long game would have earned them is not
    // possible from a phone — so earn the first, then let the owner set the scene the
    // way the database tests for snake do, and play the seventh for real.
    await play('a', race, 'e2e4');
    await play('b', race, 'd7d5');
    await db.exec(`UPDATE public.game_matches
      SET chess = jsonb_set(chess, '{captures,white}', '["pawn","pawn","knight","bishop","rook","pawn"]'::jsonb)
      WHERE id = '${race}'`);
    const seventh = await play('a', race, 'e4d5');
    assert.equal(seventh.end_reason, 'capture-race');
    assert.equal(seventh.captures.white.length, 7);
    assert.equal((await match(race)).winner_id, a.id);

    // --- Resignation, and checkmate still trumping a hunt ---------------------------
    await login('a');
    const duel = await games.startChess('classic');
    await play('a', duel, 'e2e4');
    await login('b');
    await games.playChess(await match(duel), 'resign');
    assert.equal((await match(duel)).winner_id, a.id, 'resigning hands the match to the partner');

    // Outsiders see nothing and can start nothing.
    const outsider = (await auth.signUpWithEmail('c@test.com', 'password')).user;
    await auth.saveOnboardingProfile(outsider.id, { name: 'C', location: null, timezone: 'UTC' });
    await assert.rejects(games.startChess('classic'), /Pair/);
    await assert.rejects(games.fetchGames(), /Pair/);

    // The Games retirement migration is rerunnable and preserves supported finished matches.
    const migration = await readFile(new URL('../supabase/migrations/202610180002_remove_daily_games_and_tic_tac_toe.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await db.exec(await readFile(new URL('../supabase/migrations/202610180006_connect_four.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/verify-games.sql', import.meta.url), 'utf8'));
    await login('a');
    assert.equal((await match(hunt)).winner_id, a.id, 'rerunning the retirement migration preserves supported matches');
    const perms = await db.query("SELECT has_function_privilege('authenticated','public.chess_legal(text[],text,integer,integer,integer,text)','EXECUTE') allowed");
    assert.equal(perms.rows[0].allowed, false, 'the referee internals stay server-side');
  } finally { await db?.close(); await server.close(); }
});

test('chess database: the SQL mirror castles, takes en passant and promotes like the phone', async () => {
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
    await auth.saveOnboardingProfile(a.id, { name: 'A', location: null, timezone: 'UTC' });
    const { couple } = await auth.createCouple(a.id, '2020-01-01');
    const b = (await auth.signUpWithEmail('b@test.com', 'password')).user;
    await auth.saveOnboardingProfile(b.id, { name: 'B', location: null, timezone: 'UTC' });
    await auth.joinCoupleWithCode(b.id, couple.invite_code);
    const login = (who) => auth.signInWithEmail(`${who}@test.com`, 'password');
    const match = async (id) => (await games.fetchGames()).matches.find((m) => m.id === id);
    const line = async (id, moves) => {
      for (const [i, move] of moves.entries()) {
        await login(i % 2 ? 'b' : 'a');
        await games.playChess(await match(id), move);
      }
      return match(id);
    };

    await login('a');
    const castle = await games.startChess('classic');
    let m = await line(castle, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'e1g1']);
    assert.equal(m.chess.board[62], 'wK', 'the king lands on g1');
    assert.equal(m.chess.board[61], 'wR', 'the rook hops to f1');
    assert.equal(m.chess.castling.includes('K'), false, 'castling spends the right');
    await login('b'); await games.playChess(await match(castle), 'resign');

    await login('a');
    const ep = await games.startChess('classic');
    assert.notEqual(ep, castle);
    m = await line(ep, ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6']);
    assert.equal(m.chess.board[43], '', 'the double-stepped pawn on d5 is removed');
    assert.deepEqual(m.chess.captures.white, ['pawn'], 'en passant is a capture');
    await login('b'); await games.playChess(await match(ep), 'resign');

    await login('a');
    const promo = await games.startChess('classic');
    m = await line(promo, ['a2a4', 'b7b5', 'a4b5', 'a7a6', 'b5a6', 'b8c6', 'a6a7', 'a8b8', 'a7b8q']);
    assert.equal(m.chess.board[1], 'wQ*', 'the promoted queen is marked — she is not the original');
    assert.equal(m.chess.captures.white.length, 3);
  } finally { await db?.close(); await server.close(); }
});
