-- Raise a Child: talking it out.
--
-- A disagreement used to settle itself the moment the second pick landed. It does not any
-- more. When the two of you choose differently the year waits: you can take it to chat,
-- change your own pick once, or — if this year's call is yours — use it.
--
--   family_votes.revisions   how many times this parent has changed their pick (0 or 1)
--   raise_child_vote         first pick, then at most one change ("two times to decide")
--   raise_child_resolve_as   the resolver, now with a kind of decision
--   raise_child_lead_decide  the lead parent's "use my decision"
--   raise_child_state        the moments, now carrying the split and what each parent may do
--
-- Additive only: one column, no table is altered in a way that loses anything.
BEGIN;

-- ---------------------------------------------------------------------------------
-- 1. A pick can be changed once. Two decisions per parent, and then it is settled.
-- ---------------------------------------------------------------------------------

ALTER TABLE public.family_votes
  ADD COLUMN IF NOT EXISTS revisions SMALLINT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.family_votes'::regclass
       AND conname = 'family_votes_one_revision'
  ) THEN
    ALTER TABLE public.family_votes
      ADD CONSTRAINT family_votes_one_revision CHECK (revisions BETWEEN 0 AND 1);
  END IF;
END $$;

COMMENT ON COLUMN public.family_votes.revisions IS
  'How many times this parent has changed their mind on this moment. Never more than one.';

-- ---------------------------------------------------------------------------------
-- 2. The resolver: agreement settles at once, a split waits, and the timeout is a
--    backstop rather than the first answer.
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_resolve_as(
  p_moment_id UUID,
  p_force BOOLEAN DEFAULT false,
  p_decision TEXT DEFAULT 'auto'
)
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
  agreed BOOLEAN := false;
  chosen SMALLINT;
  deciding UUID;
  other UUID;
  lead UUID;
  lagger UUID;
  choice JSONB;
  outcome_line TEXT;
  outcome_json JSONB;
  notes TEXT;
  decider_name TEXT;
  child_name TEXT;
  due BOOLEAN;
  kind TEXT;
