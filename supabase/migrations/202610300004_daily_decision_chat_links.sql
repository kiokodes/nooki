-- Daily Decisions: the way back from the chat.
--
-- "Take to chat" used to paste the question and all three options into the transcript,
-- which made the chat a wall of text and left nobody a way back to the card. It now
-- posts one short line with a link, and the bubble's "Open today's decision" button
-- brings either partner straight back to the question to answer it.
--
-- Like the Raise a Child bridge, the link lives in its own table so no existing table is
-- touched:
--
--   daily_decision_chat_links    one row per day's decision: the message that points at it
--   daily_decision_take_to_chat  one signed-in partner posts the line, linked, atomically
BEGIN;

CREATE TABLE IF NOT EXISTS public.daily_decision_chat_links (
  message_id UUID PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  question_id BIGINT NOT NULL REFERENCES public.daily_decision_questions(id) ON DELETE CASCADE,
  decision_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- One day, one thread: tapping "Take to chat" twice brings the same message back rather
-- than filling the chat with copies.
CREATE UNIQUE INDEX IF NOT EXISTS daily_decision_chat_links_one_per_day
  ON public.daily_decision_chat_links (couple_id, decision_date);

ALTER TABLE public.daily_decision_chat_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS daily_decision_chat_links_read_couple ON public.daily_decision_chat_links;
CREATE POLICY daily_decision_chat_links_read_couple ON public.daily_decision_chat_links
  FOR SELECT TO authenticated
  USING (couple_id = public.get_user_couple_id(auth.uid()));

REVOKE ALL ON public.daily_decision_chat_links FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.daily_decision_chat_links TO authenticated;
GRANT ALL ON public.daily_decision_chat_links TO service_role;

CREATE OR REPLACE FUNCTION public.daily_decision_take_to_chat()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  cid UUID;
  today_utc DATE := (timezone('utc'::text, now()))::date;
  chosen_question BIGINT;
  prompt_text TEXT;
  existing public.daily_decision_chat_links%ROWTYPE;
  content TEXT;
  posted public.messages%ROWTYPE;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Sign in to see today''s decision.'; END IF;
  cid := public.get_user_couple_id(caller);
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner first.'; END IF;

  SELECT a.question_id INTO chosen_question
    FROM public.daily_decision_assignments a
   WHERE couple_id = cid AND decision_date = today_utc;
  IF chosen_question IS NULL THEN
    RAISE EXCEPTION 'There is no decision today.';
  END IF;

  SELECT * INTO existing
    FROM public.daily_decision_chat_links
   WHERE couple_id = cid AND decision_date = today_utc;
  IF existing.message_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'message_id', existing.message_id,
      'question_id', existing.question_id,
      'decision_date', existing.decision_date,
      'reused', true
    );
  END IF;

  SELECT q.question INTO prompt_text
    FROM public.daily_decision_questions q WHERE q.id = chosen_question;

  -- One short line: the question, and a nudge. The three options stay on the card,
  -- where they can actually be answered.
  content := 'Today’s decision — “' || coalesce(prompt_text, 'one for us') || '”.' || E'\n'
    || 'Pick whenever you have a moment. Neither of us sees the other’s answer until we have both chosen.';

  INSERT INTO public.messages (couple_id, sender_id, content)
  VALUES (cid, caller, content)
  RETURNING * INTO posted;

  INSERT INTO public.daily_decision_chat_links (message_id, couple_id, question_id, decision_date)
  VALUES (posted.id, cid, chosen_question, today_utc);

  RETURN jsonb_build_object(
    'message_id', posted.id,
    'question_id', chosen_question,
    'decision_date', today_utc,
    'reused', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.daily_decision_take_to_chat() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.daily_decision_take_to_chat() TO authenticated;

COMMENT ON FUNCTION public.daily_decision_take_to_chat() IS
  'Posts today''s decision into the couple''s chat as one linked line, and returns its id.';

COMMIT;
