import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

// Exercise the Together client hooks against PGlite/RLS; no network or live
// Supabase project is used.
test('Together hooks: visits (including clearing one) and agreed Together time', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'Blob']) globalThis[key] = dom.window[key];
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
    const { useVisits } = await server.ssrLoadModule('/src/hooks/useVisits.ts');
    const { useTogetherTime } = await server.ssrLoadModule('/src/hooks/useTogetherTime.ts');

    const alice = (await auth.signUpWithEmail('alice@example.com', 'password')).user;
    await auth.saveOnboardingProfile(alice.id, { name: 'Alice', location: null, timezone: 'Africa/Lagos' });
    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, { name: 'Bob', location: null, timezone: 'Africa/Lagos' });
    const { couple } = await auth.createCouple(bob.id, '2020-02-14');
    await auth.signInWithEmail('alice@example.com', 'password');
    await auth.joinCoupleWithCode(alice.id, couple.invite_code);
    const { data: upcoming, error: visitError } = await supabase.from('visits').insert({
      couple_id: couple.id, start_date: '2099-06-01', end_date: '2099-06-02',
      location: 'Lagos', timezone: 'Africa/Lagos', created_by: alice.id,
    }).select().single();
    assert.equal(visitError, null);
    const { data: past, error: pastError } = await supabase.from('visits').insert({
      couple_id: couple.id, start_date: '2020-06-01', end_date: '2020-06-02',
      location: 'Abuja', timezone: 'Africa/Lagos', created_by: alice.id,
    }).select().single();
    assert.equal(pastError, null);

    let activeUserId = alice.id;
    let latest;
    function Harness() {
      latest = {
        visits: useVisits(couple.id, activeUserId),
        togetherTime: useTogetherTime(couple.id, activeUserId),
      };
      return null;
    }
    const render = () => act(async () => root.render(React.createElement(Harness)));
    const refreshAll = () => act(async () => {
      await Promise.all([latest.visits.refresh(), latest.togetherTime.refresh()]);
    });
    await render();
    await refreshAll();

    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await act(async () => latest.togetherTime.propose({
      activityType: 'game', activityId: 'word-wheel', activityName: 'Word Wheel',
      scheduledAt, timezone: 'Africa/Lagos',
    }));
    assert.equal(latest.togetherTime.sessions.length, 1);
    assert.equal(latest.togetherTime.sessions[0].activity_id, 'word-wheel');
    // Suggesting a time does not lock it in: Alice waits for Bob's yes.
    assert.equal(latest.togetherTime.sessions[0].status, 'proposed');
    assert.equal(latest.togetherTime.sessions[0].proposed_by, alice.id);
    assert.equal(latest.togetherTime.sessions[0].agreed_by, null);

    // The other partner agrees, counter-suggests, and is agreed with in turn.
    await auth.signInWithEmail('bob@example.com', 'password');
    activeUserId = bob.id;
    await render();
    await refreshAll();
    assert.equal(latest.togetherTime.sessions.length, 1);
    // Bob's agreement is what locks Alice's suggested time in.
    await act(async () => latest.togetherTime.agree(latest.togetherTime.sessions[0]));
    assert.equal(latest.togetherTime.sessions[0].status, 'scheduled');
    assert.equal(latest.togetherTime.sessions[0].agreed_by, bob.id);
    // Bob suggesting a different time reopens it — now he is the one waiting.
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    await act(async () => latest.togetherTime.suggestTime(latest.togetherTime.sessions[0], later, 'Africa/Lagos'));
    assert.equal(latest.togetherTime.sessions[0].status, 'proposed');
    assert.equal(latest.togetherTime.sessions[0].proposed_by, bob.id);
    assert.equal(latest.togetherTime.sessions[0].agreed_by, null);
    await auth.signInWithEmail('alice@example.com', 'password');
    activeUserId = alice.id;
    await render();
    await refreshAll();
    await act(async () => latest.togetherTime.agree(latest.togetherTime.sessions[0]));
    assert.equal(latest.togetherTime.sessions[0].status, 'scheduled');
    assert.equal(latest.togetherTime.sessions[0].agreed_by, alice.id);
    await auth.signInWithEmail('bob@example.com', 'password');
    activeUserId = bob.id;
    await render();
    await refreshAll();

    // Plans change: Bob can clear the upcoming visit Alice planned. It comes off
    // the calendar for the couple; the past visit stays put.
    assert.equal(latest.visits.visits.length, 2);
    assert.equal(latest.visits.visit.id, upcoming.id);
    await act(async () => latest.visits.deleteVisit(upcoming.id));
    assert.equal(latest.visits.visits.length, 1);
    assert.equal(latest.visits.visits[0].id, past.id);
    assert.equal(latest.visits.visit, null, 'no next visit is counting down once it is cleared');
    assert.equal(latest.togetherTime.sessions.length, 1, 'clearing a visit leaves Together time alone');
  } finally {
    await act(async () => root.unmount());
    await backend?.close();
    await server.close();
    dom.window.close();
  }
});
