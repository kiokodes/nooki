-- Retire Read together. The Together tab no longer has a shared shelf, a reader,
-- or a highlight-to-chat bridge. Book files, shelf rows, saved places and margin
-- notes are removed rather than left unreachable. A chat message that quoted a
-- passage keeps its own words (they were stored on the message); only the link
-- back into a book goes away. Together time can only schedule a game.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.together_time_sessions') IS NULL
     OR to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'Apply the Together tab and chat migrations before 202610190006_remove_shared_books.sql.';
  END IF;
END $$;

-- A book date has nothing left to open. Drop it before the activity check tightens.
DELETE FROM public.together_time_sessions WHERE activity_type = 'book';

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'together_time_sessions'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%activity_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.together_time_sessions DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE public.together_time_sessions
  DROP CONSTRAINT IF EXISTS together_time_sessions_activity_type_check;
ALTER TABLE public.together_time_sessions
  ADD CONSTRAINT together_time_sessions_activity_type_check
  CHECK (activity_type = 'game');

-- The agreement rules stay. The only change is that a book is no longer a valid activity.
CREATE OR REPLACE FUNCTION public.guard_together_time_session()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE
  actor UUID := auth.uid();
  plan_changed BOOLEAN;
BEGIN
  IF NEW.activity_type IS DISTINCT FROM 'game' THEN
    RAISE EXCEPTION 'Choose a game to play together.';
  END IF;
  IF NEW.activity_id NOT IN (
    'rock-paper-scissors', 'snake', 'chess', 'sudoku', 'tetris',
    'connect-four', 'dash-duel', 'word-wheel'
  ) THEN
    RAISE EXCEPTION 'Choose one of the games in Nooki.';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF actor IS NOT NULL THEN
      IF NEW.status <> 'proposed' THEN
        RAISE EXCEPTION 'A Together time starts as a suggestion. It locks in when your partner agrees.';
      END IF;
      NEW.proposed_by := actor;
      NEW.agreed_by := NULL;
      NEW.agreed_at := NULL;
      NEW.reminder_sent_at := NULL;
    ELSIF NEW.proposed_by IS NULL THEN
      NEW.proposed_by := NEW.created_by;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.couple_id <> OLD.couple_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'A scheduled date stays with the couple who made it.';
  END IF;
  IF actor IS NOT NULL
     AND NEW.reminder_sent_at IS DISTINCT FROM OLD.reminder_sent_at THEN
    RAISE EXCEPTION 'Only the reminder service can change reminder status.';
  END IF;

  IF actor IS NOT NULL THEN
    plan_changed := NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
      OR NEW.timezone IS DISTINCT FROM OLD.timezone
      OR NEW.activity_type IS DISTINCT FROM OLD.activity_type
      OR NEW.activity_id IS DISTINCT FROM OLD.activity_id
      OR NEW.activity_name IS DISTINCT FROM OLD.activity_name;

    IF OLD.status IN ('done', 'cancelled') AND NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'That Together time is over. Suggest a new one instead.';
    END IF;
    IF OLD.status = 'proposed' AND NEW.status = 'done' THEN
      RAISE EXCEPTION 'Agree on a time together before marking it done.';
    END IF;

    IF OLD.status = 'proposed' AND NEW.status = 'scheduled' THEN
      IF actor IS NOT DISTINCT FROM OLD.proposed_by THEN
        RAISE EXCEPTION 'Your partner needs to agree before this locks in.';
      END IF;
      IF plan_changed THEN
        RAISE EXCEPTION 'Agree to the suggested time as it is, or suggest a different one.';
      END IF;
      NEW.proposed_by := OLD.proposed_by;
      NEW.agreed_by := actor;
      NEW.agreed_at := now();
    ELSIF NEW.status = 'proposed' AND (OLD.status = 'scheduled' OR plan_changed) THEN
      NEW.proposed_by := actor;
      NEW.agreed_by := NULL;
      NEW.agreed_at := NULL;
      NEW.reminder_sent_at := NULL;
    ELSIF OLD.status = 'scheduled' AND NEW.status = 'scheduled' AND plan_changed THEN
      RAISE EXCEPTION 'This time is locked in. Suggest a different time and let your partner agree.';
    ELSE
      NEW.proposed_by := OLD.proposed_by;
      NEW.agreed_by := OLD.agreed_by;
      NEW.agreed_at := OLD.agreed_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Chat no longer links a bubble to a book passage. Replace the guard and the send
-- policy before the column goes, so neither still names it.
CREATE OR REPLACE FUNCTION public.guard_message_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.couple_id <> OLD.couple_id
     OR NEW.sender_id IS DISTINCT FROM OLD.sender_id
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.reply_to_id IS DISTINCT FROM OLD.reply_to_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Most of a message is frozen: only its author can edit the words, and only the recipient can stamp the receipt.';
  END IF;

  IF NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    IF OLD.sender_id IS NOT DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'You cannot mark your own message as read.';
    END IF;
    IF OLD.read_at IS NOT NULL OR NEW.read_at IS NULL THEN
      RAISE EXCEPTION 'A read receipt cannot be taken back.';
    END IF;
  END IF;

  IF NEW.content IS DISTINCT FROM OLD.content THEN
    IF OLD.sender_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'You can only edit your own messages.';
    END IF;
    NEW.edited_at := timezone('utc'::text, now());
  ELSIF NEW.edited_at IS DISTINCT FROM OLD.edited_at THEN
    RAISE EXCEPTION 'The edit stamp only moves when the words do.';
  END IF;

  RETURN NEW;
END;
$$;

DROP POLICY IF EXISTS "Couple members can send messages" ON public.messages;
CREATE POLICY "Couple members can send messages" ON public.messages
FOR INSERT TO authenticated
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid())
  AND (sender_id = auth.uid() OR (sender_id IS NULL AND type = 'system'))
  AND (session_id IS NULL OR public.get_session_couple_id(session_id) = couple_id)
  AND (reply_to_id IS NULL OR public.message_is_in_couple(reply_to_id, couple_id))
);

ALTER TABLE public.messages DROP COLUMN IF EXISTS highlight_id;
DROP FUNCTION IF EXISTS public.highlight_is_in_couple(UUID, UUID);

DO $$
DECLARE t TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['shared_books', 'reading_progress', 'highlights'] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

DROP TABLE IF EXISTS public.reading_progress;
DROP TABLE IF EXISTS public.highlights;
DROP TABLE IF EXISTS public.shared_books;

DROP FUNCTION IF EXISTS public.guard_book_immutable();
DROP FUNCTION IF EXISTS public.guard_book_limit();
DROP FUNCTION IF EXISTS public.set_reading_progress_updated_at();

DO $drop_books_storage$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'DROP POLICY IF EXISTS "Couple members can read their book files" ON storage.objects';
  EXECUTE 'DROP POLICY IF EXISTS "Couple members can upload their book files" ON storage.objects';
  EXECUTE 'DROP POLICY IF EXISTS "Couple members can delete their book files" ON storage.objects';
  -- Hosted Supabase refuses direct deletes from storage.objects and storage.buckets
  -- (storage.protect_delete). A local database still accepts them. Either way the
  -- policies are gone, so a phone can no longer read the files.
  BEGIN
    DELETE FROM storage.objects WHERE bucket_id = 'shared-books';
    IF to_regclass('storage.buckets') IS NOT NULL THEN
      DELETE FROM storage.buckets WHERE id = 'shared-books';
    END IF;
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;
END
$drop_books_storage$;

COMMIT;
