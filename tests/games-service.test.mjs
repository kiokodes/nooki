import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

test('games service distinguishes Snake setup failures from pairing, network and invalid-input errors', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
  } });
  let client;
  try {
    const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
    client = supabase;
    await client.auth.initialize();
    const games = await server.ssrLoadModule('/src/lib/gamesService.ts');
    const fail = (code, message) => { client.rpc = async () => ({ data: null, error: { code, message } }); };
    fail('P0001', 'Invalid game settings.');
    await assert.rejects(games.startGame('snake', false, 3), /202610150010_snake_duel.sql/);
    await assert.rejects(games.startGame('snake', false, 5), /202610150010_snake_duel.sql/);
    await assert.rejects(games.startGame('snake', false, 4), /^Error: Invalid game settings\.$/);
    await assert.rejects(games.startGame('tic-tac-toe', false, 3), /^Error: Invalid game settings\.$/);
    fail('23514', 'new row for relation "game_matches" violates check constraint "game_matches_game_check"');
    await assert.rejects(games.startGame('snake', false, 3), /202610150010_snake_duel.sql/);
    // The same violation on start_chess means Chess is installed but the game check
    // predates it: users get the named repair, never the raw constraint wording.
    await assert.rejects(games.startChess('classic'), /Chess needs a database update\..*202610150014_restore_chess_tetris_game_check\.sql/);
    await assert.rejects(games.startChess('classic'), (err) => !err.message.includes('violates check constraint'),
      'the raw Postgres constraint error must not reach the user');
    // Tetris' start hits the same downgraded check the same way.
    await assert.rejects(games.startTetris('sprint'), /Tetris Duel needs a database update\..*202610150014_restore_chess_tetris_game_check\.sql/);
    fail('PGRST202', 'Could not find public.snake_start in the schema cache');
    await assert.rejects(games.startSnakeRun('match'), /202610150010_snake_duel.sql/);
    fail('42883', 'function public.snake_sweep(uuid) does not exist');
    await assert.rejects(games.fetchGames(), /202610150010_snake_duel.sql/);
    fail('PGRST202', 'Could not find public.games_state in the schema cache');
    await assert.rejects(games.fetchGames(), /202610150007_games.sql/);
    fail('PGRST202', 'Could not find public.start_chess in the schema cache');
    await assert.rejects(games.startChess('queen-hunt'), /202610150011_chess.sql/);
    fail('42883', 'function public.chess_view(jsonb) does not exist');
    await assert.rejects(games.fetchGames(), /202610150011_chess.sql/);
    fail('P0001', 'Both partners must be paired.');
    await assert.rejects(games.startGame('snake', false, 3), /^Error: Both partners must be paired\.$/);
    fail('', 'Failed to fetch');
    await assert.rejects(games.startGame('snake', false, 3), /^Error: Failed to fetch$/);

    for (const data of [null, {}, { today: '2026-10-15', wins: {}, matches: null }]) {
      client.rpc = async () => ({ data, error: null });
      await assert.rejects(games.fetchGames(), /incomplete response/, 'a malformed response becomes an error, not a render crash');
    }
    const empty = { today: '2026-10-15', wins: {}, matches: [] };
    client.rpc = async () => ({ data: empty, error: null });
    assert.deepEqual(await games.fetchGames(), empty);
  } finally {
    await client?.auth.dispose();
    await server.close();
  }
});
