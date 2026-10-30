import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

process.env.TZ = 'UTC';

const TRAITS_A = ['patient', 'funny', 'warm'];
const TRAITS_B = ['creative', 'calm', 'curious'];
const LOOK = { skin: 'warm-3', hair: 'curl-2', outfit: '#c98b6b' };

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
  const alice = await mk('Alice', `inherit-a${suffix}@example.com`);
  const bob = await mk('Bob', `inherit-b${suffix}@example.com`);
  await auth.signInWithEmail(alice.email, 'password');
  const { couple } = await auth.createCouple(alice.id, '2020-02-14');
  await auth.signInWithEmail(bob.email, 'password');
  await auth.joinCoupleWithCode(bob.id, couple.invite_code);

  // The two of them agree on a name and a face, so the childhood opens.
  await auth.signInWithEmail(alice.email, 'password');
  await supabase.rpc('raise_child_setup', { p_name: 'Mia', p_look: LOOK, p_traits: TRAITS_A });
  await auth.signInWithEmail(bob.email, 'password');
  const { data, error } = await supabase.rpc('raise_child_setup', { p_name: 'Mia', p_look: LOOK, p_traits: TRAITS_B });
  assert.equal(error, null, error?.message);
  assert.equal(data.family.status, 'active');
  return { alice, bob, couple, familyId: data.family.id };
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

const inheritance = () => rpc('raise_child_inheritance');

test('a child is born with three traits: at least one from each parent', async () => {
  const family = await makeCouple();

  await signIn(family.alice);
  const hers = await inheritance();
  assert.equal(hers.inherited.length, 3, 'three traits, not a blank page');
  assert.ok(hers.inherited.every((trait) => trait.label && trait.slug), 'every trait reads as a word');
  assert.ok(
    hers.inherited.every((trait) => TRAITS_A.includes(trait.slug) || TRAITS_B.includes(trait.slug)),
    'each one is a trait a parent actually chose',
  );

  const mine = hers.inherited.filter((trait) => trait.from_me).length;
  const theirs = hers.inherited.length - mine;
  assert.ok(mine >= 1, 'at least one trait came from her');
  assert.ok(theirs >= 1, 'and at least one from him');

  // The sentence is about resemblance, never a score.
  assert.equal(hers.line, mine > theirs ? 'Mia has more of your traits.' : 'Mia has more of Bob\'s traits.');
  assert.equal(hers.more_like, mine > theirs ? 'me' : 'partner');
  assert.equal(/\d/.test(hers.line), false, 'no numbers in the line');

  // His side sees the same three traits, attributed the other way round.
  await signIn(family.bob);
  const his = await inheritance();
  assert.deepEqual(
    his.inherited.map((trait) => [trait.slug, trait.from_me]),
    hers.inherited.map((trait) => [trait.slug, !trait.from_me]),
    'same child, same traits, mirrored attribution',
  );
  assert.equal(his.more_like, mine > theirs ? 'partner' : 'me');
  assert.equal(his.line, mine > theirs ? 'Mia has more of Alice\'s traits.' : 'Mia has more of your traits.');

  // Nothing has been shaped yet: the traits that come from the years are still empty.
  const state = await rpc('raise_child_state');
  assert.equal(state.child.name, 'Mia');
  assert.deepEqual(state.child.traits, [], 'what the years add starts empty');
});

test('the draw always gives each parent a share', async () => {
  for (let round = 0; round < 5; round += 1) {
    const family = await makeCouple();
    await signIn(family.alice);
    const view = await inheritance();
    assert.equal(view.inherited.length, 3, `round ${round}: three traits`);
    const mine = view.inherited.filter((trait) => trait.from_me).length;
    assert.ok(mine >= 1 && mine <= 2, `round ${round}: ${mine} of 3 came from her, so both parents are in`);
  }
});

test('the traits they came with are drawn once and never taken away', async () => {
  const family = await makeCouple();
  await signIn(family.alice);
  const first = (await inheritance()).inherited.map((trait) => trait.slug);

  // The seeder is idempotent: a second call, from anywhere, changes nothing.
  await backend.query('SELECT public.raise_child_seed_inherited_traits($1)', [family.familyId]);
  await signIn(family.alice);
  assert.deepEqual((await inheritance()).inherited.map((trait) => trait.slug), first);

  // A decision adds to what the child is becoming, without touching what they came with.
  await backend.query(
    `SELECT public.raise_child_apply_effects($1, '{"traits":{"brave":1}}'::jsonb, $2, $3, true)`,
    [family.familyId, family.alice.id, family.bob.id],
  );
  await signIn(family.alice);
  const after = await rpc('raise_child_state');
  assert.ok(after.child.traits.some((trait) => trait.slug === 'brave'), 'the year shaped them');
  assert.deepEqual((await inheritance()).inherited.map((trait) => trait.slug), first,
    'and the three they were born with are still there');

  // Even a full list of earned traits cannot push an inherited one out.
  await backend.query(
    `SELECT public.raise_child_apply_effects($1, '{"traits":{"kind":1,"shy":1,"messy":1,"proud":1}}'::jsonb, $2, $3, true)`,
    [family.familyId, family.alice.id, family.bob.id],
  );
  await signIn(family.alice);
  const full = await rpc('raise_child_state');
  assert.equal(full.child.traits.length <= 4, true, 'the earned list keeps its own ceiling');
  assert.deepEqual((await inheritance()).inherited.map((trait) => trait.slug), first,
    'and the born-with three stay exactly as they were');
});

test('a family already in a childhood gets its traits back-filled', async () => {
  const family = await makeCouple();

  // As if this family had opened before inheritance existed.
  await backend.query('DELETE FROM public.child_inherited_traits WHERE family_id = $1', [family.familyId]);
  await signIn(family.alice);
  assert.equal((await inheritance()).inherited.length, 0, 'nothing yet');

  await backend.query('SELECT public.raise_child_seed_inherited_traits($1)', [family.familyId]);
  await signIn(family.alice);
  const backfilled = await inheritance();
  assert.equal(backfilled.inherited.length, 3);
  assert.ok(backfilled.inherited.some((trait) => trait.from_me));
  assert.ok(backfilled.inherited.some((trait) => !trait.from_me));
  assert.ok(backfilled.line);
});
