import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

test('Duel: an old database reports the migration, polling keeps the error, and retry starts a real match', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent']) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
  } });
  let db;
  try {
    const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
    db = await installTestBackend(supabase);
    const auth = await server.ssrLoadModule('/src/lib/authService.ts');
    const service = await server.ssrLoadModule('/src/lib/gamesService.ts');
    const { useGames } = await server.ssrLoadModule('/src/hooks/useGames.ts');
    const { GamesView } = await server.ssrLoadModule('/src/components/games/GamesView.tsx');
    const alice = (await auth.signUpWithEmail('alice@test.com', 'password')).user;
    await auth.saveOnboardingProfile(alice.id, 'Alice', 'Africa/Lagos');
    const { couple } = await auth.createCouple(alice.id, '2020-01-01');
    const bob = (await auth.signUpWithEmail('bob@test.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, 'Bob', 'UTC');
    await auth.joinCoupleWithCode(bob.id, couple.invite_code);

    const original = await readFile(new URL('../supabase/migrations/202610150007_games.sql', import.meta.url), 'utf8');
    const snake = await readFile(new URL('../supabase/migrations/202610150010_snake_duel.sql', import.meta.url), 'utf8');
    const chess = await readFile(new URL('../supabase/migrations/202610150011_chess.sql', import.meta.url), 'utf8');
    const verify = await readFile(new URL('../supabase/verify-games.sql', import.meta.url), 'utf8');
    // This really is the old start_game, not a stub inventing an error message.
    await db.exec(original);
    await auth.signInWithEmail('alice@test.com', 'password');

    const rpc = supabase.rpc;
    const requests = [];
    supabase.rpc = (...args) => { requests.push(args[0]); return rpc(...args); };
    let latest;
    function Harness() {
      const games = useGames(couple.id, alice.id);
      React.useEffect(() => { latest = games; });
      return React.createElement(GamesView, { games, userId: alice.id, partnerName: 'Bob' });
    }
    const waitFor = async (predicate, message) => {
      for (let attempt = 0; attempt < 160; attempt += 1) {
        if (predicate()) return;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
      }
      assert.fail(message);
    };
    const click = async (text) => {
      const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === text);
      assert(button, `missing button: ${text}`);
      assert.equal(button.disabled, false, `${text} must be enabled`);
      await act(async () => { button.click(); });
    };
    await act(async () => root.render(React.createElement(Harness)));
    await waitFor(() => latest.data, 'Games should load even with the old start RPC');
    await click('Duel Bob →');
    await waitFor(() => latest.error, 'the failed start should surface');
    const alert = () => document.querySelector('[data-game="snake"] [role="alert"]');
    assert.match(alert().textContent, /202610150010_snake_duel.sql/);
    assert.equal(latest.pendingGame, null);
    assert.equal(latest.busy, false);
    const reads = requests.filter(name => name === 'games_state').length;
    await waitFor(() => requests.filter(name => name === 'games_state').length > reads, 'a background refresh should happen');
    assert.match(alert().textContent, /202610150010_snake_duel.sql/, 'successful polling cannot erase the start error');
    assert.equal(requests.filter(name => name === 'start_game').length, 1);

    // The owner applies Snake and then Chess to keep the latest Games schema. Retry must redo the
    // failed start, not merely refresh the already-readable list of games.
    await db.exec(snake);
    await db.exec(chess);
    await db.exec(verify);
    await auth.signInWithEmail('alice@test.com', 'password');
    await click('Try again');
    await waitFor(() => document.querySelector('[data-snake-gate]'), 'retry should open the duel gate');
    assert.equal(requests.filter(name => name === 'start_game').length, 2);
    assert.equal(latest.error, null);
    assert.equal(latest.data.matches.length, 1);
    const matchId = latest.match.id;
    await click('← All games');
    await click('Duel Bob →');
    await waitFor(() => latest.match, 'clicking Duel again should resume it');
    assert.equal(latest.match.id, matchId);
    assert.equal(latest.data.matches.length, 1);
    await click('Start my run');
    await waitFor(() => document.querySelector('.snake-board'), 'the database-dealt board should open');
    assert.equal(latest.match.snake.mine.status, 'running');
    assert(latest.match.snake.mine.foods.length > 0);
    await act(async () => { await latest.forfeitSnake(matchId); });
    assert.equal((await service.fetchGames()).matches[0].winner_id, bob.id);

    // Also reject a stale games_state even if start_game already accepts Snake.
    await act(async () => root.render(null));
    const oldState = original.match(/CREATE OR REPLACE FUNCTION public\.games_state\(\)[\s\S]*?END \$\$;/)[0];
    await db.exec(oldState);
    await assert.rejects(db.exec(verify), /games_state is the pre-Snake version/);
    await db.rollback();
    await db.exec(snake);
    await db.exec(chess);
    await db.exec(verify);
  } finally {
    await act(async () => root.unmount());
    await db?.close();
    await server.close();
    dom.window.close();
  }
});
