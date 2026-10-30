-- Raise a Child: the child's name and face belong to both parents, not to the faster thumb.
--
-- Until this file the first parent to save a name won it, and the second silently
-- overwrote it. Now each parent makes a proposal, both proposals are visible to both of
-- them, and the child is only named (and faced) when the two proposals agree — either
-- because the two of you landed on the same thing, or because one of you deliberately
-- moved to the other's. Nothing is ever decided by who saved last.
--
-- Additive only: one new table and four new functions. raise_child_setup is replaced so
-- it proposes instead of writing. No existing column is added, altered or dropped.
BEGIN;

-- ---------------------------------------------------------------------------------
-- 1. The proposals: one per parent, readable by both, writable only by its author
-- ---------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.family_setup_proposals (
  family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  look JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(look) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, user_id)
);

ALTER TABLE public.family_setup_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_setup_proposals REPLICA IDENTITY FULL;

-- Both partners read both proposals: seeing each other's idea is the whole point.
DROP POLICY IF EXISTS family_setup_proposals_read_couple ON public.family_setup_proposals;
CREATE POLICY family_setup_proposals_read_couple ON public.family_setup_proposals
  FOR SELECT TO authenticated
  USING (family_id IN (
    SELECT id FROM public.families WHERE couple_id = public.get_user_couple_id(auth.uid())
  ));

-- No insert/update/delete policy: the two functions below are the only way in, so a
-- parent can never write the other parent's name for them.
REVOKE ALL ON public.family_setup_proposals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.family_setup_proposals TO authenticated;
GRANT ALL ON public.family_setup_proposals TO service_role;

COMMENT ON TABLE public.family_setup_proposals IS
  'Each parent''s suggested name and face. The child is only named when the two agree.';

