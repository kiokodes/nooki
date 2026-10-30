import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

process.env.TZ = 'UTC';

const TRAITS_A = ['patient', 'funny', 'warm'];
const TRAITS_B = ['creative', 'calm', 'curious'];
const LOOK = { skin: 'warm-3', hair: 'curl-2', outfit: '#c98b6b' };
const OTHER_LOOK = { skin: 'deep-4', hair: 'braid-1', outfit: '#7a9a8b' };

let server;
let supabase;
let auth;
let backend;

before(async () => {
  server = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
    },
  });
  ({ supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts'));
  backend = await installTestBackend(supabase);
  auth = await server.ssrLoadModule('/src/lib/authService.ts');
});

after(async () => {
  await backend?.close();
  await server?.close();
});

let coupleCount = 0;

async function makeCouple() {
  coupleCount += 1;
  const suffix = coupleCount;
  const mk = async (name, email) => {
    const user = (await auth.signUpWithEmail(email, 'password')).user;
    await auth.saveOnboardingProfile(user.id, { name, location: null, timezone: 'UTC' });
    return { id: user.id, email, name };
  };
  const alice = await mk('Alice', `mutual-a${suffix}@example.com`);
  const bob = await mk('Bob', `mutual-b${suffix}@example.com`);
  await auth.signInWithEmail(alice.email, 'password');
  const { couple } = await auth.createCouple(alice.id, '2020-02-14');
  await auth.signInWithEmail(bob.email, 'password');
  await auth.joinCoupleWithCode(bob.id, couple.invite_code);
  return { alice, bob, couple };
}

const signIn = async (who) => {
  const result = await auth.signInWithEmail(who.email, 'password');
  assert.equal(result.error ?? null, null);
};

const rpc = async (name, args = {}) => {
  const { data, error } = await supabase.rpc(name, args);
  assert.equal(error, null, `${name} failed: ${error?.message}`);
  return data;
};

const rpcError = async (name, args = {}) => {
  const { error } = await supabase.rpc(name, args);
  assert.ok(error, `expected ${name} to refuse`);
  return error.message;
};

const proposals = () => rpc('raise_child_setup_proposals');
const state = () => rpc('raise_child_state');

test('a child is only named when both parents land on the same name and face', async () => {
  const couple = await makeCouple();

  // Alice proposes a name and a face; nothing is decided yet.
  await signIn(couple.alice);
  const proposed = await rpc('raise_child_setup', { p_name: 'Mia', p_look: LOOK, p_traits: TRAITS_A });
  assert.equal(proposed.family.status, 'setup', 'one parent cannot open the childhood');
  assert.equal(proposed.child, null, 'and cannot name the child');
  assert.equal(proposed.setup.name, null);

  // Bob has joined but not suggested anything, so nothing of his to agree with.
  await signIn(couple.bob);
  let view = await proposals();
  assert.equal(view.mine, null);
  assert.deepEqual(view.partner, { name: 'Mia', look: LOOK }, 'her suggestion is his to see');
  assert.equal(view.agreed, false);
  assert.equal(view.locked, false);

  // He suggests a different name: both stay visible, neither wins.
  const second = await rpc('raise_child_setup', { p_name: 'Noor', p_look: OTHER_LOOK, p_traits: TRAITS_B });
  assert.equal(second.family.status, 'setup');
  assert.equal(second.child, null);
  view = await proposals();
  assert.deepEqual(view.mine, { name: 'Noor', look: OTHER_LOOK });
  assert.deepEqual(view.partner, { name: 'Mia', look: LOOK });
  assert.equal(view.name_same, false);
  assert.equal(view.look_same, false);
  assert.equal(view.agreed, false);

  // Alice sees the same two suggestions from her side.
  await signIn(couple.alice);
  const hers = await proposals();
  assert.deepEqual(hers.mine, { name: 'Mia', look: LOOK });
  assert.deepEqual(hers.partner, { name: 'Noor', look: OTHER_LOOK });
  assert.equal(hers.agreed, false);

  // Bob moves to her name only. The name now agrees; the face does not.
  await signIn(couple.bob);
  const onName = await rpc('raise_child_adopt_setup', { p_part: 'name' });
  assert.equal(onName.child, null, 'a shared name is not enough on its own');
  view = await proposals();
  assert.equal(view.name_same, true);
  assert.equal(view.look_same, false);
  assert.equal(view.agreed, false);

  // And then to her face. Now both proposals agree, so the child exists — and because
  // both parents' three traits are in, the childhood opens.
  const onFace = await rpc('raise_child_adopt_setup', { p_part: 'look' });
  assert.equal(onFace.family.status, 'active');
  assert.equal(onFace.child.name, 'Mia');
  assert.deepEqual(onFace.child.look, LOOK);
  assert.ok(onFace.album.count >= 1, 'the arrival opens the album');

  view = await proposals();
  assert.equal(view.agreed, true);
  assert.equal(view.locked, true, 'the name is settled once the first chapter opens');

  const album = await rpc('raise_child_album');
  const arrivals = album.filter((entry) => entry.kind === 'milestone');
  assert.equal(arrivals.length, 1, 'the arrival is written once, not once per parent');
  assert.match(arrivals[0].title, /Mia/);

  // Nothing after this can rename the child behind the other parent's back.
  await signIn(couple.alice);
  await rpc('raise_child_setup', { p_name: 'Zed', p_look: OTHER_LOOK });
  const renamed = await state();
  assert.equal(renamed.child.name, 'Mia');
  assert.deepEqual(renamed.child.look, LOOK);
  const locked = await proposals();
  assert.deepEqual(locked.mine, { name: 'Mia', look: LOOK }, 'the settled name stays the proposal');
});

