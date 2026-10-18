-- ============================================================================
-- TOGETHER TAB: Visits and Someday List
-- Adds support for:
-- 1. Visits table - planned visits with countdown
-- 2. Someday items table - shared list of things to experience together
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. Visits Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  -- Visit dates
  start_date DATE NOT NULL,
  end_date DATE,
  -- Location info
  location TEXT,
  timezone TEXT DEFAULT 'UTC',
  -- Status
  is_tentative BOOLEAN NOT NULL DEFAULT false,
  -- Metadata
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  -- Constraints
  CONSTRAINT valid_dates CHECK (end_date IS NULL OR end_date >= start_date)
);

-- Indexes for visits
CREATE INDEX IF NOT EXISTS idx_visits_couple_id ON public.visits(couple_id);
CREATE INDEX IF NOT EXISTS idx_visits_start_date ON public.visits(start_date);
CREATE INDEX IF NOT EXISTS idx_visits_end_date ON public.visits(end_date) WHERE end_date IS NOT NULL;

-- Enable RLS for visits
ALTER TABLE public.visits ENABLE ROW LEVEL SECURITY;

-- RLS Policies for visits
DROP POLICY IF EXISTS visits_read ON public.visits;
CREATE POLICY visits_read ON public.visits FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

DROP POLICY IF EXISTS visits_insert ON public.visits;
CREATE POLICY visits_insert ON public.visits FOR INSERT TO authenticated
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()));

DROP POLICY IF EXISTS visits_update ON public.visits;
CREATE POLICY visits_update ON public.visits FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()))
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()));

DROP POLICY IF EXISTS visits_delete ON public.visits;
CREATE POLICY visits_delete ON public.visits FOR DELETE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

-- Grant permissions
REVOKE ALL ON public.visits FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.visits TO authenticated;

-- ============================================================================
-- 2. Someday Items Table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.someday_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  -- Item content
  text TEXT NOT NULL CHECK (char_length(text) > 0 AND char_length(text) <= 500),
  -- Status
  completed BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ,
  -- Metadata
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  -- Constraints
  CONSTRAINT completed_at_check CHECK (
    (completed = false AND completed_at IS NULL) OR
    (completed = true AND completed_at IS NOT NULL)
  )
);

-- Indexes for someday_items
CREATE INDEX IF NOT EXISTS idx_someday_items_couple_id ON public.someday_items(couple_id);
CREATE INDEX IF NOT EXISTS idx_someday_items_completed ON public.someday_items(completed);
CREATE INDEX IF NOT EXISTS idx_someday_items_created_at ON public.someday_items(created_at);

-- Enable RLS for someday_items
ALTER TABLE public.someday_items ENABLE ROW LEVEL SECURITY;

-- RLS Policies for someday_items
DROP POLICY IF EXISTS someday_items_read ON public.someday_items;
CREATE POLICY someday_items_read ON public.someday_items FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

DROP POLICY IF EXISTS someday_items_insert ON public.someday_items;
CREATE POLICY someday_items_insert ON public.someday_items FOR INSERT TO authenticated
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()));

DROP POLICY IF EXISTS someday_items_update ON public.someday_items;
CREATE POLICY someday_items_update ON public.someday_items FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()))
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()));

DROP POLICY IF EXISTS someday_items_delete ON public.someday_items;
CREATE POLICY someday_items_delete ON public.someday_items FOR DELETE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

-- Grant permissions
REVOKE ALL ON public.someday_items FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.someday_items TO authenticated;

-- ============================================================================
-- 3. Helper Functions
-- ============================================================================

-- Function to get the next upcoming visit for a couple
CREATE OR REPLACE FUNCTION public.get_next_visit(p_couple_id UUID)
RETURNS public.visits
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.visits
  WHERE couple_id = p_couple_id
  AND (start_date >= CURRENT_DATE OR (end_date IS NOT NULL AND end_date >= CURRENT_DATE))
  ORDER BY start_date ASC
  LIMIT 1;
$$;

-- Function to check if a visit is currently happening
CREATE OR REPLACE FUNCTION public.is_visit_happening(p_visit_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start DATE;
  v_end DATE;
BEGIN
  SELECT start_date, end_date INTO v_start, v_end
  FROM public.visits WHERE id = p_visit_id;
  
  IF v_start IS NULL THEN
    RETURN false;
  END IF;
  
  IF v_end IS NULL THEN
    -- If no end date, visit is only on start date
    RETURN CURRENT_DATE = v_start;
  ELSE
    -- Visit is happening if today is between start and end (inclusive)
    RETURN CURRENT_DATE >= v_start AND CURRENT_DATE <= v_end;
  END IF;
END;
$$;

-- ============================================================================
-- 4. Real-time Publications
-- ============================================================================

-- Add tables to realtime publication
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
    -- Add visits table if not already in publication
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables 
      WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='visits'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.visits;
    END IF;
    
    -- Add someday_items table if not already in publication
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables 
      WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='someday_items'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.someday_items;
    END IF;
  END IF;
END $$;

COMMIT;