-- ---------------------------------------------------------------------------------
-- 2. Agreement: the same name, and the same face, by both parents
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_same_name(p_a TEXT, p_b TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
AS $$
  SELECT btrim(coalesce(p_a, '')) <> ''
     AND lower(btrim(coalesce(p_a, ''))) = lower(btrim(coalesce(p_b, '')));
$$;

-- Only the three things a parent can actually choose are compared, so a future extra key
-- on the look can never stop two parents who agree from being understood to agree.
CREATE OR REPLACE FUNCTION public.raise_child_same_look(p_a JSONB, p_b JSONB)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
AS $$
  SELECT coalesce(p_a -> 'skin', '""'::JSONB) = coalesce(p_b -> 'skin', '""'::JSONB)
     AND coalesce(p_a -> 'hair', '""'::JSONB) = coalesce(p_b -> 'hair', '""'::JSONB)
     AND coalesce(p_a -> 'outfit', '""'::JSONB) = coalesce(p_b -> 'outfit', '""'::JSONB);
$$;

COMMENT ON FUNCTION public.raise_child_same_name(TEXT, TEXT) IS
  'The same name apart from case and stray spaces.';
COMMENT ON FUNCTION public.raise_child_same_look(JSONB, JSONB) IS
  'The same skin, hair and colour.';

-- ---------------------------------------------------------------------------------
-- 3. Settling: when the two proposals agree, that is the child — and if six traits are
--    in as well, the childhood opens. Nothing here runs twice: the family leaves 'setup'.
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

COMMENT ON FUNCTION public.raise_child_settle_setup(UUID) IS
  'Names the child once both parents'' proposals agree, and opens the childhood when the traits are in too.';

-- ---------------------------------------------------------------------------------
-- 4. What each parent sees of the other's idea
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_setup_proposals()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  fam public.families%ROWTYPE;
  mine public.family_setup_proposals%ROWTYPE;
  theirs public.family_setup_proposals%ROWTYPE;
BEGIN
  PERFORM public.raise_child_require_couple();
  fam := public.raise_child_open_family();

  IF fam.id IS NULL THEN
    RETURN jsonb_build_object(
      'mine', NULL, 'partner', NULL,
      'name_same', false, 'look_same', false,
      'agreed', false, 'locked', false
    );
  END IF;

  SELECT * INTO mine FROM public.family_setup_proposals
   WHERE family_id = fam.id AND user_id = auth.uid();
  SELECT * INTO theirs FROM public.family_setup_proposals
   WHERE family_id = fam.id AND user_id <> auth.uid()
   ORDER BY created_at
   LIMIT 1;

  RETURN jsonb_build_object(
    'mine', CASE WHEN mine.family_id IS NULL THEN NULL
                 ELSE jsonb_build_object('name', mine.name, 'look', mine.look) END,
    'partner', CASE WHEN theirs.family_id IS NULL THEN NULL
                    ELSE jsonb_build_object('name', theirs.name, 'look', theirs.look) END,
    'name_same', mine.family_id IS NOT NULL AND theirs.family_id IS NOT NULL
      AND public.raise_child_same_name(mine.name, theirs.name),
    'look_same', mine.family_id IS NOT NULL AND theirs.family_id IS NOT NULL
      AND public.raise_child_same_look(mine.look, theirs.look),
    'agreed', mine.family_id IS NOT NULL AND theirs.family_id IS NOT NULL
      AND public.raise_child_same_name(mine.name, theirs.name)
      AND public.raise_child_same_look(mine.look, theirs.look),
    'locked', fam.status <> 'setup'
  );
END;
$$;

COMMENT ON FUNCTION public.raise_child_setup_proposals() IS
  'Both parents'' suggested names and faces, as this parent is allowed to see them.';

-- ---------------------------------------------------------------------------------
-- 5. Proposing: the same call the app already makes, but it can no longer name the child
--    on its own. A name here is a suggestion and nothing more.
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_setup(
  p_name TEXT DEFAULT NULL,
  p_look JSONB DEFAULT NULL,
  p_traits TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  cid UUID;
  fam public.families%ROWTYPE;
  chosen_traits TEXT[] := NULL;
  clean_name TEXT := nullif(btrim(coalesce(p_name, '')), '');
BEGIN
  cid := public.raise_child_require_couple();
  fam := public.raise_child_open_family();

  IF p_traits IS NOT NULL AND cardinality(p_traits) > 0 THEN
    chosen_traits := public.raise_child_validate_traits(p_traits);
  END IF;

  IF fam.id IS NULL THEN
    INSERT INTO public.families (couple_id, created_by) VALUES (cid, caller) RETURNING * INTO fam;
  END IF;

  INSERT INTO public.family_parents (family_id, user_id, traits)
  VALUES (fam.id, caller, coalesce(chosen_traits, '{}'))
  ON CONFLICT (family_id, user_id) DO UPDATE
    SET traits = CASE WHEN cardinality(EXCLUDED.traits) = 3 THEN EXCLUDED.traits ELSE public.family_parents.traits END;

  -- While the family is still being set up, a name is a proposal. Once the childhood has
  -- begun the name is settled and this is deliberately ignored: neither parent can rename
  -- the child alone, and a late client cannot smuggle one in.
  IF fam.status = 'setup' AND clean_name IS NOT NULL THEN
    INSERT INTO public.family_setup_proposals (family_id, user_id, name, look)
    VALUES (fam.id, caller, clean_name, coalesce(p_look, '{}'::JSONB))
    ON CONFLICT (family_id, user_id) DO UPDATE
      SET name = EXCLUDED.name,
          look = CASE WHEN p_look IS NULL THEN public.family_setup_proposals.look ELSE EXCLUDED.look END,
          updated_at = now();
  END IF;

  PERFORM public.raise_child_settle_setup(fam.id);

  RETURN public.raise_child_state();
END;
$$;

COMMENT ON FUNCTION public.raise_child_setup(TEXT, JSONB, TEXT[]) IS
  'Saves this parent''s traits and their suggested name and face. The child is named only when both parents agree.';

-- ---------------------------------------------------------------------------------
-- 6. Moving to the other's idea: "Use Mia" or "Use their face", deliberately
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_adopt_setup(p_part TEXT DEFAULT 'all')
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  fam public.families%ROWTYPE;
  mine public.family_setup_proposals%ROWTYPE;
  theirs public.family_setup_proposals%ROWTYPE;
  part TEXT := lower(coalesce(nullif(btrim(p_part), ''), 'all'));
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to raise a child.'; END IF;
  fam := public.raise_child_open_family();
  IF fam.id IS NULL THEN RAISE EXCEPTION 'Start the family first.'; END IF;
  IF fam.status <> 'setup' THEN
    RAISE EXCEPTION 'The name is settled now.';
  END IF;
  IF part NOT IN ('name', 'look', 'all') THEN
    RAISE EXCEPTION 'There is nothing to match there.';
  END IF;

  SELECT * INTO theirs FROM public.family_setup_proposals
   WHERE family_id = fam.id AND user_id <> auth.uid()
   ORDER BY created_at
   LIMIT 1;
  IF theirs.family_id IS NULL THEN
    RAISE EXCEPTION 'Your partner has not suggested a name yet.';
  END IF;

  SELECT * INTO mine FROM public.family_setup_proposals
   WHERE family_id = fam.id AND user_id = auth.uid();

  -- With nothing of my own yet, adopting anything means taking their whole suggestion.
  INSERT INTO public.family_setup_proposals (family_id, user_id, name, look)
  VALUES (fam.id, auth.uid(), theirs.name, theirs.look)
  ON CONFLICT (family_id, user_id) DO UPDATE
    SET name = CASE
          WHEN part IN ('name', 'all') THEN theirs.name
          ELSE public.family_setup_proposals.name
        END,
        look = CASE
          WHEN part IN ('look', 'all') THEN theirs.look
          ELSE public.family_setup_proposals.look
        END,
        updated_at = now();

  PERFORM public.raise_child_settle_setup(fam.id);

  RETURN public.raise_child_state();
END;
$$;

COMMENT ON FUNCTION public.raise_child_adopt_setup(TEXT) IS
  '"Use their name" / "use their face" / both, then settle the child if that made the two agree.';

-- ---------------------------------------------------------------------------------
-- 7. Permissions
-- ---------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.raise_child_same_name(TEXT, TEXT), public.raise_child_same_look(JSONB, JSONB),
  public.raise_child_settle_setup(UUID)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.raise_child_setup_proposals(), public.raise_child_adopt_setup(TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raise_child_setup_proposals(), public.raise_child_adopt_setup(TEXT)
  TO authenticated;

-- raise_child_setup keeps the grant it already had; the body simply proposes now.
GRANT EXECUTE ON FUNCTION public.raise_child_setup(TEXT, JSONB, TEXT[]) TO authenticated;

-- ---------------------------------------------------------------------------------
-- 8. Realtime: the partner's suggestion appears without a refresh
-- ---------------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
         AND tablename = 'family_setup_proposals'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.family_setup_proposals;
    END IF;
  END IF;
END $$;

COMMIT;
