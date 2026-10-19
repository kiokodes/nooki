-- Together tab: visit reflection and planning, scheduled Together time, idea matching,
-- and a private-by-couple memory timeline.
--
-- Additive migration: existing visit dates, books, and someday ideas are preserved.
BEGIN;

-- A once-private answer stays private until both partners have saved their wish.
CREATE TABLE IF NOT EXISTS public.visit_wishes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wish TEXT NOT NULL CHECK (char_length(btrim(wish)) BETWEEN 1 AND 240),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT visit_wishes_one_per_partner UNIQUE (visit_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_visit_wishes_couple_visit ON public.visit_wishes(couple_id, visit_id);
ALTER TABLE public.visit_wishes ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.visit_wishes_are_revealed(p_visit_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT count(DISTINCT wish.user_id) >= 2
  FROM public.visit_wishes AS wish
  JOIN public.visits AS visit ON visit.id = wish.visit_id
  WHERE wish.visit_id = p_visit_id
    AND visit.couple_id = public.get_user_couple_id(auth.uid())
$$;
REVOKE ALL ON FUNCTION public.visit_wishes_are_revealed(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.visit_wishes_are_revealed(UUID) TO authenticated;

DROP POLICY IF EXISTS visit_wishes_read ON public.visit_wishes;
CREATE POLICY visit_wishes_read ON public.visit_wishes FOR SELECT TO authenticated
USING (
  couple_id = public.get_user_couple_id(auth.uid())
  AND (user_id = auth.uid() OR public.visit_wishes_are_revealed(visit_id))
);
DROP POLICY IF EXISTS visit_wishes_insert ON public.visit_wishes;
CREATE POLICY visit_wishes_insert ON public.visit_wishes FOR INSERT TO authenticated
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid()) AND user_id = auth.uid()
  AND EXISTS (SELECT 1 FROM public.visits v WHERE v.id = visit_id AND v.couple_id = couple_id)
);
DROP POLICY IF EXISTS visit_wishes_update ON public.visit_wishes;
CREATE POLICY visit_wishes_update ON public.visit_wishes FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()) AND user_id = auth.uid())
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid()) AND user_id = auth.uid()
  AND EXISTS (SELECT 1 FROM public.visits v WHERE v.id = visit_id AND v.couple_id = couple_id)
);
GRANT SELECT, INSERT, UPDATE ON public.visit_wishes TO authenticated;
REVOKE ALL ON public.visit_wishes FROM anon;

-- A short shared checklist. Each item has one clear owner, while either partner may
-- check it off or update it as the plan changes.
CREATE TABLE IF NOT EXISTS public.visit_checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (char_length(btrim(text)) BETWEEN 1 AND 120),
  assigned_to UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  completed BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_visit_checklist_visit ON public.visit_checklist_items(couple_id, visit_id, created_at);
ALTER TABLE public.visit_checklist_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS visit_checklist_read ON public.visit_checklist_items;
CREATE POLICY visit_checklist_read ON public.visit_checklist_items FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));
DROP POLICY IF EXISTS visit_checklist_insert ON public.visit_checklist_items;
CREATE POLICY visit_checklist_insert ON public.visit_checklist_items FOR INSERT TO authenticated
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid())
  AND created_by = auth.uid()
  AND EXISTS (SELECT 1 FROM public.visits v WHERE v.id = visit_id AND v.couple_id = couple_id)
  AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = assigned_to AND p.couple_id = couple_id)
);
DROP POLICY IF EXISTS visit_checklist_update ON public.visit_checklist_items;
CREATE POLICY visit_checklist_update ON public.visit_checklist_items FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()))
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid())
  AND EXISTS (SELECT 1 FROM public.visits v WHERE v.id = visit_id AND v.couple_id = couple_id)
  AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = assigned_to AND p.couple_id = couple_id)
);
DROP POLICY IF EXISTS visit_checklist_delete ON public.visit_checklist_items;
CREATE POLICY visit_checklist_delete ON public.visit_checklist_items FOR DELETE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.visit_checklist_items TO authenticated;
REVOKE ALL ON public.visit_checklist_items FROM anon;

