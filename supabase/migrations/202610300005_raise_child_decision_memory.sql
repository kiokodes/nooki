-- Decision memory uses the already durable, family-scoped resolved moments as its
-- source of truth. A prerequisite is {"event_slug":"...", "choice":1}; all must
-- match. Choice indexes are one-based and must never be reordered once published.
BEGIN;

ALTER TABLE public.event_templates
  ADD COLUMN IF NOT EXISTS required_decisions JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.event_templates DROP CONSTRAINT IF EXISTS event_templates_required_decisions_array;
ALTER TABLE public.event_templates ADD CONSTRAINT event_templates_required_decisions_array
  CHECK (jsonb_typeof(required_decisions) = 'array');

-- Stable indices matter both for existing families and for authored follow-ups.
CREATE OR REPLACE FUNCTION public.raise_child_guard_choice_order()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE old_labels TEXT[]; new_labels TEXT[];
BEGIN
  SELECT array_agg(x.value ->> 'label' ORDER BY x.ordinality) INTO old_labels
    FROM jsonb_array_elements(OLD.choices) WITH ORDINALITY AS x(value, ordinality);
  SELECT array_agg(x.value ->> 'label' ORDER BY x.ordinality) INTO new_labels
    FROM jsonb_array_elements(NEW.choices) WITH ORDINALITY AS x(value, ordinality);
  IF old_labels IS DISTINCT FROM new_labels AND (
    EXISTS (SELECT 1 FROM public.family_moments WHERE event_slug = OLD.slug AND status = 'resolved')
    OR EXISTS (SELECT 1 FROM public.event_templates t, jsonb_array_elements(t.required_decisions) AS r(item)
                WHERE r.item ->> 'event_slug' = OLD.slug)
  ) THEN
    RAISE EXCEPTION 'Cannot change choice labels or order for a decision that has been resolved or referenced.';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.raise_child_guard_choice_order() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS raise_child_guard_choice_order ON public.event_templates;
CREATE TRIGGER raise_child_guard_choice_order BEFORE UPDATE OF choices ON public.event_templates
  FOR EACH ROW EXECUTE FUNCTION public.raise_child_guard_choice_order();

CREATE OR REPLACE FUNCTION public.raise_child_pick_event(
  p_family_id UUID,
  p_age SMALLINT,
  p_traits TEXT[],
  p_wide BOOLEAN DEFAULT false,
  p_use_traits BOOLEAN DEFAULT true
)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  picked TEXT;
BEGIN
  SELECT t.slug INTO picked
    FROM public.event_templates t
   WHERE t.active
     -- Never widen age ranges: scenes must fit the child's actual age. p_wide is
     -- retained for compatibility with the existing caller, but is intentionally ignored.
     AND p_age BETWEEN t.min_age AND t.max_age
     AND NOT EXISTS (
       SELECT 1 FROM public.family_moments m
        WHERE m.family_id = p_family_id AND m.event_slug = t.slug
     )
     -- Never relax decision prerequisites, even when trait matching is relaxed.
     -- Invalid or missing keys cannot match; no cast of untrusted content is needed.
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(t.required_decisions) AS r(requirement)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.family_moments prior
           WHERE prior.family_id = p_family_id
             AND prior.status = 'resolved'
             AND prior.event_slug = r.requirement ->> 'event_slug'
             AND prior.chosen_choice::text = r.requirement ->> 'choice'
        )
     )
     AND (NOT p_use_traits OR cardinality(t.required_trait_tags) = 0 OR t.required_trait_tags <@ coalesce(p_traits, '{}'))
     AND (NOT p_use_traits OR NOT (t.excluded_trait_tags && coalesce(p_traits, '{}')))
   ORDER BY (
       SELECT count(*) FROM public.family_moments m
        WHERE m.family_id = p_family_id AND m.category = t.category
     ) ASC,
     random()
   LIMIT 1;
  RETURN picked;
END;
$$;

COMMENT ON COLUMN public.event_templates.required_decisions IS
  'All listed family-scoped resolved event/one-based choice pairs are mandatory, including in fallback. Published choice order is immutable.';

COMMIT;
