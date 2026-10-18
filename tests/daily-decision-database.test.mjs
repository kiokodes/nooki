import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

process.env.TZ = 'UTC';

const POOL_QUESTIONS = [
  ['How should we spend our next free evening?', 'Cook together', 'Watch a film', 'Go for a walk'],
  ['We can afford one treat this month. Which should it be?', 'A meal out', 'A day trip', 'Something for the home'],
  ['A free Saturday appears. How should we use it?', 'See friends', 'Rest at home', 'Try somewhere new'],
];

test('Daily Decisions: random unseen pool, private choices, matching consensus and locked agreement', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
  } });
  let backend;
  try {
    const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
    backend = await installTestBackend(supabase);
    const auth = await server.ssrLoadModule('/src/lib/authService.ts');
    const migration = await readFile(new URL('../supabase/migrations/202610180001_daily_decision_pool.sql', import.meta.url), 'utf8');

    // This migration is safe to re-run over the fresh-install schema and seeds no pool rows.
    await backend.exec(migration);
    await backend.exec(migration);
    assert.equal((await backend.query('SELECT count(*)::int AS count FROM public.daily_decision_questions')).rows[0].count, 0);

    const mkUser = async (email, name, timezone = 'UTC') => {
      const user = (await auth.signUpWithEmail(email, 'password')).user;
      await auth.saveOnboardingProfile(user.id, { name, location: null, timezone });
      return user;
    };
    const alice = await mkUser('alice@example.com', 'Alice', 'Africa/Lagos');
    const bob = await mkUser('bob@example.com', 'Bob', 'Europe/London');
    const cara = await mkUser('cara@example.com', 'Cara');
    const dan = await mkUser('dan@example.com', 'Dan');
    await auth.signInWithEmail('alice@example.com', 'password');
    const { couple } = await auth.createCouple(alice.id, '2020-02-14');
    await auth.signInWithEmail('bob@example.com', 'password');
    await auth.joinCoupleWithCode(bob.id, couple.invite_code);
    await auth.signInWithEmail('cara@example.com', 'password');
    const { couple: couple2 } = await auth.createCouple(cara.id, '2021-06-01');
    await auth.signInWithEmail('dan@example.com', 'password');
    await auth.joinCoupleWithCode(dan.id, couple2.invite_code);

    // The pool is undated: question + three options, nothing else to upload.
    for (const [question, a, b, c] of POOL_QUESTIONS) {
      await backend.query(
        `INSERT INTO public.daily_decision_questions (question, option_a, option_b, option_c) VALUES ($1, $2, $3, $4)`,
        [question, a, b, c],
      );
    }
    const poolById = new Map((await backend.query('SELECT id, question FROM public.daily_decision_questions')).rows
      .map((row) => [Number(row.id), row.question]));

    const state = () => supabase.rpc('daily_decision_state');
    const submit = (optionIndex) => supabase.rpc('submit_daily_decision_choice', { p_option_index: optionIndex });
    const login = (email) => auth.signInWithEmail(email, 'password');

    // Both partners are handed the same randomly picked question, and it is one
    // of the uploaded pool rows with exactly its three options.
    await login('alice@example.com');
    let result = await state();
    assert.equal(result.error, null);
    const todaysQuestion = result.data.question;
    assert(todaysQuestion, 'a pool question is assigned for today');
    assert.equal(poolById.get(todaysQuestion.id), todaysQuestion.question);
    assert.equal(todaysQuestion.options.length, 3);
    assert(todaysQuestion.options.every((option) => typeof option === 'string' && option.length > 0));
    assert.equal(result.data.total, 3);
    assert.equal(result.data.remaining, 2, 'today’s question counts as seen; the rest of the pool remains');
    assert.equal(result.data.exhausted, false);
    assert.equal(result.data.my_choice, null);
    assert.equal(result.data.partner_choice, null);
    assert.equal(result.data.agreed, false);

    await login('bob@example.com');
    result = await state();
    assert.equal(result.data.question.id, todaysQuestion.id, 'the partner gets the same saved assignment, not a new pick');

    // The first choice is recorded for Alice, but Bob cannot inspect it or its contents.
    await login('alice@example.com');
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

    // The second couple works through the whole pool one day at a time and is
    // never handed the same question twice. Moving today's assignment back a
    // day (as the owner) stands in for the next UTC day arriving.
    const seenByCouple2 = [];
    for (let day = 0; day < POOL_QUESTIONS.length; day += 1) {
      await login('cara@example.com');
      result = await state();
      assert.equal(result.error, null);
      assert(result.data.question, `day ${day + 1} still has an unseen question`);
      assert(!seenByCouple2.includes(result.data.question.id), 'a question is never assigned twice');
      seenByCouple2.push(result.data.question.id);
      assert.equal(result.data.remaining, POOL_QUESTIONS.length - day - 1);
      await backend.query(
        `UPDATE public.daily_decision_assignments SET decision_date = DATE '2000-01-01' + $2::int WHERE couple_id = $1 AND decision_date = (timezone('utc'::text, now()))::date`,
        [couple2.id, day],
      );
    }
    assert.equal(new Set(seenByCouple2).size, POOL_QUESTIONS.length, 'the couple saw the entire pool exactly once');

    // With the pool used up, the state says so instead of repeating a question,
    // and submitting is refused with the same news.
    await login('cara@example.com');
    result = await state();
    assert.equal(result.data.question, null);
    assert.equal(result.data.exhausted, true);
    assert.equal(result.data.remaining, 0);
    assert.equal(result.data.total, POOL_QUESTIONS.length);
    const tooLate = await submit(1);
    assert(tooLate.error);
    assert.match(tooLate.error.message, /every daily decision/);

    // Uploading more questions is all it takes to continue: the next day picks
    // from the new rows only.
    await backend.query(
      `INSERT INTO public.daily_decision_questions (question, option_a, option_b, option_c) VALUES ($1, $2, $3, $4)`,
      ['One more: how should we celebrate?', 'Cook something special', 'Go out', 'Invite friends over'],
    );
    await login('dan@example.com');
    result = await state();
    assert.equal(result.data.question.question, 'One more: how should we celebrate?');
    assert.equal(result.data.exhausted, false);

    // A third, unpaired account has no couple decision and can see neither the
    // pool nor any couple's responses or assignments.
    const eve = await mkUser('eve@example.com', 'Eve');
    await login('eve@example.com');
    result = await state();
    assert.equal(result.data.question, null, 'an unpaired account has no couple decision');
    assert.equal(result.data.partner_choice, null);
    const poolRead = await supabase.from('daily_decision_questions').select('*');
    assert(poolRead.error || (poolRead.data ?? []).length === 0,
      'the pool itself is not readable directly; only the state RPC hands out a question');
    assert.deepEqual((await supabase.from('daily_decision_responses').select('*')).data, []);
    assert.deepEqual((await supabase.from('daily_decision_assignments').select('*')).data, []);

    // Writes remain behind the RPCs; the app cannot forge, update or erase rows.
    const directWrite = await supabase.from('daily_decision_responses').insert({
      couple_id: couple.id,
      decision_date: new Date().toISOString().slice(0, 10),
      user_id: eve.id,
      option_index: 1,
    });
    assert(directWrite.error, 'direct response inserts are denied');

    const privileges = (await backend.query(`
      SELECT has_table_privilege('authenticated', 'public.daily_decision_questions', 'SELECT') AS question_read,
             has_table_privilege('authenticated', 'public.daily_decision_questions', 'INSERT') AS question_write,
             has_table_privilege('authenticated', 'public.daily_decision_assignments', 'SELECT') AS assignment_read,
             has_table_privilege('authenticated', 'public.daily_decision_assignments', 'INSERT') AS assignment_insert,
             has_table_privilege('authenticated', 'public.daily_decision_responses', 'SELECT') AS response_read,
             has_table_privilege('authenticated', 'public.daily_decision_responses', 'INSERT') AS response_insert,
             has_table_privilege('authenticated', 'public.daily_decision_responses', 'UPDATE') AS response_update,
             has_table_privilege('anon', 'public.daily_decision_responses', 'SELECT') AS anon_read,
             has_function_privilege('authenticated', 'public.daily_decision_state()', 'EXECUTE') AS state_rpc,
             has_function_privilege('authenticated', 'public.ensure_daily_decision_assignment(uuid,date)', 'EXECUTE') AS picker_rpc,
             has_function_privilege('anon', 'public.submit_daily_decision_choice(smallint)', 'EXECUTE') AS anon_submit
    `)).rows[0];
    assert.equal(privileges.question_read, false, 'the pool is only reachable through the state RPC');
    assert.equal(privileges.question_write, false);
    assert.equal(privileges.assignment_read, true, 'the assignment read grant is still filtered by RLS');
    assert.equal(privileges.assignment_insert, false);
    assert.equal(privileges.response_read, true, 'the response read grant is still filtered by RLS');
    assert.equal(privileges.response_insert, false);
    assert.equal(privileges.response_update, false);
    assert.equal(privileges.anon_read, false);
    assert.equal(privileges.state_rpc, true);
    assert.equal(privileges.picker_rpc, false, 'the picker takes any couple id, so only the RPCs may call it');
    assert.equal(privileges.anon_submit, false);
  } finally {
    await backend?.close();
    await server.close();
  }
});

