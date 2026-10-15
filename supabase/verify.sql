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
  -- Discuss: the imported question library, its sessions, the sealed answers, the
  -- reactions and the 18+ consent both partners have to give.
  IF to_regclass('public.questions') IS NULL THEN
    RAISE EXCEPTION 'Missing questions table. Apply supabase/migrations/202610150004_discuss_questions.sql.';
  END IF;
  IF to_regclass('public.question_sessions') IS NULL THEN
    RAISE EXCEPTION 'Missing question_sessions table. Apply supabase/migrations/202610150004_discuss_questions.sql.';
  END IF;
  IF to_regclass('public.answers') IS NULL THEN
    RAISE EXCEPTION 'Missing answers table. Apply supabase/migrations/202610150004_discuss_questions.sql.';
  END IF;
  IF to_regclass('public.answer_reactions') IS NULL THEN
    RAISE EXCEPTION 'Missing answer_reactions table. Apply supabase/migrations/202610150004_discuss_questions.sql.';
  END IF;
  IF to_regclass('public.couple_settings') IS NULL THEN
    RAISE EXCEPTION 'Missing couple_settings table. Apply supabase/migrations/202610150004_discuss_questions.sql.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('questions', 'question_sessions', 'answers', 'answer_reactions', 'couple_settings')
      AND NOT c.relrowsecurity
  ) THEN RAISE EXCEPTION 'Row-level security must be enabled on the Discuss tables.'; END IF;
  -- The library is read-only for the app: only the owner (or a service-role import) writes it.
  IF NOT has_table_privilege('authenticated', 'public.questions', 'SELECT') THEN
    RAISE EXCEPTION 'Authenticated users need select on questions.';
  END IF;
  IF has_table_privilege('authenticated', 'public.questions', 'INSERT')
     OR has_table_privilege('authenticated', 'public.questions', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.questions', 'DELETE') THEN
    RAISE EXCEPTION 'The app must not be able to write to questions: the library is imported by the owner.';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.question_sessions', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.question_sessions', 'INSERT') THEN
    RAISE EXCEPTION 'Authenticated users need select and insert on question_sessions.';
  END IF;
  IF has_table_privilege('authenticated', 'public.question_sessions', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.question_sessions', 'DELETE') THEN
    RAISE EXCEPTION 'question_sessions progress belongs to its trigger, and one partner must not be able to delete a shared history.';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.answers', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.answers', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.answers', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.answer_reactions', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.answer_reactions', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.answer_reactions', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.couple_settings', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.couple_settings', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.couple_settings', 'UPDATE') THEN
    RAISE EXCEPTION 'Authenticated users need select, insert and update on answers, answer_reactions and couple_settings.';
  END IF;
  IF has_table_privilege('anon', 'public.questions', 'SELECT')
     OR has_table_privilege('anon', 'public.question_sessions', 'SELECT')
     OR has_table_privilege('anon', 'public.answers', 'SELECT')
     OR has_table_privilege('anon', 'public.answer_reactions', 'SELECT')
     OR has_table_privilege('anon', 'public.couple_settings', 'SELECT') THEN
    RAISE EXCEPTION 'Anonymous users must not be able to reach the Discuss tables.';
  END IF;
  FOREACH signature IN ARRAY ARRAY[
    'public.question_categories()', 'public.pick_question(text,integer)', 'public.ask_question(text)'
  ] LOOP
    IF to_regprocedure(signature) IS NULL THEN
      RAISE EXCEPTION 'Missing function %. Apply the Discuss migration.', signature;
    END IF;
    IF NOT has_function_privilege('authenticated', signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'Authenticated users cannot execute %.', signature;
    END IF;
    IF has_function_privilege('anon', signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'Anonymous users must not have access to %.', signature;
    END IF;
  END LOOP;
  -- The reveal rule and the 18+ gate live in these policies; the count catches a
  -- half-applied migration rather than trusting any one of them.
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND (
    (tablename = 'questions' AND policyname = 'Signed-in users can browse the question library')
    OR (tablename = 'question_sessions' AND policyname IN (
      'Couple members can view their question sessions', 'Couple members can ask their partner a question'))
    OR (tablename = 'answers' AND policyname IN (
      'Couple members can view answers', 'Couple members can answer a question',
      'Users can edit their own answer before the reveal'))
    OR (tablename = 'answer_reactions' AND policyname IN (
      'Couple members can view reactions', 'Couple members can react to a reveal',
      'Users can change their own reaction'))
    OR (tablename = 'couple_settings' AND policyname IN (
      'Couple members can view their question settings', 'Users can save their own question settings',
      'Users can change their own question settings'))
  )) <> 12 THEN RAISE EXCEPTION 'Required Discuss RLS policies are missing. Rerun supabase/migrations/202610150004_discuss_questions.sql.'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.answers'::regclass
    AND tgname = 'answers_sync_session_progress' AND tgenabled = 'O'
  ) THEN RAISE EXCEPTION 'Missing answers progress trigger: a session would never reveal. Apply the Discuss migration.'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.answers'::regclass
    AND tgname = 'answers_guard_payload' AND tgenabled = 'O'
  ) THEN RAISE EXCEPTION 'Missing answers payload trigger. Apply the Discuss migration.'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.questions'::regclass
    AND tgname = 'questions_normalize_row' AND tgenabled = 'O'
  ) THEN RAISE EXCEPTION 'Missing question normalising trigger: a CSV import would not be canonicalised. Apply the Discuss migration.'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.question_sessions'::regclass
    AND tgname = 'question_sessions_guard' AND tgenabled = 'O'
  ) THEN RAISE EXCEPTION 'Missing question_sessions guard trigger. Apply the Discuss migration.'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.answer_reactions'::regclass
    AND tgname = 'answer_reactions_guard' AND tgenabled = 'O'
  ) THEN RAISE EXCEPTION 'Missing answer_reactions guard trigger. Apply the Discuss migration.'; END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conname IN (
    'questions_seriousness_check', 'questions_input_type_check', 'questions_options_shape',
    'answers_shape_check', 'answer_reactions_reaction_check'
  )) <> 5 THEN RAISE EXCEPTION 'Required Discuss column checks are missing. Rerun the Discuss migration.'; END IF;
  IF (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
    'question_sessions_couple_question', 'answers_session_user', 'answer_reactions_session_user'
  )) <> 3 THEN RAISE EXCEPTION 'Required Discuss unique indexes are missing: one session per question, and one answer and reaction per partner. Rerun the Discuss migration.'; END IF;
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND (SELECT count(*) FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename IN ('question_sessions', 'answers', 'answer_reactions')) <> 3 THEN
    RAISE EXCEPTION 'The Discuss tables are not all in the supabase_realtime publication, so a reveal will not arrive live. Rerun supabase/migrations/202610150004_discuss_questions.sql.';
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
SELECT 'PASS: required functions, pairing permissions, RLS, anniversary trigger, couple_events calendar, realtime messages and the Discuss question tables are present. Still complete the two-device acceptance test.' AS result;
COMMIT;
