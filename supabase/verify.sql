-- Read-only deployment preflight: run in the same live project's SQL Editor.
-- This does not create users, seed data, change couples, or contact Auth providers.
BEGIN TRANSACTION READ ONLY;
DO $$
DECLARE
  signature TEXT;
BEGIN
  IF to_regclass('public.profiles') IS NULL OR to_regclass('public.couples') IS NULL THEN
    RAISE EXCEPTION 'Missing profiles/couples tables. Apply the schema to a new project first.';
  END IF;
  IF to_regclass('public.couple_events') IS NULL THEN
    RAISE EXCEPTION 'Missing couple_events table. Apply supabase/migrations/202610150002_couple_events.sql.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN ('profiles', 'couples', 'couple_events') AND NOT c.relrowsecurity
  ) THEN RAISE EXCEPTION 'Row-level security must be enabled on profiles, couples and couple_events.'; END IF;

  FOREACH signature IN ARRAY ARRAY[
    'public.create_couple(date)', 'public.join_couple(text)',
    'public.leave_pending_couple()', 'public.update_pending_anniversary(date)',
    'public.request_or_confirm_breakup()', 'public.cancel_breakup_request()'
  ] LOOP
    IF to_regprocedure(signature) IS NULL THEN
      RAISE EXCEPTION 'Missing function %. Apply the required database migration.', signature;
    END IF;
    IF NOT has_function_privilege('authenticated', signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'Authenticated users cannot execute %.', signature;
    END IF;
  END LOOP;
  FOREACH signature IN ARRAY ARRAY[
    'public.create_couple(date)', 'public.join_couple(text)',
    'public.leave_pending_couple()', 'public.update_pending_anniversary(date)'
  ] LOOP
    IF has_function_privilege('anon', signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'Anonymous users must not have access to %.', signature;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.couples'::regclass
    AND tgname = 'guard_paired_anniversary' AND tgenabled = 'O'
  ) THEN RAISE EXCEPTION 'Missing anniversary lock trigger. Apply the pairing migration.'; END IF;
  IF NOT has_table_privilege('authenticated', 'public.couple_events', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.couple_events', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.couple_events', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.couple_events', 'DELETE') THEN
    RAISE EXCEPTION 'Authenticated users need select, insert, update and delete on couple_events.';
  END IF;
  IF has_table_privilege('anon', 'public.couple_events', 'SELECT') THEN
    RAISE EXCEPTION 'Anonymous users must not be able to read couple_events.';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'couple_events' AND (
    policyname IN ('Couple members can view their events', 'Couple members can add events',
                   'Couple members can edit their events', 'Couple members can delete their events')
  )) <> 4 THEN RAISE EXCEPTION 'Required couple_events RLS policies are missing.'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.couple_events'::regclass
    AND tgname = 'couple_events_set_updated_at' AND tgenabled = 'O'
  ) THEN RAISE EXCEPTION 'Missing couple_events updated_at trigger. Apply the calendar migration.'; END IF;
  IF NOT has_table_privilege('authenticated', 'public.profiles', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.profiles', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.couples', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.couples', 'UPDATE') THEN
    RAISE EXCEPTION 'Authenticated users need profile and couple table permissions.';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND (
    (tablename = 'profiles' AND policyname IN ('Users can view own profile or partner profile', 'Users can insert own profile', 'Users can update own profile'))
    OR (tablename = 'couples' AND policyname IN ('Users can view own couple or query invite code', 'Users can update own couple'))
  )) <> 5 THEN RAISE EXCEPTION 'Required profile/couple RLS policies are missing.'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'couples'
    AND policyname = 'Authenticated users can create couples'
  ) THEN RAISE EXCEPTION 'Old couple creation policy is still active. Apply the pairing migration.'; END IF;
END;
$$;
SELECT 'PASS: required functions, pairing permissions, RLS, anniversary trigger and couple_events calendar are present. Still complete the two-device acceptance test.' AS result;
COMMIT;
