import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

test('Someday list: both partners share, complete, reorder and delete every task', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'Event']) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
    },
  });
  const root = createRoot(document.getElementById('root'));
  let backend;
  try {
    const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
    backend = await installTestBackend(supabase);
    supabase.channel = () => { const channel = { on: () => channel, subscribe: () => channel }; return channel; };
    supabase.removeChannel = async () => {};
    const auth = await server.ssrLoadModule('/src/lib/authService.ts');
    const { useSomedayList } = await server.ssrLoadModule('/src/hooks/useSomedayList.ts');

    const alice = (await auth.signUpWithEmail('alice@example.com', 'password')).user;
    await auth.saveOnboardingProfile(alice.id, { name: 'Alice', location: null, timezone: 'Africa/Lagos' });
    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, { name: 'Bob', location: null, timezone: 'Pacific/Auckland' });
    const { couple } = await auth.createCouple(bob.id, '2020-02-14');
    await auth.signInWithEmail('alice@example.com', 'password');
    await auth.joinCoupleWithCode(alice.id, couple.invite_code);

    let latest;
    function Harness() { latest = useSomedayList(couple.id, alice.id); return null; }
    const render = () => act(async () => root.render(React.createElement(Harness)));
    await render();
    let one;
    let two;
    await act(async () => { one = await latest.addItem('Try the night market'); });
    await act(async () => { two = await latest.addItem('Watch the sunset'); });
    assert.deepEqual(latest.items.map((item) => item.text), ['Try the night market', 'Watch the sunset'], 'new tasks join the end of the notebook');

    await act(async () => latest.reorderItems([two.id, one.id]));
    assert.deepEqual(latest.items.map((item) => item.text), ['Watch the sunset', 'Try the night market']);
    await act(async () => latest.toggleItem(latest.items[0]));
    assert.equal(latest.items[0].completed, true);

    await auth.signInWithEmail('bob@example.com', 'password');
    const { data: sharedItems, error } = await supabase.from('someday_items').select('*').eq('couple_id', couple.id);
    assert.equal(error, null);
    assert.deepEqual(new Set(sharedItems.map((item) => item.id)), new Set([one.id, two.id]), 'both tasks are visible to both partners');
    const deletedByPartner = await supabase.from('someday_items').delete().eq('id', one.id).eq('couple_id', couple.id);
    assert.equal(deletedByPartner.error, null, 'either partner can remove a task without a vote/consensus');
    const { data: remaining } = await supabase.from('someday_items').select('*').eq('couple_id', couple.id);
    assert.deepEqual(remaining.map((item) => item.id), [two.id]);
  } finally {
    await act(async () => root.unmount());
    await backend?.close();
    await server.close();
    dom.window.close();
  }
});
