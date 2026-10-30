-- Raise a Child: the child starts as somebody, not as a blank page.
--
-- The three traits each parent chose during setup are supposed to be visible in the child
-- from the first day: at least one from each parent, and a third that lands on either of
-- them. That is what lets the app say, warmly and truthfully, "Mia has more of your
-- traits" — and it is where the years of decisions start shaping them from.
--
-- Additive only: one new table, two small helpers, one new read RPC, and
-- raise_child_settle_setup is replaced so a family that opens now gets its traits at
-- birth. No existing table, column or constraint is touched.
BEGIN;

-- ---------------------------------------------------------------------------------
-- 1. What the child came with, and who it came from
-- ---------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.child_inherited_traits (
  family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  trait TEXT NOT NULL,
  -- Kept per child so the resemblance line never has to guess: if both parents chose the
  -- same trait, the row still remembers which of them it is attributed to.
  from_user UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, trait)
);

ALTER TABLE public.child_inherited_traits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.child_inherited_traits REPLICA IDENTITY FULL;

DROP POLICY IF EXISTS child_inherited_traits_read_couple ON public.child_inherited_traits;
CREATE POLICY child_inherited_traits_read_couple ON public.child_inherited_traits
  FOR SELECT TO authenticated
  USING (family_id IN (
    SELECT id FROM public.families WHERE couple_id = public.get_user_couple_id(auth.uid())
  ));

-- Read by both parents; written only by the function below.
REVOKE ALL ON public.child_inherited_traits FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.child_inherited_traits TO authenticated;
GRANT ALL ON public.child_inherited_traits TO service_role;

COMMENT ON TABLE public.child_inherited_traits IS
  'The three traits the child was born with, and which parent each came from.';

-- ---------------------------------------------------------------------------------
-- 2. The draw
-- ---------------------------------------------------------------------------------

-- A random trait this parent has that the child does not have yet. NULL when there is
-- nothing left to take — two parents with identical lists simply give the child fewer.
CREATE OR REPLACE FUNCTION public.raise_child_pick_untaken(p_from TEXT[], p_taken TEXT[])
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE pool TEXT[];
BEGIN
  SELECT array_agg(t) INTO pool
    FROM unnest(coalesce(p_from, '{}'::TEXT[])) AS t
   WHERE NOT (t = ANY (coalesce(p_taken, '{}'::TEXT[])));
  IF pool IS NULL OR cardinality(pool) = 0 THEN RETURN NULL; END IF;
  RETURN pool[1 + floor(random() * cardinality(pool))::INT];
END;
$$;

-- At least one from each parent, then a third from either of them. Runs once per child:
-- a family that already has traits keeps the ones it was born with, whatever happens next.
CREATE OR REPLACE FUNCTION public.raise_child_seed_inherited_traits(p_family_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  fam public.families%ROWTYPE;
  parents UUID[];
  a_traits TEXT[];
  b_traits TEXT[];
  taken TEXT[] := '{}';
  pick TEXT;
  from_user UUID;
BEGIN
  SELECT * INTO fam FROM public.families WHERE id = p_family_id;
  IF fam.id IS NULL OR fam.status = 'setup' THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.child_inherited_traits WHERE family_id = fam.id) THEN RETURN; END IF;

  parents := public.raise_child_parents(fam.id);
  IF cardinality(parents) < 2 THEN RETURN; END IF;
  SELECT traits INTO a_traits FROM public.family_parents WHERE family_id = fam.id AND user_id = parents[1];
  SELECT traits INTO b_traits FROM public.family_parents WHERE family_id = fam.id AND user_id = parents[2];
  IF cardinality(coalesce(a_traits, '{}')) < 3 OR cardinality(coalesce(b_traits, '{}')) < 3 THEN RETURN; END IF;

  -- One from the first parent.
  pick := public.raise_child_pick_untaken(a_traits, taken);
  IF pick IS NOT NULL THEN
    INSERT INTO public.child_inherited_traits (family_id, trait, from_user, sort_order)
    VALUES (fam.id, pick, parents[1], 1);
    taken := taken || pick;
  END IF;

  -- One from the other, so neither parent is left out of their own child.
  pick := public.raise_child_pick_untaken(b_traits, taken);
  IF pick IS NOT NULL THEN
    INSERT INTO public.child_inherited_traits (family_id, trait, from_user, sort_order)
    VALUES (fam.id, pick, parents[2], 2);
    taken := taken || pick;
  END IF;

  -- And a third from whichever of the two it lands on (a coin toss when they share it).
  pick := public.raise_child_pick_untaken(a_traits || b_traits, taken);
  IF pick IS NOT NULL THEN
    SELECT options.candidate INTO from_user
      FROM (
        SELECT parents[1] AS candidate WHERE pick = ANY (a_traits)
        UNION ALL
        SELECT parents[2] AS candidate WHERE pick = ANY (b_traits)
      ) AS options
     ORDER BY random()
     LIMIT 1;
    INSERT INTO public.child_inherited_traits (family_id, trait, from_user, sort_order)
    VALUES (fam.id, pick, from_user, 3);
  END IF;
END;
$$;

COMMENT ON FUNCTION public.raise_child_seed_inherited_traits(UUID) IS
  'Draws the child''s three inherited traits once: at least one from each parent, the third from either.';

-- ---------------------------------------------------------------------------------
-- 3. What this parent sees of it
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_inheritance()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  fam public.families%ROWTYPE;
  cs public.child_state%ROWTYPE;
  parents UUID[];
  partner UUID;
  partner_name TEXT;
  mine INTEGER := 0;
  theirs INTEGER := 0;
  inherited JSONB;
