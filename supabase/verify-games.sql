-- Read-only Games preflight; run after verify.sql and the Games migrations, including
-- 202610180002_remove_daily_games_and_tic_tac_toe.sql.
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
 FOREACH fn IN ARRAY ARRAY['public.games_state()','public.start_game(text,integer)','public.play_game(uuid,integer,text)'] LOOP
   IF to_regprocedure(fn) IS NULL THEN RAISE EXCEPTION 'Missing Games RPC: %',fn; END IF;
   IF NOT has_function_privilege('authenticated',fn,'EXECUTE') OR has_function_privilege('anon',fn,'EXECUTE') THEN
     RAISE EXCEPTION 'Unsafe Games RPC permissions: %',fn;
   END IF;
 END LOOP;

 -- The retirement migration owns the public entry point now: it must retain Snake while
 -- exposing neither a daily flag nor the retired game/date fields.
 IF position('''snake''' IN pg_get_functiondef('public.start_game(text,integer)'::regprocedure)) = 0 THEN
   RAISE EXCEPTION 'start_game does not support Snake Duel: apply migration 202610180002 after the Games migrations.';
 END IF;
 IF to_regprocedure('public.start_game(text,boolean,integer)') IS NOT NULL
    OR position('daily_date' IN pg_get_functiondef('public.games_state()'::regprocedure)) > 0
    OR position('tic-tac-toe' IN pg_get_functiondef('public.games_state()'::regprocedure)) > 0 THEN
   RAISE EXCEPTION 'Daily Games or Tic Tac Toe are still installed: apply migration 202610180002_remove_daily_games_and_tic_tac_toe.sql.';
 END IF;
 IF position('snake_view' IN pg_get_functiondef('public.games_state()'::regprocedure)) = 0
 OR position('snake_sweep' IN pg_get_functiondef('public.games_state()'::regprocedure)) = 0 THEN
   RAISE EXCEPTION 'games_state is missing the Snake snapshot or expiry sweep: apply the current Games migrations.';
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
   RAISE EXCEPTION 'The game_matches game check does not allow chess: rerun migration 011, or apply migration 202610150014_restore_chess_tetris_game_check.sql to restore just this check.';
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

 -- The Tetris duel (migration 012): the same bargain as Snake, on a different board. The
 -- piece sequence is dealt here, the taps are checked here, and the score is replayed here.
 IF NOT EXISTS (
   SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='game_matches' AND column_name='tetris'
 ) THEN
   RAISE EXCEPTION 'Apply supabase/migrations/202610150012_tetris_duel.sql before deploying Tetris.';
 END IF;
 IF NOT EXISTS (
   SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='game_matches' AND column_name='tetris_mode'
 ) THEN
   RAISE EXCEPTION 'A Tetris duel is fixed to the mode it was started in: rerun migration 012.';
 END IF;
 IF NOT EXISTS (
   SELECT 1 FROM pg_constraint
    WHERE conrelid='public.game_matches'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%tetris%'
 ) THEN
   RAISE EXCEPTION 'The game_matches game check does not allow tetris: rerun migration 012, or apply migration 202610150014_restore_chess_tetris_game_check.sql to restore just this check.';
 END IF;
 IF to_regprocedure('public.tetris_replay(jsonb,jsonb,integer,integer)') IS NULL THEN
   RAISE EXCEPTION 'Missing the Tetris replay the score is derived from: apply migration 012.';
 END IF;
 FOREACH fn IN ARRAY ARRAY['public.start_tetris(text)','public.tetris_start(uuid)','public.tetris_beat(uuid,integer,jsonb)','public.tetris_finish(uuid,integer,jsonb)','public.tetris_forfeit(uuid)'] LOOP
   IF to_regprocedure(fn) IS NULL THEN RAISE EXCEPTION 'Missing Tetris RPC: %',fn; END IF;
   IF NOT has_function_privilege('authenticated',fn,'EXECUTE') OR has_function_privilege('anon',fn,'EXECUTE') THEN
     RAISE EXCEPTION 'Unsafe Tetris RPC permissions: %',fn;
   END IF;
 END LOOP;
 FOREACH fn IN ARRAY ARRAY['public.tetris_commit(uuid,integer,jsonb,boolean)','public.tetris_sweep(uuid)','public.tetris_settle(uuid)','public.tetris_view(jsonb,uuid,boolean,uuid,uuid,text)','public.tetris_max_ticks()','public.tetris_budget(timestamptz)','public.tetris_replay(jsonb,jsonb,integer,integer)'] LOOP
   IF to_regprocedure(fn) IS NULL THEN RAISE EXCEPTION 'Missing the Tetris internals: %',fn; END IF;
   IF has_function_privilege('authenticated',fn,'EXECUTE') OR has_function_privilege('anon',fn,'EXECUTE') THEN
     RAISE EXCEPTION 'The Tetris internals must stay server-side: %',fn;
   END IF;
 END LOOP;
 -- Connect Four: moves and winning lines are calculated under the match row lock.
 IF NOT EXISTS (
   SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='game_matches' AND column_name='board'
 ) THEN RAISE EXCEPTION 'Apply supabase/migrations/202610180006_connect_four.sql before deploying Connect Four.'; END IF;
 IF NOT EXISTS (
   SELECT 1 FROM pg_constraint WHERE conrelid='public.game_matches'::regclass AND contype='c'
     AND pg_get_constraintdef(oid) LIKE '%connect-four%'
 ) THEN RAISE EXCEPTION 'The game_matches game check does not allow Connect Four: apply migration 202610180006_connect_four.sql.'; END IF;
 FOREACH fn IN ARRAY ARRAY['public.start_connect_four()','public.connect_four_move(uuid,integer,integer)'] LOOP
   IF to_regprocedure(fn) IS NULL THEN RAISE EXCEPTION 'Missing Connect Four RPC: %',fn; END IF;
   IF NOT has_function_privilege('authenticated',fn,'EXECUTE') OR has_function_privilege('anon',fn,'EXECUTE') THEN
     RAISE EXCEPTION 'Unsafe Connect Four RPC permissions: %',fn;
   END IF;
 END LOOP;

 -- Dash Duel: one server-dealt Lagos route, three lanes, and database-replayed runs.
 IF NOT EXISTS (
   SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='game_matches' AND column_name='dash'
 ) THEN RAISE EXCEPTION 'Apply supabase/migrations/202610180009_dash_duel.sql before deploying Dash Duel.'; END IF;
 IF NOT EXISTS (
   SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='game_matches' AND column_name='dash_mode'
 ) OR NOT EXISTS (
   SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='game_matches' AND column_name='dash_level'
 ) THEN RAISE EXCEPTION 'Dash Duel needs its mode and first-player course level: rerun migration 202610180009_dash_duel.sql.'; END IF;
 IF NOT EXISTS (
   SELECT 1 FROM pg_constraint WHERE conrelid='public.game_matches'::regclass AND contype='c'
     AND pg_get_constraintdef(oid) LIKE '%dash-duel%'
 ) THEN RAISE EXCEPTION 'The game_matches game check does not allow Dash Duel: apply migration 202610180009_dash_duel.sql.'; END IF;
 IF to_regprocedure('public.dash_replay(jsonb,jsonb,integer,integer)') IS NULL THEN
   RAISE EXCEPTION 'Missing the Dash replay that derives distance and hearts: apply migration 202610180009_dash_duel.sql.';
 END IF;
 IF to_regprocedure('public.dash_tick_duration(integer)') IS NULL
    OR to_regprocedure('public.dash_elapsed_ms(integer)') IS NULL THEN
   RAISE EXCEPTION 'Dash Duel needs its dodge-only speed ramp: apply supabase/migrations/202610190002_dash_duel_dodge_speed.sql.';
 END IF;
 IF position('jumpable' IN pg_get_functiondef('public.dash_deal_course(text)'::regprocedure)) > 0 THEN
   RAISE EXCEPTION 'Dash Duel is still dealing jumpable barriers: apply supabase/migrations/202610190002_dash_duel_dodge_speed.sql.';
 END IF;
 IF position('dash_view' IN pg_get_functiondef('public.games_state()'::regprocedure)) = 0
    OR position('dash_sweep' IN pg_get_functiondef('public.games_state()'::regprocedure)) = 0 THEN
   RAISE EXCEPTION 'games_state is missing the Dash snapshot or seven-day expiry sweep: rerun migration 202610180009_dash_duel.sql.';
 END IF;
 FOREACH fn IN ARRAY ARRAY['public.start_dash(text,text)','public.dash_start(uuid)','public.dash_beat(uuid,integer,jsonb)','public.dash_finish(uuid,integer,jsonb)','public.dash_forfeit(uuid)'] LOOP
   IF to_regprocedure(fn) IS NULL THEN RAISE EXCEPTION 'Missing Dash Duel RPC: %',fn; END IF;
   IF NOT has_function_privilege('authenticated',fn,'EXECUTE') OR has_function_privilege('anon',fn,'EXECUTE') THEN
     RAISE EXCEPTION 'Unsafe Dash Duel RPC permissions: %',fn;
   END IF;
 END LOOP;
 FOREACH fn IN ARRAY ARRAY['public.dash_tick_duration(integer)','public.dash_elapsed_ms(integer)',
   'public.dash_max_ticks()','public.dash_budget(timestamptz)','public.dash_deal_course(text)',
   'public.dash_replay(jsonb,jsonb,integer,integer)','public.dash_settle(uuid)','public.dash_sweep(uuid)',
   'public.dash_commit(uuid,integer,jsonb,boolean)','public.dash_view(jsonb,uuid,boolean,uuid,uuid,text,text)'] LOOP
   IF to_regprocedure(fn) IS NULL THEN RAISE EXCEPTION 'Missing Dash Duel internals: %',fn; END IF;
   IF has_function_privilege('authenticated',fn,'EXECUTE') OR has_function_privilege('anon',fn,'EXECUTE') THEN
     RAISE EXCEPTION 'Dash Duel internals must stay server-side: %',fn;
   END IF;
 END LOOP;

 -- Word Wheel: a pregenerated puzzle bank, one shared round and server-counted words.
 FOREACH fn IN ARRAY ARRAY['public.word_puzzles','public.word_rounds','public.word_round_results'] LOOP
   IF to_regclass(fn) IS NULL THEN
     RAISE EXCEPTION 'Apply supabase/migrations/202610190001_word_wheel.sql before deploying Word Wheel.';
   END IF;
   IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = fn::regclass)
      OR has_table_privilege('authenticated', fn, 'SELECT')
      OR has_table_privilege('anon', fn, 'SELECT') THEN
     RAISE EXCEPTION 'Word Wheel tables must stay private: rerun migration 202610190001_word_wheel.sql.';
   END IF;
 END LOOP;
 IF NOT EXISTS (
   SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='word_one_open_round'
 ) THEN RAISE EXCEPTION 'Word Wheel needs a single open round per couple: rerun migration 202610190001_word_wheel.sql.'; END IF;
 IF NOT EXISTS (
   SELECT 1 FROM information_schema.columns WHERE table_schema='public'
     AND table_name='word_round_results' AND column_name='started_at'
 ) THEN RAISE EXCEPTION 'Word Wheel needs independent attempt clocks: apply migration 202610190003_word_wheel_async_practice.sql.'; END IF;
 IF to_regprocedure('public.word_start(uuid)') IS NULL
    OR position('started_at' IN pg_get_functiondef('public.word_view(public.word_rounds,uuid)'::regprocedure)) = 0
    OR position('started_at' IN pg_get_functiondef('public.word_submit(uuid,text[],integer)'::regprocedure)) = 0
    OR position('started_at' IN pg_get_functiondef('public.word_sweep(uuid)'::regprocedure)) = 0 THEN
   RAISE EXCEPTION 'Word Wheel needs independent attempt clocks: apply migration 202610190003_word_wheel_async_practice.sql.';
 END IF;
 IF position('word_view' IN pg_get_functiondef('public.games_state()'::regprocedure)) = 0
    OR position('word_sweep' IN pg_get_functiondef('public.games_state()'::regprocedure)) = 0 THEN
   RAISE EXCEPTION 'games_state is missing the Word Wheel snapshot or grace-window sweep: rerun migration 202610190001_word_wheel.sql.';
 END IF;
 FOREACH fn IN ARRAY ARRAY['public.start_word_round(text,integer)','public.word_start(uuid)','public.word_ready(uuid)',
   'public.word_submit(uuid,text[],integer)','public.word_cancel(uuid)'] LOOP
   IF to_regprocedure(fn) IS NULL THEN RAISE EXCEPTION 'Missing Word Wheel RPC: %',fn; END IF;
   IF NOT has_function_privilege('authenticated',fn,'EXECUTE') OR has_function_privilege('anon',fn,'EXECUTE') THEN
     RAISE EXCEPTION 'Unsafe Word Wheel RPC permissions: %',fn;
   END IF;
 END LOOP;
 FOREACH fn IN ARRAY ARRAY['public.word_layout(text[])','public.word_view(public.word_rounds,uuid)',
   'public.word_settle(uuid)','public.word_sweep(uuid)'] LOOP
   IF to_regprocedure(fn) IS NULL THEN RAISE EXCEPTION 'Missing Word Wheel internals: %',fn; END IF;
   IF has_function_privilege('authenticated',fn,'EXECUTE') OR has_function_privilege('anon',fn,'EXECUTE') THEN
     RAISE EXCEPTION 'Word Wheel internals must stay server-side: %',fn;
   END IF;
 END LOOP;
END $$;
SELECT 'PASS: always-available Games RPCs, server-refereed Connect Four, Dash Duel and Word Wheel, the Snake and Tetris replays, the Chess referee and secret-table permissions are configured. Test both devices before release.' AS result;
COMMIT;
