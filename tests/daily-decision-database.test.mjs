import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

process.env.TZ = 'UTC';

test('Daily Decisions: manual prompts, private choices, matching consensus and locked agreement', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
  } });
  let backend;
  try {
    const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
    backend = await installTestBackend(supabase);
    const auth = await server.ssrLoadModule('/src/lib/authService.ts');
    const migration = await readFile(new URL('../supabase/migrations/202610170002_daily_decisions.sql', import.meta.url), 'utf8');

    // This migration is safe to re-run and deliberately seeds no prompt rows.
    await backend.exec(migration);
    assert.equal((await backend.query('SELECT count(*)::int AS count FROM public.daily_decision_questions')).rows[0].count, 0);

    const alice = (await auth.signUpWithEmail('alice@example.com', 'password')).user;
    await auth.saveOnboardingProfile(alice.id, { name: 'Alice', location: null, timezone: 'Africa/Lagos' });
    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, { name: 'Bob', location: null, timezone: 'Europe/London' });
    const cara = (await auth.signUpWithEmail('cara@example.com', 'password')).user;
    await auth.saveOnboardingProfile(cara.id, { name: 'Cara', location: null, timezone: 'UTC' });
    await auth.signInWithEmail('alice@example.com', 'password');
    const { couple } = await auth.createCouple(alice.id, '2020-02-14');
    await auth.signInWithEmail('bob@example.com', 'password');
    await auth.joinCoupleWithCode(bob.id, couple.invite_code);

    const today = new Date().toISOString().slice(0, 10);
    await backend.query(
      `INSERT INTO public.daily_decision_questions (decision_date, question, option_a, option_b, option_c)
       VALUES ($1, $2, $3, $4, $5)`,
      [today, 'How should we spend our next free evening?', 'Cook together', 'Watch a film', 'Go for a walk'],
    );

    const state = () => supabase.rpc('daily_decision_state');
    const submit = (optionIndex) => supabase.rpc('submit_daily_decision_choice', { p_option_index: optionIndex });
    const login = (email) => auth.signInWithEmail(email, 'password');

    // Prompt rows are shared; the date and three choices are the Supabase upload contract.
    await login('alice@example.com');
    let result = await state();
    assert.equal(result.error, null);
    assert.equal(result.data.question.decision_date, today);
    assert.equal(result.data.question.question, 'How should we spend our next free evening?');
    assert.deepEqual(result.data.question.options, ['Cook together', 'Watch a film', 'Go for a walk']);
    assert.equal(result.data.my_choice, null);
    assert.equal(result.data.partner_choice, null);
    assert.equal(result.data.agreed, false);

    // The first choice is recorded for Alice, but Bob cannot inspect it or its contents.
    const invalid = await submit(4);
    assert(invalid.error);
    assert.match(invalid.error.message, /three options/);
    assert.equal((await submit(1)).error, null);
    result = await state();
    assert.equal(result.data.my_choice, 1);
    assert.equal(result.data.partner_responded, false);
    assert.equal(result.data.partner_choice, null, 'the RPC never returns a sealed partner choice');

    await login('bob@example.com');
    result = await state();
    assert.equal(result.data.my_choice, null);
    assert.equal(result.data.partner_responded, true, 'progress is visible without answer text');
    assert.equal(result.data.partner_choice, null, 'Bob does not see Alice\'s option before replying');
    assert.equal(result.data.both_answered, false);
    assert.deepEqual((await supabase.from('daily_decision_responses').select('*')).data, [],
      'RLS also hides the partner response row before Bob has replied');

    assert.equal((await submit(2)).error, null);
    result = await state();
    assert.equal(result.data.my_choice, 2);
    assert.equal(result.data.partner_choice, 1);
    assert.equal(result.data.both_answered, true);
    assert.equal(result.data.agreed, false, 'different choices are revealed, not finalized');
    const revealedToBob = await supabase.from('daily_decision_responses').select('*');
    assert.equal(revealedToBob.data.length, 2, 'both response rows become readable after the second reply');

    // Alice can see both choices now and revise hers; matching answers become a locked decision.
    await login('alice@example.com');
    result = await state();
    assert.equal(result.data.my_choice, 1);
    assert.equal(result.data.partner_choice, 2);
    assert.equal((await submit(2)).error, null);
    result = await state();
    assert.equal(result.data.my_choice, 2);
    assert.equal(result.data.partner_choice, 2);
    assert.equal(result.data.agreed, true);
    const locked = await submit(3);
    assert(locked.error);
    assert.match(locked.error.message, /already agreed/);

    // A third account may read the shared prompt but never the couple's response rows.
    await login('cara@example.com');
    result = await state();
    assert.equal(result.data.question, null, 'an unpaired account has no couple decision');
    assert.equal(result.data.partner_choice, null);
    assert.equal((await supabase.from('daily_decision_questions').select('*')).data.length, 1,
      'signed-in users can read the shared prompt library');
    assert.deepEqual((await supabase.from('daily_decision_responses').select('*')).data, []);

    // Writes remain behind the RPC; the app cannot forge, update or erase response rows.
    const directWrite = await supabase.from('daily_decision_responses').insert({
      couple_id: couple.id,
      decision_date: today,
      user_id: cara.id,
      option_index: 1,
    });
    assert(directWrite.error, 'direct response inserts are denied');

    const privileges = (await backend.query(`
      SELECT has_table_privilege('authenticated', 'public.daily_decision_questions', 'SELECT') AS question_read,
             has_table_privilege('authenticated', 'public.daily_decision_questions', 'INSERT') AS question_write,
             has_table_privilege('authenticated', 'public.daily_decision_responses', 'SELECT') AS response_read,
             has_table_privilege('authenticated', 'public.daily_decision_responses', 'INSERT') AS response_insert,
             has_table_privilege('authenticated', 'public.daily_decision_responses', 'UPDATE') AS response_update,
             has_table_privilege('anon', 'public.daily_decision_responses', 'SELECT') AS anon_read,
             has_function_privilege('authenticated', 'public.daily_decision_state()', 'EXECUTE') AS state_rpc,
             has_function_privilege('anon', 'public.submit_daily_decision_choice(smallint)', 'EXECUTE') AS anon_submit
    `)).rows[0];
    assert.equal(privileges.question_read, true);
    assert.equal(privileges.question_write, false);
    assert.equal(privileges.response_read, true, 'the response read grant is still filtered by RLS');
    assert.equal(privileges.response_insert, false);
    assert.equal(privileges.response_update, false);
    assert.equal(privileges.anon_read, false);
    assert.equal(privileges.state_rpc, true);
    assert.equal(privileges.anon_submit, false);
  } finally {
    await backend?.close();
    await server.close();
  }
});
