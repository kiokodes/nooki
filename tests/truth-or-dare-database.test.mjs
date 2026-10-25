import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const alice = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const outsider = '00000000-0000-4000-8000-000000000003';
const couple = '10000000-0000-4000-8000-000000000001';

async function makeDatabase({ withDob = false } = {}) {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id UUID PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE SQL STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::UUID;
    $$;
    CREATE TABLE public.couples (id UUID PRIMARY KEY);
    CREATE TABLE public.profiles (
      id UUID PRIMARY KEY REFERENCES auth.users(id),
      couple_id UUID REFERENCES public.couples(id)${withDob ? ',\n      date_of_birth DATE' : ''}
    );
    CREATE FUNCTION public.get_user_couple_id(user_uid UUID) RETURNS UUID
    LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT couple_id FROM public.profiles WHERE id = user_uid;
    $$;
  `);
  const baseMigration = await readFile(new URL('../supabase/migrations/202610220001_truth_or_dare.sql', import.meta.url), 'utf8');
  const lockMigration = await readFile(new URL('../supabase/migrations/202610250001_lock_truth_or_dare_spicy.sql', import.meta.url), 'utf8');
  await db.exec(baseMigration);
  // Applying the additive migration twice must not change or duplicate its objects.
  await db.exec(baseMigration);
  await db.exec(`
    INSERT INTO auth.users (id) VALUES ('${alice}'), ('${bob}'), ('${outsider}');
    INSERT INTO public.couples (id) VALUES ('${couple}');
    INSERT INTO public.profiles (id, couple_id${withDob ? ', date_of_birth' : ''}) VALUES
      ('${alice}', '${couple}'${withDob ? ", (current_date - interval '19 years')::date" : ''}),
      ('${bob}', '${couple}'${withDob ? ", (current_date - interval '20 years')::date" : ''}),
      ('${outsider}', NULL${withDob ? ', NULL' : ''});
    INSERT INTO public.tod_prompts (id, type, theme, intensity, text, tags, mode, active) VALUES
      ('r-truth-1', 'truth', 'random', 1, 'What small thing made you smile today?', ARRAY['daily-life'], 'text', true),
      ('r-truth-2', 'truth', 'random', 1, 'What memory from school still makes you laugh?', ARRAY['memory'], 'voice', true),
      ('r-truth-3', 'truth', 'random', 2, 'What fear do you want us to understand better?', ARRAY['trust'], 'text', true),
      ('r-dare-1', 'dare', 'random', 1, 'On a private call, make a face for your current mood.', ARRAY['playful'], 'video_call', true),
      ('r-dare-2', 'dare', 'random', 1, 'Send a voice note with one small thing you are proud of.', ARRAY['voice'], 'voice', true),
      ('r-dare-3', 'dare', 'random', 2, 'Text one kind thing you want us to remember this week.', ARRAY['care'], 'text', true),
      ('f-truth-1', 'truth', 'flirty', 1, 'What makes you feel close to me from far away?', ARRAY['romance'], 'text', true),
      ('f-dare-1', 'dare', 'flirty', 1, 'On a private call, give me your warmest smile.', ARRAY['romance'], 'video_call', true),
      ('s-truth-1', 'truth', 'spicy', 1, 'What kind of kiss do you want from me?', ARRAY['desire'], 'text', true),
      ('s-dare-1', 'dare', 'spicy', 1, 'On a private call, describe one touch you would enjoy.', ARRAY['sensual'], 'voice', true),
      ('r-truth-off', 'truth', 'random', 1, 'This prompt is waiting for review.', ARRAY['review'], 'text', false);
    -- A Spicy room and approved Spicy prompts from a build that predates the lock.
    INSERT INTO public.tod_rounds (id, couple_id, theme, created_by, player_one, player_two, turn_id, status, accepted_by)
      VALUES ('20000000-0000-4000-8000-000000000001', '${couple}', 'spicy', '${alice}', '${alice}', '${bob}', '${alice}', 'active', ARRAY['${alice}', '${bob}']::UUID[]);
    GRANT USAGE ON SCHEMA public, auth TO authenticated, anon, service_role;
  `);
  // The lock migration closes that room and withdraws those prompts; it must be rerunnable.
  await db.exec(lockMigration);
  await db.exec(lockMigration);
  return db;
}

async function asUser(db, userId) {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [userId || '']);
  await db.exec('SET ROLE authenticated');
}

async function rpc(db, name, args = []) {
  const placeholders = args.map((_, index) => `$${index + 1}`).join(', ');
  const result = await db.query(`SELECT public.${name}(${placeholders}) AS result`, args);
  return result.rows[0].result;
}

test('Truth or Dare database: Spicy lock, RLS, age gates, consent, turn order, skip, pause and seen-prompt rotation', async () => {
  const db = await makeDatabase();
  try {
    // The migration closed the leftover Spicy room and withdrew its prompts from the pool.
    assert.equal(
      (await db.query("SELECT status FROM public.tod_rounds WHERE id = '20000000-0000-4000-8000-000000000001'")).rows[0].status,
      'ended',
      'an open Spicy room from an older build is closed',
    );
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM public.tod_prompts WHERE theme = 'spicy' AND active")).rows[0].n,
      0,
      'Spicy prompts are withdrawn from the live pool',
    );

    // A Spicy room cannot be joined or dealt even if one somehow exists.
    await db.exec(`
      INSERT INTO public.tod_rounds (id, couple_id, theme, created_by, player_one, player_two, turn_id, status, accepted_by)
      VALUES ('20000000-0000-4000-8000-000000000002', '${couple}', 'spicy', '${alice}', '${alice}', '${bob}', '${alice}', 'inviting', '{}'::UUID[]);
    `);
    await asUser(db, alice);
    await assert.rejects(rpc(db, 'tod_accept_round', ['20000000-0000-4000-8000-000000000002']), /locked until marriage verification/i);
    assert.equal((await rpc(db, 'tod_state')).round, null, 'a locked room is never handed back to a phone');

    // Starting any round retires a stray locked room instead of being blocked by it.
    const randomRoundId = await rpc(db, 'tod_start_round', ['random']);
    assert.equal(
      (await db.query("SELECT status FROM public.tod_rounds WHERE id = '20000000-0000-4000-8000-000000000002'")).rows[0].status,
      'ended',
      'a new round self-heals by closing a stray Spicy room',
    );

    await asUser(db, alice);
    const visiblePrompts = await db.query('SELECT id FROM public.tod_prompts ORDER BY id');
    assert.equal(visiblePrompts.rows.some((row) => row.id === 'r-truth-off'), false, 'signed-in users can read active prompts only');
    await assert.rejects(db.query("UPDATE public.tod_prompts SET active = true WHERE id = 'r-truth-off'"), /permission denied/i);
    await assert.rejects(db.query(`INSERT INTO public.tod_rounds (couple_id, theme, created_by, player_one, player_two, turn_id)
      VALUES ('${couple}', 'random', '${alice}', '${alice}', '${bob}', '${alice}')`), /permission denied/i);
    await assert.rejects(db.query('SELECT * FROM public.tod_seen_prompts'), /permission denied/i);

    // Random has no adult-theme age check; Flirty requires both partners to confirm 18+.
    await assert.rejects(rpc(db, 'tod_start_round', ['flirty']), /both partners meet its age rule/i);
    await rpc(db, 'tod_accept_round', [randomRoundId]);
    let room = await rpc(db, 'tod_state');
    assert.equal(room.round.status, 'inviting');
    assert.deepEqual(room.round.accepted_by, [alice]);
    await assert.rejects(rpc(db, 'tod_choose_prompt', [randomRoundId, 'truth']), /round is not active/i);

    await asUser(db, bob);
    await rpc(db, 'tod_accept_round', [randomRoundId]);
    room = await rpc(db, 'tod_state');
    assert.equal(room.round.status, 'active', 'the room opens when both partners tap in');
    await assert.rejects(rpc(db, 'tod_choose_prompt', [randomRoundId, 'truth']), /partner’s turn/i);

    await asUser(db, alice);
    const firstTruth = await rpc(db, 'tod_choose_prompt', [randomRoundId, 'truth']);
    assert.equal(firstTruth.intensity, 1);
    assert.equal((await rpc(db, 'tod_state')).round.current_prompt.id, firstTruth.id, 'both phones read the same prompt snapshot');
    await rpc(db, 'tod_complete_prompt', [randomRoundId, 'skip']);

    await asUser(db, bob);
    room = await rpc(db, 'tod_state');
    assert.equal(room.round.turn_id, bob, 'Skip still advances the turn');
    const secondTruth = await rpc(db, 'tod_choose_prompt', [randomRoundId, 'truth']);
    assert.notEqual(secondTruth.id, firstTruth.id, 'the couple does not see a prompt twice while its pool has unseen rows');
    await rpc(db, 'tod_complete_prompt', [randomRoundId, 'done']);

    await asUser(db, alice);
    const strongerTruth = await rpc(db, 'tod_choose_prompt', [randomRoundId, 'truth']);
    assert.equal(strongerTruth.intensity, 2, 'the selected intensity steps up with the round');
    await asUser(db, bob);
    await rpc(db, 'tod_pause_round', [randomRoundId]);
    room = await rpc(db, 'tod_state');
    assert.equal(room.round.status, 'paused');
    assert.equal(room.round.current_prompt.id, strongerTruth.id, 'pausing preserves the shared prompt');
    await assert.rejects(rpc(db, 'tod_complete_prompt', [randomRoundId, 'done']), /round is not active/i);
    await rpc(db, 'tod_resume_round', [randomRoundId]);
    await asUser(db, alice);
    await rpc(db, 'tod_complete_prompt', [randomRoundId, 'done']);
    await asUser(db, bob);
    await rpc(db, 'tod_end_round', [randomRoundId]);
    await db.exec('RESET ROLE');
    assert.equal((await db.query(`SELECT status FROM public.tod_rounds WHERE id = '${randomRoundId}'`)).rows[0].status, 'ended');
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM public.tod_seen_prompts WHERE couple_id = '${couple}'`)).rows[0].n, 3);

    await asUser(db, alice);
    await assert.rejects(rpc(db, 'tod_start_round', ['flirty']), /both partners meet its age rule/i);
    await rpc(db, 'tod_confirm_age', [18]);
    room = await rpc(db, 'tod_state');
    assert.deepEqual(room.ages.mine, { tier: 18, source: 'confirmation' });
    assert.deepEqual(room.ages.partner, { tier: 0, source: 'missing' });
    await assert.rejects(rpc(db, 'tod_start_round', ['flirty']), /both partners meet its age rule/i);

    await asUser(db, bob);
    await rpc(db, 'tod_confirm_age', [18]);
    await asUser(db, alice);
    const flirtyRoundId = await rpc(db, 'tod_start_round', ['flirty']);
    await rpc(db, 'tod_accept_round', [flirtyRoundId]);
    assert.equal((await rpc(db, 'tod_state')).round.status, 'inviting');
    await asUser(db, bob);
    await rpc(db, 'tod_accept_round', [flirtyRoundId]);
    assert.equal((await rpc(db, 'tod_state')).round.status, 'active');
    await rpc(db, 'tod_end_round', [flirtyRoundId]);

    // Spicy is locked for everyone: not even two partners who both confirm 20+ can open it.
    await rpc(db, 'tod_confirm_age', [20]);
    await asUser(db, alice);
    await rpc(db, 'tod_confirm_age', [20]);
    assert.deepEqual((await rpc(db, 'tod_state')).ages.mine, { tier: 20, source: 'confirmation' });
    await assert.rejects(rpc(db, 'tod_start_round', ['spicy']), /locked until marriage verification/i);
    assert.deepEqual((await rpc(db, 'tod_state')).active_counts.spicy, { truth: 0, dare: 0 },
      'the Spicy bucket reports no usable prompts');

    // A hand-made active Spicy round still cannot pick, finish or resume a prompt.
    await db.exec('RESET ROLE');
    await db.exec(`
      INSERT INTO public.tod_rounds (id, couple_id, theme, created_by, player_one, player_two, turn_id, status, accepted_by)
      VALUES ('20000000-0000-4000-8000-000000000003', '${couple}', 'spicy', '${alice}', '${alice}', '${bob}', '${alice}', 'active',
        ARRAY['${alice}', '${bob}']::UUID[]);
    `);
    await asUser(db, alice);
    await assert.rejects(rpc(db, 'tod_choose_prompt', ['20000000-0000-4000-8000-000000000003', 'truth']), /locked until marriage verification/i);
    await assert.rejects(rpc(db, 'tod_complete_prompt', ['20000000-0000-4000-8000-000000000003', 'done']), /locked until marriage verification/i);
    await assert.rejects(rpc(db, 'tod_pause_round', ['20000000-0000-4000-8000-000000000003']), /locked until marriage verification/i);
    await db.exec('RESET ROLE');
    await db.exec("UPDATE public.tod_rounds SET status = 'paused' WHERE id = '20000000-0000-4000-8000-000000000003'");
    await asUser(db, alice);
    await assert.rejects(rpc(db, 'tod_resume_round', ['20000000-0000-4000-8000-000000000003']), /locked until marriage verification/i);
    await rpc(db, 'tod_end_round', ['20000000-0000-4000-8000-000000000003']);
    assert.equal(
      (await db.query("SELECT status FROM public.tod_rounds WHERE id = '20000000-0000-4000-8000-000000000003'")).rows[0].status,
      'ended',
      'ending a locked round is still allowed so a couple is never trapped',
    );

    await asUser(db, outsider);
    await assert.rejects(rpc(db, 'tod_state'), /pair with your partner/i);
  } finally {
    await db.close();
  }
});

