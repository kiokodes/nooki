-- Raise a Child: two partners raising one child, from birth to eighteen, deciding every
-- big moment together. Additive only — no existing table is altered or removed.
--
-- Where the truth lives:
--   game_config          the only place the pacing numbers live (moments per day,
--                        timeout hours, chapters per day, gifts per day)
--   trait_catalog        the parent traits to choose from and the child traits that can
--                        show up, so the owner can add more without a deploy
--   families             one open family per couple (archived ones stay for the album)
--   family_parents       each parent's three traits and hidden bond
--   child_state          the child: name, look, hidden temperament, up to four visible
--                        traits, mood, age, and whose year it is
--   event_templates      the owner's own content, uploaded and validated by
--                        scripts/raise-a-child-events.mjs; never seeded here
--   family_moments       one row per moment instance in this family
--   family_votes         the private picks; RLS shows the partner's only after the reveal
--   album_entries        every outcome, gift, milestone and note, with the child's age
--   family_gifts         the little surprise cards the child leaves a parent
--
-- All the resolving happens in this file's functions, so both phones always agree.
BEGIN;

-- ---------------------------------------------------------------------------------
-- 1. Tuning, traits and temperaments (data, not code)
-- ---------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.game_config (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  moments_per_day SMALLINT NOT NULL DEFAULT 1 CHECK (moments_per_day BETWEEN 0 AND 3),
  timeout_hours SMALLINT NOT NULL DEFAULT 24 CHECK (timeout_hours BETWEEN 1 AND 168),
  chapters_per_day SMALLINT NOT NULL DEFAULT 1 CHECK (chapters_per_day BETWEEN 0 AND 1),
  gifts_per_day SMALLINT NOT NULL DEFAULT 1 CHECK (gifts_per_day BETWEEN 0 AND 2),
  -- A chapter is a year: three moments in it, two while the child is very small.
  moments_per_chapter SMALLINT NOT NULL DEFAULT 3 CHECK (moments_per_chapter BETWEEN 1 AND 4),
  moments_young SMALLINT NOT NULL DEFAULT 2 CHECK (moments_young BETWEEN 1 AND 3),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.game_config
  ADD COLUMN IF NOT EXISTS moments_per_chapter SMALLINT NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS moments_young SMALLINT NOT NULL DEFAULT 2;
INSERT INTO public.game_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.game_config IS
  'One row. Tune the game''s pacing here; no code change and no deploy needed.';

CREATE TABLE IF NOT EXISTS public.trait_catalog (
  slug TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('parent', 'child')),
  blurb TEXT,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.trait_catalog (slug, label, kind, blurb, sort_order) VALUES
  ('patient', 'Patient', 'parent', 'You wait for the second telling.', 10),
  ('funny', 'Funny', 'parent', 'You find the joke in the middle of it.', 20),
  ('strict', 'Strict', 'parent', 'You like the line where you drew it.', 30),
  ('adventurous', 'Adventurous', 'parent', 'You say yes before the plan is finished.', 40),
  ('anxious', 'Anxious', 'parent', 'You think of the thing that could go wrong.', 50),
  ('creative', 'Creative', 'parent', 'You make something out of nothing.', 60),
  ('calm', 'Calm', 'parent', 'Your voice stays low when the room doesn''t.', 70),
  ('curious', 'Curious', 'parent', 'You ask one more question.', 80),
  ('warm', 'Warm', 'parent', 'You make the room easier to be in.', 90),
  ('organised', 'Organised', 'parent', 'You know where the forms are.', 100)
ON CONFLICT (slug) DO UPDATE SET label = EXCLUDED.label, kind = EXCLUDED.kind,
  blurb = coalesce(EXCLUDED.blurb, public.trait_catalog.blurb), sort_order = EXCLUDED.sort_order;

-- The child's visible traits. The first word of each outcome effect key must be one of
-- these (or a future row the owner adds).
INSERT INTO public.trait_catalog (slug, label, kind, blurb, sort_order) VALUES
  ('kind', 'Kind', 'child', 'Notices who needs something.', 210),
  ('stubborn', 'Stubborn', 'child', 'Holds on to a decision.', 230),
  ('shy', 'Shy', 'child', 'Takes a while to warm up.', 240),
  ('brave', 'Brave', 'child', 'Goes first, sometimes scared.', 250),
  ('playful', 'Playful', 'child', 'Finds the game in the day.', 260),
  ('thoughtful', 'Thoughtful', 'child', 'Thinks before saying.', 270),
  ('honest', 'Honest', 'child', 'Says the true thing.', 280),
  ('gentle', 'Gentle', 'child', 'Handles things carefully.', 290),
  ('messy', 'Messy', 'child', 'Leaves a trail of happy evidence.', 300),
  ('proud', 'Proud', 'child', 'Stands a little taller.', 310),
  ('restless', 'Restless', 'child', 'Needs to be moving.', 320)
ON CONFLICT (slug) DO UPDATE SET label = EXCLUDED.label, kind = EXCLUDED.kind,
  blurb = coalesce(EXCLUDED.blurb, public.trait_catalog.blurb), sort_order = EXCLUDED.sort_order;

CREATE TABLE IF NOT EXISTS public.temperaments (
  slug TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  base_weight SMALLINT NOT NULL DEFAULT 10 CHECK (base_weight BETWEEN 0 AND 100),
  active BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO public.temperaments (slug, label, base_weight) VALUES
  ('sunny', 'Sunny', 14),
  ('dreamy', 'Dreamy', 12),
  ('bold', 'Bold', 12),
  ('steady', 'Steady', 14),
  ('gentle', 'Gentle', 12),
  ('spirited', 'Spirited', 12)
ON CONFLICT (slug) DO NOTHING;

-- Which parent traits make which temperament more likely. Never a guarantee: the
-- function below is a weighted draw, and nothing on a phone is ever told the result.
CREATE TABLE IF NOT EXISTS public.temperament_bias (
  trait_slug TEXT NOT NULL REFERENCES public.trait_catalog(slug) ON DELETE CASCADE,
  temperament_slug TEXT NOT NULL REFERENCES public.temperaments(slug) ON DELETE CASCADE,
  weight SMALLINT NOT NULL DEFAULT 0 CHECK (weight BETWEEN -20 AND 20),
  PRIMARY KEY (trait_slug, temperament_slug)
);

INSERT INTO public.temperament_bias (trait_slug, temperament_slug, weight) VALUES
  ('creative', 'dreamy', 8), ('creative', 'sunny', 4),
  ('funny', 'sunny', 8), ('funny', 'spirited', 4),
  ('adventurous', 'bold', 8), ('adventurous', 'spirited', 4),
  ('calm', 'steady', 8), ('calm', 'gentle', 4),
  ('warm', 'gentle', 8), ('warm', 'sunny', 4),
  ('curious', 'dreamy', 6), ('curious', 'bold', 4),
  ('strict', 'steady', 6), ('strict', 'spirited', 3),
  ('anxious', 'gentle', 5), ('anxious', 'steady', 3),
  ('organised', 'steady', 7),
  ('patient', 'gentle', 6), ('patient', 'steady', 4)
ON CONFLICT (trait_slug, temperament_slug) DO NOTHING;

-- ---------------------------------------------------------------------------------
-- 2. The family
-- ---------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.families (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'active', 'letter', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS families_one_open_per_couple
  ON public.families (couple_id) WHERE status <> 'archived';
CREATE INDEX IF NOT EXISTS families_couple_idx ON public.families (couple_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.family_parents (
  family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  traits TEXT[] NOT NULL DEFAULT '{}',
  bond SMALLINT NOT NULL DEFAULT 55 CHECK (bond BETWEEN 0 AND 100),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, user_id),
  CONSTRAINT family_parents_three_traits CHECK (cardinality(traits) <= 3)
);

CREATE TABLE IF NOT EXISTS public.child_state (
  family_id UUID PRIMARY KEY REFERENCES public.families(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  look JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(look) = 'object'),
  -- The temperament is for the server's eyes only: no RPC ever returns it.
  temperament TEXT REFERENCES public.temperaments(slug) ON DELETE SET NULL,
  visible_traits TEXT[] NOT NULL DEFAULT '{}',
  mood TEXT NOT NULL DEFAULT 'content',
  age SMALLINT NOT NULL DEFAULT 0 CHECK (age BETWEEN 0 AND 18),
  lead_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  last_tick_day DATE,
  last_age_up_day DATE,
  letter JSONB,
  letter_written_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT child_state_four_traits CHECK (cardinality(visible_traits) <= 4)
);

-- ---------------------------------------------------------------------------------
-- 3. The owner's content, and this family's play through it
-- ---------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.event_templates (
  slug TEXT PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  min_age SMALLINT NOT NULL CHECK (min_age BETWEEN 0 AND 17),
  max_age SMALLINT NOT NULL CHECK (max_age BETWEEN 0 AND 17),
  category TEXT NOT NULL CHECK (category IN ('home', 'school', 'friends', 'health', 'money', 'values', 'fun')),
  required_trait_tags TEXT[] NOT NULL DEFAULT '{}',
  excluded_trait_tags TEXT[] NOT NULL DEFAULT '{}',
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 80),
  setup_text TEXT NOT NULL CHECK (char_length(btrim(setup_text)) BETWEEN 1 AND 220),
  choices JSONB NOT NULL CHECK (jsonb_typeof(choices) = 'array' AND jsonb_array_length(choices) BETWEEN 2 AND 4),
  tone TEXT,
  active BOOLEAN NOT NULL DEFAULT false,
  batch TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_templates_age_range CHECK (min_age <= max_age)
);

CREATE INDEX IF NOT EXISTS event_templates_active_age
  ON public.event_templates (min_age, max_age, category) WHERE active = true;

CREATE TABLE IF NOT EXISTS public.family_moments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  age SMALLINT NOT NULL CHECK (age BETWEEN 0 AND 18),
  day DATE NOT NULL DEFAULT (timezone('utc'::text, now()))::date,
  event_slug TEXT NOT NULL REFERENCES public.event_templates(slug) ON DELETE RESTRICT,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  lead_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  agreement BOOLEAN,
  chosen_choice SMALLINT CHECK (chosen_choice BETWEEN 1 AND 4),
  outcome_text TEXT,
  outcome JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT family_moments_once_per_family UNIQUE (family_id, event_slug)
);

CREATE INDEX IF NOT EXISTS family_moments_family_age ON public.family_moments (family_id, age, created_at);

CREATE TABLE IF NOT EXISTS public.family_votes (
  moment_id UUID NOT NULL REFERENCES public.family_moments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  choice_index SMALLINT NOT NULL CHECK (choice_index BETWEEN 1 AND 4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (moment_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.album_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('moment', 'gift', 'milestone', 'note', 'letter')),
  age SMALLINT NOT NULL CHECK (age BETWEEN 0 AND 18),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  moment_id UUID REFERENCES public.family_moments(id) ON DELETE SET NULL,
  author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS album_entries_family_age ON public.album_entries (family_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.family_gifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day DATE NOT NULL DEFAULT (timezone('utc'::text, now()))::date,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  opened_at TIMESTAMPTZ,
  album_entry_id UUID REFERENCES public.album_entries(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (family_id, user_id, day)
);

-- The outbox behind the one warm notification a parent may get in a day. The primary
-- key is what makes "at most one per day per user" true in the database, not in code.
CREATE TABLE IF NOT EXISTS public.raise_child_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  day DATE NOT NULL DEFAULT (timezone('utc'::text, now()))::date,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  UNIQUE (user_id, day)
);

-- ---------------------------------------------------------------------------------
-- 4. Row Level Security: the couple, and only the couple
-- ---------------------------------------------------------------------------------

ALTER TABLE public.game_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trait_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.temperaments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.temperament_bias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.families ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_parents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.child_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_moments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.album_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_gifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.raise_child_notifications ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.family_moments REPLICA IDENTITY FULL;
ALTER TABLE public.family_votes REPLICA IDENTITY FULL;
ALTER TABLE public.family_gifts REPLICA IDENTITY FULL;
ALTER TABLE public.album_entries REPLICA IDENTITY FULL;

-- The tuning row and the trait lists are read by every signed-in phone and written by
-- the owner only.
DROP POLICY IF EXISTS game_config_read ON public.game_config;
CREATE POLICY game_config_read ON public.game_config FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS trait_catalog_read ON public.trait_catalog;
CREATE POLICY trait_catalog_read ON public.trait_catalog FOR SELECT TO authenticated USING (active = true);
DROP POLICY IF EXISTS temperaments_read ON public.temperaments;
CREATE POLICY temperaments_read ON public.temperaments FOR SELECT TO authenticated USING (active = true);
DROP POLICY IF EXISTS temperament_bias_read ON public.temperament_bias;
CREATE POLICY temperament_bias_read ON public.temperament_bias FOR SELECT TO authenticated USING (true);

-- Content: active rows only, and only signed-in accounts. Only the service role writes.
DROP POLICY IF EXISTS event_templates_read_active ON public.event_templates;
CREATE POLICY event_templates_read_active ON public.event_templates
  FOR SELECT TO authenticated USING (active = true);

-- The family's own rows.
DROP POLICY IF EXISTS families_read_couple ON public.families;
CREATE POLICY families_read_couple ON public.families FOR SELECT TO authenticated
  USING (couple_id = public.get_user_couple_id(auth.uid()));
DROP POLICY IF EXISTS family_parents_read_couple ON public.family_parents;
CREATE POLICY family_parents_read_couple ON public.family_parents FOR SELECT TO authenticated
  USING (family_id IN (SELECT id FROM public.families WHERE couple_id = public.get_user_couple_id(auth.uid())));
DROP POLICY IF EXISTS child_state_read_couple ON public.child_state;
CREATE POLICY child_state_read_couple ON public.child_state FOR SELECT TO authenticated
  USING (family_id IN (SELECT id FROM public.families WHERE couple_id = public.get_user_couple_id(auth.uid())));
DROP POLICY IF EXISTS family_moments_read_couple ON public.family_moments;
CREATE POLICY family_moments_read_couple ON public.family_moments FOR SELECT TO authenticated
  USING (family_id IN (SELECT id FROM public.families WHERE couple_id = public.get_user_couple_id(auth.uid())));
DROP POLICY IF EXISTS album_entries_read_couple ON public.album_entries;
CREATE POLICY album_entries_read_couple ON public.album_entries FOR SELECT TO authenticated
  USING (family_id IN (SELECT id FROM public.families WHERE couple_id = public.get_user_couple_id(auth.uid())));
DROP POLICY IF EXISTS family_gifts_read_own ON public.family_gifts;
CREATE POLICY family_gifts_read_own ON public.family_gifts FOR SELECT TO authenticated
  USING (user_id = auth.uid()
    AND family_id IN (SELECT id FROM public.families WHERE couple_id = public.get_user_couple_id(auth.uid())));
DROP POLICY IF EXISTS raise_child_notifications_read_own ON public.raise_child_notifications;
CREATE POLICY raise_child_notifications_read_own ON public.raise_child_notifications FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- A vote is private until both parents have voted: the same shape Daily Decisions uses.
CREATE OR REPLACE FUNCTION public.can_read_family_vote(p_moment_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  fam UUID;
BEGIN
  IF caller IS NULL THEN RETURN FALSE; END IF;
  SELECT m.family_id INTO fam
    FROM public.family_moments m
   WHERE m.id = p_moment_id
     AND m.family_id IN (SELECT id FROM public.families WHERE couple_id = public.get_user_couple_id(caller));
  IF fam IS NULL THEN RETURN FALSE; END IF;
  IF p_user_id = caller THEN RETURN TRUE; END IF;
  RETURN EXISTS (SELECT 1 FROM public.family_votes v WHERE v.moment_id = p_moment_id AND v.user_id = caller)
     AND EXISTS (SELECT 1 FROM public.family_votes v WHERE v.moment_id = p_moment_id AND v.user_id = p_user_id);
END;
$$;

DROP POLICY IF EXISTS family_votes_read_until_reveal ON public.family_votes;
CREATE POLICY family_votes_read_until_reveal ON public.family_votes FOR SELECT TO authenticated
  USING (public.can_read_family_vote(moment_id, user_id));

-- The app never writes these tables directly: every write is a function below.
REVOKE ALL ON public.game_config, public.trait_catalog, public.temperaments, public.temperament_bias,
  public.families, public.family_parents, public.child_state, public.event_templates,
  public.family_moments, public.family_votes, public.album_entries, public.family_gifts,
  public.raise_child_notifications
  FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.game_config, public.trait_catalog, public.temperaments, public.temperament_bias,
  public.families, public.event_templates,
  public.family_moments, public.family_votes, public.album_entries, public.family_gifts,
  public.raise_child_notifications
  TO authenticated;

-- Two tables are only ever read through the state function, so the client cannot
-- select the columns that must stay hidden: the temperament the child was born with,
-- and either parent's bond. Column grants make that a database fact, not a promise.
GRANT SELECT (family_id, user_id, traits, joined_at) ON public.family_parents TO authenticated;
GRANT SELECT (family_id, name, look, visible_traits, mood, age, lead_user_id, letter,
  letter_written_at, created_at, updated_at) ON public.child_state TO authenticated;

GRANT ALL ON public.game_config, public.trait_catalog, public.temperaments, public.temperament_bias,
  public.families, public.family_parents, public.child_state, public.event_templates,
  public.family_moments, public.family_votes, public.album_entries, public.family_gifts,
  public.raise_child_notifications
  TO service_role;

-- ---------------------------------------------------------------------------------
-- 5. Helpers: who is asking, and the family they belong to
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_config()
RETURNS public.game_config
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT * FROM public.game_config WHERE id;
$$;

-- The caller's couple, or an exception. Every app-facing function starts here.
CREATE OR REPLACE FUNCTION public.raise_child_require_couple()
RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE cid UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in to raise a child.';
  END IF;
  SELECT couple_id INTO cid FROM public.profiles WHERE id = auth.uid();
  IF cid IS NULL THEN
    RAISE EXCEPTION 'Pair with your partner first.';
  END IF;
  RETURN cid;
END;
$$;

-- This couple's family, archived ones excluded: one child at a time.
CREATE OR REPLACE FUNCTION public.raise_child_open_family()
RETURNS public.families
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE fam public.families%ROWTYPE;
BEGIN
  SELECT * INTO fam
    FROM public.families
   WHERE couple_id = public.raise_child_require_couple()
     AND status <> 'archived'
   ORDER BY created_at DESC
   LIMIT 1;
  RETURN fam;
END;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_guard_family(p_family_id UUID)
RETURNS public.families
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE fam public.families%ROWTYPE;
BEGIN
  SELECT * INTO fam FROM public.families WHERE id = p_family_id;
  IF fam.id IS NULL THEN
    RAISE EXCEPTION 'That family is not here any more.';
  END IF;
  IF fam.couple_id <> public.get_user_couple_id(auth.uid()) THEN
    RAISE EXCEPTION 'That family belongs to another couple.';
  END IF;
  RETURN fam;
END;
$$;

-- The two parents, oldest first: parent A is the one who started the family.
CREATE OR REPLACE FUNCTION public.raise_child_parents(p_family_id UUID)
RETURNS UUID[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT coalesce(array_agg(user_id ORDER BY joined_at, user_id), '{}'::UUID[])
    FROM public.family_parents WHERE family_id = p_family_id;
$$;

-- --- Traits ----------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_validate_traits(p_traits TEXT[])
RETURNS TEXT[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE cleaned TEXT[];
BEGIN
  SELECT array_agg(DISTINCT btrim(t) ORDER BY btrim(t)) INTO cleaned
    FROM unnest(coalesce(p_traits, '{}'::TEXT[])) AS t
   WHERE btrim(t) <> '';
  IF cleaned IS NULL OR cardinality(cleaned) <> 3 THEN
    RAISE EXCEPTION 'Choose exactly three traits.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(cleaned) AS t
     WHERE NOT EXISTS (
       SELECT 1 FROM public.trait_catalog c WHERE c.slug = t AND c.kind = 'parent' AND c.active
     )
  ) THEN
    RAISE EXCEPTION 'One of those traits is not available.';
  END IF;
  RETURN cleaned;
END;
$$;

-- The weighted draw. Both parents' traits nudge the odds; nothing is guaranteed, and
-- the result never leaves the server.
CREATE OR REPLACE FUNCTION public.raise_child_temperament(p_traits_a TEXT[], p_traits_b TEXT[])
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  all_traits TEXT[] := coalesce(p_traits_a, '{}') || coalesce(p_traits_b, '{}');
  total NUMERIC := 0;
  picked TEXT;
  roll NUMERIC;
  running NUMERIC := 0;
  row RECORD;
BEGIN
  SELECT sum(greatest(1, t.base_weight + coalesce((
      SELECT sum(b.weight) FROM public.temperament_bias b
       WHERE b.temperament_slug = t.slug AND b.trait_slug = ANY(all_traits)
    ), 0))) INTO total
    FROM public.temperaments t WHERE t.active;
  IF total IS NULL OR total <= 0 THEN
    RETURN (SELECT slug FROM public.temperaments WHERE active ORDER BY slug LIMIT 1);
  END IF;
  roll := random() * total;
  FOR row IN
    SELECT t.slug,
           greatest(1, t.base_weight + coalesce((
             SELECT sum(b.weight) FROM public.temperament_bias b
              WHERE b.temperament_slug = t.slug AND b.trait_slug = ANY(all_traits)
           ), 0))::NUMERIC AS weight
      FROM public.temperaments t
     WHERE t.active
     ORDER BY t.slug
  LOOP
    running := running + row.weight;
    IF picked IS NULL AND roll <= running THEN
      picked := row.slug;
    END IF;
  END LOOP;
  RETURN coalesce(picked, (SELECT slug FROM public.temperaments WHERE active ORDER BY slug LIMIT 1));
END;
$$;

-- --- Bond: a number the server keeps, and a sentence the parent reads -------------

CREATE OR REPLACE FUNCTION public.raise_child_bond_band(p_bond SMALLINT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_bond >= 75 THEN 'close'
    WHEN p_bond >= 55 THEN 'warming'
    WHEN p_bond >= 35 THEN 'steady'
    ELSE 'finding'
  END;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_bond_line(p_bond SMALLINT, p_child TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_bond >= 75 THEN p_child || ' runs to you first when the door opens.'
    WHEN p_bond >= 55 THEN p_child || ' looks for you in the room before anyone else.'
    WHEN p_bond >= 35 THEN p_child || ' settles beside you when the day is quiet.'
    ELSE p_child || ' is still learning how to reach for you — gently, in their own time.'
  END;
$$;

-- --- Effects --------------------------------------------------------------------

-- Applies one choice's effects: at most four visible traits (oldest fades), a mood,
-- and a bond nudge. On a split the child feels it: the parent whose call it was
-- edges closer, the other is left a little further off. Nobody is punished for
-- their answer; the bond simply records what the child felt.
CREATE OR REPLACE FUNCTION public.raise_child_apply_effects(
  p_family_id UUID,
  p_effects JSONB,
  p_deciding UUID,
  p_other UUID,
  p_agreement BOOLEAN,
  p_deciding_bond_delta_extra SMALLINT DEFAULT 0
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  cs public.child_state%ROWTYPE;
  traits TEXT[];
  key TEXT;
  value SMALLINT;
  delta SMALLINT;
BEGIN
  SELECT * INTO cs FROM public.child_state WHERE family_id = p_family_id FOR UPDATE;
  IF cs.family_id IS NULL THEN RETURN; END IF;

  traits := coalesce(cs.visible_traits, '{}');
  IF jsonb_typeof(p_effects -> 'traits') = 'object' THEN
    FOR key, value IN SELECT k, (v #>> '{}')::SMALLINT FROM jsonb_each(p_effects -> 'traits') AS e(k, v) LOOP
      IF value > 0 THEN
        IF NOT (key = ANY(traits)) THEN
          traits := traits || key;
        END IF;
        WHILE cardinality(traits) > 4 LOOP
          traits := traits[2:cardinality(traits)];
        END LOOP;
      ELSIF value < 0 THEN
        traits := array_remove(traits, key);
      END IF;
    END LOOP;
  END IF;

  UPDATE public.child_state
     SET visible_traits = coalesce(traits, '{}'),
         mood = coalesce(nullif(p_effects ->> 'mood', ''), mood),
         updated_at = now()
   WHERE family_id = p_family_id;

  -- When the two of you picked differently, the option's own bond effect is not applied
  -- to either of you: the year simply carries the small split nudge, nothing more.
  delta := CASE WHEN p_agreement THEN coalesce((p_effects ->> 'bond')::SMALLINT, 0) ELSE 0 END;
  IF p_agreement THEN
    UPDATE public.family_parents SET bond = least(100, greatest(0, bond + delta))
     WHERE family_id = p_family_id;
  ELSE
    IF p_deciding IS NOT NULL THEN
      UPDATE public.family_parents SET bond = least(100, greatest(0, bond + delta + p_deciding_bond_delta_extra))
       WHERE family_id = p_family_id AND user_id = p_deciding;
    END IF;
    IF p_other IS NOT NULL THEN
      UPDATE public.family_parents SET bond = least(100, greatest(0, bond - p_deciding_bond_delta_extra))
       WHERE family_id = p_family_id AND user_id = p_other;
    END IF;
  END IF;
END;
$$;

-- --- Choosing the next event ------------------------------------------------------

-- Active events that fit this age, that this family has never seen, whose required
-- tags the parents (or the child so far) can meet and whose excluded tags they do
-- not. Categories the family has used least come first, so a year does not become
-- three school moments in a row.
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
  age_low SMALLINT := CASE WHEN p_wide THEN greatest(0, p_age - 1) ELSE p_age END;
  age_high SMALLINT := CASE WHEN p_wide THEN least(17, p_age + 1) ELSE p_age END;
BEGIN
  SELECT t.slug INTO picked
    FROM public.event_templates t
   WHERE t.active
     AND t.min_age <= age_high
     AND t.max_age >= age_low
     AND NOT EXISTS (
       SELECT 1 FROM public.family_moments m
        WHERE m.family_id = p_family_id AND m.event_slug = t.slug
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

-- The whole search: the right fit first, then a little wider, then any age, then a
-- quiet day. It never raises for missing content, because an empty library is a
-- normal state on the first day the game ships.
-- How many moments this chapter can hold: fewer while the child is tiny.
CREATE OR REPLACE FUNCTION public.raise_child_chapter_target(p_age SMALLINT)
RETURNS INTEGER
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT CASE WHEN coalesce(p_age, 0) <= 3
    THEN (SELECT moments_young FROM public.game_config WHERE id)
    ELSE (SELECT moments_per_chapter FROM public.game_config WHERE id)
  END;
$$;

/**
 * Whether this chapter has said everything it has to say. True when nothing is waiting on
 * either parent and the chapter has reached its size, or when there is no card left that
 * would fit the family. A quiet year can therefore end; a chapter that still has a card to
 * come cannot be skipped past.
 */
CREATE OR REPLACE FUNCTION public.raise_child_chapter_complete(p_family_id UUID, p_age SMALLINT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  held INTEGER;
  target INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.family_moments
     WHERE family_id = p_family_id AND age = p_age AND status = 'open'
  ) THEN
    RETURN FALSE;
  END IF;
  SELECT count(*) INTO held FROM public.family_moments
   WHERE family_id = p_family_id AND age = p_age;
  target := public.raise_child_chapter_target(p_age);
  IF held >= coalesce(target, 3) THEN
    RETURN TRUE;
  END IF;
  RETURN public.raise_child_choose_event(p_family_id, p_age) IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_choose_event(p_family_id UUID, p_age SMALLINT)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  traits TEXT[];
  picked TEXT;
BEGIN
  SELECT coalesce(array_agg(DISTINCT t), '{}')
    INTO traits
    FROM (
      SELECT unnest(fp.traits) AS t FROM public.family_parents fp WHERE fp.family_id = p_family_id
      UNION
      SELECT unnest(cs.visible_traits) FROM public.child_state cs WHERE cs.family_id = p_family_id
    ) s
   WHERE t IS NOT NULL;

  picked := public.raise_child_pick_event(p_family_id, p_age, traits, false, true);
  IF picked IS NULL THEN
    picked := public.raise_child_pick_event(p_family_id, p_age, traits, true, true);
  END IF;
  IF picked IS NULL THEN
    picked := public.raise_child_pick_event(p_family_id, p_age, traits, false, false);
  END IF;
  IF picked IS NULL THEN
    picked := public.raise_child_pick_event(p_family_id, p_age, traits, true, false);
  END IF;
  RETURN picked;
END;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_create_moment(p_family_id UUID, p_age SMALLINT, p_day DATE)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  chosen_slug TEXT;
  tpl public.event_templates%ROWTYPE;
  new_id UUID;
BEGIN
  chosen_slug := public.raise_child_choose_event(p_family_id, p_age);
  IF chosen_slug IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO tpl FROM public.event_templates WHERE event_templates.slug = chosen_slug;
  INSERT INTO public.family_moments (family_id, age, day, event_slug, category)
  VALUES (p_family_id, p_age, p_day, tpl.slug, tpl.category)
  ON CONFLICT (family_id, event_slug) DO NOTHING
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

-- ---------------------------------------------------------------------------------
-- 6. Resolving a moment: the lead parent rule, the effects and the album
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_resolve(p_moment_id UUID, p_force BOOLEAN DEFAULT false)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  m public.family_moments%ROWTYPE;
  fam public.families%ROWTYPE;
  cfg public.game_config%ROWTYPE;
  cs public.child_state%ROWTYPE;
  tpl public.event_templates%ROWTYPE;
  parents UUID[];
  parent_a UUID;
  parent_b UUID;
  a_choice SMALLINT;
  b_choice SMALLINT;
  both_voted BOOLEAN;
  agreed BOOLEAN;
  chosen SMALLINT;
  deciding UUID;
  other UUID;
  lead UUID;
  choice JSONB;
  outcome_line TEXT;
  outcome_json JSONB;
  notes TEXT;
  decider_name TEXT;
  child_name TEXT;
  due BOOLEAN;
BEGIN
  SELECT * INTO m FROM public.family_moments WHERE id = p_moment_id FOR UPDATE;
  IF m.id IS NULL THEN RAISE EXCEPTION 'That moment is not here any more.'; END IF;
  IF m.status = 'resolved' THEN RETURN m.outcome; END IF;

  SELECT * INTO fam FROM public.families WHERE id = m.family_id;
  -- A signed-in caller must be one of the two parents; the daily job has no caller.
  IF auth.uid() IS NOT NULL AND fam.couple_id IS DISTINCT FROM public.get_user_couple_id(auth.uid()) THEN
    RAISE EXCEPTION 'That moment belongs to another couple.';
  END IF;

  cfg := public.raise_child_config();
  parents := public.raise_child_parents(m.family_id);
  parent_a := parents[1];
  parent_b := parents[2];
  SELECT choice_index INTO a_choice FROM public.family_votes WHERE moment_id = m.id AND user_id = parent_a;
  SELECT choice_index INTO b_choice FROM public.family_votes WHERE moment_id = m.id AND user_id = parent_b;
  both_voted := a_choice IS NOT NULL AND b_choice IS NOT NULL;
  due := now() >= m.created_at + make_interval(hours => cfg.timeout_hours);

  IF NOT both_voted THEN
    IF a_choice IS NULL AND b_choice IS NULL THEN RETURN NULL; END IF;
    IF NOT (p_force AND due) THEN RETURN NULL; END IF;
  END IF;

  SELECT * INTO cs FROM public.child_state WHERE family_id = m.family_id;
  SELECT * INTO tpl FROM public.event_templates WHERE slug = m.event_slug;
  lead := coalesce(cs.lead_user_id, parent_a);

  IF both_voted THEN
    agreed := a_choice = b_choice;
    IF agreed THEN
      chosen := a_choice;
      deciding := NULL;
      other := NULL;
    ELSE
      chosen := CASE WHEN lead = parent_a THEN a_choice ELSE b_choice END;
      deciding := lead;
      other := CASE WHEN lead = parent_a THEN parent_b ELSE parent_a END;
    END IF;
  ELSE
    -- Nobody answered in time: the pick that was made counts, quietly.
    agreed := false;
    chosen := coalesce(a_choice, b_choice);
    deciding := CASE WHEN a_choice IS NOT NULL THEN parent_a ELSE parent_b END;
    other := CASE WHEN a_choice IS NOT NULL THEN parent_b ELSE parent_a END;
  END IF;

  choice := tpl.choices -> (chosen - 1);
  IF choice IS NULL OR jsonb_typeof(choice) <> 'object' THEN
    RAISE EXCEPTION 'That moment has no outcome for that choice.';
  END IF;
  outcome_line := choice ->> 'outcome_text';

  SELECT name INTO decider_name FROM public.profiles WHERE id = coalesce(deciding, lead);
  SELECT name INTO child_name FROM public.child_state WHERE family_id = m.family_id;

  IF agreed THEN
    notes := 'You both wanted the same thing. ' || child_name || ' felt that.';
  ELSIF both_voted THEN
    notes := 'You wanted different things. This year went with ' || coalesce(decider_name, 'your other half') || '’s call.';
  ELSE
    notes := 'We went with ' || coalesce(decider_name, 'the pick that was made') || '’s pick.';
  END IF;

  -- A timeout is not a split and carries no penalty: the picked outcome happens, and
  -- neither parent's bond moves. A real split nudges both by one, and no further.
  PERFORM public.raise_child_apply_effects(
    m.family_id,
    coalesce(choice -> 'effects', '{}'::JSONB),
    CASE WHEN agreed OR NOT both_voted THEN NULL ELSE deciding END,
    CASE WHEN agreed OR NOT both_voted THEN NULL ELSE other END,
    agreed,
    (CASE WHEN agreed OR NOT both_voted THEN 0 ELSE 1 END)::SMALLINT
  );

  outcome_json := jsonb_build_object(
    'agreement', agreed,
    'split', both_voted AND NOT agreed,
    'timed_out', NOT both_voted,
    'chosen_index', chosen,
    'chosen_label', choice ->> 'label',
    'outcome_text', outcome_line,
    'note', notes,
    'decided_by', coalesce(deciding, lead),
    'decided_by_name', decider_name
  );

  UPDATE public.family_moments
     SET status = 'resolved',
         chosen_choice = chosen,
         agreement = agreed,
         lead_user_id = coalesce(deciding, lead),
         outcome_text = outcome_line,
         outcome = outcome_json,
         resolved_at = now()
   WHERE id = m.id;

  INSERT INTO public.album_entries (family_id, kind, age, title, body, moment_id)
  VALUES (m.family_id, 'moment', m.age, tpl.title, outcome_line, m.id);

  RETURN outcome_json;
END;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_resolve_due(p_family_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  cfg public.game_config%ROWTYPE;
  r RECORD;
  resolved INTEGER := 0;
BEGIN
  cfg := public.raise_child_config();
  FOR r IN
    SELECT id FROM public.family_moments
     WHERE family_id = p_family_id
       AND status = 'open'
       AND now() >= created_at + make_interval(hours => cfg.timeout_hours)
  LOOP
    IF public.raise_child_resolve(r.id, true) IS NOT NULL THEN
      resolved := resolved + 1;
    END IF;
  END LOOP;
  RETURN resolved;
END;
$$;

-- ---------------------------------------------------------------------------------
-- 7. The cosy layer: gifts, the daily tick and the one warm notification
-- ---------------------------------------------------------------------------------

-- The child's small gifts are the game's own warmth, not the owner's event content:
-- they are derived from the child's age and the traits the family has grown, and are
-- written here so they can never drift out of tone.
CREATE OR REPLACE FUNCTION public.raise_child_gift_copy(p_age SMALLINT, p_traits TEXT[], p_child TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  kind_trait BOOLEAN := 'kind' = ANY(coalesce(p_traits, '{}'));
  playful BOOLEAN := 'playful' = ANY(coalesce(p_traits, '{}'));
BEGIN
  IF p_age <= 2 THEN
    RETURN jsonb_build_object(
      'slug', 'first-word',
      'title', p_child || ' said your name',
      'body', 'It came out sideways the first time, and then again, much clearer. The whole room went quiet so it could be said twice.'
    );
  ELSIF p_age <= 6 THEN
    RETURN jsonb_build_object(
      'slug', 'drawing',
      'title', p_child || ' left you a drawing',
      'body', 'Three stick people holding hands, a sun in the corner with far too many rays, and you in the middle of it all.'
    );
  ELSIF p_age <= 10 THEN
    RETURN jsonb_build_object(
      'slug', 'note',
      'title', p_child || ' wrote you a note',
      'body', 'It was folded four times and taped shut, and it said — in careful capitals — that you are their favourite grown-up.'
    );
  ELSIF p_age <= 14 THEN
    RETURN jsonb_build_object(
      'slug', 'song',
      'title', p_child || ' sent you a song',
      'body', 'No message with it, just a link and a shy little "this one reminded me of you".'
    );
  ELSIF p_age <= 16 THEN
    RETURN jsonb_build_object(
      'slug', 'tea',
      'title', p_child || ' made you tea',
      'body', 'Made it exactly the way you take it, without being asked, and left it where you always sit.'
    );
  ELSE
    RETURN jsonb_build_object(
      'slug', CASE WHEN kind_trait OR playful THEN 'hug' ELSE 'letter' END,
      'title', p_child || ' left you a line',
      'body', 'Written on the back of a school sheet: "I know you two decided everything together. I noticed. Thank you."'
    );
  END IF;
END;
$$;

-- One gift for one parent, weighted by that parent's bond: the child leans toward
-- whoever has been closest this year, never away from the other.
-- One small surprise for each parent, every day. Nobody is skipped because the other
-- parent was drawn instead: a gift is a hello, not a competition.
CREATE OR REPLACE FUNCTION public.raise_child_create_gift(p_family_id UUID, p_day DATE)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  cs public.child_state%ROWTYPE;
  parent RECORD;
  copy JSONB;
  entry UUID;
  created INTEGER := 0;
BEGIN
  SELECT * INTO cs FROM public.child_state WHERE family_id = p_family_id;
  IF cs.family_id IS NULL THEN RETURN 0; END IF;

  FOR parent IN
    SELECT fp.user_id FROM public.family_parents fp
     WHERE fp.family_id = p_family_id AND fp.bond > 0
     ORDER BY fp.joined_at, fp.user_id
  LOOP
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.family_gifts
       WHERE family_id = p_family_id AND user_id = parent.user_id AND day = p_day
    );
    copy := public.raise_child_gift_copy(cs.age, cs.visible_traits, cs.name);
    INSERT INTO public.album_entries (family_id, kind, age, title, body)
    VALUES (p_family_id, 'gift', cs.age, copy ->> 'title', copy ->> 'body')
    RETURNING id INTO entry;
    INSERT INTO public.family_gifts (family_id, user_id, day, slug, title, body, album_entry_id)
    VALUES (p_family_id, parent.user_id, p_day, copy ->> 'slug', copy ->> 'title', copy ->> 'body', entry);
    created := created + 1;
  END LOOP;

  RETURN created;
END;
$$;

-- One warm line a day at most, per parent, and always in the child's voice.
CREATE OR REPLACE FUNCTION public.raise_child_queue_notification(p_family_id UUID, p_day DATE)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  cs public.child_state%ROWTYPE;
  p RECORD;
  gift RECORD;
  open_moments INTEGER;
BEGIN
  SELECT * INTO cs FROM public.child_state WHERE family_id = p_family_id;
  IF cs.family_id IS NULL THEN RETURN; END IF;
  SELECT count(*) INTO open_moments FROM public.family_moments WHERE family_id = p_family_id AND status = 'open';
  FOR p IN SELECT user_id FROM public.family_parents WHERE family_id = p_family_id LOOP
    SELECT * INTO gift FROM public.family_gifts
      WHERE family_id = p_family_id AND user_id = p.user_id AND day = p_day
      ORDER BY created_at DESC LIMIT 1;
    INSERT INTO public.raise_child_notifications (user_id, family_id, day, title, body)
    VALUES (
      p.user_id,
      p_family_id,
      p_day,
      CASE WHEN gift.id IS NOT NULL THEN gift.title
           WHEN open_moments > 0 THEN cs.name || ' saved you a seat at the table'
           ELSE cs.name || ' is thinking about you' END,
      CASE WHEN gift.id IS NOT NULL THEN left(gift.body, 140)
           WHEN open_moments > 0 THEN cs.name || ' left something small for the two of you on the table.'
           ELSE 'A quiet day in the house. Nothing is waiting on you.' END
    )
    ON CONFLICT (user_id, day) DO NOTHING;
  END LOOP;
END;
$$;

-- Everything a new day needs for one family. Safe to run as often as you like: the
-- last_tick_day guard means the day's content is created once.
CREATE OR REPLACE FUNCTION public.raise_child_tick_family(p_family_id UUID, p_day DATE DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  tick_day DATE := coalesce(p_day, (timezone('utc'::text, now()))::date);
  fam public.families%ROWTYPE;
  cs public.child_state%ROWTYPE;
  cfg public.game_config%ROWTYPE;
  created INTEGER := 0;
  gifts INTEGER := 0;
  resolved INTEGER;
  created_today INTEGER := 0;
  in_chapter INTEGER := 0;
  allowed INTEGER := 0;
  i INTEGER;
BEGIN
  SELECT * INTO fam FROM public.families WHERE id = p_family_id;
  IF fam.id IS NULL OR fam.status <> 'active' THEN
    RETURN jsonb_build_object('family', p_family_id, 'skipped', true);
  END IF;
  SELECT * INTO cs FROM public.child_state WHERE family_id = p_family_id;
  IF cs.family_id IS NULL THEN
    RETURN jsonb_build_object('family', p_family_id, 'skipped', true);
  END IF;
  cfg := public.raise_child_config();
  resolved := public.raise_child_resolve_due(p_family_id);

  IF cs.last_tick_day IS DISTINCT FROM tick_day THEN
    -- Today's allowance is the smaller of the daily pace and what the chapter still needs;
    -- a chapter fills up over days, and never runs past its size.
    SELECT count(*) INTO created_today FROM public.family_moments
     WHERE family_id = p_family_id AND family_moments.day = tick_day;
    SELECT count(*) INTO in_chapter FROM public.family_moments
     WHERE family_id = p_family_id AND family_moments.age = cs.age;
    allowed := least(
      greatest(0, cfg.moments_per_day - created_today),
      greatest(0, public.raise_child_chapter_target(cs.age) - in_chapter)
    );
    FOR i IN 1..allowed LOOP
      IF public.raise_child_create_moment(p_family_id, cs.age, tick_day) IS NULL THEN EXIT; END IF;
      created := created + 1;
    END LOOP;
    FOR i IN 1..cfg.gifts_per_day LOOP
      IF public.raise_child_create_gift(p_family_id, tick_day) IS NOT NULL THEN
        gifts := gifts + 1;
      END IF;
    END LOOP;
    PERFORM public.raise_child_queue_notification(p_family_id, tick_day);
    UPDATE public.child_state SET last_tick_day = tick_day, updated_at = now() WHERE family_id = p_family_id;
  END IF;

  RETURN jsonb_build_object(
    'family', p_family_id, 'day', tick_day, 'moments', created, 'gifts', gifts, 'resolved', resolved
  );
END;
$$;

-- The daily job. pg_cron calls this hourly; content is only created once a day and the
-- 24-hour timeouts are settled every hour, so a family never waits on a phone waking up.
CREATE OR REPLACE FUNCTION public.raise_child_daily_tick(p_day DATE DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  fam RECORD;
  results JSONB := '[]'::JSONB;
BEGIN
  FOR fam IN
    SELECT f.id FROM public.families f
      JOIN public.child_state cs ON cs.family_id = f.id
     WHERE f.status = 'active'
  LOOP
    results := results || jsonb_build_array(public.raise_child_tick_family(fam.id, p_day));
  END LOOP;
  PERFORM public.raise_child_invoke_push();
  RETURN results;
END;
$$;

-- The push outbox is drained by the send-push function (a Database Webhook on
-- raise_child_notifications, or the hourly call below when pg_net is configured).
CREATE OR REPLACE FUNCTION public.raise_child_claim_notifications(p_limit INTEGER DEFAULT 50)
RETURNS SETOF public.raise_child_notifications
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT * FROM public.raise_child_notifications
   WHERE sent_at IS NULL
   ORDER BY created_at
   LIMIT greatest(1, least(coalesce(p_limit, 50), 200));
$$;

CREATE OR REPLACE FUNCTION public.raise_child_mark_notification_sent(p_id UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  UPDATE public.raise_child_notifications SET sent_at = now() WHERE id = p_id AND sent_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_invoke_push()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE endpoint TEXT; webhook_secret TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')
     OR to_regclass('vault.decrypted_secrets') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.raise_child_notifications WHERE sent_at IS NULL) THEN
    RETURN;
  END IF;
  SELECT decrypted_secret INTO endpoint FROM vault.decrypted_secrets WHERE name = 'nooki_send_push_url' LIMIT 1;
  SELECT decrypted_secret INTO webhook_secret FROM vault.decrypted_secrets WHERE name = 'nooki_push_webhook_secret' LIMIT 1;
  IF endpoint IS NULL OR webhook_secret IS NULL THEN RETURN; END IF;
  PERFORM net.http_post(
    url := endpoint,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || webhook_secret),
    body := jsonb_build_object('type', 'SCHEDULED', 'table', 'raise_child_notifications'),
    timeout_milliseconds := 10000
  );
END;
$$;

-- ---------------------------------------------------------------------------------
-- 8. Setup: a name, a look, three traits each, and a temperament only the server knows
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
  cs public.child_state%ROWTYPE;
  chosen_traits TEXT[] := NULL;
  parents UUID[];
  traits_a TEXT[];
  traits_b TEXT[];
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

  SELECT * INTO cs FROM public.child_state WHERE family_id = fam.id;
  IF fam.status = 'setup' THEN
    IF clean_name IS NOT NULL AND clean_name <> '' THEN
      IF cs.family_id IS NULL THEN
        INSERT INTO public.child_state (family_id, name, look)
        VALUES (fam.id, clean_name, coalesce(p_look, '{}'::JSONB))
        RETURNING * INTO cs;
      ELSE
        UPDATE public.child_state
           SET name = clean_name,
               look = coalesce(p_look, look),
               updated_at = now()
         WHERE family_id = fam.id
        RETURNING * INTO cs;
      END IF;
    ELSIF p_look IS NOT NULL AND cs.family_id IS NOT NULL THEN
      UPDATE public.child_state SET look = p_look, updated_at = now()
       WHERE family_id = fam.id RETURNING * INTO cs;
    END IF;
  END IF;

  parents := public.raise_child_parents(fam.id);
  IF fam.status = 'setup' AND cardinality(parents) = 2 AND cs.family_id IS NOT NULL THEN
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
        'The day ' || cs.name || ' arrived',
        'Two parents, three traits each, and a whole childhood ahead. ' || cs.name || ' came home today.'
      );
      PERFORM public.raise_child_tick_family(fam.id);
    END IF;
  END IF;

  RETURN public.raise_child_state();
END;
$$;

-- ---------------------------------------------------------------------------------
-- 9. The state the app reads: never a partner's sealed pick, never a bond number
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_state()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  cfg public.game_config%ROWTYPE;
  fam public.families%ROWTYPE;
  cs public.child_state%ROWTYPE;
  parents UUID[];
  partner UUID;
  my_traits TEXT[];
  partner_traits TEXT[];
  my_bond SMALLINT;
  bond_band TEXT;
  bond_line TEXT;
  child_json JSONB := NULL;
  moments JSONB := '[]'::JSONB;
  gift_json JSONB := NULL;
  open_count INTEGER := 0;
  can_age_up BOOLEAN := false;
  age_hint TEXT := NULL;
  letter_json JSONB := NULL;
  catalog JSONB;
  configured BOOLEAN;
  album_count INTEGER := 0;
  today DATE := (timezone('utc'::text, now()))::date;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Sign in to raise a child.'; END IF;
  cfg := public.raise_child_config();
  SELECT count(*) > 0 INTO configured FROM public.event_templates WHERE active;

  SELECT coalesce(jsonb_agg(jsonb_build_object('slug', t.slug, 'label', t.label, 'blurb', t.blurb) ORDER BY t.sort_order, t.label), '[]'::JSONB)
    INTO catalog
    FROM public.trait_catalog t WHERE t.kind = 'parent' AND t.active;

  fam := public.raise_child_open_family();
  IF fam.id IS NULL THEN
    RETURN jsonb_build_object(
      'family', NULL,
      'configured', configured,
      'config', to_jsonb(cfg) - 'id',
      'setup', jsonb_build_object(
        'name', NULL, 'look', '{}'::JSONB, 'catalog', catalog,
        'mine', '[]'::JSONB, 'partner_joined', false, 'ready', false,
        'content_ready', configured
      ),
      'me', jsonb_build_object('bond', jsonb_build_object('band', NULL, 'line', NULL)),
      'child', NULL,
      'today', jsonb_build_object('moments', '[]'::JSONB, 'gift', NULL, 'can_age_up', false, 'age_up_hint', NULL),
      'album', jsonb_build_object('count', 0),
      'letter', NULL
    );
  END IF;

  SELECT * INTO cs FROM public.child_state WHERE family_id = fam.id;
  parents := public.raise_child_parents(fam.id);
  partner := CASE WHEN parents[1] = caller THEN parents[2] ELSE parents[1] END;
  SELECT traits INTO my_traits FROM public.family_parents WHERE family_id = fam.id AND user_id = caller;
  SELECT traits INTO partner_traits FROM public.family_parents WHERE family_id = fam.id AND user_id = partner;
  SELECT bond INTO my_bond FROM public.family_parents WHERE family_id = fam.id AND user_id = caller;

  IF my_bond IS NOT NULL THEN
    bond_band := public.raise_child_bond_band(my_bond);
  END IF;

  IF cs.family_id IS NOT NULL THEN
    bond_line := public.raise_child_bond_line(coalesce(my_bond, 50)::SMALLINT, cs.name);
    child_json := jsonb_build_object(
      'name', cs.name,
      'look', cs.look,
      'age', cs.age,
      'mood', cs.mood,
      'traits', coalesce((
        SELECT jsonb_agg(jsonb_build_object('slug', t.slug, 'label', t.label, 'blurb', t.blurb) ORDER BY t.sort_order)
          FROM public.trait_catalog t
         WHERE t.slug = ANY(coalesce(cs.visible_traits, '{}'))
      ), '[]'::JSONB),
      'age_label', CASE
        WHEN cs.age = 0 THEN 'newborn'
        WHEN cs.age = 1 THEN 'one year old'
        ELSE cs.age || ' years old'
      END
    );

    SELECT count(*) INTO album_count FROM public.album_entries WHERE family_id = fam.id;
    SELECT count(*) INTO open_count FROM public.family_moments WHERE family_id = fam.id AND status = 'open';

    SELECT coalesce(jsonb_agg(moment ORDER BY created_at), '[]'::JSONB) INTO moments
      FROM (
        SELECT
          m.created_at,
          jsonb_build_object(
            'id', m.id,
            'age', m.age,
            'category', m.category,
            'title', t.title,
            'setup_text', t.setup_text,
            'choices', (
              SELECT jsonb_agg(jsonb_build_object('index', ord, 'label', c ->> 'label') ORDER BY ord)
                FROM jsonb_array_elements(t.choices) WITH ORDINALITY AS x(c, ord)
            ),
            'my_choice', (SELECT v.choice_index FROM public.family_votes v WHERE v.moment_id = m.id AND v.user_id = caller),
            'partner_voted', EXISTS (SELECT 1 FROM public.family_votes v WHERE v.moment_id = m.id AND v.user_id = partner),
            'resolved', m.status = 'resolved',
            'outcome', CASE WHEN m.status = 'resolved' THEN m.outcome ELSE NULL END,
            'due_at', m.created_at + make_interval(hours => cfg.timeout_hours),
            'created_at', m.created_at
          ) AS moment
        FROM public.family_moments m
        JOIN public.event_templates t ON t.slug = m.event_slug
        WHERE m.family_id = fam.id
          AND m.age = cs.age
          AND (m.status = 'open' OR m.resolved_at > now() - interval '2 days')
      ) s;

    SELECT jsonb_build_object(
        'id', g.id, 'title', g.title, 'body', g.body, 'day', g.day,
        'opened', g.opened_at IS NOT NULL
      )
      INTO gift_json
      FROM public.family_gifts g
     WHERE g.family_id = fam.id AND g.user_id = caller
     ORDER BY g.created_at DESC
     LIMIT 1;

    can_age_up := fam.status = 'active'
      AND public.raise_child_chapter_complete(fam.id, cs.age)
      AND (
        cs.last_age_up_day IS NULL
        OR cs.last_age_up_day <> today
        OR cfg.chapters_per_day > 1
      );
    age_hint := CASE
      WHEN fam.status = 'letter' THEN NULL
      WHEN open_count > 0 THEN 'A moment is still waiting on you both.'
      WHEN NOT public.raise_child_chapter_complete(fam.id, cs.age) THEN 'The next moment arrives tomorrow.'
      WHEN cs.last_age_up_day = today AND cfg.chapters_per_day <= 1 THEN 'Today''s chapter is done. Come back tomorrow.'
      WHEN NOT configured THEN 'No moments are switched on yet.'
      ELSE NULL
    END;

    letter_json := cs.letter;
  END IF;

  RETURN jsonb_build_object(
    'family', jsonb_build_object('id', fam.id, 'status', fam.status, 'since', fam.created_at),
    'configured', configured,
    'config', to_jsonb(cfg) - 'id',
    'setup', jsonb_build_object(
      'name', cs.name,
      'look', coalesce(cs.look, '{}'::JSONB),
      'catalog', catalog,
      'mine', to_jsonb(coalesce(my_traits, '{}')),
      'partner_joined', partner IS NOT NULL,
      'partner_traits_ready', cardinality(coalesce(partner_traits, '{}')) = 3,
      'ready', fam.status <> 'setup',
      'content_ready', configured
    ),
    'me', jsonb_build_object(
      'user_id', caller,
      'bond', jsonb_build_object('band', bond_band, 'line', bond_line)
    ),
    'child', child_json,
    'today', jsonb_build_object(
      'moments', moments,
      'gift', gift_json,
      'can_age_up', can_age_up,
      'age_up_hint', age_hint
    ),
    'album', jsonb_build_object('count', album_count),
    'letter', letter_json
  );
END;
$$;

-- ---------------------------------------------------------------------------------
-- 10. Playing: a private pick, an age up, the album, and the letter at eighteen
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_vote(p_moment_id UUID, p_choice INTEGER)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  m public.family_moments%ROWTYPE;
  tpl public.event_templates%ROWTYPE;
  fam public.families%ROWTYPE;
BEGIN
  SELECT * INTO m FROM public.family_moments WHERE id = p_moment_id;
  IF m.id IS NULL THEN RAISE EXCEPTION 'That moment is not here any more.'; END IF;
  fam := public.raise_child_guard_family(m.family_id);
  IF fam.status <> 'active' THEN RAISE EXCEPTION 'This chapter is closed.'; END IF;
  IF m.status = 'resolved' THEN RAISE EXCEPTION 'That moment has already been decided.'; END IF;
  SELECT * INTO tpl FROM public.event_templates WHERE slug = m.event_slug;
  IF p_choice IS NULL OR p_choice < 1 OR p_choice > jsonb_array_length(tpl.choices) THEN
    RAISE EXCEPTION 'Choose one of the options on the card.';
  END IF;

  INSERT INTO public.family_votes (moment_id, user_id, choice_index)
  VALUES (m.id, caller, p_choice::SMALLINT)
  ON CONFLICT (moment_id, user_id) DO UPDATE
    SET choice_index = EXCLUDED.choice_index, updated_at = now();

  RETURN public.raise_child_resolve(m.id, false);
END;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_open_gift(p_gift_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE g public.family_gifts%ROWTYPE;
BEGIN
  SELECT * INTO g FROM public.family_gifts WHERE id = p_gift_id;
  IF g.id IS NULL THEN RAISE EXCEPTION 'That gift is not here any more.'; END IF;
  PERFORM public.raise_child_guard_family(g.family_id);
  IF g.user_id <> auth.uid() THEN RAISE EXCEPTION 'That gift is for your partner.'; END IF;
  UPDATE public.family_gifts SET opened_at = coalesce(opened_at, now()) WHERE id = g.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_age_up()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  fam public.families%ROWTYPE;
  cs public.child_state%ROWTYPE;
  cfg public.game_config%ROWTYPE;
  parents UUID[];
  other UUID;
  waiting INTEGER;
  next_age SMALLINT;
  milestone TEXT;
  milestone_body TEXT;
BEGIN
  fam := public.raise_child_open_family();
  IF fam.id IS NULL THEN RAISE EXCEPTION 'Start the family first.'; END IF;
  IF fam.status <> 'active' THEN RAISE EXCEPTION 'This family is not in a chapter right now.'; END IF;
  SELECT * INTO cs FROM public.child_state WHERE family_id = fam.id;
  IF cs.family_id IS NULL THEN RAISE EXCEPTION 'The family is still being set up.'; END IF;
  cfg := public.raise_child_config();
  PERFORM public.raise_child_resolve_due(fam.id);

  SELECT count(*) INTO waiting FROM public.family_moments
   WHERE family_id = fam.id AND age = cs.age AND status = 'open';
  IF waiting > 0 THEN
    RAISE EXCEPTION 'There is still a moment waiting on both of you.';
  END IF;
  IF NOT public.raise_child_chapter_complete(fam.id, cs.age) THEN
    RAISE EXCEPTION 'This chapter still has a moment to come.';
  END IF;
  IF cfg.chapters_per_day <= 0 THEN
    RAISE EXCEPTION 'Chapters are paused right now.';
  END IF;
  IF cs.last_age_up_day = (timezone('utc'::text, now()))::date AND cfg.chapters_per_day <= 1 THEN
    RAISE EXCEPTION 'Today''s chapter is done. Come back tomorrow.';
  END IF;

  parents := public.raise_child_parents(fam.id);
  other := CASE WHEN parents[1] = cs.lead_user_id THEN parents[2] ELSE parents[1] END;
  next_age := least(18, cs.age + 1);

  UPDATE public.child_state
     SET age = next_age,
         lead_user_id = coalesce(other, lead_user_id),
         last_age_up_day = (timezone('utc'::text, now()))::date,
         last_tick_day = NULL,
         updated_at = now()
   WHERE family_id = fam.id
  RETURNING * INTO cs;

  milestone := CASE cs.age
    WHEN 1 THEN 'First word'
    WHEN 5 THEN 'First day of school'
    WHEN 7 THEN 'First best friend'
    WHEN 14 THEN 'First heartbreak'
    WHEN 18 THEN 'Graduation'
    ELSE NULL END;
  IF milestone IS NOT NULL THEN
    milestone_body := CASE cs.age
      WHEN 1 THEN cs.name || ' said a whole word, and then said it eleven more times to be sure.'
      WHEN 5 THEN 'A bag too big, a uniform too long, and a wave at the gate that lasted a little too long.'
      WHEN 7 THEN 'A friend at last — the kind you wait by the door for.'
      WHEN 14 THEN 'A first heartbreak. Small in the scheme of things, enormous that week. You were there.'
      ELSE cs.name || ' walked out of the school gates for the last time, and back in through your front door.' END;
    INSERT INTO public.album_entries (family_id, kind, age, title, body)
    VALUES (fam.id, 'milestone', cs.age, milestone, milestone_body);
  END IF;

  IF cs.age >= 18 THEN
    UPDATE public.families SET status = 'letter', updated_at = now() WHERE id = fam.id;
    PERFORM public.raise_child_write_letter(fam.id);
  ELSE
    -- The new chapter opens through the same daily pace as any other day: if today's
    -- allowance is spent, the first card arrives tomorrow.
    PERFORM public.raise_child_tick_family(fam.id, (timezone('utc'::text, now()))::date);
  END IF;

  RETURN public.raise_child_state();
END;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_album(p_limit INTEGER DEFAULT 40, p_before TIMESTAMPTZ DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  fam public.families%ROWTYPE;
BEGIN
  fam := public.raise_child_open_family();
  IF fam.id IS NULL THEN RETURN '[]'::JSONB; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
        'id', e.id, 'kind', e.kind, 'age', e.age, 'title', e.title,
        'body', e.body, 'created_at', e.created_at, 'author_id', e.author_id
      ) ORDER BY e.created_at DESC)
      FROM (
        SELECT * FROM public.album_entries
         WHERE family_id = fam.id
           AND (p_before IS NULL OR created_at < p_before)
         ORDER BY created_at DESC
         LIMIT greatest(1, least(coalesce(p_limit, 40), 100))
      ) e
  ), '[]'::JSONB);
END;
$$;

-- ---------------------------------------------------------------------------------
-- 11. Eighteen: the letter, the note back, and a new child when they are ready
-- ---------------------------------------------------------------------------------

-- Assembled from what actually happened — the traits the family grew, how often the
-- two of them found each other, and how many decisions they made — from fixed pieces
-- of text. No outside service, and never cruel: a low bond is written as distance
-- that was worked through, not as blame.
CREATE OR REPLACE FUNCTION public.raise_child_write_letter(p_family_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  cs public.child_state%ROWTYPE;
  traits TEXT;
  trait_count INTEGER;
  decided INTEGER;
  agreed INTEGER;
  paragraphs JSONB;
  letter_json JSONB;
BEGIN
  SELECT * INTO cs FROM public.child_state WHERE family_id = p_family_id;
  IF cs.family_id IS NULL THEN RETURN NULL; END IF;
  IF cs.letter IS NOT NULL THEN RETURN cs.letter; END IF;

  SELECT coalesce(string_agg(t.label, ', ' ORDER BY t.sort_order), ''), count(*)
    INTO traits, trait_count
    FROM public.trait_catalog t
   WHERE t.slug = ANY(coalesce(cs.visible_traits, '{}'));

  SELECT count(*), count(*) FILTER (WHERE m.agreement) INTO decided, agreed
    FROM public.family_moments m
   WHERE m.family_id = p_family_id AND m.status = 'resolved';

  paragraphs := jsonb_build_array(
    'Dear both of you,',
    'I am eighteen today, which is strange to write down. I keep thinking about how many times you must have stood in the kitchen deciding something about me.',
    CASE WHEN trait_count = 0
      THEN 'You always said I was a bit of everything, and never quite one thing.'
      ELSE 'You always say I am ' || traits || '. I think I got that from the two of you, in different measures.'
    END,
    CASE WHEN decided = 0
      THEN 'You did not have many big moments to argue over. The small ones, you did together.'
      WHEN agreed = decided
        THEN 'You made ' || decided || ' decisions about me, and every one of them you agreed on. I never once heard a door slam over me.'
      ELSE 'You made ' || decided || ' decisions about me. ' || agreed || ' of them you saw the same way straight off. The rest you had to talk through, and I noticed that too — how you always came back to the table.'
    END,
    'Whatever else was going on, there was always someone at the door when I came home.',
    -- No signature: the app does not draw a closing for anyone.
    'Thank you for deciding together, even when it was hard, and for letting me be the reason. I am all right. I am going to be all right.'
  );

  letter_json := jsonb_build_object(
    'paragraphs', paragraphs,
    'written_at', now(),
    'child', cs.name
  );

  UPDATE public.child_state SET letter = letter_json, letter_written_at = now(), updated_at = now()
   WHERE family_id = p_family_id;

  INSERT INTO public.album_entries (family_id, kind, age, title, body)
  VALUES (p_family_id, 'letter', 18, cs.name || '’s letter to you both', (SELECT string_agg(value, E'\n\n') FROM jsonb_array_elements_text(paragraphs)));

  RETURN letter_json;
END;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_reply(p_note TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  fam public.families%ROWTYPE;
  cs public.child_state%ROWTYPE;
  clean TEXT := btrim(coalesce(p_note, ''));
BEGIN
  fam := public.raise_child_open_family();
  IF fam.id IS NULL THEN RAISE EXCEPTION 'There is no family here yet.'; END IF;
  IF fam.status <> 'letter' THEN RAISE EXCEPTION 'The letter comes at eighteen.'; END IF;
  SELECT * INTO cs FROM public.child_state WHERE family_id = fam.id;
  IF char_length(clean) = 0 THEN RAISE EXCEPTION 'Write a line first.'; END IF;
  IF char_length(clean) > 400 THEN RAISE EXCEPTION 'Keep it to 400 characters.'; END IF;
  INSERT INTO public.album_entries (family_id, kind, age, title, body, author_id)
  VALUES (fam.id, 'note', 18, 'A note back to ' || cs.name, clean, auth.uid());
END;
$$;

-- Archiving is the only thing that closes a family. The album stays; nothing is deleted.
CREATE OR REPLACE FUNCTION public.raise_child_new_child()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  fam public.families%ROWTYPE;
BEGIN
  fam := public.raise_child_open_family();
  IF fam.id IS NOT NULL THEN
    IF fam.status <> 'letter' THEN
      RAISE EXCEPTION 'The letter at eighteen comes before a new child.';
    END IF;
    UPDATE public.families SET status = 'archived', archived_at = now(), updated_at = now()
     WHERE id = fam.id;
  END IF;
  RETURN public.raise_child_state();
END;
$$;

-- ---------------------------------------------------------------------------------
-- 12. Permissions: the app gets the app functions, the job gets the job functions
-- ---------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.can_read_family_vote(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_read_family_vote(UUID, UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.raise_child_state(), public.raise_child_setup(TEXT, JSONB, TEXT[]),
  public.raise_child_vote(UUID, INTEGER), public.raise_child_open_gift(UUID), public.raise_child_age_up(),
  public.raise_child_album(INTEGER, TIMESTAMPTZ), public.raise_child_reply(TEXT), public.raise_child_new_child()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raise_child_state(), public.raise_child_setup(TEXT, JSONB, TEXT[]),
  public.raise_child_vote(UUID, INTEGER), public.raise_child_open_gift(UUID), public.raise_child_age_up(),
  public.raise_child_album(INTEGER, TIMESTAMPTZ), public.raise_child_reply(TEXT), public.raise_child_new_child()
  TO authenticated;

REVOKE ALL ON FUNCTION public.raise_child_config(), public.raise_child_require_couple(),
  public.raise_child_open_family(), public.raise_child_guard_family(UUID), public.raise_child_parents(UUID),
  public.raise_child_validate_traits(TEXT[]), public.raise_child_temperament(TEXT[], TEXT[]),
  public.raise_child_bond_band(SMALLINT), public.raise_child_bond_line(SMALLINT, TEXT),
  public.raise_child_apply_effects(UUID, JSONB, UUID, UUID, BOOLEAN, SMALLINT),
  public.raise_child_pick_event(UUID, SMALLINT, TEXT[], BOOLEAN, BOOLEAN),
  public.raise_child_chapter_target(SMALLINT), public.raise_child_chapter_complete(UUID, SMALLINT),
  public.raise_child_choose_event(UUID, SMALLINT), public.raise_child_create_moment(UUID, SMALLINT, DATE),
  public.raise_child_resolve(UUID, BOOLEAN), public.raise_child_resolve_due(UUID),
  public.raise_child_gift_copy(SMALLINT, TEXT[], TEXT), public.raise_child_create_gift(UUID, DATE),
  public.raise_child_queue_notification(UUID, DATE), public.raise_child_tick_family(UUID, DATE),
  public.raise_child_daily_tick(DATE), public.raise_child_claim_notifications(INTEGER),
  public.raise_child_mark_notification_sent(UUID), public.raise_child_invoke_push(),
  public.raise_child_write_letter(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.raise_child_daily_tick(DATE), public.raise_child_tick_family(UUID, DATE),
  public.raise_child_resolve(UUID, BOOLEAN), public.raise_child_resolve_due(UUID),
  public.raise_child_write_letter(UUID), public.raise_child_claim_notifications(INTEGER),
  public.raise_child_mark_notification_sent(UUID), public.raise_child_invoke_push()
  TO service_role;

-- ---------------------------------------------------------------------------------
-- 13. Realtime: both phones see the same reveal, without a refresh
-- ---------------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'families') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.families;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'child_state') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.child_state;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'family_moments') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.family_moments;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'family_votes') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.family_votes;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'album_entries') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.album_entries;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'family_gifts') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.family_gifts;
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------
-- 14. The hourly job. Content is created once a day inside the function; the hourly
-- call is what settles the 24-hour timeouts promptly and drains the push outbox.
-- ---------------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE 'SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = ''nooki-raise-a-child-hourly''';
    PERFORM cron.schedule(
      'nooki-raise-a-child-hourly',
      '7 * * * *',
      'SELECT public.raise_child_daily_tick();'
    );
  END IF;
END $$;

COMMIT;