CREATE OR REPLACE FUNCTION public.guard_visit_checklist_item()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.couple_id IS DISTINCT FROM OLD.couple_id
    OR NEW.visit_id IS DISTINCT FROM OLD.visit_id
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
  ) THEN
    RAISE EXCEPTION 'A checklist item stays with its visit and creator.';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_visit_checklist_item ON public.visit_checklist_items;
CREATE TRIGGER guard_visit_checklist_item
BEFORE UPDATE ON public.visit_checklist_items
FOR EACH ROW EXECUTE FUNCTION public.guard_visit_checklist_item();

-- Give existing someday ideas an open-by-default visibility to preserve today's
-- shared-list behaviour. A linked idea can be placed on a specific visit day.
ALTER TABLE public.someday_items
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS visit_date DATE;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'someday_visibility_check'
      AND conrelid = 'public.someday_items'::regclass
  ) THEN
    ALTER TABLE public.someday_items
      ADD CONSTRAINT someday_visibility_check CHECK (visibility IN ('open', 'private'));
  END IF;
END $$;
UPDATE public.someday_items AS item
SET visit_date = visit.start_date
FROM public.visits AS visit
WHERE item.visit_id = visit.id AND item.visit_date IS NULL;

CREATE OR REPLACE FUNCTION public.guard_someday_item_visibility_and_day()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE
  planned_visit public.visits;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'An idea stays with the partner who added it.';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.visibility IS DISTINCT FROM OLD.visibility AND auth.uid() IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Only the person who added a private idea can share it.';
  END IF;
  IF NEW.visit_id IS NULL THEN
    NEW.visit_date := NULL;
    RETURN NEW;
  END IF;
  IF NEW.visibility <> 'open' THEN
    RAISE EXCEPTION 'Share this idea before adding it to a visit.';
  END IF;
  SELECT * INTO planned_visit FROM public.visits
  WHERE id = NEW.visit_id AND couple_id = NEW.couple_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That visit is not part of your plans.'; END IF;
  IF NEW.visit_date IS NULL THEN NEW.visit_date := planned_visit.start_date; END IF;
  IF NEW.visit_date < planned_visit.start_date
     OR NEW.visit_date > coalesce(planned_visit.end_date, planned_visit.start_date) THEN
    RAISE EXCEPTION 'Choose a day inside this visit.';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_someday_item_visit ON public.someday_items;
DROP TRIGGER IF EXISTS guard_someday_item_visibility_and_day ON public.someday_items;
CREATE TRIGGER guard_someday_item_visibility_and_day
BEFORE INSERT OR UPDATE OF visit_id, visit_date, visibility, couple_id, created_by
ON public.someday_items FOR EACH ROW
EXECUTE FUNCTION public.guard_someday_item_visibility_and_day();

DROP POLICY IF EXISTS someday_items_read ON public.someday_items;
CREATE POLICY someday_items_read ON public.someday_items FOR SELECT TO authenticated
USING (
  couple_id = public.get_user_couple_id(auth.uid())
  AND (visibility = 'open' OR created_by = auth.uid())
);
DROP POLICY IF EXISTS someday_items_insert ON public.someday_items;
CREATE POLICY someday_items_insert ON public.someday_items FOR INSERT TO authenticated
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()) AND created_by = auth.uid());
DROP POLICY IF EXISTS someday_items_update ON public.someday_items;
CREATE POLICY someday_items_update ON public.someday_items FOR UPDATE TO authenticated
USING (
  couple_id = public.get_user_couple_id(auth.uid())
  AND (visibility = 'open' OR created_by = auth.uid())
)
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()));
DROP POLICY IF EXISTS someday_items_delete ON public.someday_items;
CREATE POLICY someday_items_delete ON public.someday_items FOR DELETE TO authenticated
USING (
  couple_id = public.get_user_couple_id(auth.uid())
  AND (visibility = 'open' OR created_by = auth.uid())
);

