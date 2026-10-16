-- Lock down the Snake, Chess and Tetris internals on projects that already ran
-- 010, 011 or 012 (this file was renumbered from 012 to 013 when the Tetris duel
-- took 012; the contents grew to cover Tetris as well).
--
-- Why this exists: a real Supabase project carries default privileges that grant
-- EXECUTE on every newly created public function directly to the API roles
-- (anon, authenticated, service_role). Migrations 010, 011 and 012 revoked EXECUTE
-- only `FROM PUBLIC, anon`, never naming authenticated — so on a live project every
-- signed-in phone kept a direct grant on the server-side internals and
-- verify-games.sql quite correctly refuses to pass:
--
--   ERROR: P0001: The Snake internals must stay server-side:
--   public.snake_commit(uuid,integer,jsonb,boolean)
--
-- (The Chess referee and Tetris helpers have the same exposure; the verifier simply
-- reaches the Snake names first.) Vanilla PostgreSQL has no such default privileges,
-- which is why the migration tests never reproduced this.
--
-- This file changes privileges only: it creates and alters no function, table or
-- row, so it is safe on a project with couples and saved matches, safe before or
-- after any duel has been played, and safe to run more than once. A function whose
-- migration has not been applied yet is simply skipped. Run it, then rerun
-- supabase/verify-games.sql and require PASS.
BEGIN;

DO $$
DECLARE fn text;
BEGIN
  -- Server-side only: the score replay and its helpers, the run commit the public
  -- wrappers funnel into, the settle/sweep, the sealed snapshot, and the whole
  -- chess referee. These are reached through the SECURITY DEFINER entry points
  -- below, which execute as their owner and never needed the phone's grant.
  FOREACH fn IN ARRAY ARRAY[
    'public.snake_max_ticks()', 'public.snake_budget(timestamptz)',
    'public.snake_replay(jsonb,jsonb,integer,integer)',
    'public.snake_commit(uuid,integer,jsonb,boolean)',
    'public.snake_sweep(uuid)', 'public.snake_settle(uuid)',
    'public.snake_view(jsonb,uuid,boolean,uuid,uuid)',
    'public.chess_start_board()', 'public.chess_attacked(text[],integer,text)',
    'public.chess_pseudo(text[],text,integer,integer,integer)',
    'public.chess_apply(text[],integer,integer,text,integer)',
    'public.chess_legal(text[],text,integer,integer,integer,text)',
    'public.chess_has_move(text[],text,integer,text)',
    'public.chess_in_check(text[],text)', 'public.chess_view(jsonb)',
    'public.chess_state_json(text)',
    'public.tetris_max_ticks()', 'public.tetris_budget(timestamptz)',
    'public.tetris_replay(jsonb,jsonb,integer,integer)',
    'public.tetris_commit(uuid,integer,jsonb,boolean)',
    'public.tetris_sweep(uuid)', 'public.tetris_settle(uuid)',
    'public.tetris_view(jsonb,uuid,boolean,uuid,uuid,text)'
  ] LOOP
    IF to_regprocedure(fn) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    END IF;
  END LOOP;

  -- The entry points a phone is meant to call keep (or regain) their grant, so this
  -- repair can never lock the app out of its own games.
  FOREACH fn IN ARRAY ARRAY[
    'public.snake_start(uuid)', 'public.snake_beat(uuid,integer,jsonb)',
    'public.snake_finish(uuid,integer,jsonb)', 'public.snake_forfeit(uuid)',
    'public.start_chess(text)', 'public.chess_move(uuid,integer,text)',
    'public.start_tetris(text)', 'public.tetris_start(uuid)',
    'public.tetris_beat(uuid,integer,jsonb)',
    'public.tetris_finish(uuid,integer,jsonb)', 'public.tetris_forfeit(uuid)'
  ] LOOP
    IF to_regprocedure(fn) IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    END IF;
  END LOOP;
END $$;

COMMIT;
