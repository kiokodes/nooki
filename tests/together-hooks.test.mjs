import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

// Exercise the new client hooks against PGlite/RLS. Storage is represented by a tiny
// private-bucket stub; no network or live Supabase project is used.
test('Together hooks: wishes, checklist, scheduled time and private visit-memory storage', async () => {
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
    const storedFiles = [];
    const fakeBucket = {
      upload: async (path, body, options) => { storedFiles.push({ path, body, options }); return { error: null }; },
      remove: async () => ({ error: null }),
      createSignedUrl: async (path) => ({ data: { signedUrl: `https://signed.example/${path}` }, error: null }),
    };
    supabase.storage.from = (bucket) => {
      assert.equal(bucket, 'visit-memories');
      return fakeBucket;
    };
    supabase.channel = () => { const channel = { on: () => channel, subscribe: () => channel }; return channel; };
    supabase.removeChannel = async () => {};

    const auth = await server.ssrLoadModule('/src/lib/authService.ts');
    const { useVisits } = await server.ssrLoadModule('/src/hooks/useVisits.ts');
    const { useVisitPlanning } = await server.ssrLoadModule('/src/hooks/useVisitPlanning.ts');
    const { useTogetherTime } = await server.ssrLoadModule('/src/hooks/useTogetherTime.ts');
    const { useVisitMemories } = await server.ssrLoadModule('/src/hooks/useVisitMemories.ts');

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
        planning: useVisitPlanning(couple.id, upcoming.id, activeUserId),
        togetherTime: useTogetherTime(couple.id, activeUserId),
        memories: useVisitMemories(couple.id, activeUserId),
      };
      return null;
    }
    const render = () => act(async () => root.render(React.createElement(Harness)));
    const refreshAll = () => act(async () => {
      await Promise.all([latest.planning.refresh(), latest.togetherTime.refresh(), latest.memories.refresh()]);
    });
    await render();
    await refreshAll();

    await act(async () => latest.planning.saveWish('A quiet breakfast, just us.'));
    assert.equal(latest.planning.wishes.length, 1);
    await act(async () => latest.planning.addChecklistItem('Book the train', bob.id));
    assert.equal(latest.planning.checklist[0].assigned_to, bob.id);
    await act(async () => latest.planning.updateChecklistItem(latest.planning.checklist[0].id, { completed: true }));
    assert.equal(latest.planning.checklist[0].completed, true);

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

    const photo = new Blob(['small test photo'], { type: 'image/jpeg' });
    let ownMemory;
    await act(async () => { ownMemory = await latest.memories.save(past.id, photo, 'We laughed all the way home.'); });
    assert.match(ownMemory.photo_path, new RegExp(`^memories/${couple.id}/${alice.id}/${past.id}/`));
    assert.equal(ownMemory.photo_url, `https://signed.example/${ownMemory.photo_path}`);
    assert.equal(storedFiles.length, 1);
    assert.equal(storedFiles[0].options.contentType, 'image/jpeg');

    // The other partner sees shared contributions but only gets to write their own.
    await auth.signInWithEmail('bob@example.com', 'password');
    activeUserId = bob.id;
    await render();
    await refreshAll();
    assert.equal(latest.planning.wishes.length, 0, 'Bob cannot read Alice\'s wish before submitting his own');
    await act(async () => latest.planning.saveWish('A walk after dinner.'));
    assert.equal(latest.planning.wishes.length, 2);
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
    assert.equal(latest.memories.entries.length, 1);
    assert.equal(latest.memories.entries[0].user_id, alice.id);
    const partnerMemory = await act(async () => latest.memories.save(past.id, new Blob(['another photo'], { type: 'image/png' }), 'The walk in the rain.'));
    assert.equal(latest.memories.entries.length, 2);
    assert.equal(storedFiles.length, 2);
    assert(storedFiles[1].path.includes(`/${bob.id}/${past.id}/`));
    assert.equal(partnerMemory.user_id, bob.id);

    // Plans change: Bob can clear the upcoming visit Alice planned. It comes off
    // the calendar for the couple; the past visit (and its memories) stay put.
    await act(async () => latest.visits.refresh());
    assert.equal(latest.visits.visits.length, 2);
    assert.equal(latest.visits.visit.id, upcoming.id);
    await act(async () => latest.visits.deleteVisit(upcoming.id));
    assert.equal(latest.visits.visits.length, 1);
    assert.equal(latest.visits.visits[0].id, past.id);
    assert.equal(latest.visits.visit, null, 'no next visit is counting down once it is cleared');
    await act(async () => latest.memories.refresh());
    assert.equal(latest.memories.entries.length, 2, 'clearing a future visit keeps past memories');
  } finally {
    await act(async () => root.unmount());
    await backend?.close();
    await server.close();
    dom.window.close();
  }
});
