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
 FOREACH fn IN ARRAY ARRAY['public.games_state()','public.start_game(text,boolean,integer,text)','public.play_game(uuid,integer,text)'] LOOP
   IF to_regprocedure(fn) IS NULL THEN RAISE EXCEPTION 'Missing Games RPC: %',fn; END IF;
   IF NOT has_function_privilege('authenticated',fn,'EXECUTE') OR has_function_privilege('anon',fn,'EXECUTE') THEN
     RAISE EXCEPTION 'Unsafe Games RPC permissions: %',fn;
   END IF;
 END LOOP;

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
 -- able to settle someone else's duel or score a run without playing it.
 FOREACH fn IN ARRAY ARRAY['public.snake_commit(uuid,integer,jsonb,boolean)','public.snake_sweep(uuid)','public.snake_settle(uuid)','public.snake_view(jsonb,uuid,boolean,uuid,uuid)'] LOOP
   IF to_regprocedure(fn) IS NULL THEN RAISE EXCEPTION 'Missing the Snake internals: %',fn; END IF;
   IF has_function_privilege('authenticated',fn,'EXECUTE') OR has_function_privilege('anon',fn,'EXECUTE') THEN
     RAISE EXCEPTION 'The Snake internals must stay server-side: %',fn;
   END IF;
 END LOOP;

 -- The Tetris duel (migration 011): the same bargain as Snake, on a different board. The
 -- piece sequence is dealt here, the taps are checked here, and the score is replayed here.
 IF NOT EXISTS (
   SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='game_matches' AND column_name='tetris'
 ) THEN
   RAISE EXCEPTION 'Apply supabase/migrations/202610150011_tetris_duel.sql before deploying Tetris.';
 END IF;
 IF NOT EXISTS (
   SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='game_matches' AND column_name='tetris_mode'
 ) THEN
   RAISE EXCEPTION 'A Tetris duel is fixed to the mode it was started in: rerun migration 011.';
 END IF;
 IF NOT EXISTS (
   SELECT 1 FROM pg_constraint
    WHERE conrelid='public.game_matches'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%tetris%'
 ) THEN
   RAISE EXCEPTION 'The game_matches game check does not allow tetris: rerun migration 011.';
 END IF;
 IF to_regprocedure('public.tetris_replay(jsonb,jsonb,integer,integer)') IS NULL THEN
   RAISE EXCEPTION 'Missing the Tetris replay the score is derived from: apply migration 011.';
 END IF;
 FOREACH fn IN ARRAY ARRAY['public.tetris_start(uuid)','public.tetris_beat(uuid,integer,jsonb)','public.tetris_finish(uuid,integer,jsonb)','public.tetris_forfeit(uuid)'] LOOP
   IF to_regprocedure(fn) IS NULL THEN RAISE EXCEPTION 'Missing Tetris RPC: %',fn; END IF;
   IF NOT has_function_privilege('authenticated',fn,'EXECUTE') OR has_function_privilege('anon',fn,'EXECUTE') THEN
     RAISE EXCEPTION 'Unsafe Tetris RPC permissions: %',fn;
   END IF;
 END LOOP;
 FOREACH fn IN ARRAY ARRAY['public.tetris_commit(uuid,integer,jsonb,boolean)','public.tetris_sweep(uuid)','public.tetris_settle(uuid)','public.tetris_view(jsonb,uuid,boolean,uuid,uuid,text)'] LOOP
   IF to_regprocedure(fn) IS NULL THEN RAISE EXCEPTION 'Missing the Tetris internals: %',fn; END IF;
   IF has_function_privilege('authenticated',fn,'EXECUTE') OR has_function_privilege('anon',fn,'EXECUTE') THEN
     RAISE EXCEPTION 'The Tetris internals must stay server-side: %',fn;
   END IF;
 END LOOP;
END $$;
SELECT 'PASS: Games RPCs, the Snake and Tetris replays and secret-table permissions are configured. Test both devices before release.' AS result;
COMMIT;
