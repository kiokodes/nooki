-- Replace Together-time scheduling and private/matched ideas with a shared notebook.
-- The notebook title, couple ownership, completion, and ordering remain; old private
-- ideas become ordinary shared entries now that privacy is no longer part of this list.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE 'SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = ''nooki-together-time-reminders''';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.invoke_together_time_reminder_sweep();
DROP FUNCTION IF EXISTS public.claim_due_together_time_reminders();
DROP TABLE IF EXISTS public.together_time_sessions CASCADE;
DROP FUNCTION IF EXISTS public.guard_together_time_session();

-- The notebook shows only the task title. Remove privacy controls and yes-votes.
-- Existing task titles and stored legacy notes remain in the database; private entries
-- become shared tasks rather than hidden or discarded.
DROP TRIGGER IF EXISTS guard_someday_item_visit ON public.someday_items;
DROP TRIGGER IF EXISTS guard_someday_item_visibility_and_day ON public.someday_items;
DROP FUNCTION IF EXISTS public.guard_someday_item_visibility_and_day();
DROP TABLE IF EXISTS public.someday_item_votes CASCADE;
DROP POLICY IF EXISTS someday_items_read ON public.someday_items;
DROP POLICY IF EXISTS someday_items_update ON public.someday_items;
DROP POLICY IF EXISTS someday_items_delete ON public.someday_items;
ALTER TABLE public.someday_items DROP CONSTRAINT IF EXISTS someday_visibility_check;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'someday_items' AND column_name = 'visibility') THEN
    UPDATE public.someday_items SET visibility = 'open' WHERE visibility IS DISTINCT FROM 'open';
  END IF;
END $$;
ALTER TABLE public.someday_items DROP COLUMN IF EXISTS visibility;

CREATE OR REPLACE FUNCTION public.guard_someday_item_visit()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE planned_visit public.visits;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'A task stays with the partner who added it.';
  END IF;
  IF NEW.visit_id IS NULL THEN
    NEW.visit_date := NULL;
    RETURN NEW;
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
CREATE TRIGGER guard_someday_item_visit
BEFORE INSERT OR UPDATE OF visit_id, visit_date, couple_id, created_by
ON public.someday_items FOR EACH ROW
EXECUTE FUNCTION public.guard_someday_item_visit();

-- Every item belongs to the couple. Either partner can read, reorder, complete, edit,
-- or delete it; no private/author-only paths remain in the notebook.
DROP POLICY IF EXISTS someday_items_read ON public.someday_items;
CREATE POLICY someday_items_read ON public.someday_items FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));
DROP POLICY IF EXISTS someday_items_update ON public.someday_items;
CREATE POLICY someday_items_update ON public.someday_items FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()))
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()));
DROP POLICY IF EXISTS someday_items_delete ON public.someday_items;
CREATE POLICY someday_items_delete ON public.someday_items FOR DELETE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

COMMIT;
