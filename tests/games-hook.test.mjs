import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('games actions cannot leave an old account busy or clear a new account’s pending action', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'Event']) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
  } });
  let client;
  try {
    const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
    client = supabase;
    await client.auth.initialize();
    const starts = [];
    client.rpc = (name) => name === 'start_game'
      ? new Promise(resolve => starts.push(resolve))
      : Promise.resolve({ data: { today: '2026-10-15', wins: {}, matches: [] }, error: null });
    const { useGames } = await server.ssrLoadModule('/src/hooks/useGames.ts');
    let latest;
    function Harness({ user }) {
      const games = useGames(`couple-${user}`, user);
      React.useEffect(() => { latest = games; });
      return null;
    }
    const render = user => act(async () => root.render(React.createElement(Harness, { user })));
    const begin = async () => {
      let completion;
      await act(async () => { completion = latest.start('snake'); });
      return { completion };
    };
    const complete = async (pending, data = 'match', error = null) => {
      await act(async () => { starts.shift()({ data, error }); await pending.completion; });
    };

    await render('a');
    const first = await begin();
    assert.equal(latest.busy, true);
    await render('b');
    assert.equal(latest.busy, false);
    await complete(first);
    await render('a');
    assert.equal(latest.busy, false, 'returning to A must not resurrect its completed pending flag');

    const old = await begin();
    await render('b');
    const newer = await begin();
    await complete(old);
    assert.equal(latest.busy, true, 'A completing must not clear B’s in-flight action');
    assert.equal(latest.pendingGame, 'snake');
    await complete(newer, null, { code: '', message: 'Connection interrupted' });
    assert.equal(latest.busy, false);
    assert.equal(latest.error, 'Connection interrupted');
    await render('a');
    assert.equal(latest.error, null, 'an action error belongs only to the account that made it');
    assert.equal(latest.busy, false);
  } finally {
    await act(async () => root.unmount());
    await client?.auth.dispose();
    await server.close();
    dom.window.close();
  }
});
