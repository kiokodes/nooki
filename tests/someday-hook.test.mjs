import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

test('someday list hook: append tasks, persist arrow ordering, completion and deletion', async () => {
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
    await act(async () => root.render(React.createElement(Harness)));
    assert.deepEqual(latest.items, []);
    let first;
    let second;
    await act(async () => { first = await latest.addItem('Try that restaurant'); });
    await act(async () => { second = await latest.addItem('Sunset at the beach'); });
    assert.deepEqual(latest.items.map((item) => item.text), ['Try that restaurant', 'Sunset at the beach']);
    assert.equal(latest.items[1].sort_order, latest.items[0].sort_order + 1);
    await assert.rejects(latest.addItem('   '), /task title/);

    await act(async () => latest.reorderItems([second.id, first.id]));
    assert.deepEqual(latest.items.map((item) => item.id), [second.id, first.id]);
    await act(async () => latest.toggleItem(latest.items[0]));
    assert.equal(latest.items[0].completed, true);
    await act(async () => latest.deleteItem(latest.items[1]));
    assert.deepEqual(latest.items.map((item) => item.id), [second.id]);

    const { data: visit, error } = await supabase.from('visits').insert({
      couple_id: couple.id, start_date: '2099-05-01', end_date: '2099-05-02',
      location: 'Lagos', timezone: 'Africa/Lagos', is_tentative: false, created_by: alice.id,
    }).select().single();
    assert.equal(error, null);
    await act(async () => latest.attachToVisit(latest.items[0], visit.id, '2099-05-02'));
    assert.equal(latest.items[0].visit_date, '2099-05-02');
    assert.equal(latest.error, null);
  } finally {
    await act(async () => root.unmount());
    await backend?.close();
    await server.close();
    dom.window.close();
  }
});
