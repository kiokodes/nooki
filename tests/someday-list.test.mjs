import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

// The list hook combines RLS-filtered ideas and quiet votes. This verifies privacy with
// two authenticated partners rather than relying on the presentation layer to hide rows.
test('Someday list: private visibility, quiet yes-votes and a mutual match', async () => {
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
    let open;
    let secret;
    await act(async () => { open = await latest.addItem('Try the night market'); });
    await act(async () => { secret = await latest.addItem('A surprise for later', 'Just for me.', 'private'); });
    assert.equal(open.visibility, 'open');
    assert.equal(secret.visibility, 'private');
    assert.deepEqual(new Set(latest.items.map((item) => item.id)), new Set([open.id, secret.id]));

    // Alice's yes-votes are stored separately; the UI can show her own choice without
    // exposing individual votes to Bob.
    await act(async () => { await latest.toggleWant(open); });
    await act(async () => { await latest.toggleWant(secret); });
    await act(async () => { await latest.refresh(); });
    assert.deepEqual(new Set(latest.items.find((item) => item.id === open.id).wanters), new Set([alice.id]));
    assert.deepEqual(new Set(latest.items.find((item) => item.id === secret.id).wanters), new Set([alice.id]));

    await auth.signInWithEmail('bob@example.com', 'password');
    const { data: bobItems, error: bobItemsError } = await supabase.from('someday_items').select('*').eq('couple_id', couple.id);
    assert.equal(bobItemsError, null);
    assert.deepEqual(bobItems.map((item) => item.id), [open.id], 'RLS hides Alice\'s private idea completely');
    const { data: bobVotes, error: bobVotesError } = await supabase.from('someday_item_votes').select('idea_id, user_id').eq('couple_id', couple.id);
    assert.equal(bobVotesError, null);
    assert.deepEqual(bobVotes.map((vote) => ({ idea_id: vote.idea_id, user_id: vote.user_id })), [{ idea_id: open.id, user_id: alice.id }], 'RLS hides the vote on a private idea');
    const privateVote = await supabase.from('someday_item_votes').insert({ idea_id: secret.id, couple_id: couple.id, user_id: bob.id });
    assert(privateVote.error, 'the other partner cannot vote on an idea they cannot see');
    const forbiddenShare = await supabase.from('someday_items').update({ visibility: 'private' }).eq('id', open.id);
    assert(forbiddenShare.error, 'only the idea author may change its visibility');

    // Bob votes yes on the open idea. Only the combined state becomes a match.
    const bobVote = await supabase.from('someday_item_votes').insert({ idea_id: open.id, couple_id: couple.id, user_id: bob.id });
    assert.equal(bobVote.error, null);
    await auth.signInWithEmail('alice@example.com', 'password');
    await act(async () => latest.refresh());
    const matched = latest.items.find((item) => item.id === open.id);
    assert.deepEqual(new Set(matched.wanters), new Set([alice.id, bob.id]));
    assert.equal(matched.wanters.length, 2);

    // The same open item can be placed on one visit day. An out-of-range day and a
    // private idea are rejected by the database trigger.
    const { data: visit, error: visitError } = await supabase.from('visits').insert({
      couple_id: couple.id, start_date: '2099-05-01', end_date: '2099-05-02',
      location: 'Lagos', timezone: 'Africa/Lagos', is_tentative: false, created_by: alice.id,
    }).select().single();
    assert.equal(visitError, null);
    await act(async () => { await latest.attachToVisit(matched, visit.id, '2099-05-02'); });
    assert.equal(latest.items.find((item) => item.id === open.id).visit_date, '2099-05-02');
    await act(async () => assert.rejects(latest.attachToVisit(latest.items.find((item) => item.id === open.id), visit.id, '2099-05-03'), /Choose a day inside this visit/));
    await act(async () => assert.rejects(latest.attachToVisit(latest.items.find((item) => item.id === secret.id), visit.id, '2099-05-01'), /Share this idea before adding it to a visit/));
  } finally {
    await act(async () => root.unmount());
    await backend?.close();
    await server.close();
    dom.window.close();
  }
});
