import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

test('games: saved multiplayer, daily limit, sealed picks and authoritative scoring', async () => {
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
  await auth.saveOnboardingProfile(a.id,'A','UTC');
  const { couple } = await auth.createCouple(a.id,'2020-01-01');
  const b = (await auth.signUpWithEmail('b@test.com','password')).user;
  await auth.saveOnboardingProfile(b.id,'B','UTC');
  await auth.joinCoupleWithCode(b.id,couple.invite_code);
  const login = who => auth.signInWithEmail(`${who}@test.com`,'password');
  const match = async id => (await games.fetchGames()).matches.find(m=>m.id===id);
  await login('a');
  const id = await games.startGame('tic-tac-toe',false,3);
  assert.equal(await games.startGame('tic-tac-toe',false,3),id);
  await login('b');
  await assert.rejects(games.playGame(await match(id),'0'), /partner's turn/);
  for (const [who,cell] of [['a','0'],['b','3'],['a','1'],['b','4'],['a','2']]) {
   await login(who); await games.playGame(await match(id),cell);
  }
  assert.equal((await match(id)).winner_id,a.id);
  await assert.rejects(games.playGame(await match(id),'8'), /finished/);
  assert.equal((await games.fetchGames()).wins[a.id],1);
  const draw = await games.startGame('tic-tac-toe',false,3);
  for (const [i,cell] of ['0','1','2','4','3','5','7','6','8'].entries()) {
   await login(i%2 ? 'b':'a'); await games.playGame(await match(draw),cell);
  }
  assert.equal((await match(draw)).finished,true);
  assert.equal((await match(draw)).winner_id,null);
  for (const best of [3,5]) {
   await login('a');
   const rps = await games.startGame('rock-paper-scissors',false,best);
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
  const daily = await games.startGame('tic-tac-toe',true,3);
  await login('a');
  assert.equal(await games.startGame('rock-paper-scissors',true,5),daily);
  await db.exec(`UPDATE public.game_matches SET finished=true WHERE id='${daily}'`);
  await login('b');
  assert.equal(await games.startGame('tic-tac-toe',true,3),daily,'completed daily cannot be replayed');
  await db.exec(`UPDATE public.game_matches SET daily_date=daily_date-1 WHERE id='${daily}'`);
  await login('b');
  assert.notEqual(await games.startGame('tic-tac-toe',true,3),daily,'new UTC day allows new match');
  const outsider = (await auth.signUpWithEmail('c@test.com','password')).user;
  await auth.saveOnboardingProfile(outsider.id,'C','UTC');
  await assert.rejects(games.fetchGames(), /Pair/);
  await assert.rejects(games.playGame({id,round:1},'0'), /not found/);
  await assert.rejects(games.startGame('tic-tac-toe',false,3), /Pair/);
  const migration = await readFile(new URL('../supabase/migrations/202610150007_games.sql',import.meta.url),'utf8');
  await db.exec(migration);
  await db.exec(await readFile(new URL('../supabase/verify-games.sql',import.meta.url),'utf8'));
  await login('a');
  assert.equal((await match(id)).winner_id,a.id,'migration reruns preserve matches');
  const perms = await db.query("SELECT has_table_privilege('authenticated','public.game_matches','SELECT') allowed");
  assert.equal(perms.rows[0].allowed,false,'secret table is not client readable');
 } finally { await db?.close(); await server.close(); }
});