test('Daily Decisions pool migration upgrades a dated install without losing its answers', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE anon NOLOGIN;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id UUID PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE SQL STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$;
      CREATE TABLE public.couples (id UUID PRIMARY KEY);
      CREATE TABLE public.profiles (id UUID PRIMARY KEY, couple_id UUID);
      CREATE FUNCTION public.get_user_couple_id(p_user UUID) RETURNS UUID LANGUAGE SQL STABLE SECURITY DEFINER AS $$
        SELECT couple_id FROM public.profiles WHERE id = p_user;
      $$;
      INSERT INTO auth.users (id) VALUES
        ('11111111-1111-1111-1111-111111111111'),
        ('22222222-2222-2222-2222-222222222222');
      INSERT INTO public.couples (id) VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
      INSERT INTO public.profiles (id, couple_id) VALUES
        ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
        ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    `);

    // The dated install, exactly as 202610170002 created it, with one answered
    // day and one scheduled day that was never reached.
    const dated = await readFile(new URL('../supabase/migrations/202610170002_daily_decisions.sql', import.meta.url), 'utf8');
    await db.exec(dated);
    await db.query(`
      INSERT INTO public.daily_decision_questions (decision_date, question, option_a, option_b, option_c) VALUES
        ('2026-10-17', 'Answered together', 'One', 'Two', 'Three'),
        ('2026-10-18', 'Never opened', 'Alpha', 'Beta', 'Gamma')
    `);
    await db.query(`
      INSERT INTO public.daily_decision_responses (couple_id, decision_date, user_id, option_index) VALUES
        ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-10-17', '11111111-1111-1111-1111-111111111111', 2),
        ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-10-17', '22222222-2222-2222-2222-222222222222', 2)
    `);

    const pool = await readFile(new URL('../supabase/migrations/202610180001_daily_decision_pool.sql', import.meta.url), 'utf8');
    await db.exec(pool);
    await db.exec(pool);

    const columns = (await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'daily_decision_questions'
    `)).rows.map((row) => row.column_name);
    assert(columns.includes('id'), 'pool questions gain a stable id');
    assert(!columns.includes('decision_date'), 'the date leaves the question table');

    const questions = (await db.query('SELECT id, question FROM public.daily_decision_questions ORDER BY question')).rows;
    assert.equal(questions.length, 2, 'both dated questions join the pool');
    assert(questions.every((row) => row.id !== null), 'every pool row has an id');
    assert.notEqual(questions[0].id, questions[1].id);

    const assignments = (await db.query('SELECT couple_id, decision_date::text AS day, question_id FROM public.daily_decision_assignments')).rows;
    assert.equal(assignments.length, 1, 'the answered day becomes that couple’s assignment');
    const answered = questions.find((row) => row.question === 'Answered together');
    assert.equal(Number(assignments[0].question_id), Number(answered.id));
    assert.equal(assignments[0].day, '2026-10-17');

    const responses = (await db.query('SELECT count(*)::int AS count FROM public.daily_decision_responses')).rows[0];
    assert.equal(responses.count, 2, 'existing answers survive the upgrade');
  } finally {
    await db.close();
  }
});
