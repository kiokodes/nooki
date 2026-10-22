-- Truth or Dare: additive tables only. Existing profiles, couples and game tables are
-- intentionally left untouched. Age is read from an existing DOB column when present;
-- otherwise the player can store a one-time, self-reported age threshold here.
BEGIN;

CREATE TABLE IF NOT EXISTS public.tod_prompts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('truth', 'dare')),
  theme TEXT NOT NULL CHECK (theme IN ('random', 'flirty', 'spicy')),
  intensity SMALLINT NOT NULL CHECK (intensity BETWEEN 1 AND 5),
  text TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  mode TEXT NOT NULL CHECK (mode IN ('text', 'voice', 'video_call', 'solo')),
  active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tod_prompts_text_length CHECK (
    char_length(btrim(text)) BETWEEN 1 AND CASE type WHEN 'truth' THEN 199 ELSE 279 END
  ),
  CONSTRAINT tod_prompts_bucket_text_unique UNIQUE (type, theme, intensity, text)
);

CREATE INDEX IF NOT EXISTS tod_prompts_active_bucket
  ON public.tod_prompts (theme, type, intensity)
  WHERE active = true;

ALTER TABLE public.tod_prompts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tod_prompts_read_active ON public.tod_prompts;
CREATE POLICY tod_prompts_read_active ON public.tod_prompts
  FOR SELECT TO authenticated USING (active = true);
REVOKE ALL ON public.tod_prompts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tod_prompts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tod_prompts TO service_role;

