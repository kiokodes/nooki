import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

// The hook is the only place that decides where a new idea goes and how a dragged
// order is sent to the database. This runs the real hook against real RLS in PGlite,
// with only the Realtime socket stubbed out.
test('someday list hook: new ideas join the top, notes save, drag order persists and the visit link works', async () => {
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
    // No live Realtime socket in a unit test; the hook's actions reload the list
    // themselves, which is what the UI depends on as well.
    supabase.channel = () => {
      const channel = { on: () => channel, subscribe: () => channel };
      return channel;
    };
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
    function Harness() {
      latest = useSomedayList(couple.id, alice.id);
      return null;
    }
    const render = () => act(async () => root.render(React.createElement(Harness)));
    await render();
    assert.equal(latest.loading, false);
    assert.deepEqual(latest.items, []);

    let first;
    await act(async () => {
      first = await latest.addItem('Try that restaurant');
    });
    assert.equal(first.text, 'Try that restaurant');
    assert.equal(latest.items.length, 1);

    await act(async () => {
      await latest.addItem('Sunset at the beach', 'Pack a blanket.');
    });
    assert.deepEqual(latest.items.map((item) => item.text), [
      'Sunset at the beach',
      'Try that restaurant',
    ], 'a new idea joins the top');
    assert.equal(latest.items[0].details, 'Pack a blanket.');
    assert.equal(latest.items[0].sort_order, latest.items[1].sort_order - 1);

    // Notes and the idea text can be edited later; the list reloads with the new words.
    await act(async () => {
      await latest.updateItem(latest.items[1], 'Dinner at that restaurant', 'Ask for the window table.');
    });
    assert.equal(latest.items[1].text, 'Dinner at that restaurant');
    assert.equal(latest.items[1].details, 'Ask for the window table.');
    await assert.rejects(
      (async () => {
        await act(async () => {
          await latest.updateItem(latest.items[1], '   ', null);
        });
      })(),
      /few words/,
      'an empty idea title is refused before it reaches the database',
    );

    // A dragged order is saved and comes back in the same order.
    const [newest, oldest] = latest.items;
    await act(async () => {
      await latest.reorderItems([oldest.id, newest.id]);
    });
    assert.deepEqual(latest.items.map((item) => item.text), [
      'Dinner at that restaurant',
      'Sunset at the beach',
    ]);

    // Complete / restore keeps the idea and its place in the completed group.
    await act(async () => {
      await latest.toggleItem(latest.items[1]);
    });
    assert.equal(latest.items[1].completed, true);
    await act(async () => {
      await latest.toggleItem(latest.items[1]);
    });
    assert.equal(latest.items[1].completed, false);

    // The visit bridge pins and unpins the same idea.
    const { data: visit, error: visitError } = await supabase
      .from('visits')
      .insert({
        couple_id: couple.id,
        start_date: '2099-05-01',
        end_date: null,
        location: 'Lagos',
        timezone: 'Africa/Lagos',
        is_tentative: false,
        created_by: alice.id,
      })
      .select()
      .single();
    assert.equal(visitError, null);
    await act(async () => {
      await latest.attachToVisit(latest.items[0], visit.id);
    });
    assert.equal(latest.items[0].visit_id, visit.id);
    await act(async () => {
      await latest.attachToVisit(latest.items[0], null);
    });
    assert.equal(latest.items[0].visit_id, null);

    // Deleting removes only the chosen idea.
    await act(async () => {
      await latest.deleteItem(latest.items[1]);
    });
    assert.deepEqual(latest.items.map((item) => item.text), ['Dinner at that restaurant']);

    // The migrate-me message is friendly rather than a raw Postgres error.
    assert.equal(latest.error, null);
  } finally {
    await act(async () => root.unmount());
    await backend?.close();
    await server.close();
    dom.window.close();
  }
});
