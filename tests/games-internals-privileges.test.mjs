import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const readSql = (relative) => readFile(new URL(relative, import.meta.url), 'utf8');

// A live Supabase project is not vanilla PostgreSQL: its default privileges grant
// EXECUTE on every newly created public function directly to anon and authenticated.
// The test backend creates those roles bare, so migrations whose REVOKE named only
// PUBLIC and anon looked locked down locally while every signed-in phone on the real
// project kept a direct grant on the Snake/Chess internals — and verify-games.sql
// failed with "The Snake internals must stay server-side: public.snake_commit(...)".
// This test recreates the Supabase privilege environment so it cannot regress.
test('games internals stay server-side under Supabase default privileges', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id UUID PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE SQL STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::UUID;
      $$;
      CREATE FUNCTION auth.role() RETURNS TEXT LANGUAGE SQL STABLE AS $$ SELECT current_user::TEXT; $$;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    `);
    await db.exec(await readSql('../supabase/schema.sql'));
    const verify = await readSql('../supabase/verify-games.sql');
    const repair = await readSql('../supabase/migrations/202610150012_lock_down_game_internals.sql');

    const privilege = async (role, fn) => (await db.query(
      `SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS allowed`, [role, fn],
    )).rows[0].allowed;
    const internals = [
      'public.snake_commit(uuid,integer,jsonb,boolean)', 'public.snake_sweep(uuid)',
      'public.snake_settle(uuid)', 'public.snake_view(jsonb,uuid,boolean,uuid,uuid)',
      'public.snake_max_ticks()', 'public.snake_budget(timestamptz)',
      'public.snake_replay(jsonb,jsonb,integer,integer)',
      'public.chess_legal(text[],text,integer,integer,integer,text)',
      'public.chess_view(jsonb)', 'public.chess_start_board()',
    ];
    const entryPoints = [
      'public.snake_start(uuid)', 'public.snake_beat(uuid,integer,jsonb)',
      'public.snake_finish(uuid,integer,jsonb)', 'public.snake_forfeit(uuid)',
      'public.start_chess(text)', 'public.chess_move(uuid,integer,text)',
    ];
    const assertLockedDown = async (when) => {
      for (const fn of internals) {
        assert.equal(await privilege('authenticated', fn), false, `${when}: authenticated must not execute ${fn}`);
        assert.equal(await privilege('anon', fn), false, `${when}: anon must not execute ${fn}`);
      }
      for (const fn of entryPoints) {
        assert.equal(await privilege('authenticated', fn), true, `${when}: the app still needs ${fn}`);
        assert.equal(await privilege('anon', fn), false, `${when}: anon must not execute ${fn}`);
      }
    };

    // A fresh project installed from schema.sql passes the preflight even with
    // Supabase's auto-grants in play, and the privilege matrix is exactly as designed.
    await db.exec(verify);
    await assertLockedDown('fresh schema');

    // Recreate the live-project state the old migrations left behind, and confirm
    // the verifier reports it with the user's exact error...
    await db.exec(`
      GRANT EXECUTE ON FUNCTION public.snake_commit(uuid,integer,jsonb,boolean) TO authenticated;
      GRANT EXECUTE ON FUNCTION public.chess_legal(text[],text,integer,integer,integer,text) TO authenticated;
    `);
    await assert.rejects(db.exec(verify), /The Snake internals must stay server-side: public\.snake_commit/,
      'the preflight names the exposed internal, as it did on the live project');
    await db.exec('ROLLBACK').catch(() => {});

    // ...then the repair migration locks it down again, changes nothing else, and
    // is safe to run twice.
    await db.exec(repair);
    await db.exec(verify);
    await assertLockedDown('after the repair migration');
    await db.exec(repair);
    await db.exec(verify);
  } finally {
    await db.close();
  }
});
