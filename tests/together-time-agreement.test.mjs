import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

// A Together time is a suggestion until the other partner agrees to it. These rules
// belong to PostgreSQL (the guard trigger), so neither partner — and no stale
// client — can lock in a time one-sidedly. Run against real PGlite/RLS.
test('Together time agreement: propose, agree, counter-suggest, and no reminder before both say yes', async () => {
  const server = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
    },
  });
  let backend;
  try {
    const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
    backend = await installTestBackend(supabase);
    const auth = await server.ssrLoadModule('/src/lib/authService.ts');

    const alice = (await auth.signUpWithEmail('alice@example.com', 'password')).user;
    await auth.saveOnboardingProfile(alice.id, { name: 'Alice', location: null, timezone: 'Africa/Lagos' });
    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, { name: 'Bob', location: null, timezone: 'Africa/Lagos' });
    const { couple } = await auth.createCouple(bob.id, '2020-02-14');
    await auth.signInWithEmail('alice@example.com', 'password');
    await auth.joinCoupleWithCode(alice.id, couple.invite_code);

    const base = {
      couple_id: couple.id, created_by: alice.id, activity_type: 'game', activity_id: 'word-wheel',
      activity_name: 'Word Wheel', timezone: 'Africa/Lagos',
    };
    const read = async (id) => (await supabase.from('together_time_sessions').select('*').eq('id', id).single()).data;

    // One partner cannot create a locked-in date directly: it starts as a suggestion.
    const forced = await supabase.from('together_time_sessions').insert({
      ...base, scheduled_at: '2099-05-01T18:00:00.000Z', status: 'scheduled',
    });
    assert.match(forced.error?.message || '', /starts as a suggestion/);
    const suggestion = await supabase.from('together_time_sessions').insert({
      ...base, scheduled_at: '2099-05-01T18:00:00.000Z',
    }).select().single();
    assert.equal(suggestion.error, null);
    assert.equal(suggestion.data.status, 'proposed');
    assert.equal(suggestion.data.proposed_by, alice.id);
    assert.equal(suggestion.data.agreed_by, null);
    assert.equal(suggestion.data.agreed_at, null);
    const firstId = suggestion.data.id;

    // The proposer cannot agree to their own suggestion…
    const selfAgree = await supabase.from('together_time_sessions')
      .update({ status: 'scheduled' }).eq('id', firstId);
    assert.match(selfAgree.error?.message || '', /Your partner needs to agree/);
    // …nor stamp a forged agreement onto it without locking anything in.
    const forged = await supabase.from('together_time_sessions')
      .update({ agreed_by: bob.id, agreed_at: new Date().toISOString() }).eq('id', firstId);
    assert.equal(forged.error, null);
    assert.equal((await read(firstId)).agreed_by, null, 'the trigger, not the client, stamps agreements');
    // And an un-agreed suggestion cannot be marked done.
    const prematureDone = await supabase.from('together_time_sessions')
      .update({ status: 'done' }).eq('id', firstId);
    assert.match(prematureDone.error?.message || '', /Agree on a time together/);

    // The partner can agree — but only to the exact time that was suggested.
    await auth.signInWithEmail('bob@example.com', 'password');
    const movedAgree = await supabase.from('together_time_sessions')
      .update({ status: 'scheduled', scheduled_at: '2099-05-02T18:00:00.000Z' }).eq('id', firstId);
    assert.match(movedAgree.error?.message || '', /Agree to the suggested time as it is/);
    const agreed = await supabase.from('together_time_sessions')
      .update({ status: 'scheduled' }).eq('id', firstId);
    assert.equal(agreed.error, null);
    const locked = await read(firstId);
    assert.equal(locked.status, 'scheduled');
    assert.equal(locked.proposed_by, alice.id);
    assert.equal(locked.agreed_by, bob.id);
    assert.ok(locked.agreed_at);

    // A locked-in time cannot quietly move: changing it reopens it as a suggestion
    // from whoever moved it, and the other partner has to agree all over again.
    const silentMove = await supabase.from('together_time_sessions')
      .update({ scheduled_at: '2099-05-03T18:00:00.000Z' }).eq('id', firstId);
    assert.match(silentMove.error?.message || '', /This time is locked in/);
    await auth.signInWithEmail('alice@example.com', 'password');
    const reopened = await supabase.from('together_time_sessions')
      .update({ status: 'proposed', scheduled_at: '2099-05-03T18:00:00.000Z' }).eq('id', firstId);
    assert.equal(reopened.error, null);
    const again = await read(firstId);
    assert.equal(again.status, 'proposed');
    assert.equal(again.proposed_by, alice.id);
    assert.equal(again.agreed_by, null);
    assert.equal(again.agreed_at, null);

    // A counter-suggestion hands the suggestion to the other partner: Bob moves the
    // pending time, so now Bob waits and Alice is the one who can lock it in.
    await auth.signInWithEmail('bob@example.com', 'password');
    const counter = await supabase.from('together_time_sessions')
      .update({ status: 'proposed', scheduled_at: '2099-05-04T19:30:00.000Z' }).eq('id', firstId);
    assert.equal(counter.error, null);
    assert.equal((await read(firstId)).proposed_by, bob.id);
    const bobSelfAgree = await supabase.from('together_time_sessions')
      .update({ status: 'scheduled' }).eq('id', firstId);
    assert.match(bobSelfAgree.error?.message || '', /Your partner needs to agree/);
    await auth.signInWithEmail('alice@example.com', 'password');
    const relocked = await supabase.from('together_time_sessions')
      .update({ status: 'scheduled' }).eq('id', firstId);
    assert.equal(relocked.error, null);
    assert.equal((await read(firstId)).agreed_by, alice.id);

    // Either partner can still cancel a suggestion, and a finished date stays finished.
    const second = await supabase.from('together_time_sessions').insert({
      ...base, scheduled_at: '2099-06-01T18:00:00.000Z',
    }).select().single();
    assert.equal(second.error, null);
    await auth.signInWithEmail('bob@example.com', 'password');
    const cancelled = await supabase.from('together_time_sessions')
      .update({ status: 'cancelled' }).eq('id', second.data.id);
    assert.equal(cancelled.error, null);
    const resurrected = await supabase.from('together_time_sessions')
      .update({ status: 'proposed', scheduled_at: '2099-06-02T18:00:00.000Z' }).eq('id', second.data.id);
    assert.match(resurrected.error?.message || '', /That Together time is over/);

    // The reminder sweep only claims locked-in dates: a due suggestion — even one
    // whose time has come and gone — never notifies either phone.
    await backend.query("SELECT set_config('request.jwt.claim.sub', '', false)");
    await backend.query(`
      INSERT INTO public.together_time_sessions
        (couple_id, created_by, activity_type, activity_id, activity_name, scheduled_at, timezone, status)
      VALUES ($1, $2, 'game', 'word-wheel', 'Unagreed Word Wheel', now() - interval '1 minute', 'Africa/Lagos', 'proposed'),
             ($1, $2, 'game', 'word-wheel', 'Locked In Word Wheel', now() - interval '1 minute', 'Africa/Lagos', 'scheduled')
    `, [couple.id, alice.id]);
    const { rows: claimed } = await backend.query('SELECT * FROM public.claim_due_together_time_reminders()');
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].activity_name, 'Locked In Word Wheel');
  } finally {
    await backend?.close();
    await server.close();
  }
});
