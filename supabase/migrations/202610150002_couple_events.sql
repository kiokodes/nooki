-- Run this migration on existing Supabase projects before deploying the calendar feature.
-- Adds the couple-owned events calendar. Nothing existing is modified or removed,
-- so it is safe on a live project and safe to rerun.
BEGIN;

CREATE TABLE IF NOT EXISTS public.couple_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  -- Who added it; the row survives that account being deleted.
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  event_date DATE NOT NULL,
  repeats_yearly BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT couple_events_title_length CHECK (char_length(btrim(title)) BETWEEN 1 AND 120)
);

-- The calendar always reads one couple's events, ordered by date.
CREATE INDEX IF NOT EXISTS idx_couple_events_couple_date
  ON public.couple_events(couple_id, event_date);

ALTER TABLE public.couple_events ENABLE ROW LEVEL SECURITY;

-- Only the two partners of the event's couple can read or change it.
-- Unpaired users have a NULL couple id, so every policy denies them.
DROP POLICY IF EXISTS "Couple members can view their events" ON public.couple_events;
CREATE POLICY "Couple members can view their events" ON public.couple_events
FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

DROP POLICY IF EXISTS "Couple members can add events" ON public.couple_events;
CREATE POLICY "Couple members can add events" ON public.couple_events
FOR INSERT TO authenticated
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()) AND created_by = auth.uid());

DROP POLICY IF EXISTS "Couple members can edit their events" ON public.couple_events;
CREATE POLICY "Couple members can edit their events" ON public.couple_events
FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()))
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()));

DROP POLICY IF EXISTS "Couple members can delete their events" ON public.couple_events;
CREATE POLICY "Couple members can delete their events" ON public.couple_events
FOR DELETE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

-- Keep updated_at honest without the client having to remember it.
CREATE OR REPLACE FUNCTION public.set_couple_event_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  NEW.updated_at := timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS couple_events_set_updated_at ON public.couple_events;
CREATE TRIGGER couple_events_set_updated_at
BEFORE UPDATE ON public.couple_events
FOR EACH ROW EXECUTE FUNCTION public.set_couple_event_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.couple_events TO authenticated;
REVOKE ALL ON public.couple_events FROM anon;

COMMIT;