-- Each partner can quietly record whether they want to do an open idea. For a private
-- idea, only its author can add/read their own vote; making it open reveals the match.
CREATE TABLE IF NOT EXISTS public.someday_item_votes (
  idea_id UUID NOT NULL REFERENCES public.someday_items(id) ON DELETE CASCADE,
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (idea_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_someday_item_votes_couple ON public.someday_item_votes(couple_id, idea_id);
ALTER TABLE public.someday_item_votes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS someday_item_votes_read ON public.someday_item_votes;
CREATE POLICY someday_item_votes_read ON public.someday_item_votes FOR SELECT TO authenticated
USING (
  couple_id = public.get_user_couple_id(auth.uid())
  AND EXISTS (
    SELECT 1 FROM public.someday_items idea
    WHERE idea.id = idea_id AND idea.couple_id = couple_id
      AND (idea.visibility = 'open' OR idea.created_by = auth.uid())
  )
);
DROP POLICY IF EXISTS someday_item_votes_insert ON public.someday_item_votes;
CREATE POLICY someday_item_votes_insert ON public.someday_item_votes FOR INSERT TO authenticated
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid()) AND user_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.someday_items idea
    WHERE idea.id = idea_id AND idea.couple_id = couple_id
      AND (idea.visibility = 'open' OR idea.created_by = auth.uid())
  )
);
DROP POLICY IF EXISTS someday_item_votes_delete ON public.someday_item_votes;
CREATE POLICY someday_item_votes_delete ON public.someday_item_votes FOR DELETE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()) AND user_id = auth.uid());
GRANT SELECT, INSERT, DELETE ON public.someday_item_votes TO authenticated;
REVOKE ALL ON public.someday_item_votes FROM anon;

-- A shared activity scheduled for a specific time, with one reminder for both partners.
CREATE TABLE IF NOT EXISTS public.together_time_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  activity_type TEXT NOT NULL CHECK (activity_type IN ('book', 'game')),
  activity_id TEXT NOT NULL CHECK (char_length(btrim(activity_id)) BETWEEN 1 AND 80),
  activity_name TEXT NOT NULL CHECK (char_length(btrim(activity_name)) BETWEEN 1 AND 120),
  scheduled_at TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'done', 'cancelled')),
  reminder_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_together_time_due ON public.together_time_sessions(scheduled_at)
  WHERE status = 'scheduled' AND reminder_sent_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_together_time_couple ON public.together_time_sessions(couple_id, scheduled_at);
ALTER TABLE public.together_time_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS together_time_read ON public.together_time_sessions;
CREATE POLICY together_time_read ON public.together_time_sessions FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));
DROP POLICY IF EXISTS together_time_insert ON public.together_time_sessions;
CREATE POLICY together_time_insert ON public.together_time_sessions FOR INSERT TO authenticated
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()) AND created_by = auth.uid());
DROP POLICY IF EXISTS together_time_update ON public.together_time_sessions;
CREATE POLICY together_time_update ON public.together_time_sessions FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()))
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()));
GRANT SELECT, INSERT, UPDATE ON public.together_time_sessions TO authenticated;
REVOKE ALL ON public.together_time_sessions FROM anon;

CREATE OR REPLACE FUNCTION public.guard_together_time_session()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF NEW.activity_type = 'game' AND NEW.activity_id NOT IN (
    'rock-paper-scissors', 'snake', 'chess', 'sudoku', 'tetris',
    'connect-four', 'dash-duel', 'word-wheel'
  ) THEN
    RAISE EXCEPTION 'Choose one of the games in Nooki.';
  END IF;
  IF NEW.activity_type = 'book' AND NOT EXISTS (
    SELECT 1 FROM public.shared_books
    WHERE id::text = NEW.activity_id AND couple_id = NEW.couple_id
  ) THEN
    RAISE EXCEPTION 'Choose a book from your shared shelf.';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.couple_id <> OLD.couple_id OR NEW.created_by IS DISTINCT FROM OLD.created_by) THEN
    RAISE EXCEPTION 'A scheduled date stays with the couple who made it.';
  END IF;
  IF TG_OP = 'UPDATE' AND auth.uid() IS NOT NULL
     AND NEW.reminder_sent_at IS DISTINCT FROM OLD.reminder_sent_at THEN
    RAISE EXCEPTION 'Only the reminder service can change reminder status.';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_together_time_session ON public.together_time_sessions;
CREATE TRIGGER guard_together_time_session
BEFORE INSERT OR UPDATE ON public.together_time_sessions
FOR EACH ROW EXECUTE FUNCTION public.guard_together_time_session();

