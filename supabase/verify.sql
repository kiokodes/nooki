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
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN ('profiles', 'couples') AND NOT c.relrowsecurity
  ) THEN RAISE EXCEPTION 'Row-level security must be enabled on profiles and couples.'; END IF;

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
SELECT 'PASS: required functions, pairing permissions, RLS and anniversary trigger are present. Still complete the two-device acceptance test.' AS result;
COMMIT;
