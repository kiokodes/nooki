-- Run this migration on existing Supabase projects before deploying Daily Decisions.
-- It adds one dated, owner-uploaded multiple-choice prompt and private couple answers.
-- This migration deliberately inserts NO questions: add a row for each day you want live.
--
-- A partner can always read their own choice. The other choice remains private until both
-- partners have replied; then both see the result. A matching pair is the agreed decision
-- and is locked. If they differ, either can revise their choice until they match.
--
-- The same statements live at the end of supabase/schema.sql for brand-new projects.
BEGIN;

-- One prompt per UTC day. The three separate option columns make CSV uploads into the
-- Supabase table straightforward and make "exactly three choices" a database guarantee.
CREATE TABLE IF NOT EXISTS public.daily_decision_questions (
  decision_date DATE PRIMARY KEY,
  question TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT daily_decision_questions_question_length
    CHECK (char_length(btrim(question)) BETWEEN 1 AND 1000),
  CONSTRAINT daily_decision_questions_option_a_length
    CHECK (char_length(btrim(option_a)) BETWEEN 1 AND 250),
  CONSTRAINT daily_decision_questions_option_b_length
    CHECK (char_length(btrim(option_b)) BETWEEN 1 AND 250),
  CONSTRAINT daily_decision_questions_option_c_length
    CHECK (char_length(btrim(option_c)) BETWEEN 1 AND 250),
  CONSTRAINT daily_decision_questions_options_distinct
    CHECK (
      lower(btrim(option_a)) <> lower(btrim(option_b))
      AND lower(btrim(option_a)) <> lower(btrim(option_c))
      AND lower(btrim(option_b)) <> lower(btrim(option_c))
    )
);

