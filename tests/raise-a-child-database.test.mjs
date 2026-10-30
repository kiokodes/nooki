import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

process.env.TZ = 'UTC';

// The moments a test family can meet. Test-only fixture copy: the owner's real
// batches arrive through scripts/raise-a-child-events.mjs and are never seeded here.
const EVENTS = [
  {
    slug: 'db-broken-vase', min_age: 3, max_age: 6, category: 'home', tone: 'gentle',
    title: 'The broken vase',
    setup_text: 'A favourite vase is in three pieces on the kitchen floor, and Mia is standing very still beside it.',
    choices: [
      { label: 'Clean it up together', outcome_text: 'You swept it up side by side. The vase is gone; the afternoon is not.', effects: { traits: { kind: 2 }, mood: 'safe', bond: 1 } },
      { label: 'Ask what happened first', outcome_text: 'She told you the whole story twice. Nobody was cross by the end of it.', effects: { traits: { honest: 1, thoughtful: 1 }, mood: 'safe' } },
      { label: 'Sit down with her before anything else', outcome_text: 'You sat on the floor among the pieces until she was ready. The vase was never the point.', effects: { traits: { gentle: 1 }, mood: 'safe', bond: 1 } },
    ],
  },
  {
    slug: 'db-bedtime-3', min_age: 3, max_age: 3, category: 'fun', tone: 'gentle',
    title: 'Past bedtime',
    setup_text: 'It is twenty minutes past bedtime and Mia has reappeared in the doorway.',
    choices: [
      { label: 'One more story', outcome_text: 'One more became two, and then the lights were out for good.', effects: { traits: { playful: 1 }, mood: 'delighted' } },
      { label: 'Back to bed, softly', outcome_text: 'She went, and called goodnight from the stairs twice.', effects: { traits: { gentle: 1 }, mood: 'safe', bond: -1 } },
    ],
  },
  {
    slug: 'db-story-time', min_age: 3, max_age: 6, category: 'fun', tone: 'warm',
    title: 'One more chapter',
    setup_text: 'It is past bedtime, and Mia is holding the book with the torn corner.',
    choices: [
      { label: 'One more chapter', outcome_text: 'One more became three. She fell asleep on the last page.', effects: { traits: { playful: 1 }, mood: 'delighted' } },
      { label: 'Lights out, gently', outcome_text: 'She negotiated for a page and got half of one.', effects: { traits: { thoughtful: 1 }, mood: 'content', bond: -1 } },
    ],
  },
  {
    slug: 'db-first-morning', min_age: 4, max_age: 5, category: 'school', tone: 'gentle',
    title: 'The first morning',
    setup_text: 'The shoes are too shiny and the gate is too big, and Mia has gone quiet.',
    choices: [
      { label: 'Walk her to the door', outcome_text: 'You got as far as the door. She went in on her own feet.', effects: { traits: { brave: 1 }, mood: 'brave', bond: 1 } },
      { label: 'Wait at the gate', outcome_text: 'She turned round twice to check you were there. You were.', effects: { traits: { shy: 1 }, mood: 'safe' } },
    ],
  },
  {
    slug: 'db-pocket-money', min_age: 7, max_age: 10, category: 'money', tone: 'warm',
    title: 'Pocket money',
    setup_text: 'There is a jar on the counter and a long, careful list of things Mia wants to buy.',
    choices: [
      { label: 'Three coins a week', outcome_text: 'The jar fills slowly. She counts it every Friday.', effects: { traits: { thoughtful: 1 }, mood: 'content' } },
      { label: 'Three coins, and a job for more', outcome_text: 'The windows are streaky and she is very proud of them.', effects: { traits: { proud: 1 }, mood: 'proud', bond: -1 } },
    ],
  },
  {
    slug: 'db-leaving-home', min_age: 16, max_age: 17, category: 'values', tone: 'bittersweet',
    title: 'The map on the wall',
    setup_text: 'There is a map on Mia’s wall with three cities circled, and none of them are near.',
    choices: [
      { label: 'Help her plan the first one', outcome_text: 'The plan is on the fridge in her handwriting.', effects: { traits: { brave: 1 }, mood: 'proud', bond: 1 } },
      { label: 'Ask her to show you the map', outcome_text: 'She explained every circle. You asked questions until it got late.', effects: { traits: { thoughtful: 1 }, mood: 'tender', bond: 2 } },
    ],
  },
];

