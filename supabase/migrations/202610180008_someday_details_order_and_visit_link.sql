-- ============================================================================
-- TOGETHER TAB: Someday list — notes, a manual order, and the visit bridge
-- ============================================================================
-- Run this on an existing project after
-- 202610180007_together_visits_and_someday_list.sql. It is additive and safe to
-- rerun: no existing row is deleted, and the backfill only touches rows that do
-- not yet have an order.
--
-- What it adds:
--   1. details   — the context a partner writes after tapping an idea, up to
--                  1,000 characters (the tab-level title stays at 500).
--   2. sort_order — the couple's own order. Drag a row and both phones see the
--                  same list; new ideas join at the top.
--   3. visit_id  — "Add to our next visit": pins an idea to one of the couple's
--                  planned visits so it also shows on the visit card. Deleting
--                  the visit puts the idea back on the someday list rather than
--                  deleting it.
--   4. reorder_someday_items() — writes a whole order atomically, validating
--                  every id belongs to the caller's couple.
--   5. A trigger refusing a visit link that points at another couple's visit.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1) Columns
-- ============================================================================

ALTER TABLE public.someday_items
  ADD COLUMN IF NOT EXISTS details TEXT,
  ADD COLUMN IF NOT EXISTS sort_order DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS visit_id UUID REFERENCES public.visits(id) ON DELETE SET NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'someday_details_length_check'
      AND conrelid = 'public.someday_items'::regclass
  ) THEN
    ALTER TABLE public.someday_items
      ADD CONSTRAINT someday_details_length_check
      CHECK (details IS NULL OR char_length(details) <= 1000);
  END IF;
END $$;

-- Keep today's visible order: newest first. After this, the order belongs to the
-- couple and only changes when someone drags a row.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY couple_id
           ORDER BY created_at DESC, id DESC
         ) - 1 AS position
  FROM public.someday_items
  WHERE sort_order IS NULL
)
UPDATE public.someday_items AS item
SET sort_order = ranked.position
FROM ranked
WHERE item.id = ranked.id;

ALTER TABLE public.someday_items ALTER COLUMN sort_order SET DEFAULT 0;
ALTER TABLE public.someday_items ALTER COLUMN sort_order SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_someday_items_order
  ON public.someday_items(couple_id, sort_order, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_someday_items_visit_id
  ON public.someday_items(visit_id) WHERE visit_id IS NOT NULL;

-- ============================================================================
-- 2) A linked visit must be one of this couple's visits
-- ============================================================================

CREATE OR REPLACE FUNCTION public.guard_someday_item_visit()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF NEW.visit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.visits
    WHERE id = NEW.visit_id AND couple_id = NEW.couple_id
  ) THEN
    RAISE EXCEPTION 'That visit is not part of your plans.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_someday_item_visit ON public.someday_items;
CREATE TRIGGER guard_someday_item_visit
BEFORE INSERT OR UPDATE OF visit_id, couple_id ON public.someday_items
FOR EACH ROW EXECUTE FUNCTION public.guard_someday_item_visit();

-- ============================================================================
-- 3) Saving the dragged order
-- ============================================================================
-- One call writes the whole list. The phone sends the ids top to bottom; the
-- function refuses duplicates and any id that is not on the caller's own list,
-- so a forged request cannot reorder a stranger's rows. SECURITY DEFINER keeps
-- the UPDATE from being half-visible while it runs.

CREATE OR REPLACE FUNCTION public.reorder_someday_items(p_ids UUID[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  cid UUID := public.get_user_couple_id(auth.uid());
  distinct_count INTEGER;
  owned_count INTEGER;
BEGIN
  IF cid IS NULL THEN
    RAISE EXCEPTION 'Pair with your partner first.';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN;
  END IF;

  SELECT count(DISTINCT id) INTO distinct_count FROM unnest(p_ids) AS id;
  IF distinct_count <> cardinality(p_ids) THEN
    RAISE EXCEPTION 'A list item can only appear once.';
  END IF;

  SELECT count(*) INTO owned_count
  FROM public.someday_items
  WHERE couple_id = cid AND id = ANY(p_ids);
  IF owned_count <> cardinality(p_ids) THEN
    RAISE EXCEPTION 'That someday list is not yours.';
  END IF;

  UPDATE public.someday_items AS item
  SET sort_order = ordered.position - 1,
      updated_at = now()
  FROM unnest(p_ids) WITH ORDINALITY AS ordered(id, position)
  WHERE item.id = ordered.id AND item.couple_id = cid;
END;
$$;

REVOKE ALL ON FUNCTION public.reorder_someday_items(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reorder_someday_items(UUID[]) TO authenticated;

-- ============================================================================
-- 4) Realtime
-- ============================================================================
-- The table is already in the publication from migration 007. Kept here so a
-- project that skipped that step still ends up live.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
         AND tablename = 'someday_items'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.someday_items;
  END IF;
END $$;

COMMIT;
