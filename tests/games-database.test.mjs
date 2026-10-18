import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

test('games: only always-available multiplayer matches remain, with sealed RPS picks and authoritative scoring', async () => {
 const server = await createServer({ server: { middlewareMode:true, hmr:false, ws:false }, define: {
  'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
  'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
 }});
 let db;
 try {
  const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
  db = await installTestBackend(supabase);
  const auth = await server.ssrLoadModule('/src/lib/authService.ts');
  const games = await server.ssrLoadModule('/src/lib/gamesService.ts');
  const a = (await auth.signUpWithEmail('a@test.com','password')).user;
  await auth.saveOnboardingProfile(a.id, { name: 'A', location: null, timezone: 'UTC' });
  const { couple } = await auth.createCouple(a.id,'2020-01-01');
  const b = (await auth.signUpWithEmail('b@test.com','password')).user;
  await auth.saveOnboardingProfile(b.id, { name: 'B', location: null, timezone: 'UTC' });
  await auth.joinCoupleWithCode(b.id,couple.invite_code);
  const login = who => auth.signInWithEmail(`${who}@test.com`,'password');
  const match = async id => (await games.fetchGames()).matches.find(m=>m.id===id);

  for (const best of [3,5]) {
   await login('a');
   const rps = await games.startGame('rock-paper-scissors',best);
   assert.equal(await games.startGame('rock-paper-scissors',best), rps, 'an open match resumes');
   await games.playGame(await match(rps),'rock');
   await assert.rejects(games.playGame(await match(rps),'paper'), /locked/);
   await login('b');
   const sealed = await match(rps);
   assert.equal(sealed.my_pick,null);
   assert.equal(sealed.partner_locked,true);
   assert.equal('pick_x' in sealed,false);
   assert.equal(JSON.stringify(sealed).includes('"rock"'),false);
   const direct = await supabase.rpc('play_game',{p_id:rps,p_round:1,p_move:'invalid'});
   assert.ok(direct.error);
   await games.playGame(sealed,'rock');
   assert.equal((await match(rps)).score_x,0);
   assert.equal((await match(rps)).rounds[0].x,'rock');
   await assert.rejects(games.playGame(sealed,'paper'), /changed/);
   for(let i=0;i<Math.ceil(best/2);i++) {
    await login('a'); await games.playGame(await match(rps),'paper');
    await login('b'); await games.playGame(await match(rps),'rock');
   }
   assert.equal((await match(rps)).winner_id,a.id);
   assert.equal((await match(rps)).finished,true);
  }
  assert.equal((await games.fetchGames()).wins[a.id],2, 'wins include only completed, supported games');

  const gamesColumns = await db.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'game_matches'`);
  const columnNames = gamesColumns.rows.map(row => row.column_name);
  assert.equal(columnNames.includes('daily_date'), false, 'the daily-game date is removed');
  assert.equal(columnNames.includes('board'), true, 'the consolidated schema includes Connect Four’s board');
  const oldStart = await db.query(`SELECT to_regprocedure('public.start_game(text,boolean,integer)') AS procedure`);
  assert.equal(oldStart.rows[0].procedure, null, 'the daily-flag RPC no longer exists');
  await assert.rejects(games.startGame('tic-tac-toe',3), /Invalid game settings/);

  const outsider = (await auth.signUpWithEmail('c@test.com','password')).user;
  await auth.saveOnboardingProfile(outsider.id, { name: 'C', location: null, timezone: 'UTC' });
  await assert.rejects(games.fetchGames(), /Pair/);
  await assert.rejects(games.playGame({id:'00000000-0000-0000-0000-000000000000',round:1},'rock'), /not found/);
  await assert.rejects(games.startGame('rock-paper-scissors',3), /Pair/);

  const retirement = await readFile(new URL('../supabase/migrations/202610180002_remove_daily_games_and_tic_tac_toe.sql',import.meta.url),'utf8');
  await db.exec(retirement);
  await db.exec(await readFile(new URL('../supabase/migrations/202610180005_connect_four.sql',import.meta.url),'utf8'));
  const verify = await readFile(new URL('../supabase/verify-games.sql',import.meta.url),'utf8');
  await db.exec(verify);
  const perms = await db.query("SELECT has_table_privilege('authenticated','public.game_matches','SELECT') allowed");
  assert.equal(perms.rows[0].allowed,false,'secret table is not client readable');
 } finally { await db?.close(); await server.close(); }
});
