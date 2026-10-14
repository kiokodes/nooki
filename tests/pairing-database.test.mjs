import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const alice = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
const third = '00000000-0000-4000-8000-000000000003';
const noProfile = '00000000-0000-4000-8000-000000000004';

test('database pairing, anniversary locks, cancellation and RLS', async () => {
  const db = new PGlite();
  try {
    // Simulate the Supabase auth schema/roles without accessing a real project.
    await db.exec(`
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE anon NOLOGIN;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id UUID PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE SQL STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$;
      CREATE FUNCTION auth.role() RETURNS TEXT LANGUAGE SQL STABLE AS $$ SELECT current_user::TEXT; $$;
    `);
    const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
    const migration = await readFile(new URL('../supabase/migrations/202610150001_pairing_flow.sql', import.meta.url), 'utf8');
    await db.exec(schema);
    await db.exec(`
      GRANT USAGE ON SCHEMA public, auth TO authenticated, anon;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles, public.couples TO authenticated;
      INSERT INTO auth.users VALUES ('${alice}'), ('${bob}'), ('${third}'), ('${noProfile}');
      INSERT INTO public.profiles (id, name) VALUES ('${alice}', 'Alice'), ('${bob}', 'Bob'), ('${third}', 'Third');
    `);
    const asUser = async (id) => {
      await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [id || '']);
      await db.exec('SET ROLE authenticated');
    };
    const rpc = async (name, args = []) => {
      const placeholders = args.map((_, i) => `$${i + 1}`).join(',');
      return (await db.query(`SELECT public.${name}(${placeholders}) AS result`, args)).rows[0].result;
    };
    await asUser(alice);
    const created = await rpc('create_couple', ['2020-02-14']);
    assert.equal(created.success, true);
    const initial = (await db.query('SELECT * FROM public.couples')).rows[0];
    assert.match(initial.invite_code, /^[A-Z0-9]{6}$/);
    assert.equal((await db.query('SELECT couple_id FROM public.profiles')).rows[0].couple_id, created.couple_id);
    assert.equal((await rpc('update_pending_anniversary', ['2021-03-15'])).success, true);
    // Migration is safe to apply to a populated project and rerun.
    await db.exec('RESET ROLE');
    await db.exec(migration);
    await db.exec(migration);
    await asUser(alice);
    assert.equal((await db.query('SELECT invite_code FROM public.couples')).rows[0].invite_code, initial.invite_code);
    assert.equal((await rpc('create_couple', ['2020-01-01'])).success, false);

    await asUser(bob);
    assert.equal((await db.query('SELECT * FROM public.couples')).rows.length, 0, 'unpaired users cannot read invite codes');
    await assert.rejects(db.query('UPDATE public.profiles SET couple_id = $1 WHERE id = $2', [created.couple_id, bob]), /row-level security/);
    assert.equal((await rpc('join_couple', ['BAD'])).success, false);
    const joined = await rpc('join_couple', [` ${initial.invite_code.toLowerCase().slice(0, 3)} ${initial.invite_code.toLowerCase().slice(3)} `]);
    assert.equal(joined.success, true);
    assert.equal(joined.couple_id, created.couple_id);
    assert.equal((await rpc('join_couple', [initial.invite_code])).success, true, 'retry is idempotent');
    assert.equal((await db.query('SELECT * FROM public.profiles')).rows.length, 2, 'both partners visible after join');
    assert.equal((await rpc('update_pending_anniversary', ['2022-01-01'])).success, false);
    await assert.rejects(db.query('UPDATE public.couples SET anniversary_date = $1 WHERE id = $2', ['2022-01-01', created.couple_id]), /anniversary is locked/);
    assert.equal((await rpc('leave_pending_couple')).success, false, 'paired couples cannot be cancelled unilaterally');
    await asUser(third);
    assert.equal((await rpc('join_couple', [initial.invite_code])).success, false, 'third partner rejected');

    const pending = await rpc('create_couple', ['2023-04-05']);
    const pendingCode = (await db.query('SELECT invite_code FROM public.couples')).rows[0].invite_code;
    assert.equal(pending.success, true);
    assert.equal((await rpc('leave_pending_couple')).success, true);
    assert.equal((await db.query('SELECT couple_id FROM public.profiles')).rows[0].couple_id, null);
    assert.equal((await rpc('join_couple', [pendingCode])).success, false, 'cancelled invite revoked');
    assert.equal((await rpc('create_couple', ['2024-05-06'])).success, true, 'creator can start again');

    await asUser(noProfile);
    assert.equal((await rpc('join_couple', [initial.invite_code])).success, false);
    assert.equal((await rpc('create_couple', ['2020-01-01'])).success, false);
    await asUser(null);
    assert.equal((await rpc('join_couple', [initial.invite_code])).success, false);
    await db.exec('SET ROLE anon');
    await assert.rejects(rpc('join_couple', [initial.invite_code]), /permission denied/);
    await db.exec('RESET ROLE');
    const verification = await readFile(new URL('../supabase/verify.sql', import.meta.url), 'utf8');
    await db.exec(verification);
  } finally {
    await db.close();
  }
});