test('Truth or Dare uses a stored date of birth when the profile has one', async () => {
  const db = await makeDatabase({ withDob: true });
  try {
    await asUser(db, alice);
    const room = await rpc(db, 'tod_state');
    assert.deepEqual(room.ages.mine, { tier: 18, source: 'date_of_birth' });
    assert.deepEqual(room.ages.partner, { tier: 20, source: 'date_of_birth' });
    await assert.rejects(rpc(db, 'tod_confirm_age', [20]), /date of birth is already on file/i);
    await assert.rejects(rpc(db, 'tod_start_round', ['spicy']), /locked until marriage verification/i);
    const flirtyRoundId = await rpc(db, 'tod_start_round', ['flirty']);
    assert.ok(flirtyRoundId);
  } finally {
    await db.close();
  }
});

test('Truth or Dare from schema.sql: a fresh project carries the same Spicy lock', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id UUID PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE SQL STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$;
    `);
    await db.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
    await db.exec(`
      INSERT INTO auth.users (id) VALUES ('${alice}'), ('${bob}');
      INSERT INTO public.couples (id, invite_code) VALUES ('${couple}', 'ABC123');
      INSERT INTO public.profiles (id, couple_id, name) VALUES
        ('${alice}', '${couple}', 'Alice'), ('${bob}', '${couple}', 'Bob');
      INSERT INTO public.tod_prompts (id, type, theme, intensity, text, tags, mode, active) VALUES
        ('r-truth-1', 'truth', 'random', 1, 'What made you smile today?', ARRAY['daily-life'], 'text', true),
        ('r-dare-1', 'dare', 'random', 1, 'Send a voice note about your day.', ARRAY['voice'], 'voice', true),
        ('s-truth-1', 'truth', 'spicy', 1, 'What kind of kiss do you want from me?', ARRAY['desire'], 'text', true),
        ('s-dare-1', 'dare', 'spicy', 1, 'Describe one touch you would enjoy.', ARRAY['sensual'], 'voice', true);
      GRANT USAGE ON SCHEMA public, auth TO authenticated, anon, service_role;
    `);

    await asUser(db, alice);
    await assert.rejects(rpc(db, 'tod_start_round', ['spicy']), /locked until marriage verification/i);
    assert.deepEqual((await rpc(db, 'tod_state')).active_counts.spicy, { truth: 0, dare: 0 });
    assert.ok(await rpc(db, 'tod_start_round', ['random']), 'Random still starts on a fresh project');
    const locked = await db.query(
      "SELECT has_function_privilege('authenticated', 'public.tod_theme_locked(text)', 'EXECUTE') AS allowed",
    );
    assert.equal(locked.rows[0].allowed, false, 'a phone cannot call the lock switch directly');
  } finally {
    await db.close();
  }
});
