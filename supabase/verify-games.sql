-- Read-only Games preflight; run after verify.sql and migrations 007, 010 and 011.
BEGIN TRANSACTION READ ONLY;
DO $$
DECLARE fn text;
BEGIN
 IF to_regclass('public.game_matches') IS NULL THEN
   RAISE EXCEPTION 'Apply supabase/migrations/202610150007_games.sql before deploying Games.';
 END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.game_matches'::regclass)
 OR has_table_privilege('authenticated','public.game_matches','SELECT')
 OR has_table_privilege('authenticated','public.game_matches','UPDATE')
 OR has_table_privilege('anon','public.game_matches','SELECT') THEN
   RAISE EXCEPTION 'Game secrets must be private: rerun migration 007.';
 END IF;
 FOREACH fn IN ARRAY ARRAY['public.games_state()','public.start_game(text,boolean,integer)','public.play_game(uuid,integer,text)'] LOOP
   IF to_regprocedure(fn) IS NULL THEN RAISE EXCEPTION 'Missing Games RPC: %',fn; END IF;
   IF NOT has_function_privilege('authenticated',fn,'EXECUTE') OR has_function_privilege('anon',fn,'EXECUTE') THEN
     RAISE EXCEPTION 'Unsafe Games RPC permissions: %',fn;
   END IF;
 END LOOP;

 -- Rerunning 007 after 010 leaves the Snake tables/functions present, but replaces
 -- these two entry points with pre-Snake versions. Existence checks alone miss that:
 -- Duel gets "Invalid game settings" and games_state no longer seals Snake scores.
 IF position('''snake''' IN pg_get_functiondef('public.start_game(text,boolean,integer)'::regprocedure)) = 0 THEN
   RAISE EXCEPTION 'start_game does not support Snake Duel: rerun migration 010 after migration 007.';
 END IF;
 IF position('snake_view' IN pg_get_functiondef('public.games_state()'::regprocedure)) = 0
 OR position('snake_sweep' IN pg_get_functiondef('public.games_state()'::regprocedure)) = 0 THEN
   RAISE EXCEPTION 'games_state is the pre-Snake version: rerun migration 010 after migration 007 to restore sealed scores and expiry.';
 END IF;

 -- The Snake duel (migration 010). Its rules live in the database too: the food is dealt
 -- here, the run reports are checked here, and the score is replayed from them here.
 IF NOT EXISTS (
   SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='game_matches' AND column_name='snake'
 ) THEN
   RAISE EXCEPTION 'Apply supabase/migrations/202610150010_snake_duel.sql before deploying Snake.';
 END IF;
 IF NOT EXISTS (
   SELECT 1 FROM pg_constraint
    WHERE conrelid='public.game_matches'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%snake%'
 ) THEN
   RAISE EXCEPTION 'The game_matches game check does not allow snake: rerun migration 010.';
 END IF;
 IF to_regprocedure('public.snake_replay(jsonb,jsonb,integer,integer)') IS NULL THEN
   RAISE EXCEPTION 'Missing the Snake replay the score is derived from: apply migration 010.';
 END IF;
 FOREACH fn IN ARRAY ARRAY['public.snake_start(uuid)','public.snake_beat(uuid,integer,jsonb)','public.snake_finish(uuid,integer,jsonb)','public.snake_forfeit(uuid)'] LOOP
   IF to_regprocedure(fn) IS NULL THEN RAISE EXCEPTION 'Missing Snake RPC: %',fn; END IF;
   IF NOT has_function_privilege('authenticated',fn,'EXECUTE') OR has_function_privilege('anon',fn,'EXECUTE') THEN
     RAISE EXCEPTION 'Unsafe Snake RPC permissions: %',fn;
   END IF;
 END LOOP;
 -- The sweep, the settle and the replay are the server's own business: a phone must not be
 -- able to settle someone else's duel or score a run without playing it. Naming
 -- `authenticated` matters on a real Supabase project: its default privileges grant
 -- EXECUTE on new public functions directly to that role, so a revoke that only names
 -- PUBLIC and anon leaves these callable — which is the failure this check reports.
 FOREACH fn IN ARRAY ARRAY['public.snake_commit(uuid,integer,jsonb,boolean)','public.snake_sweep(uuid)','public.snake_settle(uuid)','public.snake_view(jsonb,uuid,boolean,uuid,uuid)','public.snake_max_ticks()','public.snake_budget(timestamptz)','public.snake_replay(jsonb,jsonb,integer,integer)'] LOOP
   IF to_regprocedure(fn) IS NULL THEN RAISE EXCEPTION 'Missing the Snake internals: %',fn; END IF;
   IF has_function_privilege('authenticated',fn,'EXECUTE') OR has_function_privilege('anon',fn,'EXECUTE') THEN
     RAISE EXCEPTION 'The Snake internals must stay server-side: %',fn;
   END IF;
 END LOOP;
 -- Chess (migration 011). Its rules live in the database too: chess_legal is the
 -- mirror of src/lib/chess.ts, and a phone may only name two squares.
 IF NOT EXISTS (
   SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='game_matches' AND column_name='chess'
 ) THEN
   RAISE EXCEPTION 'Apply supabase/migrations/202610150011_chess.sql before deploying Chess.';
 END IF;
 IF NOT EXISTS (
   SELECT 1 FROM pg_constraint
    WHERE conrelid='public.game_matches'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%chess%'
 ) THEN
   RAISE EXCEPTION 'The game_matches game check does not allow chess: rerun migration 011, or apply migration 202610150013_restore_chess_game_check.sql to restore just this check.';
 END IF;
 FOREACH fn IN ARRAY ARRAY['public.start_chess(text)','public.chess_move(uuid,integer,text)'] LOOP
   IF to_regprocedure(fn) IS NULL THEN RAISE EXCEPTION 'Missing Chess RPC: %',fn; END IF;
   IF NOT has_function_privilege('authenticated',fn,'EXECUTE') OR has_function_privilege('anon',fn,'EXECUTE') THEN
     RAISE EXCEPTION 'Unsafe Chess RPC permissions: %',fn;
   END IF;
 END LOOP;
 FOREACH fn IN ARRAY ARRAY['public.chess_attacked(text[],integer,text)','public.chess_pseudo(text[],text,integer,integer,integer)','public.chess_apply(text[],integer,integer,text,integer)','public.chess_legal(text[],text,integer,integer,integer,text)','public.chess_has_move(text[],text,integer,text)','public.chess_in_check(text[],text)','public.chess_view(jsonb)','public.chess_state_json(text)','public.chess_start_board()'] LOOP
   IF to_regprocedure(fn) IS NULL THEN RAISE EXCEPTION 'Missing the Chess internals: %',fn; END IF;
   IF has_function_privilege('authenticated',fn,'EXECUTE') OR has_function_privilege('anon',fn,'EXECUTE') THEN
     RAISE EXCEPTION 'The Chess internals must stay server-side: %',fn;
   END IF;
 END LOOP;
END $$;
SELECT 'PASS: Games RPCs, the Snake replay, the Chess referee and secret-table permissions are configured. Test both devices before release.' AS result;
COMMIT;
