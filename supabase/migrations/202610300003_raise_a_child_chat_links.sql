-- Raise a Child: the way back from the chat.
--
-- "Talk it out" already put the split into the chat. This adds the other half: the message
-- carries a link to the moment, so either parent can tap it and be back on the decision
-- card without hunting for the sheet.
--
-- The link lives in its own table rather than as a new column on `messages`, so no
-- existing table is touched: the chat stays exactly as it is for every other feature, and
-- the game owns its own bridge.
--
--   raise_child_chat_links   one row per shared moment: which chat message points at it
--   raise_child_take_to_chat one signed-in parent posts the split, linked, atomically
BEGIN;

CREATE TABLE IF NOT EXISTS public.raise_child_chat_links (
  message_id UUID PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  moment_id UUID NOT NULL REFERENCES public.family_moments(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One moment, one thread: tapping "Talk it out" twice brings the same message back
-- instead of filling the chat with copies.
CREATE UNIQUE INDEX IF NOT EXISTS raise_child_chat_links_one_per_moment
  ON public.raise_child_chat_links (moment_id);

CREATE INDEX IF NOT EXISTS raise_child_chat_links_family_idx
  ON public.raise_child_chat_links (family_id);

ALTER TABLE public.raise_child_chat_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS raise_child_chat_links_read_couple ON public.raise_child_chat_links;
CREATE POLICY raise_child_chat_links_read_couple ON public.raise_child_chat_links
  FOR SELECT TO authenticated
  USING (family_id IN (SELECT id FROM public.families WHERE couple_id = public.get_user_couple_id(auth.uid())));

REVOKE ALL ON public.raise_child_chat_links FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.raise_child_chat_links TO authenticated;
GRANT ALL ON public.raise_child_chat_links TO service_role;

CREATE OR REPLACE FUNCTION public.raise_child_take_to_chat(p_moment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  m public.family_moments%ROWTYPE;
  fam public.families%ROWTYPE;
  cs public.child_state%ROWTYPE;
  tpl public.event_templates%ROWTYPE;
  parents UUID[];
  a_choice SMALLINT;
  b_choice SMALLINT;
  name_a TEXT;
  name_b TEXT;
  label_a TEXT;
  label_b TEXT;
  existing public.raise_child_chat_links%ROWTYPE;
  content TEXT;
  posted public.messages%ROWTYPE;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Sign in to raise a child.'; END IF;

  SELECT * INTO m FROM public.family_moments WHERE id = p_moment_id;
  IF m.id IS NULL THEN RAISE EXCEPTION 'That moment is not here any more.'; END IF;
  fam := public.raise_child_guard_family(m.family_id);
  IF m.status <> 'open' THEN RAISE EXCEPTION 'That moment has already been decided.'; END IF;

  SELECT * INTO existing FROM public.raise_child_chat_links WHERE moment_id = m.id;
  IF existing.message_id IS NOT NULL THEN
    RETURN jsonb_build_object('message_id', existing.message_id, 'moment_id', m.id, 'reused', true);
  END IF;

  SELECT * INTO cs FROM public.child_state WHERE family_id = m.family_id;
  SELECT * INTO tpl FROM public.event_templates WHERE slug = m.event_slug;
  parents := public.raise_child_parents(m.family_id);
  SELECT choice_index INTO a_choice FROM public.family_votes WHERE moment_id = m.id AND user_id = parents[1];
  SELECT choice_index INTO b_choice FROM public.family_votes WHERE moment_id = m.id AND user_id = parents[2];
  IF a_choice IS NULL OR b_choice IS NULL THEN
    RAISE EXCEPTION 'Wait until you have both answered.';
  END IF;

  SELECT name INTO name_a FROM public.profiles WHERE id = parents[1];
  SELECT name INTO name_b FROM public.profiles WHERE id = parents[2];
  label_a := tpl.choices -> (a_choice - 1) ->> 'label';
  label_b := tpl.choices -> (b_choice - 1) ->> 'label';

  -- Two short lines and a question: the bubble carries the split, not the whole card.
  content := 'About ' || cs.name || ' — “' || tpl.title || '”.' || E'\n'
    || coalesce(name_a, 'One of us') || ' picked “' || coalesce(label_a, 'one of them') || '”; '
    || coalesce(name_b, 'the other') || ' picked “' || coalesce(label_b, 'another') || '”.' || E'\n'
    || 'Which way should this year go?';

  INSERT INTO public.messages (couple_id, sender_id, content)
  VALUES (fam.couple_id, caller, content)
  RETURNING * INTO posted;

  INSERT INTO public.raise_child_chat_links (message_id, family_id, moment_id)
  VALUES (posted.id, m.family_id, m.id);

  RETURN jsonb_build_object('message_id', posted.id, 'moment_id', m.id, 'reused', false);
END;
$$;

REVOKE ALL ON FUNCTION public.raise_child_take_to_chat(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raise_child_take_to_chat(UUID) TO authenticated;

COMMENT ON FUNCTION public.raise_child_take_to_chat(UUID) IS
  'Posts the split into the couple''s chat, linked back to the moment, and returns its id.';

COMMIT;