test('proposals agree on the name whatever the case and the stray spaces', async () => {
  const couple = await makeCouple();

  await signIn(couple.alice);
  await rpc('raise_child_setup', { p_name: 'Mia', p_look: LOOK, p_traits: TRAITS_A });

  await signIn(couple.bob);
  const stored = await rpc('raise_child_setup', { p_name: '  mia ', p_look: LOOK, p_traits: TRAITS_B });

  assert.equal(stored.family.status, 'active');
  assert.equal(stored.child.name, 'Mia', 'the settled name is the first parent’s spelling');
  const view = await proposals();
  assert.equal(view.name_same, true);
  assert.equal(view.look_same, true);
  assert.equal(view.agreed, true);
});

test('moving to the other parent’s idea: refused too early, and it still waits on the traits', async () => {
  const couple = await makeCouple();

  await signIn(couple.alice);
  await rpc('raise_child_setup', { p_name: 'Mia', p_look: LOOK, p_traits: TRAITS_A });

  // She has suggested something; Bob has not, so there is nothing of his to move to.
  assert.match(await rpcError('raise_child_adopt_setup', { p_part: 'name' }), /not suggested/i);
  assert.match(await rpcError('raise_child_adopt_setup', { p_part: 'haircut' }), /nothing to match/i);

  // His own three traits can go in before he has any name in mind.
  await signIn(couple.bob);
  const traitsOnly = await rpc('raise_child_setup', { p_traits: TRAITS_B });
  assert.equal(traitsOnly.family.status, 'setup', 'her suggestion alone is still not a decision');
  assert.equal(traitsOnly.child, null);

  // He can still take the whole suggestion in one go, and that settles it whole.
  const tookIt = await rpc('raise_child_adopt_setup', {});
  assert.equal(tookIt.family.status, 'active');
  assert.equal(tookIt.child.name, 'Mia');
  assert.deepEqual(tookIt.child.look, LOOK);
});

test('a suggestion on its own never names the child, and one parent alone cannot open it', async () => {
  const couple = await makeCouple();

  await signIn(couple.alice);
  const lone = await rpc('raise_child_setup', { p_name: 'Mia', p_look: LOOK });
  assert.equal(lone.family.status, 'setup', 'traits are still missing');
  assert.equal(lone.child, null);

  // She suggests the name twice; a proposal is not a decision, however often it is made.
  await rpc('raise_child_setup', { p_name: 'Mia', p_look: LOOK });
  const still = await state();
  assert.equal(still.child, null);
  assert.equal(still.setup.name, null, 'nothing is named until both agree');

  // Bob proposes and she has already agreed, so it settles without him going further.
  await signIn(couple.bob);
  await rpc('raise_child_setup', { p_name: 'Mia', p_look: LOOK, p_traits: TRAITS_B });
  await signIn(couple.alice);
  const opened = await rpc('raise_child_setup', { p_name: 'Mia', p_look: LOOK, p_traits: TRAITS_A });
  assert.equal(opened.family.status, 'active');
  assert.equal(opened.child.name, 'Mia');
});