-- One open round per couple. A selected prompt is snapshotted in the room so both
-- phones continue to see it even if an owner later pauses that prompt in the library.
CREATE TABLE IF NOT EXISTS public.tod_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  theme TEXT NOT NULL CHECK (theme IN ('random', 'flirty', 'spicy')),
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  player_one UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  player_two UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  turn_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'inviting'
    CHECK (status IN ('inviting', 'active', 'paused', 'ended')),
  accepted_by UUID[] NOT NULL DEFAULT '{}',
  current_prompt JSONB,
  completed_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  CONSTRAINT tod_rounds_two_distinct_players CHECK (player_one <> player_two),
  CONSTRAINT tod_rounds_prompt_object CHECK (
    current_prompt IS NULL OR jsonb_typeof(current_prompt) = 'object'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS tod_one_open_round_per_couple
  ON public.tod_rounds (couple_id)
  WHERE status IN ('inviting', 'active', 'paused');
CREATE INDEX IF NOT EXISTS tod_rounds_couple_recent
  ON public.tod_rounds (couple_id, created_at DESC);

ALTER TABLE public.tod_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tod_rounds REPLICA IDENTITY FULL;
DROP POLICY IF EXISTS tod_rounds_read_couple ON public.tod_rounds;
CREATE POLICY tod_rounds_read_couple ON public.tod_rounds
  FOR SELECT TO authenticated
  USING (couple_id = public.get_user_couple_id(auth.uid()));
REVOKE ALL ON public.tod_rounds FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tod_rounds TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tod_rounds TO service_role;

-- The prompt history is private to the database functions. Its unique key means a
-- couple sees each row once per theme/type pool, including prompts they skip. When an
-- entire pool is exhausted, only that bucket's history is cleared and it can cycle.
CREATE TABLE IF NOT EXISTS public.tod_seen_prompts (
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  prompt_id TEXT NOT NULL REFERENCES public.tod_prompts(id) ON DELETE CASCADE,
  round_id UUID NOT NULL REFERENCES public.tod_rounds(id) ON DELETE CASCADE,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (couple_id, prompt_id)
);
CREATE INDEX IF NOT EXISTS tod_seen_prompts_round ON public.tod_seen_prompts (round_id);
ALTER TABLE public.tod_seen_prompts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tod_seen_prompts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tod_seen_prompts TO service_role;

CREATE TABLE IF NOT EXISTS public.tod_age_confirmations (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  attested_minimum_age SMALLINT NOT NULL CHECK (attested_minimum_age IN (18, 20)),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- DOB is intentionally discovered from the profile row as JSON so this migration does
-- not add or alter a profiles column. This supports date_of_birth (and common legacy
-- spellings) if a project already has one.
CREATE OR REPLACE FUNCTION public.tod_birth_date(p_user_id UUID)
RETURNS DATE
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_value TEXT;
BEGIN
  SELECT coalesce(
    to_jsonb(p) ->> 'date_of_birth',
    to_jsonb(p) ->> 'birth_date',
    to_jsonb(p) ->> 'dob'
  ) INTO v_value
  FROM public.profiles p
  WHERE p.id = p_user_id;

  IF v_value IS NULL OR v_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RETURN NULL;
  END IF;
  BEGIN
    RETURN v_value::DATE;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.tod_age_tier(p_user_id UUID)
RETURNS SMALLINT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_birth DATE; v_attested SMALLINT; v_years INTEGER;
BEGIN
  IF p_user_id IS NULL THEN RETURN 0; END IF;
  v_birth := public.tod_birth_date(p_user_id);
  IF v_birth IS NOT NULL THEN
    v_years := extract(year FROM age(current_date, v_birth))::INTEGER;
    RETURN CASE WHEN v_years >= 20 THEN 20 WHEN v_years >= 18 THEN 18 ELSE 0 END;
  END IF;
  SELECT attested_minimum_age INTO v_attested
  FROM public.tod_age_confirmations
  WHERE user_id = p_user_id;
  RETURN coalesce(v_attested, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.tod_age_source(p_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF public.tod_birth_date(p_user_id) IS NOT NULL THEN RETURN 'date_of_birth'; END IF;
  IF EXISTS (SELECT 1 FROM public.tod_age_confirmations WHERE user_id = p_user_id) THEN
    RETURN 'confirmation';
  END IF;
  RETURN 'missing';
END;
$$;

ALTER TABLE public.tod_age_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tod_age_confirmations REPLICA IDENTITY FULL;
DROP POLICY IF EXISTS tod_age_confirmations_read_couple ON public.tod_age_confirmations;
CREATE POLICY tod_age_confirmations_read_couple ON public.tod_age_confirmations
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR (
      public.get_user_couple_id(user_id) IS NOT NULL
      AND public.get_user_couple_id(user_id) = public.get_user_couple_id(auth.uid())
    )
  );
REVOKE ALL ON public.tod_age_confirmations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tod_age_confirmations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tod_age_confirmations TO service_role;

CREATE OR REPLACE FUNCTION public.tod_confirm_age(p_minimum_age SMALLINT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user UUID := auth.uid();
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Sign in to confirm your age.'; END IF;
  IF p_minimum_age NOT IN (18, 20) THEN RAISE EXCEPTION 'Choose a valid age confirmation.'; END IF;
  IF public.tod_birth_date(v_user) IS NOT NULL THEN
    RAISE EXCEPTION 'Your date of birth is already on file.';
  END IF;
  INSERT INTO public.tod_age_confirmations (user_id, attested_minimum_age, confirmed_at)
  VALUES (v_user, p_minimum_age, now())
  ON CONFLICT (user_id) DO UPDATE
    SET attested_minimum_age = greatest(
          public.tod_age_confirmations.attested_minimum_age,
          EXCLUDED.attested_minimum_age
        ),
        confirmed_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.tod_state()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user UUID := auth.uid();
  v_couple UUID;
  v_partner UUID;
  v_round JSONB;
  v_counts JSONB;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Sign in to play.'; END IF;
  v_couple := public.get_user_couple_id(v_user);
  IF v_couple IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT p.id INTO v_partner
    FROM public.profiles p
    WHERE p.couple_id = v_couple AND p.id <> v_user
    ORDER BY p.id LIMIT 1;
  IF v_partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;

  SELECT jsonb_build_object(
    'id', r.id,
    'couple_id', r.couple_id,
    'theme', r.theme,
    'created_by', r.created_by,
    'player_one', r.player_one,
    'player_two', r.player_two,
    'turn_id', r.turn_id,
    'status', r.status,
    'accepted_by', to_jsonb(r.accepted_by),
    'current_prompt', r.current_prompt,
    'completed_count', r.completed_count,
    'created_at', r.created_at,
    'updated_at', r.updated_at
  ) INTO v_round
  FROM public.tod_rounds r
  WHERE r.couple_id = v_couple AND r.status IN ('inviting', 'active', 'paused')
  ORDER BY r.created_at DESC LIMIT 1;

  SELECT jsonb_object_agg(
    bucket.theme,
    jsonb_build_object('truth', bucket.truth_count, 'dare', bucket.dare_count)
  ) INTO v_counts
  FROM (
    SELECT themes.theme,
      count(p.id) FILTER (WHERE p.type = 'truth')::INTEGER AS truth_count,
      count(p.id) FILTER (WHERE p.type = 'dare')::INTEGER AS dare_count
    FROM (VALUES ('random'::TEXT), ('flirty'::TEXT), ('spicy'::TEXT)) AS themes(theme)
    LEFT JOIN public.tod_prompts p
      ON p.theme = themes.theme AND p.active = true
    GROUP BY themes.theme
  ) AS bucket;

  RETURN jsonb_build_object(
    'round', v_round,
    'ages', jsonb_build_object(
      'mine', jsonb_build_object('tier', public.tod_age_tier(v_user), 'source', public.tod_age_source(v_user)),
      'partner', jsonb_build_object('tier', public.tod_age_tier(v_partner), 'source', public.tod_age_source(v_partner))
    ),
    'active_counts', coalesce(v_counts, '{}'::JSONB)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.tod_start_round(p_theme TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user UUID := auth.uid();
  v_couple UUID;
  v_partner UUID;
  v_round_id UUID;
  v_required_age INTEGER;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Sign in to play.'; END IF;
  IF p_theme NOT IN ('random', 'flirty', 'spicy') THEN RAISE EXCEPTION 'Choose a valid theme.'; END IF;
  v_couple := public.get_user_couple_id(v_user);
  IF v_couple IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM 1 FROM public.couples WHERE id = v_couple FOR UPDATE;
  SELECT p.id INTO v_partner
    FROM public.profiles p
    WHERE p.couple_id = v_couple AND p.id <> v_user
    ORDER BY p.id LIMIT 1;
  IF v_partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;

  v_required_age := CASE p_theme WHEN 'flirty' THEN 18 WHEN 'spicy' THEN 20 ELSE 0 END;
  IF v_required_age > 0 AND (
    public.tod_age_tier(v_user) < v_required_age
    OR public.tod_age_tier(v_partner) < v_required_age
  ) THEN
    RAISE EXCEPTION '% opens only when both partners meet its age rule.', initcap(p_theme);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.tod_prompts WHERE theme = p_theme AND type = 'truth' AND active)
     OR NOT EXISTS (SELECT 1 FROM public.tod_prompts WHERE theme = p_theme AND type = 'dare' AND active) THEN
    RAISE EXCEPTION 'This theme is not available yet.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tod_rounds
    WHERE couple_id = v_couple AND status IN ('inviting', 'active', 'paused')
  ) THEN
    RAISE EXCEPTION 'Finish or end your current round before starting another.';
  END IF;

  INSERT INTO public.tod_rounds (
    couple_id, theme, created_by, player_one, player_two, turn_id, status, accepted_by
  ) VALUES (
    v_couple, p_theme, v_user, v_user, v_partner, v_user, 'inviting', '{}'::UUID[]
  ) RETURNING id INTO v_round_id;
  RETURN v_round_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.tod_accept_round(p_round_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_couple UUID := public.get_user_couple_id(auth.uid());
  v_round public.tod_rounds%ROWTYPE;
  v_accepted UUID[];
  v_required_age INTEGER;
BEGIN
  IF auth.uid() IS NULL OR v_couple IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT * INTO v_round FROM public.tod_rounds
    WHERE id = p_round_id AND couple_id = v_couple FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Round not found.'; END IF;
  IF auth.uid() NOT IN (v_round.player_one, v_round.player_two) THEN RAISE EXCEPTION 'This round is not yours.'; END IF;
  IF v_round.status = 'active' THEN RETURN; END IF;
  IF v_round.status <> 'inviting' THEN RAISE EXCEPTION 'This round is not waiting for partners.'; END IF;

  v_required_age := CASE v_round.theme WHEN 'flirty' THEN 18 WHEN 'spicy' THEN 20 ELSE 0 END;
  IF v_required_age > 0 AND (
    public.tod_age_tier(v_round.player_one) < v_required_age
    OR public.tod_age_tier(v_round.player_two) < v_required_age
  ) THEN
    RAISE EXCEPTION '% opens only when both partners meet its age rule.', initcap(v_round.theme);
  END IF;

  v_accepted := CASE
    WHEN auth.uid() = ANY(v_round.accepted_by) THEN v_round.accepted_by
    ELSE array_append(v_round.accepted_by, auth.uid())
  END;
  UPDATE public.tod_rounds
    SET accepted_by = v_accepted,
        status = CASE WHEN cardinality(v_accepted) = 2 THEN 'active' ELSE 'inviting' END,
        updated_at = now()
    WHERE id = v_round.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.tod_choose_prompt(p_round_id UUID, p_type TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_couple UUID := public.get_user_couple_id(auth.uid());
  v_round public.tod_rounds%ROWTYPE;
  v_prompt public.tod_prompts%ROWTYPE;
  v_required_age INTEGER;
  v_target_intensity INTEGER;
  v_snapshot JSONB;
BEGIN
  IF auth.uid() IS NULL OR v_couple IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  IF p_type NOT IN ('truth', 'dare') THEN RAISE EXCEPTION 'Choose Truth or Dare.'; END IF;
  SELECT * INTO v_round FROM public.tod_rounds
    WHERE id = p_round_id AND couple_id = v_couple FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Round not found.'; END IF;
  IF v_round.status <> 'active' THEN RAISE EXCEPTION 'This round is not active.'; END IF;
  IF auth.uid() <> v_round.turn_id THEN RAISE EXCEPTION 'It is your partner’s turn.'; END IF;
  IF v_round.current_prompt IS NOT NULL THEN RAISE EXCEPTION 'Finish or skip the current prompt first.'; END IF;

  v_required_age := CASE v_round.theme WHEN 'flirty' THEN 18 WHEN 'spicy' THEN 20 ELSE 0 END;
  IF v_required_age > 0 AND (
    public.tod_age_tier(v_round.player_one) < v_required_age
    OR public.tod_age_tier(v_round.player_two) < v_required_age
  ) THEN
    RAISE EXCEPTION '% opens only when both partners meet its age rule.', initcap(v_round.theme);
  END IF;

  v_target_intensity := least(5, 1 + (v_round.completed_count / 2));

  -- Prefer the current intensity or the next stronger level. If those have all been
  -- seen, use the strongest remaining level instead of repeating an unseen-lower row.
  SELECT p.* INTO v_prompt
    FROM public.tod_prompts p
    WHERE p.active AND p.theme = v_round.theme AND p.type = p_type
      AND p.intensity >= v_target_intensity
      AND NOT EXISTS (
        SELECT 1 FROM public.tod_seen_prompts seen
        WHERE seen.couple_id = v_couple AND seen.prompt_id = p.id
      )
    ORDER BY p.intensity ASC, random()
    LIMIT 1;
  IF NOT FOUND THEN
    SELECT p.* INTO v_prompt
      FROM public.tod_prompts p
      WHERE p.active AND p.theme = v_round.theme AND p.type = p_type
        AND NOT EXISTS (
          SELECT 1 FROM public.tod_seen_prompts seen
          WHERE seen.couple_id = v_couple AND seen.prompt_id = p.id
        )
      ORDER BY p.intensity DESC, random()
      LIMIT 1;
  END IF;

  -- Recycle only when this couple has seen every active prompt in this theme/type pool.
  IF NOT FOUND THEN
    DELETE FROM public.tod_seen_prompts seen
      USING public.tod_prompts p
      WHERE seen.couple_id = v_couple
        AND seen.prompt_id = p.id
        AND p.active AND p.theme = v_round.theme AND p.type = p_type;
    SELECT p.* INTO v_prompt
      FROM public.tod_prompts p
      WHERE p.active AND p.theme = v_round.theme AND p.type = p_type
      ORDER BY CASE WHEN p.intensity >= v_target_intensity THEN 0 ELSE 1 END,
               CASE WHEN p.intensity >= v_target_intensity THEN p.intensity ELSE -p.intensity END,
               random()
      LIMIT 1;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'No reviewed prompts are active for this theme yet.'; END IF;

  v_snapshot := jsonb_build_object(
    'id', v_prompt.id,
    'type', v_prompt.type,
    'theme', v_prompt.theme,
    'intensity', v_prompt.intensity,
    'text', v_prompt.text,
    'tags', to_jsonb(v_prompt.tags),
    'mode', v_prompt.mode
  );
  INSERT INTO public.tod_seen_prompts (couple_id, prompt_id, round_id, seen_at)
    VALUES (v_couple, v_prompt.id, v_round.id, now())
    ON CONFLICT (couple_id, prompt_id) DO UPDATE
      SET round_id = EXCLUDED.round_id, seen_at = EXCLUDED.seen_at;
  UPDATE public.tod_rounds
    SET current_prompt = v_snapshot, updated_at = now()
    WHERE id = v_round.id;
  RETURN v_snapshot;
END;
$$;

CREATE OR REPLACE FUNCTION public.tod_complete_prompt(p_round_id UUID, p_result TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_couple UUID := public.get_user_couple_id(auth.uid());
  v_round public.tod_rounds%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_couple IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  IF p_result NOT IN ('done', 'skip') THEN RAISE EXCEPTION 'Choose Done or Skip.'; END IF;
  SELECT * INTO v_round FROM public.tod_rounds
    WHERE id = p_round_id AND couple_id = v_couple FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Round not found.'; END IF;
  IF v_round.status <> 'active' THEN RAISE EXCEPTION 'This round is not active.'; END IF;
  IF auth.uid() <> v_round.turn_id THEN RAISE EXCEPTION 'It is your partner’s turn.'; END IF;
  IF v_round.current_prompt IS NULL THEN RAISE EXCEPTION 'Choose a prompt first.'; END IF;

  UPDATE public.tod_rounds
    SET current_prompt = NULL,
        completed_count = completed_count + 1,
        turn_id = CASE WHEN turn_id = player_one THEN player_two ELSE player_one END,
        updated_at = now()
    WHERE id = v_round.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.tod_pause_round(p_round_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_couple UUID := public.get_user_couple_id(auth.uid()); v_round public.tod_rounds%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_couple IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT * INTO v_round FROM public.tod_rounds
    WHERE id = p_round_id AND couple_id = v_couple FOR UPDATE;
  IF NOT FOUND OR auth.uid() NOT IN (v_round.player_one, v_round.player_two) THEN RAISE EXCEPTION 'Round not found.'; END IF;
  IF v_round.status NOT IN ('inviting', 'active', 'paused') THEN RAISE EXCEPTION 'This round has ended.'; END IF;
  UPDATE public.tod_rounds SET status = 'paused', updated_at = now() WHERE id = v_round.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.tod_resume_round(p_round_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_couple UUID := public.get_user_couple_id(auth.uid()); v_round public.tod_rounds%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_couple IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT * INTO v_round FROM public.tod_rounds
    WHERE id = p_round_id AND couple_id = v_couple FOR UPDATE;
  IF NOT FOUND OR auth.uid() NOT IN (v_round.player_one, v_round.player_two) THEN RAISE EXCEPTION 'Round not found.'; END IF;
  IF v_round.status <> 'paused' THEN RAISE EXCEPTION 'This round is not paused.'; END IF;
  UPDATE public.tod_rounds
    SET status = CASE WHEN cardinality(accepted_by) = 2 THEN 'active' ELSE 'inviting' END,
        updated_at = now()
    WHERE id = v_round.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.tod_end_round(p_round_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_couple UUID := public.get_user_couple_id(auth.uid()); v_round public.tod_rounds%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_couple IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT * INTO v_round FROM public.tod_rounds
    WHERE id = p_round_id AND couple_id = v_couple FOR UPDATE;
  IF NOT FOUND OR auth.uid() NOT IN (v_round.player_one, v_round.player_two) THEN RAISE EXCEPTION 'Round not found.'; END IF;
  IF v_round.status = 'ended' THEN RETURN; END IF;
  UPDATE public.tod_rounds
    SET status = 'ended', current_prompt = NULL, ended_at = now(), updated_at = now()
    WHERE id = v_round.id;
END;
$$;

-- Only the server-side RPCs can alter round state or seen history. The content table
-- remains service-role writable only; authenticated clients can read active prompts.
REVOKE ALL ON FUNCTION public.tod_birth_date(UUID), public.tod_age_tier(UUID), public.tod_age_source(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tod_confirm_age(SMALLINT), public.tod_state(),
  public.tod_start_round(TEXT), public.tod_accept_round(UUID), public.tod_choose_prompt(UUID, TEXT),
  public.tod_complete_prompt(UUID, TEXT), public.tod_pause_round(UUID), public.tod_resume_round(UUID),
  public.tod_end_round(UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tod_confirm_age(SMALLINT), public.tod_state(),
  public.tod_start_round(TEXT), public.tod_accept_round(UUID), public.tod_choose_prompt(UUID, TEXT),
  public.tod_complete_prompt(UUID, TEXT), public.tod_pause_round(UUID), public.tod_resume_round(UUID),
  public.tod_end_round(UUID)
  TO authenticated;

-- Live room and age-gate changes are delivered to both phones by Supabase Realtime.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'tod_rounds'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.tod_rounds;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'tod_age_confirmations'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.tod_age_confirmations;
    END IF;
  END IF;
END;
$$;

COMMIT;