-- One current choice per partner, per couple, per UTC date. Updating is only possible
-- through submit_daily_decision_choice(), which freezes a choice after the couple agrees.
CREATE TABLE IF NOT EXISTS public.daily_decision_responses (
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  decision_date DATE NOT NULL REFERENCES public.daily_decision_questions(decision_date) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  option_index SMALLINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT daily_decision_responses_option_check CHECK (option_index BETWEEN 1 AND 3),
  CONSTRAINT daily_decision_responses_one_per_partner PRIMARY KEY (couple_id, decision_date, user_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_decision_responses_couple_date
  ON public.daily_decision_responses(couple_id, decision_date);

ALTER TABLE public.daily_decision_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_decision_responses ENABLE ROW LEVEL SECURITY;

-- Prompts are shared and contain no private answers. Only signed-in accounts may read;
-- edits/imports are performed by the project owner in Supabase.
DROP POLICY IF EXISTS "Signed-in users can read daily decision questions" ON public.daily_decision_questions;
CREATE POLICY "Signed-in users can read daily decision questions" ON public.daily_decision_questions
FOR SELECT TO authenticated USING (true);

-- A security-definer predicate lets the RLS policy check the other row without recursive
-- RLS. It never returns the choice itself: partners' response rows become readable only
-- after both rows exist for this couple and date.
CREATE OR REPLACE FUNCTION public.can_read_daily_decision_response(
  p_couple_id UUID,
  p_decision_date DATE,
  p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
BEGIN
  IF caller IS NULL OR p_couple_id IS DISTINCT FROM public.get_user_couple_id(caller) THEN
    RETURN FALSE;
  END IF;
  IF p_user_id = caller THEN
    RETURN TRUE;
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM public.profiles partner
     WHERE partner.id = p_user_id
       AND partner.couple_id = p_couple_id
       AND EXISTS (
         SELECT 1 FROM public.daily_decision_responses own
          WHERE own.couple_id = p_couple_id
            AND own.decision_date = p_decision_date
            AND own.user_id = caller
       )
       AND EXISTS (
         SELECT 1 FROM public.daily_decision_responses theirs
          WHERE theirs.couple_id = p_couple_id
            AND theirs.decision_date = p_decision_date
            AND theirs.user_id = p_user_id
       )
  );
END;
$$;

DROP POLICY IF EXISTS "Couples can read daily decision choices after the reveal" ON public.daily_decision_responses;
CREATE POLICY "Couples can read daily decision choices after the reveal" ON public.daily_decision_responses
FOR SELECT TO authenticated
USING (public.can_read_daily_decision_response(couple_id, decision_date, user_id));

-- Return only this date's prompt, the caller's own choice and whether the partner has
-- replied. The partner's choice is included only after the caller has also replied.
CREATE OR REPLACE FUNCTION public.daily_decision_state()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  cid UUID;
  partner UUID;
  today_utc DATE := (timezone('utc'::text, now()))::date;
  prompt_row public.daily_decision_questions%ROWTYPE;
  own_choice SMALLINT;
  partner_choice SMALLINT;
  both_answered BOOLEAN;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Sign in to see today''s decision.';
  END IF;

  SELECT couple_id INTO cid FROM public.profiles WHERE id = caller;
  IF cid IS NULL THEN
    RETURN jsonb_build_object(
      'today', today_utc,
      'question', NULL,
      'my_choice', NULL,
      'partner_choice', NULL,
      'partner_responded', FALSE,
      'both_answered', FALSE,
      'agreed', FALSE
    );
  END IF;

  SELECT id INTO partner
    FROM public.profiles
   WHERE couple_id = cid AND id <> caller
   ORDER BY id
   LIMIT 1;

  SELECT * INTO prompt_row
    FROM public.daily_decision_questions
   WHERE decision_date = today_utc;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'today', today_utc,
      'question', NULL,
      'my_choice', NULL,
      'partner_choice', NULL,
      'partner_responded', FALSE,
      'both_answered', FALSE,
      'agreed', FALSE
    );
  END IF;

  SELECT option_index INTO own_choice
    FROM public.daily_decision_responses
   WHERE couple_id = cid AND decision_date = today_utc AND user_id = caller;
  IF partner IS NOT NULL THEN
    SELECT option_index INTO partner_choice
      FROM public.daily_decision_responses
     WHERE couple_id = cid AND decision_date = today_utc AND user_id = partner;
  END IF;
  both_answered := own_choice IS NOT NULL AND partner_choice IS NOT NULL;

  RETURN jsonb_build_object(
    'today', today_utc,
    'question', jsonb_build_object(
      'decision_date', prompt_row.decision_date,
      'question', btrim(prompt_row.question),
      'options', jsonb_build_array(
        btrim(prompt_row.option_a), btrim(prompt_row.option_b), btrim(prompt_row.option_c)
      )
    ),
    'my_choice', own_choice,
    'partner_choice', CASE WHEN both_answered THEN partner_choice ELSE NULL END,
    'partner_responded', partner_choice IS NOT NULL,
    'both_answered', both_answered,
    'agreed', both_answered AND own_choice = partner_choice
  );
END;
$$;

-- Save or revise this partner's answer for today. The couple row is locked so simultaneous
-- replies serialize: the second choice sees the first, and a matched pair cannot be edited.
CREATE OR REPLACE FUNCTION public.submit_daily_decision_choice(p_option_index SMALLINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  cid UUID;
  partner UUID;
  today_utc DATE := (timezone('utc'::text, now()))::date;
  own_choice SMALLINT;
  partner_choice SMALLINT;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Sign in before choosing an option.';
  END IF;
  IF p_option_index IS NULL OR p_option_index NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'Choose one of the three options.';
  END IF;

  SELECT couple_id INTO cid FROM public.profiles WHERE id = caller;
  IF cid IS NULL THEN
    RAISE EXCEPTION 'Pair with your partner before making a daily decision.';
  END IF;
  SELECT id INTO partner
    FROM public.profiles
   WHERE couple_id = cid AND id <> caller
   ORDER BY id
   LIMIT 1;
  IF partner IS NULL THEN
    RAISE EXCEPTION 'Your partner needs to join before you can make a decision together.';
  END IF;

  -- Keep two concurrent submissions from both believing the other answer is still absent.
  PERFORM 1 FROM public.couples WHERE id = cid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Your couple could not be found. Please reload and try again.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.daily_decision_questions WHERE decision_date = today_utc
  ) THEN
    RAISE EXCEPTION 'No daily decision has been added for today yet.';
  END IF;

  SELECT option_index INTO own_choice
    FROM public.daily_decision_responses
   WHERE couple_id = cid AND decision_date = today_utc AND user_id = caller;
  SELECT option_index INTO partner_choice
    FROM public.daily_decision_responses
   WHERE couple_id = cid AND decision_date = today_utc AND user_id = partner;

  IF own_choice IS NOT NULL AND partner_choice IS NOT NULL AND own_choice = partner_choice THEN
    RAISE EXCEPTION 'You have already agreed on today''s decision.';
  END IF;

  INSERT INTO public.daily_decision_responses (couple_id, decision_date, user_id, option_index)
  VALUES (cid, today_utc, caller, p_option_index)
  ON CONFLICT (couple_id, decision_date, user_id) DO UPDATE
    SET option_index = EXCLUDED.option_index,
        updated_at = timezone('utc'::text, now());

  SELECT option_index INTO partner_choice
    FROM public.daily_decision_responses
   WHERE couple_id = cid AND decision_date = today_utc AND user_id = partner;

  RETURN jsonb_build_object(
    'saved', TRUE,
    'both_answered', partner_choice IS NOT NULL,
    'agreed', partner_choice IS NOT NULL AND partner_choice = p_option_index
  );
END;
$$;

-- The app reads prompt rows and only those response rows allowed by RLS. All response
-- writes go through the function above; anonymous users cannot read any part of this.
REVOKE ALL ON public.daily_decision_questions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.daily_decision_responses FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.daily_decision_questions TO authenticated;
GRANT SELECT ON public.daily_decision_responses TO authenticated;

REVOKE ALL ON FUNCTION public.can_read_daily_decision_response(UUID, DATE, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_decision_state() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_daily_decision_choice(SMALLINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_read_daily_decision_response(UUID, DATE, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.daily_decision_state() TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_daily_decision_choice(SMALLINT) TO authenticated;

-- Re-read through RLS after a partner's reply. The event is only a nudge; the state RPC is
-- the sole source of revealed answer content.
ALTER TABLE public.daily_decision_responses REPLICA IDENTITY FULL;
DO $realtime$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'daily_decision_responses'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.daily_decision_responses;
  END IF;
END
$realtime$;

COMMIT;
