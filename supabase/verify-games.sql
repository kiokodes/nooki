-- Read-only Games preflight; run after verify.sql and migration 007.
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
END $$;
SELECT 'PASS: Games RPCs and secret-table permissions are configured. Test both devices before release.' AS result;
COMMIT;