BEGIN
  PERFORM public.raise_child_require_couple();
  fam := public.raise_child_open_family();
  IF fam.id IS NULL THEN
    RETURN jsonb_build_object('inherited', '[]'::JSONB, 'more_like', NULL, 'line', NULL);
  END IF;

  SELECT * INTO cs FROM public.child_state WHERE family_id = fam.id;
  IF cs.family_id IS NULL THEN
    RETURN jsonb_build_object('inherited', '[]'::JSONB, 'more_like', NULL, 'line', NULL);
  END IF;

  SELECT count(*) FILTER (WHERE from_user = caller),
         count(*) FILTER (WHERE from_user <> caller)
    INTO mine, theirs
    FROM public.child_inherited_traits WHERE family_id = fam.id;

  SELECT jsonb_agg(jsonb_build_object(
           'slug', t.trait,
           'label', coalesce(tc.label, t.trait),
           'from_me', t.from_user = caller
         ) ORDER BY t.sort_order, t.trait)
    INTO inherited
    FROM public.child_inherited_traits t
    LEFT JOIN public.trait_catalog tc ON tc.slug = t.trait
   WHERE t.family_id = fam.id;

  parents := public.raise_child_parents(fam.id);
  partner := CASE WHEN parents[1] = caller THEN parents[2] ELSE parents[1] END;
  SELECT name INTO partner_name FROM public.profiles WHERE id = partner;

  RETURN jsonb_build_object(
    'inherited', coalesce(inherited, '[]'::JSONB),
    'more_like', CASE WHEN mine > theirs THEN 'me' WHEN theirs > mine THEN 'partner' ELSE 'both' END,
    'line', CASE
      WHEN mine = 0 AND theirs = 0 THEN NULL
      WHEN mine > theirs THEN cs.name || ' has more of your traits.'
      WHEN theirs > mine THEN cs.name || ' has more of ' || coalesce(partner_name, 'your partner') || '''s traits.'
      ELSE cs.name || ' takes after you both.'
    END
  );
END;
$$;

COMMENT ON FUNCTION public.raise_child_inheritance() IS
  'The traits the child was born with, and the soft sentence about who they take after.';

-- ---------------------------------------------------------------------------------
-- 4. A family that opens from now on gets them at birth
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_settle_setup(p_family_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  fam public.families%ROWTYPE;
  parents UUID[];
  prop_a public.family_setup_proposals%ROWTYPE;
  prop_b public.family_setup_proposals%ROWTYPE;
  traits_a TEXT[];
  traits_b TEXT[];
  settled_name TEXT;
BEGIN
  SELECT * INTO fam FROM public.families WHERE id = p_family_id;
  IF fam.id IS NULL OR fam.status <> 'setup' THEN RETURN; END IF;

  parents := public.raise_child_parents(fam.id);
  IF cardinality(parents) < 2 THEN RETURN; END IF;

  SELECT * INTO prop_a FROM public.family_setup_proposals
   WHERE family_id = fam.id AND user_id = parents[1];
  SELECT * INTO prop_b FROM public.family_setup_proposals
   WHERE family_id = fam.id AND user_id = parents[2];
  IF prop_a.family_id IS NULL OR prop_b.family_id IS NULL THEN RETURN; END IF;

  IF NOT public.raise_child_same_name(prop_a.name, prop_b.name) THEN RETURN; END IF;
  IF NOT public.raise_child_same_look(prop_a.look, prop_b.look) THEN RETURN; END IF;

  -- Both parents proposed the same child. That is the child.
  settled_name := btrim(prop_a.name);
  INSERT INTO public.child_state (family_id, name, look)
  VALUES (fam.id, settled_name, prop_a.look)
  ON CONFLICT (family_id) DO UPDATE
    SET name = EXCLUDED.name,
        look = EXCLUDED.look,
        updated_at = now();

  -- The childhood opens only when the name, the face and all six traits are agreed.
  SELECT traits INTO traits_a FROM public.family_parents WHERE family_id = fam.id AND user_id = parents[1];
  SELECT traits INTO traits_b FROM public.family_parents WHERE family_id = fam.id AND user_id = parents[2];
  IF cardinality(coalesce(traits_a, '{}')) = 3 AND cardinality(coalesce(traits_b, '{}')) = 3 THEN
    UPDATE public.families SET status = 'active', updated_at = now() WHERE id = fam.id;
    UPDATE public.child_state
       SET temperament = public.raise_child_temperament(traits_a, traits_b),
           lead_user_id = fam.created_by,
           last_tick_day = NULL,
           updated_at = now()
     WHERE family_id = fam.id;
    -- Born with something of both of them.
    PERFORM public.raise_child_seed_inherited_traits(fam.id);
    INSERT INTO public.album_entries (family_id, kind, age, title, body)
    VALUES (
      fam.id, 'milestone', 0,
      'The day ' || settled_name || ' arrived',
      'Two parents, three traits each, and a whole childhood ahead. ' || settled_name || ' came home today.'
    );
    PERFORM public.raise_child_tick_family(fam.id);
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------------
-- 5. Families already in the middle of a childhood get theirs too
-- ---------------------------------------------------------------------------------

DO $$
DECLARE f RECORD;
BEGIN
  FOR f IN SELECT id FROM public.families WHERE status <> 'setup' LOOP
    PERFORM public.raise_child_seed_inherited_traits(f.id);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------
-- 6. Permissions and realtime
-- ---------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.raise_child_pick_untaken(TEXT[], TEXT[]),
  public.raise_child_seed_inherited_traits(UUID)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.raise_child_inheritance() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raise_child_inheritance() TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
         AND tablename = 'child_inherited_traits'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.child_inherited_traits;
    END IF;
  END IF;
END $$;

COMMIT;