const ALL_SLUGS = EVENTS.map((event) => event.slug);
// Only the named cards are live for the duration of one test, so a chapter's card is
// the one the test is about rather than whichever fixture the picker fancied.
const useOnly = (...slugs) => backend.query(
  'UPDATE public.event_templates SET active = (slug = ANY($1))', [slugs],
);

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
  await backend.query(`
    INSERT INTO public.event_templates
      (slug, min_age, max_age, category, title, setup_text, choices, tone, active, batch)
    SELECT * FROM jsonb_to_recordset($1::jsonb)
      AS x(slug TEXT, min_age SMALLINT, max_age SMALLINT, category TEXT, title TEXT,
           setup_text TEXT, choices JSONB, tone TEXT, active BOOLEAN, batch TEXT)
  `, [JSON.stringify(EVENTS.map((event) => ({ ...event, active: true, batch: 'test' })))]);
});

after(async () => {
  await backend?.close();
  await server?.close();
});

let coupleCount = 0;

/** A signed-in couple, with distinct accounts per test so nothing leaks between them. */
async function makeCouple() {
  coupleCount += 1;
  const suffix = coupleCount;
  const mk = async (name, email) => {
    const user = (await auth.signUpWithEmail(email, 'password')).user;
    await auth.saveOnboardingProfile(user.id, { name, location: null, timezone: 'UTC' });
    return { id: user.id, email, name };
  };
  const alice = await mk('Alice', `alice${suffix}@example.com`);
  const bob = await mk('Bob', `bob${suffix}@example.com`);
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

const state = () => rpc('raise_child_state');

async function setupFamily(couple) {
  await signIn(couple.alice);
  await rpc('raise_child_setup', { p_name: 'Mia', p_look: LOOK, p_traits: TRAITS_A });
  await signIn(couple.bob);
  const done = await rpc('raise_child_setup', { p_traits: TRAITS_B });
  couple.familyId = done.family.id;
  return done;
}

/**
 * Puts the child at an age and fills the chapter the way the hourly job would: one day at
 * a time, up to the chapter's size or until the content runs out.
 */
async function openChapterAt(couple, age) {
  const id = couple.familyId;
  await backend.query(`UPDATE public.family_moments SET status = 'resolved', agreement = true, resolved_at = now()
                        WHERE family_id = $1 AND status = 'open'`, [id]);
  await backend.query(
    `UPDATE public.child_state SET age = $1, last_age_up_day = NULL, last_tick_day = NULL WHERE family_id = $2`,
    [age, id],
  );
  for (let offset = 4; offset >= 0; offset -= 1) {
    await backend.query('UPDATE public.child_state SET last_tick_day = NULL WHERE family_id = $1', [id]);
    await backend.query('SELECT public.raise_child_tick_family($1, CURRENT_DATE + $2::int)', [id, offset]);
  }
  return id;
}

async function vote(who, momentId, index) {
  await signIn(who);
  return rpc('raise_child_vote', { p_moment_id: momentId, p_choice: index });
}

const openMoment = async (who) => {
  await signIn(who);
  const current = await state();
  return current.today.moments[0];
};

test('a family is only ready when both parents have chosen three traits', async () => {
  const couple = await makeCouple();
  await signIn(couple.alice);

  // Nobody is asked to pick a temperament, and nothing is generated before the pair share it.
  const fresh = await state();
  assert.equal(fresh.family, null);
  assert.equal(fresh.setup.partner_joined, false);
  assert.ok(fresh.setup.catalog.length >= 6);
  assert.ok(fresh.setup.catalog.every((trait) => trait.slug && trait.label && trait.blurb));

  assert.match(await rpcError('raise_child_setup', { p_name: 'Mia', p_traits: ['patient', 'funny'] }), /three/i);
  assert.match(await rpcError('raise_child_setup', { p_name: 'Mia', p_traits: ['patient', 'funny', 'funny'] }), /three|different/i);
  assert.match(await rpcError('raise_child_setup', { p_name: 'Mia', p_traits: ['patient', 'funny', 'sporty'] }), /trait/i);

  // A name can wait for the other parent, but a nameless family never becomes active.
  const unnamed = await rpc('raise_child_setup', { p_name: ' ', p_traits: TRAITS_A });
  assert.equal(unnamed.family.status, 'setup');
  assert.equal(unnamed.child, null);

  const mine = await rpc('raise_child_setup', { p_name: 'Mia', p_look: LOOK, p_traits: TRAITS_A });
  assert.equal(mine.family.status, 'setup');
  assert.equal(mine.setup.mine.length, 3);
  assert.equal(mine.setup.ready, false, 'one parent is not enough');

  // Age up is not offered, and directly asking is refused rather than half-working.
  assert.equal(mine.today.can_age_up, false);
  assert.match(await rpcError('raise_child_age_up'), /not in a chapter/i);

  const bobView = await (async () => {
    await signIn(couple.bob);
    return state();
  })();
  assert.equal(bobView.setup.partner_joined, true);
  assert.equal(bobView.setup.partner_traits_ready, true);
  assert.equal(bobView.setup.ready, false);

  const ready = await rpc('raise_child_setup', { p_traits: TRAITS_B, p_look: LOOK });
  assert.equal(ready.family.status, 'active');
  assert.equal(ready.child.name, 'Mia');
  assert.equal(ready.child.age, 0);
  assert.ok(ready.child.age_label.length > 0);
  assert.deepEqual(ready.child.look, LOOK);
  assert.ok(ready.album.count >= 1, 'the arrival opens the album');
  const album = await rpc('raise_child_album');
  assert.equal(album[0].kind, 'milestone');
  assert.match(album[0].title, /Mia/);
});

test('the temperament, and either parent’s bond, are not readable by a parent', async () => {
  const couple = await makeCouple();
  const ready = await setupFamily(couple);

  // Nothing in the state JSON names the temperament or carries a bond number.
  const json = JSON.stringify(ready);
  assert.equal(json.includes('temperament'), false);
  assert.equal(json.includes('bond_'), false);
  assert.equal(typeof ready.me.bond, 'object');
  assert.deepEqual(Object.keys(ready.me.bond).sort(), ['band', 'line']);
  assert.equal(typeof ready.me.bond.line, 'string');
  assert.equal(/\d/.test(ready.me.bond.line), false, 'no number leaks into the soft language');
  assert.equal(ready.child.traits.length <= 4, true);

  // The database agrees: those two columns are not granted to a signed-in account.
  await signIn(couple.alice);
  await assert.rejects(backend.asUser('SELECT temperament FROM public.child_state'), /permission denied/i);
  await assert.rejects(backend.asUser('SELECT bond FROM public.family_parents'), /permission denied/i);
  await assert.rejects(backend.asUser('SELECT * FROM public.child_state'), /permission denied/i);

  // The columns the app does need are still readable, and the row is the right one.
  const safe = await backend.asUser('SELECT name, age, mood, visible_traits FROM public.child_state');
  assert.equal(safe.rows.length, 1);
  assert.equal(safe.rows[0].name, 'Mia');

  // The stored temperament is real, and only the owner can look at it.
  const temperament = (await backend.query('SELECT temperament FROM public.child_state')).rows[0].temperament;
  assert.equal(typeof temperament, 'string');
  assert.ok(temperament.length > 0);
});

test('a vote is private until both parents have picked', async () => {
  const couple = await makeCouple();
  await useOnly('db-broken-vase');
  await setupFamily(couple);
  await openChapterAt(couple, 3);

  const moment = await openMoment(couple.alice);
  assert.ok(moment, 'a moment opens for the chapter');
  assert.equal(moment.my_choice, null);
  assert.equal(moment.partner_voted, false);
  assert.equal(moment.choices.length, 3);
  assert.ok(moment.choices.every((choice) => choice.label && typeof choice.index === 'number'));

  await vote(couple.alice, moment.id, 1);

  // Alice can see her own answer; nothing of Bob's.
  const aliceAfter = await state();
  assert.equal(aliceAfter.today.moments[0].my_choice, 1);
  assert.equal(aliceAfter.today.moments[0].partner_voted, false);

  // Bob sees only that she has answered, and cannot read the row behind it.
  await signIn(couple.bob);
  const bobBefore = await state();
  assert.equal(bobBefore.today.moments[0].my_choice, null);
  assert.equal(bobBefore.today.moments[0].partner_voted, true);
  const bobRows = await backend.asUser('SELECT count(*)::int AS count FROM public.family_votes');
  assert.equal(bobRows.rows[0].count, 0, 'the read policy hides the other parent’s pick');

  // The moment has not moved on: a single answer is not a decision.
  assert.equal(bobBefore.today.moments[0].resolved, false);
  const status = (await backend.query('SELECT status FROM public.family_moments ORDER BY created_at DESC LIMIT 1')).rows[0].status;
  assert.equal(status, 'open');

  await vote(couple.bob, moment.id, 2);
  const bothRows = await backend.asUser('SELECT count(*)::int AS count FROM public.family_votes');
  assert.equal(bothRows.rows[0].count, 2, 'after the reveal both picks are readable');
});

test('a split waits for the two of them, and only the lead parent can use the year’s call', async () => {
  const couple = await makeCouple();
  await useOnly('db-broken-vase');
  await setupFamily(couple);
  const id = couple.familyId;
  await openChapterAt(couple, 3);

  const moment = await openMoment(couple.alice);
  await vote(couple.alice, moment.id, 1);
  const afterBob = await vote(couple.bob, moment.id, 2);

  // Nothing settles on a disagreement any more: both picks are on the table, in the open.
  const open = afterBob.today.moments[0];
  assert.equal(open.resolved, false, 'a split is not a decision');
  assert.equal(open.disagreement, true);
  assert.equal(open.partner_choice, 1);
  assert.equal(open.my_choice, 2);
  assert.equal(open.can_change, true, 'the second say is still there');
  assert.equal(open.can_decide, false, 'Bob does not hold this year’s call');
  assert.equal(open.is_lead, false);

  await signIn(couple.alice);
  const aliceView = (await state()).today.moments[0];
  assert.equal(aliceView.can_decide, true, 'the first chapter belongs to the parent who started the family');
  assert.equal(aliceView.partner_voted, true);
  assert.equal(aliceView.partner_choice, 2, 'the other pick is readable once both have answered');

  // A call that is not yours cannot be used.
  await signIn(couple.bob);
  assert.match(await rpcError('raise_child_lead_decide', { p_moment_id: moment.id }), /partner|call/i);

  // Alice settles it herself, in the open.
  await signIn(couple.alice);
  const decided = (await rpc('raise_child_lead_decide', { p_moment_id: moment.id })).today.moments[0];
  const outcome = decided.outcome;
  assert.equal(decided.resolved, true);
  assert.equal(outcome.decision, 'lead');
  assert.equal(outcome.agreement, false);
  assert.equal(outcome.split, true);
  assert.equal(outcome.timed_out, false);
  assert.equal(outcome.decided_by_name, 'Alice');
  assert.equal(outcome.chosen_index, 1, 'the lead parent’s pick is the one the year keeps');
  assert.equal(outcome.note, 'You wanted different things. Alice had this year’s call, and used it.');

  // The child feels the split, gently: no reward, no punishment for either parent,
  // and nothing that reads as a score.
  assert.equal(decided.age, 3);
  const after = await state();
  assert.equal(after.child.mood, 'safe');
  assert.ok(after.child.traits.some((trait) => trait.slug === 'kind'));
  const bonds = (await backend.query(
    `SELECT user_id, bond FROM public.family_parents WHERE family_id = $1 ORDER BY joined_at`,
    [id],
  )).rows;
  assert.equal(bonds.length, 2);
  assert.ok(bonds[0].bond > bonds[1].bond, 'the lead parent carries the year a little more closely');
  assert.ok(Math.abs(bonds[0].bond - bonds[1].bond) <= 2, 'two points apart, not a scoreline');

  const album = await rpc('raise_child_album');
  const page = album.find((entry) => entry.kind === 'moment');
  assert.ok(page);
  assert.equal(page.title, 'The broken vase');
  assert.equal(page.body, outcome.outcome_text);
  assert.equal(album.some((entry) => /bond|score|points/i.test(entry.body)), false);

  // A resolved moment cannot be voted on, or decided, again.
  await signIn(couple.bob);
  assert.match(await rpcError('raise_child_vote', { p_moment_id: moment.id, p_choice: 1 }), /already|resolved/i);
  await signIn(couple.alice);
  assert.match(await rpcError('raise_child_lead_decide', { p_moment_id: moment.id }), /already|decided/i);
});

test('two decisions each: one change of mind, then the pick is final', async () => {
  const couple = await makeCouple();
  await useOnly('db-broken-vase');
  await setupFamily(couple);
  await openChapterAt(couple, 3);

  const moment = await openMoment(couple.alice);
  await vote(couple.alice, moment.id, 1);
  await vote(couple.bob, moment.id, 2);

  // Alice uses her second say to move onto Bob's pick: the year settles as an agreement.
  const agreed = await vote(couple.alice, moment.id, 2);
  const settled = agreed.today.moments[0];
  assert.equal(settled.resolved, true);
  assert.equal(settled.outcome.agreement, true);
  assert.equal(settled.outcome.decision, 'agreement');
  assert.equal(settled.outcome.chosen_index, 2);
  assert.equal(settled.outcome.note, 'You both wanted the same thing. Mia felt that.');
});

test('a change of mind that still disagrees leaves the card open, and the change spent', async () => {
  const couple = await makeCouple();
  await useOnly('db-broken-vase');
  await setupFamily(couple);
  await openChapterAt(couple, 3);

  const moment = await openMoment(couple.alice);
  await vote(couple.alice, moment.id, 1);
  await vote(couple.bob, moment.id, 2);

  const afterChange = await vote(couple.alice, moment.id, 3);
  const open = afterChange.today.moments[0];
  assert.equal(open.resolved, false);
  assert.equal(open.disagreement, true);
  assert.equal(open.my_choice, 3);
  assert.equal(open.can_change, false, 'the second say has been used');
  assert.equal(open.my_revisions, 1);
  assert.equal(open.can_decide, true, 'the call is still hers to use');
  assert.match(await rpcError('raise_child_vote', { p_moment_id: moment.id, p_choice: 1 }), /second say|final/i);

  // Bob's one change lands on her new pick, and the year settles as an agreement.
  const agreed = await vote(couple.bob, moment.id, 3);
  assert.equal(agreed.today.moments[0].outcome.agreement, true);
  assert.equal(agreed.today.moments[0].outcome.decision, 'agreement');
});

test('the lead parent alternates when the chapter turns', async () => {
  const couple = await makeCouple();
  await useOnly('db-broken-vase', 'db-bedtime-3', 'db-first-morning');
  await setupFamily(couple);
  await openChapterAt(couple, 3);

  // The chapter fills over days; every card in it has to be answered before it turns.
  const chapter = (await openMoment(couple.alice)).id;
  assert.ok(chapter);
  for (const moment of (await state()).today.moments) {
    await vote(couple.alice, moment.id, 1);
    await vote(couple.bob, moment.id, 1);
  }
  assert.equal((await rpc('raise_child_age_up')).child.age, 4);

  const id = couple.familyId;
  const lead = (await backend.query('SELECT lead_user_id FROM public.child_state WHERE family_id = $1', [id])).rows[0].lead_user_id;
  assert.equal(lead, couple.bob.id, 'the year turns, and so does the lead');

  // Tomorrow's card opens the new chapter, with the lead the other way round.
  await backend.query(`UPDATE public.child_state SET last_age_up_day = NULL, last_tick_day = NULL WHERE family_id = $1`, [id]);
  await backend.query('SELECT public.raise_child_tick_family($1, CURRENT_DATE + 1)', [id]);
  const second = await openMoment(couple.bob);
  await vote(couple.bob, second.id, 2);
  const split = await vote(couple.alice, second.id, 1);
  assert.equal(split.today.moments[0].resolved, false, 'a split waits, whoever holds the call');

  await signIn(couple.bob);
  const decided = (await rpc('raise_child_lead_decide', { p_moment_id: second.id })).today.moments[0].outcome;
  assert.equal(decided.decided_by_name, 'Bob');
  assert.equal(decided.chosen_index, 2);
  assert.equal(decided.decision, 'lead');
});

test('an unanswered moment resolves after the timeout with the pick that was made', async () => {
  const couple = await makeCouple();
  await useOnly('db-broken-vase');
  await setupFamily(couple);
  await openChapterAt(couple, 3);

  const moment = await openMoment(couple.alice);
  await vote(couple.alice, moment.id, 2);
  await backend.query(
    `UPDATE public.family_moments SET created_at = now() - interval '25 hours' WHERE id = $1`,
    [moment.id],
  );

  const result = (await backend.query('SELECT public.raise_child_resolve_due($1) AS r', [couple.familyId])).rows[0].r;
  assert.equal(result, 1);

  const resolved = (await backend.query('SELECT outcome FROM public.family_moments WHERE id = $1', [moment.id])).rows[0].outcome;
  assert.equal(resolved.timed_out, true);
  assert.equal(resolved.split, false);
  assert.match(resolved.note, /^We went with Alice’s pick\.$/);
  assert.equal(resolved.chosen_index, 2);
  assert.equal(resolved.decided_by_name, 'Alice');

  // No penalty and no bonus: the year happened, and neither bond moved.
  const bonds = (await backend.query(
    `SELECT bond FROM public.family_parents WHERE family_id = $1`, [couple.familyId],
  )).rows.map((row) => row.bond);
  assert.deepEqual(bonds, [55, 55]);

  // The parent who was away meets the same kind sentence, and nothing else.
  await signIn(couple.bob);
  const bobState = await state();
  const closed = bobState.today.moments[0];
  assert.equal(closed.resolved, true, 'the moment is closed, not waiting');
  assert.equal(closed.my_choice, null, 'nothing pretends he answered');
  assert.equal(closed.outcome.note, resolved.note);
  const album = await rpc('raise_child_album');
  const page = album.find((entry) => entry.kind === 'moment');
  assert.equal(page.body, resolved.outcome_text);
  const everywhere = JSON.stringify(bobState) + JSON.stringify(album);
  for (const harsh of ['missed', 'late', 'didn’t answer', "didn't answer", 'waiting for you', 'expired', 'failed']) {
    assert.equal(everywhere.toLowerCase().includes(harsh), false, `no shaming copy: ${harsh}`);
  }
});

test('a split nobody settles goes with the year’s lead parent when the clock runs out', async () => {
  const couple = await makeCouple();
  await useOnly('db-broken-vase');
  await setupFamily(couple);
  const id = couple.familyId;
  await openChapterAt(couple, 3);

  const moment = await openMoment(couple.alice);
  await vote(couple.alice, moment.id, 1);
  await vote(couple.bob, moment.id, 2);
  await backend.query(
    `UPDATE public.family_moments SET created_at = now() - interval '25 hours' WHERE id = $1`,
    [moment.id],
  );

  // The clock is the backstop, not the first answer: the year keeps the call's pick,
  // says so plainly, and neither parent is scolded for it.
  const result = (await backend.query('SELECT public.raise_child_resolve_due($1) AS r', [id])).rows[0].r;
  assert.equal(result, 1);
  const outcome = (await backend.query('SELECT outcome FROM public.family_moments WHERE id = $1', [moment.id])).rows[0].outcome;
  assert.equal(outcome.decision, 'timeout');
  assert.equal(outcome.split, true);
  assert.equal(outcome.chosen_index, 1);
  assert.equal(outcome.note, 'You wanted different things. This year went with Alice’s call.');
  assert.equal(outcome.decided_by_name, 'Alice');
});

test('age up waits for every moment, once a day, and follows the configured pacing', async () => {
  const couple = await makeCouple();
  await useOnly('db-broken-vase', 'db-story-time', 'db-first-morning');
  await setupFamily(couple);
  await backend.query('UPDATE public.game_config SET moments_per_day = 2');
  await openChapterAt(couple, 3);

  await signIn(couple.alice);
  let current = await state();
  assert.equal(current.today.moments.length, 2, 'the config decides how many arrive');
  assert.equal(current.today.can_age_up, false);

  for (const moment of current.today.moments) {
    await vote(couple.alice, moment.id, 1);
    await vote(couple.bob, moment.id, 1);
  }
  current = await state();
  assert.equal(current.today.can_age_up, true);

  const aged = await rpc('raise_child_age_up');
  assert.equal(aged.child.age, 4);
  assert.ok(aged.today.age_up_hint, 'a parent is told when the next chapter can open');

  // The new chapter arrives with its own card, so an immediate second age up still waits.
  assert.match(await rpcError('raise_child_age_up'), /moment waiting/i);
  const next = await state();
  for (const moment of next.today.moments) {
    await vote(couple.alice, moment.id, 1);
    await vote(couple.bob, moment.id, 1);
  }
  assert.match(await rpcError('raise_child_age_up'), /today|tomorrow/i);

  await backend.query('UPDATE public.game_config SET moments_per_day = 1, chapters_per_day = 1');
});

test('deliberate confusion: an age up with a moment still open is refused', async () => {
  const couple = await makeCouple();
  await useOnly('db-broken-vase', 'db-story-time', 'db-first-morning');
  await setupFamily(couple);
  await backend.query('UPDATE public.game_config SET moments_per_day = 2');
  await openChapterAt(couple, 3);

  await signIn(couple.alice);
  const current = await state();
  assert.equal(current.today.moments.length, 2);
  await vote(couple.alice, current.today.moments[0].id, 1);
  assert.match(await rpcError('raise_child_age_up'), /moment|answer|finish|chapter/i);
  await backend.query('UPDATE public.game_config SET moments_per_day = 1');
});

test('eighteen writes the letter, the notes come back, and a new child starts cleanly', async () => {
  const couple = await makeCouple();
  await useOnly('db-leaving-home');
  await setupFamily(couple);
  const id = couple.familyId;
  await openChapterAt(couple, 17);

  await backend.query(`UPDATE public.child_state SET age = 17, last_age_up_day = NULL WHERE family_id = $1`, [id]);
  await backend.query(`UPDATE public.family_moments SET status = 'resolved', agreement = true, resolved_at = now()
                        WHERE family_id = $1 AND status = 'open'`, [id]);

  await signIn(couple.alice);
  const atEighteen = await rpc('raise_child_age_up');
  assert.equal(atEighteen.family.status, 'letter');
  assert.ok(atEighteen.letter, 'the letter arrives with the last chapter');
  assert.ok(atEighteen.letter.paragraphs.length >= 3);
  assert.equal(atEighteen.letter.child, 'Mia');
  const letterText = atEighteen.letter.paragraphs.join(' ');
  assert.match(letterText, /^Dear both of you,/);
  const cruel = ['disappoint', 'failed', 'should have', 'not enough'];
  assert.equal(letterText.trim().endsWith('.'), true, 'the letter ends on the child, not on an app-drawn signature');
  for (const word of cruel) assert.equal(letterText.toLowerCase().includes(word), false, `the letter is never cruel: ${word}`);

  // Both parents can read the same letter, and neither is named as the one who got it wrong.
  await signIn(couple.bob);
  const bobLetter = await state();
  assert.equal(bobLetter.letter.paragraphs.length, atEighteen.letter.paragraphs.length);

  const reply = await rpc('raise_child_reply', { p_note: 'We read it twice, and then once more.' });
  assert.equal(reply?.errors ?? null, null);
  assert.match(await rpcError('raise_child_reply', { p_note: '   ' }), /write a line/i);
  assert.match(await rpcError('raise_child_reply', { p_note: 'x'.repeat(401) }), /400/);

  const album = await rpc('raise_child_album');
  assert.ok(album.some((entry) => entry.kind === 'letter'));
  assert.ok(album.some((entry) => entry.kind === 'note' && entry.body === 'We read it twice, and then once more.'));

  // Starting again archives the family; the album is never deleted.
  const next = await rpc('raise_child_new_child');
  assert.equal(next.family, null);
  assert.equal(next.setup.ready, false);
  const archived = (await backend.query(`SELECT status, archived_at FROM public.families WHERE id = $1`, [id])).rows[0];
  assert.equal(archived.status, 'archived');
  assert.ok(archived.archived_at);
  assert.ok((await backend.query(`SELECT count(*)::int AS count FROM public.album_entries WHERE family_id = $1`, [id])).rows[0].count > 3);
});

test('another couple cannot see the family, and nobody signed in can write content', async () => {
  const couple = await makeCouple();
  await useOnly(...ALL_SLUGS);
  await setupFamily(couple);
  const id = couple.familyId;
  await openChapterAt(couple, 3);
  await signIn(couple.alice);
  await rpc('raise_child_album');

  const strangers = await makeCouple();
  await signIn(strangers.alice);

  assert.equal((await state()).family, null, 'the other couple has no family of their own');
  for (const table of ['families', 'child_state', 'family_moments', 'album_entries', 'family_votes', 'family_parents']) {
    const rows = await backend.asUser(`SELECT count(*)::int AS count FROM public.${table}`);
    assert.equal(rows.rows[0].count, 0, `${table} is invisible to another couple`);
  }

  // The stranger cannot vote on, or open, a moment that is not theirs.
  const momentId = (await backend.query(
    `SELECT id FROM public.family_moments WHERE family_id = $1 AND status = 'open' LIMIT 1`, [id],
  )).rows[0].id;
  assert.ok(await rpcError('raise_child_vote', { p_moment_id: momentId, p_choice: 1 }));
  assert.ok(await rpcError('raise_child_lead_decide', { p_moment_id: momentId }), 'a stranger cannot use another family’s call');
  assert.equal((await backend.query(
    `SELECT count(*)::int AS count FROM public.family_votes WHERE moment_id = $1`, [momentId],
  )).rows[0].count, 0, 'the refused vote wrote nothing');

  // Content is readable by any signed-in account (active only) and writable by none.
  const visible = await backend.asUser('SELECT slug FROM public.event_templates ORDER BY slug');
  assert.deepEqual(visible.rows.map((row) => row.slug), ['db-bedtime-3', 'db-broken-vase', 'db-first-morning', 'db-leaving-home', 'db-pocket-money', 'db-story-time']);
  await backend.query(`UPDATE public.event_templates SET active = false WHERE slug = 'db-pocket-money'`);
  const afterHide = await backend.asUser(`SELECT count(*)::int AS count FROM public.event_templates`);
  assert.equal(afterHide.rows[0].count, 5);
  await backend.query(`UPDATE public.event_templates SET active = true WHERE slug = 'db-pocket-money'`);

  await assert.rejects(backend.asUser(`INSERT INTO public.event_templates (slug, min_age, max_age, category, title, setup_text, choices)
    VALUES ('sneaky', 3, 6, 'home', 'Sneaky', 'Sneaky', '[]'::jsonb)`), /permission denied/i);
  await assert.rejects(backend.asUser(`UPDATE public.game_config SET moments_per_day = 9`), /permission denied/i);
  await assert.rejects(backend.asUser(`UPDATE public.child_state SET mood = 'delighted'`), /permission denied/i);
});

test('a family with no content yet still has a gentle day', async () => {
  const couple = await makeCouple();
  await setupFamily(couple);
  const id = couple.familyId;

  const saved = (await backend.query('SELECT slug, active FROM public.event_templates')).rows;
  await backend.query('UPDATE public.event_templates SET active = false');
  try {
    await backend.query(`UPDATE public.child_state SET age = 12, last_tick_day = NULL WHERE family_id = $1`, [id]);
    await backend.query('SELECT public.raise_child_tick_family($1, CURRENT_DATE)', [id]);
    await signIn(couple.alice);
    const current = await state();
    assert.equal(current.today.moments.length, 0, 'a quiet day is allowed');
    assert.equal(current.child.age, 12);
    assert.ok(current.today.gift, 'the day still has something small in it');

    // The day's one notification is a child-led hello, never a summons to a decision.
    const notes = (await backend.query(
      'SELECT title, body FROM public.raise_child_notifications WHERE family_id = $1', [id],
    )).rows;
    assert.ok(notes.length >= 1);
    for (const note of notes) {
      const copy = `${note.title} ${note.body}`.toLowerCase();
      for (const wrong of ['decision', 'you need', 'waiting for you', 'action required', 'reminder']) {
        assert.equal(copy.includes(wrong), false, `not a summons: ${wrong}`);
      }
      assert.ok(copy.includes('mia'), 'the child leads the line');
    }
    // One per parent per day, even after a second tick.
    assert.equal(notes.length, 2);
    assert.equal(current.today.can_age_up, true, 'the chapter can turn even without a card');

    // A quiet day is not an error, and the state still opens.
    const album = await rpc('raise_child_album');
    assert.ok(Array.isArray(album));
  } finally {
    for (const row of saved) {
      await backend.query('UPDATE public.event_templates SET active = $1 WHERE slug = $2', [row.active, row.slug]);
    }
  }
});
