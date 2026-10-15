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
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'Missing messages table. Apply supabase/migrations/202610150003_messages.sql.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN ('profiles', 'couples', 'couple_events', 'messages') AND NOT c.relrowsecurity
  ) THEN RAISE EXCEPTION 'Row-level security must be enabled on profiles, couples, couple_events and messages.'; END IF;

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
  IF has_table_privilege('anon', 'public.profiles', 'SELECT')
     OR has_table_privilege('anon', 'public.couples', 'SELECT') THEN
    RAISE EXCEPTION 'Anonymous users must not be able to read profiles or couples. Rerun the pairing migration.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'couple_events' AND column_name = 'repeat_frequency'
  ) THEN RAISE EXCEPTION 'couple_events.repeat_frequency is missing. Rerun supabase/migrations/202610150002_couple_events.sql.'; END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'couple_events' AND column_name = 'repeats_yearly'
  ) THEN RAISE EXCEPTION 'couple_events still has the old repeats_yearly column. Rerun supabase/migrations/202610150002_couple_events.sql.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'couple_events_repeat_frequency_check') THEN
    RAISE EXCEPTION 'couple_events.repeat_frequency is missing its allowed-values check. Rerun the calendar migration.';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'couple_events' AND (
    policyname IN ('Couple members can view their events', 'Couple members can add events',
                   'Couple members can edit their events', 'Couple members can delete their events')
  )) <> 4 THEN RAISE EXCEPTION 'Required couple_events RLS policies are missing.'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.couple_events'::regclass
    AND tgname = 'couple_events_set_updated_at' AND tgenabled = 'O'
  ) THEN RAISE EXCEPTION 'Missing couple_events updated_at trigger. Apply the calendar migration.'; END IF;
  -- Chat: table permissions, RLS policies, the message-type check, immutability and Realtime.
  IF NOT has_table_privilege('authenticated', 'public.messages', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.messages', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.messages', 'UPDATE') THEN
    RAISE EXCEPTION 'Authenticated users need select, insert and update on messages.';
  END IF;
  IF has_table_privilege('anon', 'public.messages', 'SELECT')
     OR has_table_privilege('anon', 'public.messages', 'INSERT') THEN
    RAISE EXCEPTION 'Anonymous users must not be able to read or write messages.';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'messages' AND (
    policyname IN ('Couple members can read their messages', 'Couple members can send messages',
                   'Couple members can mark messages read')
  )) <> 3 THEN RAISE EXCEPTION 'Required messages RLS policies are missing. Rerun supabase/migrations/202610150003_messages.sql.'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'type'
  ) THEN RAISE EXCEPTION 'messages.type is missing. Rerun supabase/migrations/202610150003_messages.sql.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_type_check') THEN
    RAISE EXCEPTION 'messages.type is missing its text/question/answer/system check. Rerun the chat migration.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.messages'::regclass
    AND tgname = 'messages_guard_immutable' AND tgenabled = 'O'
  ) THEN RAISE EXCEPTION 'Missing messages immutability trigger. Apply the chat migration.'; END IF;
  -- Postgres Changes is the transport for instant messages. Only checked when the
  -- project has the Realtime publication at all.
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'messages'
     ) THEN
    RAISE EXCEPTION 'messages is not in the supabase_realtime publication, so chat will not update live. Rerun supabase/migrations/202610150003_messages.sql.';
  END IF;
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
SELECT 'PASS: required functions, pairing permissions, RLS, anniversary trigger, couple_events calendar and realtime messages are present. Still complete the two-device acceptance test.' AS result;
COMMIT;
