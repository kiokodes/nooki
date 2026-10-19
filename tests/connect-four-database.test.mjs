import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

test('Connect Four is async-resumable and its turns, wins and draws are database-refereed', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
  }});
  let db;
  try {
    const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
    db = await installTestBackend(supabase);
    await db.exec(await readFile(new URL('../supabase/migrations/202610180006_connect_four.sql', import.meta.url), 'utf8'));
    const auth = await server.ssrLoadModule('/src/lib/authService.ts');
    const service = await server.ssrLoadModule('/src/lib/gamesService.ts');
    const a = (await auth.signUpWithEmail('four-a@test.com', 'password')).user;
    await auth.saveOnboardingProfile(a.id, { name: 'A', location: null, timezone: 'UTC' });
    const { couple } = await auth.createCouple(a.id, '2020-01-01');
    const b = (await auth.signUpWithEmail('four-b@test.com', 'password')).user;
    await auth.saveOnboardingProfile(b.id, { name: 'B', location: null, timezone: 'UTC' });
    await auth.joinCoupleWithCode(b.id, couple.invite_code);
    const login = async (name) => auth.signInWithEmail(`four-${name}@test.com`, 'password');
    const match = async (id) => (await service.fetchGames()).matches.find((item) => item.id === id);
    await login('a');
    const id = await service.startConnectFour();
    assert.equal(await service.startConnectFour(), id, 'the open game resumes on either phone');
    assert.equal((await match(id)).board.length, 42);
    await login('b');
    await assert.rejects(service.playConnectFour(await match(id), 1), /partner|turn/);
    for (const [player, col] of [['a',0],['b',1],['a',0],['b',1],['a',0],['b',1],['a',0]]) {
      await login(player);
      await service.playConnectFour(await match(id), col);
    }
    const finished = await match(id);
    assert.equal(finished.finished, true);
    assert.equal(finished.winner_id, a.id);
    assert.equal(finished.board.filter(Boolean).length, 7);
    await assert.rejects(service.playConnectFour(finished, 2), /finished/);
    const perms = await db.query("SELECT has_table_privilege('authenticated','public.game_matches','SELECT') allowed");
    assert.equal(perms.rows[0].allowed, false);
    await db.exec(await readFile(new URL('../supabase/migrations/202610180009_dash_duel.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/202610190001_word_wheel.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/verify-games.sql', import.meta.url), 'utf8'));
  } finally { await db?.close(); await server.close(); }
});