-- Each partner contributes one photo and one short line after a visit ends.
CREATE TABLE IF NOT EXISTS public.visit_memory_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  photo_path TEXT NOT NULL,
  note TEXT NOT NULL CHECK (char_length(btrim(note)) BETWEEN 1 AND 240),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT visit_memory_one_per_partner UNIQUE (visit_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_visit_memories_timeline ON public.visit_memory_entries(couple_id, visit_id, created_at DESC);
ALTER TABLE public.visit_memory_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS visit_memories_read ON public.visit_memory_entries;
CREATE POLICY visit_memories_read ON public.visit_memory_entries FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));
DROP POLICY IF EXISTS visit_memories_insert ON public.visit_memory_entries;
CREATE POLICY visit_memories_insert ON public.visit_memory_entries FOR INSERT TO authenticated
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()) AND user_id = auth.uid());
DROP POLICY IF EXISTS visit_memories_update ON public.visit_memory_entries;
CREATE POLICY visit_memories_update ON public.visit_memory_entries FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()) AND user_id = auth.uid())
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()) AND user_id = auth.uid());
GRANT SELECT, INSERT, UPDATE ON public.visit_memory_entries TO authenticated;
REVOKE ALL ON public.visit_memory_entries FROM anon;

CREATE OR REPLACE FUNCTION public.guard_visit_memory_entry()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE ended DATE; visit_timezone TEXT;
BEGIN
  IF NEW.couple_id <> public.get_user_couple_id(auth.uid()) OR NEW.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'This memory does not belong to your couple.';
  END IF;
  SELECT coalesce(end_date, start_date), coalesce(timezone, 'UTC') INTO ended, visit_timezone FROM public.visits
  WHERE id = NEW.visit_id AND couple_id = NEW.couple_id;
  IF ended IS NULL THEN RAISE EXCEPTION 'That visit is not part of your plans.'; END IF;
  IF ended >= (now() AT TIME ZONE visit_timezone)::date THEN RAISE EXCEPTION 'Save this memory after your visit ends.'; END IF;
  IF NEW.photo_path !~ ('^memories/' || NEW.couple_id::text || '/' || NEW.user_id::text || '/' || NEW.visit_id::text || '/[^/]+[.](jpg|jpeg|png|webp|heic|heif)$') THEN
    RAISE EXCEPTION 'Choose a photo for this visit.';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_visit_memory_entry ON public.visit_memory_entries;
CREATE TRIGGER guard_visit_memory_entry
BEFORE INSERT OR UPDATE ON public.visit_memory_entries
FOR EACH ROW EXECUTE FUNCTION public.guard_visit_memory_entry();

-- Private storage for memory photos. Every file is readable by the couple, writable
-- only in the uploader's own folder. Database rows enforce the visit/user/path match.
DO $memory_storage$
DECLARE has_size_limit BOOLEAN; has_mime_types BOOLEAN;
BEGIN
  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN RETURN; END IF;
  INSERT INTO storage.buckets (id, name, public)
  VALUES ('visit-memories', 'visit-memories', false)
  ON CONFLICT (id) DO UPDATE SET public = false;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit'
  ) INTO has_size_limit;
  IF has_size_limit THEN EXECUTE 'UPDATE storage.buckets SET file_size_limit = 10485760 WHERE id = ''visit-memories'''; END IF;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'allowed_mime_types'
  ) INTO has_mime_types;
  IF has_mime_types THEN
    EXECUTE $sql$UPDATE storage.buckets SET allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] WHERE id = 'visit-memories'$sql$;
  END IF;
  EXECUTE 'DROP POLICY IF EXISTS "Couple can read visit memory photos" ON storage.objects';
  EXECUTE $sql$CREATE POLICY "Couple can read visit memory photos" ON storage.objects FOR SELECT TO authenticated
    USING (bucket_id = 'visit-memories' AND (storage.foldername(name))[1] = 'memories'
      AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text)$sql$;
  EXECUTE 'DROP POLICY IF EXISTS "Partners can upload their own memory photos" ON storage.objects';
  EXECUTE $sql$CREATE POLICY "Partners can upload their own memory photos" ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'visit-memories' AND (storage.foldername(name))[1] = 'memories'
      AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text
      AND (storage.foldername(name))[3] = auth.uid()::text)$sql$;
  EXECUTE 'DROP POLICY IF EXISTS "Partners can replace their own memory photos" ON storage.objects';
  EXECUTE $sql$CREATE POLICY "Partners can replace their own memory photos" ON storage.objects FOR UPDATE TO authenticated
    USING (bucket_id = 'visit-memories' AND (storage.foldername(name))[1] = 'memories'
      AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text
      AND (storage.foldername(name))[3] = auth.uid()::text)
    WITH CHECK (bucket_id = 'visit-memories' AND (storage.foldername(name))[1] = 'memories'
      AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text
      AND (storage.foldername(name))[3] = auth.uid()::text)$sql$;
  EXECUTE 'DROP POLICY IF EXISTS "Partners can remove their own memory photos" ON storage.objects';
  EXECUTE $sql$CREATE POLICY "Partners can remove their own memory photos" ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'visit-memories' AND (storage.foldername(name))[1] = 'memories'
      AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text
      AND (storage.foldername(name))[3] = auth.uid()::text)$sql$;
