-- Truth or Dare: Spicy is locked until marriage verification exists.
--
-- The Spicy prompt bank stays in the repository, but nothing in the app can open the
-- theme for now: not a 20+ age confirmation, not a marriage, not a direct RPC call.
-- Random and Flirty are untouched. The lock lives in public.tod_theme_locked(), which
-- every Spicy-facing RPC consults. When marriage verification ships, replace that one
-- function, re-activate the reviewed Spicy prompts, and restore the Spicy bucket in
-- public.tod_state().
BEGIN;

-- 1. Close any Spicy room that is still open. Without this a couple could be left holding
--    a round that can never be played, and the one-open-round rule would block new rounds.
UPDATE public.tod_rounds
  SET status = 'ended',
      current_prompt = NULL,
      ended_at = coalesce(ended_at, now()),
      updated_at = now()
  WHERE theme = 'spicy' AND status IN ('inviting', 'active', 'paused');

-- 2. Withdraw every approved Spicy prompt from the live pool. The seed script inserts with
--    ignoreDuplicates and never rewrites an owner's active flag, so rerunning it will not
--    turn these back on.
UPDATE public.tod_prompts
  SET active = false
  WHERE theme = 'spicy' AND active = true;

-- 3. One switch for the whole theme. It deliberately ignores age and relationship status:
--    self-attested age is not proof of marriage, so it must not unlock this.
CREATE OR REPLACE FUNCTION public.tod_theme_locked(p_theme TEXT)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(p_theme = 'spicy', false);
$$;

-- Only the RPCs below call it; no signed-in phone needs EXECUTE.
REVOKE ALL ON FUNCTION public.tod_theme_locked(TEXT) FROM PUBLIC, anon, authenticated;

-- 4. tod_state() never hands back an open Spicy room, and reports the Spicy bucket as
--    empty so every client renders it as unavailable even if stale prompts are active.
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
  WHERE r.couple_id = v_couple
    AND r.status IN ('inviting', 'active', 'paused')
    AND NOT public.tod_theme_locked(r.theme)
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

  v_counts := jsonb_set(
    coalesce(v_counts, '{}'::JSONB),
    '{spicy}',
    '{"truth": 0, "dare": 0}'::JSONB,
    true
  );

  RETURN jsonb_build_object(
    'round', v_round,
    'ages', jsonb_build_object(
      'mine', jsonb_build_object('tier', public.tod_age_tier(v_user), 'source', public.tod_age_source(v_user)),
      'partner', jsonb_build_object('tier', public.tod_age_tier(v_partner), 'source', public.tod_age_source(v_partner))
    ),
    'active_counts', v_counts
  );
END;
$$;

-- 5. Starting, joining, resuming, choosing and completing all refuse a locked theme, so the
--    lock survives a modified client calling the RPCs directly.
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
  IF public.tod_theme_locked(p_theme) THEN
    RAISE EXCEPTION 'Spicy is locked until marriage verification is available.';
  END IF;
  v_couple := public.get_user_couple_id(v_user);
  IF v_couple IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM 1 FROM public.couples WHERE id = v_couple FOR UPDATE;
  SELECT p.id INTO v_partner
    FROM public.profiles p
    WHERE p.couple_id = v_couple AND p.id <> v_user
    ORDER BY p.id LIMIT 1;
  IF v_partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;

  -- Self-heal: a Spicy room left open by an older build must not block a new round.
  UPDATE public.tod_rounds
    SET status = 'ended', current_prompt = NULL, ended_at = coalesce(ended_at, now()), updated_at = now()
    WHERE couple_id = v_couple AND status IN ('inviting', 'active', 'paused')
      AND public.tod_theme_locked(theme);

  v_required_age := CASE p_theme WHEN 'flirty' THEN 18 ELSE 0 END;
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
  IF public.tod_theme_locked(v_round.theme) THEN
    RAISE EXCEPTION 'Spicy is locked until marriage verification is available.';
  END IF;
  IF v_round.status = 'active' THEN RETURN; END IF;
  IF v_round.status <> 'inviting' THEN RAISE EXCEPTION 'This round is not waiting for partners.'; END IF;

  v_required_age := CASE v_round.theme WHEN 'flirty' THEN 18 ELSE 0 END;
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
  IF public.tod_theme_locked(v_round.theme) THEN
    RAISE EXCEPTION 'Spicy is locked until marriage verification is available.';
  END IF;
  IF v_round.status <> 'active' THEN RAISE EXCEPTION 'This round is not active.'; END IF;
  IF auth.uid() <> v_round.turn_id THEN RAISE EXCEPTION 'It is your partner’s turn.'; END IF;
  IF v_round.current_prompt IS NOT NULL THEN RAISE EXCEPTION 'Finish or skip the current prompt first.'; END IF;

  v_required_age := CASE v_round.theme WHEN 'flirty' THEN 18 ELSE 0 END;
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
  IF public.tod_theme_locked(v_round.theme) THEN
    RAISE EXCEPTION 'Spicy is locked until marriage verification is available.';
  END IF;
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
  IF public.tod_theme_locked(v_round.theme) THEN
    RAISE EXCEPTION 'Spicy is locked until marriage verification is available.';
  END IF;
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
  IF public.tod_theme_locked(v_round.theme) THEN
    RAISE EXCEPTION 'Spicy is locked until marriage verification is available.';
  END IF;
  IF v_round.status <> 'paused' THEN RAISE EXCEPTION 'This round is not paused.'; END IF;
  UPDATE public.tod_rounds
    SET status = CASE WHEN cardinality(accepted_by) = 2 THEN 'active' ELSE 'inviting' END,
        updated_at = now()
    WHERE id = v_round.id;
END;
$$;

COMMIT;