BEGIN
  IF p_decision NOT IN ('auto', 'lead') THEN
    RAISE EXCEPTION 'Unknown kind of decision.';
  END IF;

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
    -- One answer, or none. Nothing happens until the clock runs out.
    IF a_choice IS NULL AND b_choice IS NULL THEN RETURN NULL; END IF;
    IF p_decision = 'lead' OR NOT (p_force AND due) THEN RETURN NULL; END IF;
    kind := 'lone';
  ELSE
    agreed := a_choice = b_choice;
    IF NOT agreed AND p_decision <> 'lead' AND NOT (p_force AND due) THEN
      -- A split is not a decision. The two of them can take it to chat, change a pick,
      -- or let the year's lead parent use their call; the clock is only the backstop.
      RETURN NULL;
    END IF;
    IF agreed THEN
      kind := 'agreement';
    ELSIF p_decision = 'lead' THEN
      kind := 'lead';
    ELSE
      kind := 'timeout';
    END IF;
  END IF;

  SELECT * INTO cs FROM public.child_state WHERE family_id = m.family_id;
  SELECT * INTO tpl FROM public.event_templates WHERE slug = m.event_slug;
  lead := coalesce(cs.lead_user_id, parent_a);
  lagger := CASE WHEN lead = parent_a THEN parent_b ELSE parent_a END;

  IF both_voted THEN
    IF agreed THEN
      chosen := a_choice;
      deciding := NULL;
      other := NULL;
    ELSE
      chosen := CASE WHEN lead = parent_a THEN a_choice ELSE b_choice END;
      deciding := lead;
      other := lagger;
    END IF;
  ELSE
    -- Nobody answered in time: the pick that was made counts, quietly.
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

  IF kind = 'agreement' THEN
    notes := 'You both wanted the same thing. ' || child_name || ' felt that.';
  ELSIF kind = 'lead' THEN
    notes := 'You wanted different things. ' || coalesce(decider_name, 'Your other half')
      || ' had this year’s call, and used it.';
  ELSIF kind = 'timeout' THEN
    notes := 'You wanted different things. This year went with ' || coalesce(decider_name, 'your other half') || '’s call.';
  ELSE
    notes := 'We went with ' || coalesce(decider_name, 'the pick that was made') || '’s pick.';
  END IF;

  -- A timeout is not a split and carries no penalty: the picked outcome happens, and
  -- neither parent's bond moves. A real split nudges both by one, and no further.
  PERFORM public.raise_child_apply_effects(
    m.family_id,
    coalesce(choice -> 'effects', '{}'::JSONB),
    CASE WHEN both_voted AND NOT agreed THEN deciding ELSE NULL END,
    CASE WHEN both_voted AND NOT agreed THEN other ELSE NULL END,
    agreed,
    (CASE WHEN both_voted AND NOT agreed THEN 1 ELSE 0 END)::SMALLINT
  );

  outcome_json := jsonb_build_object(
    'agreement', agreed,
    'split', both_voted AND NOT agreed,
    'timed_out', NOT both_voted,
    'decision', kind,
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

-- The old name, now the automatic path only. Kept so the hourly job and any older call
-- keep working, and so nobody has to remember two signatures.
CREATE OR REPLACE FUNCTION public.raise_child_resolve(p_moment_id UUID, p_force BOOLEAN DEFAULT false)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN public.raise_child_resolve_as(COALESCE(p_moment_id, NULL), p_force, 'auto');
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
-- 3. The vote: first answer, then one change. Nothing settles on a split.
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
  mine public.family_votes%ROWTYPE;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Sign in to raise a child.'; END IF;

  SELECT * INTO m FROM public.family_moments WHERE id = p_moment_id;
  IF m.id IS NULL THEN RAISE EXCEPTION 'That moment is not here any more.'; END IF;
  fam := public.raise_child_guard_family(m.family_id);
  IF fam.status <> 'active' THEN RAISE EXCEPTION 'This chapter is closed.'; END IF;
  IF m.status = 'resolved' THEN RAISE EXCEPTION 'That moment has already been decided.'; END IF;
  SELECT * INTO tpl FROM public.event_templates WHERE slug = m.event_slug;
  IF p_choice IS NULL OR p_choice < 1 OR p_choice > jsonb_array_length(tpl.choices) THEN
    RAISE EXCEPTION 'Choose one of the options on the card.';
  END IF;

  SELECT * INTO mine FROM public.family_votes WHERE moment_id = m.id AND user_id = caller;
  IF mine.moment_id IS NULL THEN
    INSERT INTO public.family_votes (moment_id, user_id, choice_index)
    VALUES (m.id, caller, p_choice::SMALLINT);
  ELSIF mine.choice_index = p_choice THEN
    -- Asking for the answer already given changes nothing, and uses nothing up.
    NULL;
  ELSIF mine.revisions >= 1 THEN
    RAISE EXCEPTION 'You have already had your second say on this one.';
  ELSE
    UPDATE public.family_votes
       SET choice_index = p_choice::SMALLINT,
           revisions = revisions + 1,
           updated_at = now()
     WHERE moment_id = m.id AND user_id = caller;
  END IF;

  -- This settles an agreement, and only an agreement.
  PERFORM public.raise_child_resolve_as(m.id, false, 'auto');
  RETURN public.raise_child_state();
END;
$$;

-- ---------------------------------------------------------------------------------
-- 4. The lead parent's call, used deliberately.
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_lead_decide(p_moment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  m public.family_moments%ROWTYPE;
  fam public.families%ROWTYPE;
  cs public.child_state%ROWTYPE;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Sign in to raise a child.'; END IF;

  SELECT * INTO m FROM public.family_moments WHERE id = p_moment_id;
  IF m.id IS NULL THEN RAISE EXCEPTION 'That moment is not here any more.'; END IF;
  fam := public.raise_child_guard_family(m.family_id);
  IF fam.status <> 'active' THEN RAISE EXCEPTION 'This chapter is closed.'; END IF;
  IF m.status = 'resolved' THEN RAISE EXCEPTION 'That moment has already been decided.'; END IF;

  SELECT * INTO cs FROM public.child_state WHERE family_id = m.family_id;
  IF cs.lead_user_id IS DISTINCT FROM caller THEN
    RAISE EXCEPTION 'This year''s call belongs to your partner. Talk it through instead.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.family_votes WHERE moment_id = m.id AND user_id = caller)
     OR NOT EXISTS (SELECT 1 FROM public.family_votes WHERE moment_id = m.id AND user_id <> caller) THEN
    RAISE EXCEPTION 'Wait until you have both answered.';
  END IF;

  IF public.raise_child_resolve_as(m.id, true, 'lead') IS NULL THEN
    RAISE EXCEPTION 'There is nothing to decide here yet.';
  END IF;
  RETURN public.raise_child_state();
END;
$$;

-- ---------------------------------------------------------------------------------
-- 5. The state the two phones read: the split, and what each parent may do about it.
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
      'me', jsonb_build_object('bond', jsonb_build_object('band', NULL, 'line', NULL), 'is_lead', false),
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
            'my_choice', mine.choice_index,
            'my_revisions', coalesce(mine.revisions, 0),
            -- The other parent's pick only ever appears once both have answered.
            'partner_voted', theirs.user_id IS NOT NULL,
            'partner_choice', CASE WHEN mine.user_id IS NOT NULL AND theirs.user_id IS NOT NULL
                                   THEN theirs.choice_index ELSE NULL END,
            'disagreement', (m.status = 'open'
                             AND mine.user_id IS NOT NULL AND theirs.user_id IS NOT NULL
                             AND mine.choice_index <> theirs.choice_index),
            'is_lead', coalesce(cs.lead_user_id = caller, false),
            'can_decide', (m.status = 'open'
                           AND cs.lead_user_id = caller
                           AND mine.user_id IS NOT NULL AND theirs.user_id IS NOT NULL
                           AND mine.choice_index <> theirs.choice_index),
            'can_change', (m.status = 'open'
                           AND mine.user_id IS NOT NULL
                           AND coalesce(mine.revisions, 0) < 1),
            'resolved', m.status = 'resolved',
            'outcome', CASE WHEN m.status = 'resolved' THEN m.outcome ELSE NULL END,
            'due_at', m.created_at + make_interval(hours => cfg.timeout_hours),
            'created_at', m.created_at
          ) AS moment
        FROM public.family_moments m
        JOIN public.event_templates t ON t.slug = m.event_slug
        LEFT JOIN public.family_votes mine ON mine.moment_id = m.id AND mine.user_id = caller
        LEFT JOIN public.family_votes theirs ON theirs.moment_id = m.id AND theirs.user_id = partner
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
      'bond', jsonb_build_object('band', bond_band, 'line', bond_line),
      'is_lead', coalesce(cs.lead_user_id = caller, false)
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
-- 6. Who may call what.
-- ---------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.raise_child_resolve_as(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.raise_child_resolve_as(UUID, BOOLEAN, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.raise_child_lead_decide(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raise_child_lead_decide(UUID) TO authenticated;

COMMENT ON FUNCTION public.raise_child_lead_decide(UUID) IS
  'The year''s lead parent settles a split with their own pick, in the open.';

COMMIT;