END
$memory_storage$;

-- Called only by the trusted push function every minute. Marking rows in one locked
-- transaction prevents two overlapping sweeps from notifying the same couple twice.
CREATE OR REPLACE FUNCTION public.claim_due_together_time_reminders()
RETURNS TABLE (
  id UUID,
  couple_id UUID,
  activity_type TEXT,
  activity_id TEXT,
  activity_name TEXT,
  scheduled_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT session.id
    FROM public.together_time_sessions AS session
    WHERE session.status = 'scheduled'
      AND session.reminder_sent_at IS NULL
      AND session.scheduled_at <= now()
      AND session.scheduled_at >= now() - interval '1 day'
    ORDER BY session.scheduled_at
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.together_time_sessions AS session
  SET reminder_sent_at = now(), updated_at = now()
  FROM due
  WHERE session.id = due.id
  RETURNING session.id, session.couple_id, session.activity_type,
    session.activity_id, session.activity_name, session.scheduled_at;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_due_together_time_reminders() FROM PUBLIC, anon, authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.claim_due_together_time_reminders() TO service_role;
  END IF;
END $$;

-- pg_cron calls this every minute; the URL and shared webhook secret live only in
-- Supabase Vault, never in a migration or on a partner's device.
CREATE OR REPLACE FUNCTION public.invoke_together_time_reminder_sweep()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE endpoint TEXT; webhook_secret TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')
     OR to_regclass('vault.decrypted_secrets') IS NULL THEN
    RETURN;
  END IF;
  SELECT decrypted_secret INTO endpoint FROM vault.decrypted_secrets WHERE name = 'nooki_send_push_url' LIMIT 1;
  SELECT decrypted_secret INTO webhook_secret FROM vault.decrypted_secrets WHERE name = 'nooki_push_webhook_secret' LIMIT 1;
  IF endpoint IS NULL OR webhook_secret IS NULL THEN RETURN; END IF;
  PERFORM net.http_post(
    url := endpoint,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || webhook_secret),
    body := jsonb_build_object('type', 'SCHEDULED', 'table', 'together_time_sessions'),
    timeout_milliseconds := 10000
  );
END;
$$;
REVOKE ALL ON FUNCTION public.invoke_together_time_reminder_sweep() FROM PUBLIC, anon, authenticated;

-- Supabase commonly enables pg_cron and pg_net for projects. On an instance where either
-- extension is not enabled yet, the migration stays safe; enable both and rerun this
-- schedule block (or schedule the same SELECT from the SQL editor).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    EXECUTE 'SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = ''nooki-together-time-reminders''';
    PERFORM cron.schedule(
      'nooki-together-time-reminders',
      '* * * * *',
      'SELECT public.invoke_together_time_reminder_sweep();'
    );
  END IF;
END $$;

-- Realtime keeps the shared cards fresh on both phones.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'visit_wishes') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.visit_wishes;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'visit_checklist_items') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.visit_checklist_items;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'someday_item_votes') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.someday_item_votes;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'together_time_sessions') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.together_time_sessions;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'visit_memory_entries') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.visit_memory_entries;
    END IF;
  END IF;
END $$;

COMMIT;
