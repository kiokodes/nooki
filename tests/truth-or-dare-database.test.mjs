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
  await db.exec(await readFile(new URL('../supabase/migrations/202610220001_truth_or_dare.sql', import.meta.url), 'utf8'));
  // Applying the additive migration twice must not change or duplicate its objects.
  await db.exec(await readFile(new URL('../supabase/migrations/202610220001_truth_or_dare.sql', import.meta.url), 'utf8'));
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
    GRANT USAGE ON SCHEMA public, auth TO authenticated, anon, service_role;
  `);
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

test('Truth or Dare database: RLS, age gates, consent, turn order, skip, pause and seen-prompt rotation', async () => {
  const db = await makeDatabase();
  try {
    await asUser(db, alice);
    const visiblePrompts = await db.query('SELECT id FROM public.tod_prompts ORDER BY id');
    assert.equal(visiblePrompts.rows.some((row) => row.id === 'r-truth-off'), false, 'signed-in users can read active prompts only');
    await assert.rejects(db.query("UPDATE public.tod_prompts SET active = true WHERE id = 'r-truth-off'"), /permission denied/i);
    await assert.rejects(db.query(`INSERT INTO public.tod_rounds (couple_id, theme, created_by, player_one, player_two, turn_id)
      VALUES ('${couple}', 'random', '${alice}', '${alice}', '${bob}', '${alice}')`), /permission denied/i);
    await assert.rejects(db.query('SELECT * FROM public.tod_seen_prompts'), /permission denied/i);

    // Random has no adult-theme age check; Flirty requires both partners to confirm 18+.
    const randomRoundId = await rpc(db, 'tod_start_round', ['random']);
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

    // Spicy needs both partners to meet 20+ and both still tap in for every new round.
    await assert.rejects(rpc(db, 'tod_start_round', ['spicy']), /both partners meet its age rule/i);
    await rpc(db, 'tod_confirm_age', [20]);
    await asUser(db, alice);
    await assert.rejects(rpc(db, 'tod_start_round', ['spicy']), /both partners meet its age rule/i);
    await rpc(db, 'tod_confirm_age', [20]);
    const spicyRoundId = await rpc(db, 'tod_start_round', ['spicy']);
    await rpc(db, 'tod_accept_round', [spicyRoundId]);
    assert.equal((await rpc(db, 'tod_state')).round.status, 'inviting', 'a Spicy round waits for both explicit opt-ins');
    await asUser(db, bob);
    await rpc(db, 'tod_accept_round', [spicyRoundId]);
    assert.equal((await rpc(db, 'tod_state')).round.status, 'active');
    await rpc(db, 'tod_end_round', [spicyRoundId]);

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
    await assert.rejects(rpc(db, 'tod_start_round', ['spicy']), /both partners meet its age rule/i);
    const flirtyRoundId = await rpc(db, 'tod_start_round', ['flirty']);
    assert.ok(flirtyRoundId);
  } finally {
    await db.close();
  }
});
