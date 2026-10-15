-- Run this migration on existing Supabase projects before deploying the Discuss tab.
-- It adds the shared question library plus each couple's private sessions, answers,
-- reactions and 18+ consent. Nothing that already exists is modified or removed, so it is
-- safe on a live project and safe to rerun.
--
-- It inserts NO questions. The library is imported from your own CSV afterwards — see
-- "Question CSV contract" in README.md. Run this migration FIRST and upload the CSV into
-- the table it creates, so the column types and the normalising trigger are in place
-- before any row arrives.
--
-- The same statements live at the end of supabase/schema.sql for brand-new projects.
BEGIN;

-- ============================================================================
-- 1) Normalising helpers. The question library is imported, not hand-written, so
--    category / input_type / options spelling is whatever the CSV author used.
--    These canonicalise it once, at the door, so the app and the answer checks
--    only ever see one vocabulary.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.canonical_question_category(p_raw TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN btrim(coalesce(p_raw, '')) = '' THEN 'Uncategorised'
    ELSE CASE lower(regexp_replace(regexp_replace(btrim(p_raw), '[_\-]+', ' ', 'g'), '\s+', ' ', 'g'))
      WHEN 'fun' THEN 'Fun'
      WHEN 'deep' THEN 'Deep'
      WHEN 'family' THEN 'Family'
      WHEN 'future' THEN 'Future'
      WHEN 'money' THEN 'Money'
      WHEN 'home life' THEN 'Home Life'
      WHEN 'home' THEN 'Home Life'
      WHEN 'intimacy' THEN 'Intimacy'
      WHEN 'intimate' THEN 'Intimacy'
      WHEN 'sex' THEN 'Intimacy'
      WHEN 'silly' THEN 'Silly'
      -- An unknown category is kept as written and simply shows up as its own tile,
      -- rather than failing somebody's whole import.
      ELSE btrim(p_raw)
    END
  END;
$$;

CREATE OR REPLACE FUNCTION public.canonical_question_input_type(p_raw TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE lower(regexp_replace(btrim(coalesce(p_raw, '')), '[_\-\s]+', '', 'g'))
    WHEN 'text' THEN 'text'
    WHEN 'free' THEN 'text'
    WHEN 'freetext' THEN 'text'
    WHEN 'open' THEN 'text'
    WHEN 'openended' THEN 'text'
    WHEN 'short' THEN 'text'
    WHEN 'long' THEN 'text'
    WHEN 'paragraph' THEN 'text'
    WHEN 'write' THEN 'text'
    WHEN 'written' THEN 'text'
    WHEN 'essay' THEN 'text'
    -- "multiple choice" means one answer from several options, so it is a single pick.
    WHEN 'choice' THEN 'choice'
    WHEN 'single' THEN 'choice'
    WHEN 'singlechoice' THEN 'choice'
    WHEN 'pick' THEN 'choice'
    WHEN 'pickone' THEN 'choice'
    WHEN 'multiplechoice' THEN 'choice'
    WHEN 'radio' THEN 'choice'
    WHEN 'select' THEN 'choice'
    WHEN 'option' THEN 'choice'
    WHEN 'options' THEN 'choice'
    -- Ticking more than one option is its own type, so the UI can offer checkboxes.
    WHEN 'multichoice' THEN 'multi_choice'
    WHEN 'multi' THEN 'multi_choice'
    WHEN 'multiselect' THEN 'multi_choice'
    WHEN 'multiple' THEN 'multi_choice'
    WHEN 'checkbox' THEN 'multi_choice'
    WHEN 'checkboxes' THEN 'multi_choice'
    WHEN 'ranking' THEN 'ranking'
    WHEN 'rank' THEN 'ranking'
    WHEN 'order' THEN 'ranking'
    WHEN 'reorder' THEN 'ranking'
    WHEN 'sort' THEN 'ranking'
    WHEN 'dragdrop' THEN 'ranking'
    WHEN 'draganddrop' THEN 'ranking'
    WHEN 'slider' THEN 'slider'
    WHEN 'scale' THEN 'slider'
    WHEN 'rating' THEN 'slider'
    WHEN 'range' THEN 'slider'
    WHEN 'number' THEN 'slider'
    -- A vocabulary this app does not know degrades to free typing instead of blocking
    -- the import; fix the CSV and re-upload to get the intended control.
    ELSE 'text'
  END;
$$;

-- Accepts a JSON array, a JSON object per option, a double-encoded JSON string (a very
-- common CSV accident) or a plain "Beach | City" style list, and always returns a JSON
-- array of clean labels — or NULL when there is nothing to offer.
CREATE OR REPLACE FUNCTION public.canonical_question_options(p_raw JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_result JSONB := '[]'::JSONB;
  v_item JSONB;
  v_label TEXT;
  v_part TEXT;
  v_parsed JSONB;
BEGIN
  IF p_raw IS NULL OR jsonb_typeof(p_raw) = 'null' THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(p_raw) = 'string' THEN
    v_label := btrim(p_raw #>> '{}');
    IF v_label = '' THEN
      RETURN NULL;
    END IF;
    -- Double-encoded: "[""Beach"",""City""]" arrived as one JSON string.
    IF left(v_label, 1) IN ('[', '{') THEN
      BEGIN
        v_parsed := v_label::JSONB;
        RETURN public.canonical_question_options(v_parsed);
      EXCEPTION WHEN others THEN
        NULL; -- not JSON after all, fall through to the delimiter split
      END;
    END IF;
    -- Not JSON: treat it as a plain delimited list, "Beach | City" or "Beach, City".
    FOR v_part IN
      SELECT btrim(part) FROM unnest(regexp_split_to_array(v_label, '\s*[|;,]\s*')) AS part
    LOOP
      IF v_part <> '' THEN
        v_result := v_result || to_jsonb(v_part);
      END IF;
    END LOOP;
    IF jsonb_array_length(v_result) = 0 THEN
      RETURN NULL;
    END IF;
    RETURN v_result;
  END IF;

  IF jsonb_typeof(p_raw) = 'array' THEN
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_raw) LOOP
      v_label := CASE jsonb_typeof(v_item)
        WHEN 'object' THEN btrim(coalesce(
          v_item ->> 'label', v_item ->> 'text', v_item ->> 'value',
          v_item ->> 'title', v_item ->> 'name', v_item ->> 'id', ''))
        WHEN 'string' THEN btrim(v_item #>> '{}')
        WHEN 'null' THEN ''
        ELSE btrim(v_item #>> '{}')
      END;
      IF v_label <> '' THEN
        v_result := v_result || to_jsonb(v_label);
      END IF;
    END LOOP;
    IF jsonb_array_length(v_result) = 0 THEN
      RETURN NULL;
    END IF;
    RETURN v_result;
  END IF;

  -- A bare number/boolean/object: one option, better than losing the row.
  v_label := btrim(coalesce(p_raw ->> 0, p_raw #>> '{}', ''));
  RETURN CASE WHEN v_label = '' THEN NULL ELSE jsonb_build_array(v_label) END;
END;
$$;

-- ============================================================================
-- 2) The shared question library
--    One library for every couple; what stays private is each couple's sessions
--    and answers. Rows arrive from your CSV, never from this repo.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.questions (
  -- TEXT, not UUID: the id belongs to your CSV, so integers, slugs and UUIDs all import.
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  text TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Uncategorised',
  -- 1 is the lightest, 5 the heaviest. The browse screen filters on this.
  seriousness SMALLINT NOT NULL DEFAULT 3,
  input_type TEXT NOT NULL DEFAULT 'text',
  -- JSON array of option labels for choice / multi_choice / ranking; NULL for text / slider.
  options JSONB,
  -- 18+ rows stay invisible until both partners turn the Intimacy category on.
  is_adult BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT questions_text_length CHECK (char_length(btrim(text)) BETWEEN 1 AND 4000)
);

-- Adopt a questions table that already exists (hand-made, or created by a CSV upload)
-- instead of failing on it: add anything missing and convert anything mistyped.
DO $adopt$
DECLARE
  v_column RECORD;
BEGIN
  IF to_regclass('public.questions') IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'questions' AND column_name = 'text'
  ) THEN
    ALTER TABLE public.questions ADD COLUMN text TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'questions' AND column_name = 'category'
  ) THEN
    ALTER TABLE public.questions ADD COLUMN category TEXT NOT NULL DEFAULT 'Uncategorised';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'questions' AND column_name = 'seriousness'
  ) THEN
    ALTER TABLE public.questions ADD COLUMN seriousness SMALLINT NOT NULL DEFAULT 3;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'questions' AND column_name = 'input_type'
  ) THEN
    ALTER TABLE public.questions ADD COLUMN input_type TEXT NOT NULL DEFAULT 'text';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'questions' AND column_name = 'options'
  ) THEN
    ALTER TABLE public.questions ADD COLUMN options JSONB;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'questions' AND column_name = 'is_adult'
  ) THEN
    ALTER TABLE public.questions ADD COLUMN is_adult BOOLEAN NOT NULL DEFAULT false;
  END IF;

  -- Repair the column types a CSV upload may have inferred, so the rest of this
  -- migration (and the app) can rely on them.
  FOR v_column IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'questions'
  LOOP
    IF v_column.column_name = 'options' AND v_column.data_type NOT IN ('json', 'jsonb') THEN
      ALTER TABLE public.questions
        ALTER COLUMN options TYPE JSONB USING NULLIF(btrim(options::TEXT), '')::JSONB;
    ELSIF v_column.column_name = 'seriousness' AND v_column.data_type NOT IN ('smallint', 'integer') THEN
      ALTER TABLE public.questions
        ALTER COLUMN seriousness TYPE SMALLINT
        USING LEAST(5, GREATEST(1, coalesce(NULLIF(btrim(seriousness::TEXT), '')::INT, 3)))::SMALLINT;
    ELSIF v_column.column_name = 'is_adult' AND v_column.data_type <> 'boolean' THEN
      ALTER TABLE public.questions
        ALTER COLUMN is_adult TYPE BOOLEAN
        USING lower(btrim(is_adult::TEXT)) IN ('t', 'true', 'y', 'yes', '1');
    ELSIF v_column.column_name IN ('text', 'category', 'input_type') AND v_column.data_type <> 'text' THEN
      EXECUTE format('ALTER TABLE public.questions ALTER COLUMN %I TYPE TEXT USING %I::TEXT',
                     v_column.column_name, v_column.column_name);
    END IF;
  END LOOP;

  -- Bring rows that predate this migration into the canonical vocabulary, so the
  -- checks below cannot fail on data that is already there.
  UPDATE public.questions
     SET seriousness = LEAST(5, GREATEST(1, coalesce(seriousness, 3)))::SMALLINT
   WHERE seriousness IS NULL OR seriousness NOT BETWEEN 1 AND 5;
  UPDATE public.questions
     SET category = public.canonical_question_category(category)
   WHERE category IS DISTINCT FROM public.canonical_question_category(category);
  UPDATE public.questions
     SET input_type = public.canonical_question_input_type(input_type)
   WHERE input_type IS DISTINCT FROM public.canonical_question_input_type(input_type);
  UPDATE public.questions
     SET options = public.canonical_question_options(options)
   WHERE options IS DISTINCT FROM public.canonical_question_options(options);

  ALTER TABLE public.questions ALTER COLUMN text SET NOT NULL;
  ALTER TABLE public.questions ALTER COLUMN category SET NOT NULL;
  ALTER TABLE public.questions ALTER COLUMN seriousness SET NOT NULL;
  ALTER TABLE public.questions ALTER COLUMN input_type SET NOT NULL;
  ALTER TABLE public.questions ALTER COLUMN is_adult SET NOT NULL;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'questions_text_length') THEN
    ALTER TABLE public.questions ADD CONSTRAINT questions_text_length
      CHECK (char_length(btrim(text)) BETWEEN 1 AND 4000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'questions_seriousness_check') THEN
    ALTER TABLE public.questions ADD CONSTRAINT questions_seriousness_check
      CHECK (seriousness BETWEEN 1 AND 5);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'questions_input_type_check') THEN
    ALTER TABLE public.questions ADD CONSTRAINT questions_input_type_check
      CHECK (input_type IN ('text', 'choice', 'multi_choice', 'ranking', 'slider'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'questions_options_shape') THEN
    ALTER TABLE public.questions ADD CONSTRAINT questions_options_shape
      CHECK (options IS NULL OR jsonb_typeof(options) = 'array');
  END IF;
END
$adopt$;

ALTER TABLE public.questions ALTER COLUMN seriousness SET DEFAULT 3;
ALTER TABLE public.questions ALTER COLUMN input_type SET DEFAULT 'text';
ALTER TABLE public.questions ALTER COLUMN category SET DEFAULT 'Uncategorised';
ALTER TABLE public.questions ALTER COLUMN is_adult SET DEFAULT false;

-- Browsing always filters by category and seriousness; the adult partial index keeps the
-- 18+ gate cheap.
CREATE INDEX IF NOT EXISTS idx_questions_category_seriousness
  ON public.questions(category, seriousness);
CREATE INDEX IF NOT EXISTS idx_questions_adult
  ON public.questions(seriousness) WHERE is_adult;

-- Every row that arrives from now on is canonicalised on the way in, whatever the CSV
-- said. Existing rows were repaired above, so this only guards new imports.
CREATE OR REPLACE FUNCTION public.normalize_question_row()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_input_type TEXT;
BEGIN
  IF btrim(coalesce(NEW.text, '')) = '' THEN
    RAISE EXCEPTION 'A question needs its text. Check the row with id "%".', coalesce(NEW.id, '');
  END IF;
  NEW.text := btrim(NEW.text);
  NEW.category := public.canonical_question_category(NEW.category);
  v_input_type := public.canonical_question_input_type(NEW.input_type);
  NEW.options := public.canonical_question_options(NEW.options);
  -- Free typing and the 1-10 scale have nothing to offer, so a stray cell is dropped.
  IF v_input_type IN ('text', 'slider') THEN
    NEW.options := NULL;
  ELSIF NEW.options IS NULL THEN
    RAISE EXCEPTION 'A % question needs its options. Check the row with id "%".',
      v_input_type, coalesce(NEW.id, '');
  END IF;
  NEW.input_type := v_input_type;
  NEW.seriousness := LEAST(5, GREATEST(1, coalesce(NEW.seriousness, 3)))::SMALLINT;
  -- Intimacy is 18+ by definition, whatever the CSV's is_adult cell said.
  NEW.is_adult := coalesce(NEW.is_adult, false) OR NEW.category = 'Intimacy';
  IF btrim(coalesce(NEW.id, '')) = '' THEN
    NEW.id := gen_random_uuid()::TEXT;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS questions_normalize_row ON public.questions;
CREATE TRIGGER questions_normalize_row
BEFORE INSERT OR UPDATE ON public.questions
FOR EACH ROW EXECUTE FUNCTION public.normalize_question_row();

-- ============================================================================
-- 3) Per-couple 18+ consent. One row per partner: the Intimacy category opens
--    only when both rows say yes, and closes again the moment one says no.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.couple_settings (
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  adult_questions_enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (couple_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_couple_settings_couple ON public.couple_settings(couple_id);

-- ============================================================================
-- 4) Sessions: one per couple per question, created by "Ask my partner"
-- ============================================================================

-- question_id matches whatever type the questions primary key ended up with, so a
-- hand-made library with UUID ids still works.
DO $sessions$
DECLARE
  v_id_type TEXT;
BEGIN
  IF to_regclass('public.question_sessions') IS NOT NULL THEN
    RETURN;
  END IF;
  SELECT coalesce(format_type(atttypid, atttypmod), 'TEXT') INTO v_id_type
  FROM pg_attribute
  WHERE attrelid = 'public.questions'::regclass AND attname = 'id' AND NOT attisdropped;
  EXECUTE format(
    $sql$
    CREATE TABLE public.question_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
      question_id %s NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
      started_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
      -- Trigger-maintained progress. Both partners can read these two columns, which is
      -- how the UI knows the other has replied without seeing a word of the answer.
      answer_count SMALLINT NOT NULL DEFAULT 0
        CONSTRAINT question_sessions_answer_count_check CHECK (answer_count BETWEEN 0 AND 2),
      completed_at TIMESTAMPTZ
    )
    $sql$, v_id_type);
END
$sessions$;

-- "Surprise me" excludes everything the couple has already asked, and history is read
-- newest-first. One session per question keeps both cheap and honest.
CREATE UNIQUE INDEX IF NOT EXISTS question_sessions_couple_question
  ON public.question_sessions(couple_id, question_id);
CREATE INDEX IF NOT EXISTS idx_question_sessions_couple_created
  ON public.question_sessions(couple_id, created_at DESC);

-- ============================================================================
-- 5) Answers: exactly one per partner per session, private until both are in
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.question_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The shape depends on the question: a string, an array of labels, or a number.
  answer JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT answers_shape_check CHECK (jsonb_typeof(answer) <> 'null')
);

CREATE UNIQUE INDEX IF NOT EXISTS answers_session_user ON public.answers(session_id, user_id);
CREATE INDEX IF NOT EXISTS idx_answers_session ON public.answers(session_id);

-- ============================================================================
-- 6) Reactions and comments, added after the reveal
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.answer_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.question_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reaction TEXT NOT NULL
    CONSTRAINT answer_reactions_reaction_check
    CHECK (reaction IN ('happy', 'funny', 'sad', 'angry', 'disappointed')),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT answer_reactions_comment_length CHECK (comment IS NULL OR char_length(btrim(comment)) <= 1000)
);

CREATE UNIQUE INDEX IF NOT EXISTS answer_reactions_session_user
  ON public.answer_reactions(session_id, user_id);
CREATE INDEX IF NOT EXISTS idx_answer_reactions_session ON public.answer_reactions(session_id);

-- ============================================================================
-- 7) Helper predicates. SECURITY DEFINER so a policy can ask about a session
--    without recursing through that session's own policies.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_session_couple_id(p_session UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT couple_id FROM public.question_sessions WHERE id = p_session;
$$;

CREATE OR REPLACE FUNCTION public.get_answer_couple_id(p_answer UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.get_session_couple_id(session_id) FROM public.answers WHERE id = p_answer;
$$;

-- A session reveals the moment its second answer lands; the trigger below stamps it.
CREATE OR REPLACE FUNCTION public.is_session_revealed(p_session UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.question_sessions
    WHERE id = p_session AND completed_at IS NOT NULL
  );
$$;

-- True only when the couple has two members and both have said yes.
CREATE OR REPLACE FUNCTION public.couple_adult_questions_enabled(p_couple UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_couple IS NOT NULL
     AND (SELECT count(*) FROM public.profiles p WHERE p.couple_id = p_couple) >= 2
     AND NOT EXISTS (
       SELECT 1 FROM public.profiles p
       WHERE p.couple_id = p_couple
         AND NOT EXISTS (
           SELECT 1 FROM public.couple_settings cs
           WHERE cs.couple_id = p_couple AND cs.user_id = p.id AND cs.adult_questions_enabled
         )
     );
$$;

-- ============================================================================
-- 8) Row Level Security
-- ============================================================================

ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.couple_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.question_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.answer_reactions ENABLE ROW LEVEL SECURITY;

-- The library is shared, but 18+ rows only exist for a couple that opted in together.
-- Signed-in accounts get SELECT and nothing else: the CSV import runs as the owner.
DROP POLICY IF EXISTS "Signed-in users can browse the question library" ON public.questions;
CREATE POLICY "Signed-in users can browse the question library" ON public.questions
FOR SELECT TO authenticated
USING (
  NOT is_adult
  OR public.couple_adult_questions_enabled(public.get_user_couple_id(auth.uid()))
);

-- Each partner reads both consent rows (that is the "waiting for you both" state) and
-- writes only their own.
DROP POLICY IF EXISTS "Couple members can view their question settings" ON public.couple_settings;
CREATE POLICY "Couple members can view their question settings" ON public.couple_settings
FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

DROP POLICY IF EXISTS "Users can save their own question settings" ON public.couple_settings;
CREATE POLICY "Users can save their own question settings" ON public.couple_settings
FOR INSERT TO authenticated
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()) AND user_id = auth.uid());

DROP POLICY IF EXISTS "Users can change their own question settings" ON public.couple_settings;
CREATE POLICY "Users can change their own question settings" ON public.couple_settings
FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()) AND user_id = auth.uid())
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()) AND user_id = auth.uid());

-- Sessions carry no answer text, so both partners read them freely: this is what tells
-- the waiting partner "they have answered, yours is still hidden".
DROP POLICY IF EXISTS "Couple members can view their question sessions" ON public.question_sessions;
CREATE POLICY "Couple members can view their question sessions" ON public.question_sessions
FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

DROP POLICY IF EXISTS "Couple members can ask their partner a question" ON public.question_sessions;
CREATE POLICY "Couple members can ask their partner a question" ON public.question_sessions
FOR INSERT TO authenticated
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()) AND started_by = auth.uid());

-- No UPDATE or DELETE policy: answer_count and completed_at belong to the trigger, and
-- a shared history is not something one partner can quietly remove.
--
-- THE PRIVACY RULE. You always see your own answer. You see your partner's only once the
-- session is complete, which the database decides — never the phone.
DROP POLICY IF EXISTS "Couple members can view answers" ON public.answers;
CREATE POLICY "Couple members can view answers" ON public.answers
FOR SELECT TO authenticated
USING (
  public.get_session_couple_id(session_id) = public.get_user_couple_id(auth.uid())
  AND (user_id = auth.uid() OR public.is_session_revealed(session_id))
);

DROP POLICY IF EXISTS "Couple members can answer a question" ON public.answers;
CREATE POLICY "Couple members can answer a question" ON public.answers
FOR INSERT TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND public.get_session_couple_id(session_id) = public.get_user_couple_id(auth.uid())
);

-- Editing your own answer is allowed up to the reveal; the trigger freezes it after.
DROP POLICY IF EXISTS "Users can edit their own answer before the reveal" ON public.answers;
CREATE POLICY "Users can edit their own answer before the reveal" ON public.answers
FOR UPDATE TO authenticated
USING (
  user_id = auth.uid()
  AND public.get_session_couple_id(session_id) = public.get_user_couple_id(auth.uid())
)
WITH CHECK (
  user_id = auth.uid()
  AND public.get_session_couple_id(session_id) = public.get_user_couple_id(auth.uid())
);

-- Reactions are part of the reveal, so they follow the same rule as answers.
DROP POLICY IF EXISTS "Couple members can view reactions" ON public.answer_reactions;
CREATE POLICY "Couple members can view reactions" ON public.answer_reactions
FOR SELECT TO authenticated
USING (
  public.get_session_couple_id(session_id) = public.get_user_couple_id(auth.uid())
  AND public.is_session_revealed(session_id)
);

DROP POLICY IF EXISTS "Couple members can react to a reveal" ON public.answer_reactions;
CREATE POLICY "Couple members can react to a reveal" ON public.answer_reactions
FOR INSERT TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND public.get_session_couple_id(session_id) = public.get_user_couple_id(auth.uid())
  AND public.is_session_revealed(session_id)
);

DROP POLICY IF EXISTS "Users can change their own reaction" ON public.answer_reactions;
CREATE POLICY "Users can change their own reaction" ON public.answer_reactions
FOR UPDATE TO authenticated
USING (
  user_id = auth.uid()
  AND public.get_session_couple_id(session_id) = public.get_user_couple_id(auth.uid())
)
WITH CHECK (
  user_id = auth.uid()
  AND public.get_session_couple_id(session_id) = public.get_user_couple_id(auth.uid())
);

-- ============================================================================
-- 9) Triggers: friendly refusals, answer shapes, and the reveal itself
-- ============================================================================

CREATE OR REPLACE FUNCTION public.guard_question_session()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_couple UUID := public.get_user_couple_id(auth.uid());
  v_question public.questions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Please sign in first.';
  END IF;
  IF v_couple IS NULL THEN
    RAISE EXCEPTION 'Pair with your partner before asking questions.';
  END IF;
  IF NEW.couple_id IS DISTINCT FROM v_couple THEN
    RAISE EXCEPTION 'You can only ask questions inside your own couple.';
  END IF;
  IF NEW.started_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'A question can only be asked by you.';
  END IF;
  SELECT * INTO v_question FROM public.questions WHERE id = NEW.question_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That question is not in your library any more.';
  END IF;
  IF v_question.is_adult AND NOT public.couple_adult_questions_enabled(v_couple) THEN
    RAISE EXCEPTION 'Intimacy questions stay hidden until you both turn them on in settings.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.question_sessions
    WHERE couple_id = NEW.couple_id AND question_id = NEW.question_id AND id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'You have already asked this one. Find it in your history.';
  END IF;
  -- Progress belongs to the answer trigger, never to whoever is inserting.
  NEW.answer_count := 0;
  NEW.completed_at := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS question_sessions_guard ON public.question_sessions;
CREATE TRIGGER question_sessions_guard
BEFORE INSERT ON public.question_sessions
FOR EACH ROW EXECUTE FUNCTION public.guard_question_session();

CREATE OR REPLACE FUNCTION public.guard_answer_payload()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_couple UUID;
  v_session public.question_sessions%ROWTYPE;
  v_question public.questions%ROWTYPE;
  v_option_labels TEXT[];
  v_given TEXT[];
  v_text TEXT;
  v_value NUMERIC;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Please sign in first.';
  END IF;
  SELECT * INTO v_session FROM public.question_sessions WHERE id = NEW.session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That question session does not exist.';
  END IF;
  v_couple := v_session.couple_id;
  -- IS DISTINCT FROM, not <>: an unpaired intruder has a NULL couple id, and NULL <> NULL
  -- is NULL, which would have let the comparison pass silently.
  IF v_couple IS DISTINCT FROM public.get_user_couple_id(auth.uid()) THEN
    RAISE EXCEPTION 'You can only answer your own couple''s questions.';
  END IF;
  IF NEW.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'You can only answer as yourself.';
  END IF;
  SELECT * INTO v_question FROM public.questions WHERE id = v_session.question_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That question is not in your library any more.';
  END IF;
  IF v_question.is_adult AND NOT public.couple_adult_questions_enabled(v_couple) THEN
    RAISE EXCEPTION 'Intimacy questions stay hidden until you both turn them on in settings.';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.session_id <> OLD.session_id OR NEW.user_id <> OLD.user_id
       OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'Only your answer itself can change.';
    END IF;
    IF v_session.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Answers are locked now that you have both replied.';
    END IF;
  ELSE
    IF v_session.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'You have both answered this one already.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.answers WHERE session_id = NEW.session_id AND user_id = NEW.user_id) THEN
      RAISE EXCEPTION 'You have already answered this one. Edit it instead.';
    END IF;
  END IF;

  -- Shape the answer to the question, so a revealed pair always compares like for like.
  IF v_question.input_type = 'text' THEN
    IF jsonb_typeof(NEW.answer) <> 'string' THEN
      RAISE EXCEPTION 'This question expects a written answer.';
    END IF;
    v_text := btrim(NEW.answer #>> '{}');
    IF v_text = '' THEN
      RAISE EXCEPTION 'Please write your answer first.';
    END IF;
    IF char_length(v_text) > 4000 THEN
      RAISE EXCEPTION 'Answers can be up to 4000 characters.';
    END IF;
    NEW.answer := to_jsonb(v_text);
  ELSIF v_question.input_type = 'slider' THEN
    IF jsonb_typeof(NEW.answer) <> 'number' THEN
      RAISE EXCEPTION 'This question expects a number from 1 to 10.';
    END IF;
    v_value := (NEW.answer #>> '{}')::NUMERIC;
    IF v_value < 1 OR v_value > 10 THEN
      RAISE EXCEPTION 'Pick a number between 1 and 10.';
    END IF;
    NEW.answer := to_jsonb(v_value);
  ELSE
    v_option_labels := coalesce(
      (SELECT array_agg(btrim(label)) FROM jsonb_array_elements_text(v_question.options) AS label),
      ARRAY[]::TEXT[]
    );
    IF cardinality(v_option_labels) = 0 THEN
      RAISE EXCEPTION 'This question has no options yet. Ask the app owner to re-import it.';
    END IF;

    IF v_question.input_type = 'choice' THEN
      IF jsonb_typeof(NEW.answer) <> 'string' THEN
        RAISE EXCEPTION 'Pick exactly one option.';
      END IF;
      v_text := btrim(NEW.answer #>> '{}');
      IF NOT (v_text = ANY(v_option_labels)) THEN
        RAISE EXCEPTION 'That is not one of the options for this question.';
      END IF;
      NEW.answer := to_jsonb(v_text);
    ELSE
      -- multi_choice and ranking are both a list of option labels.
      IF jsonb_typeof(NEW.answer) <> 'array' THEN
        RAISE EXCEPTION 'This question expects a list of options.';
      END IF;
      v_given := coalesce(
        (SELECT array_agg(btrim(item)) FROM jsonb_array_elements_text(NEW.answer) AS item),
        ARRAY[]::TEXT[]
      );
      IF cardinality(v_given) = 0 THEN
        RAISE EXCEPTION 'Please choose at least one option.';
      END IF;
      IF (SELECT count(*) FROM unnest(v_given) AS item WHERE NOT (item = ANY(v_option_labels))) > 0 THEN
        RAISE EXCEPTION 'That is not one of the options for this question.';
      END IF;
      IF (SELECT count(DISTINCT item) FROM unnest(v_given) AS item) <> cardinality(v_given) THEN
        RAISE EXCEPTION 'You have listed the same option twice.';
      END IF;
      IF v_question.input_type = 'ranking' AND cardinality(v_given) <> cardinality(v_option_labels) THEN
        RAISE EXCEPTION 'Put every option in an order before you send it.';
      END IF;
      NEW.answer := to_jsonb(v_given);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS answers_guard_payload ON public.answers;
CREATE TRIGGER answers_guard_payload
BEFORE INSERT OR UPDATE ON public.answers
FOR EACH ROW EXECUTE FUNCTION public.guard_answer_payload();

-- The reveal: stamping completed_at is what opens both answers to the couple. It runs as
-- the owner because a partner has no UPDATE rights on the session row.
CREATE OR REPLACE FUNCTION public.sync_session_progress()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session UUID := coalesce(NEW.session_id, OLD.session_id);
  v_count SMALLINT;
BEGIN
  SELECT count(*)::SMALLINT INTO v_count FROM public.answers WHERE session_id = v_session;
  UPDATE public.question_sessions
     SET answer_count = v_count,
         completed_at = CASE
           WHEN v_count >= 2 AND completed_at IS NULL THEN timezone('utc'::text, now())
           WHEN v_count < 2 THEN NULL
           ELSE completed_at
         END
   WHERE id = v_session;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS answers_sync_session_progress ON public.answers;
CREATE TRIGGER answers_sync_session_progress
AFTER INSERT OR DELETE ON public.answers
FOR EACH ROW EXECUTE FUNCTION public.sync_session_progress();

CREATE OR REPLACE FUNCTION public.guard_answer_reaction()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Please sign in first.';
  END IF;
  IF public.get_session_couple_id(NEW.session_id) IS DISTINCT FROM public.get_user_couple_id(auth.uid()) THEN
    RAISE EXCEPTION 'You can only react inside your own couple.';
  END IF;
  IF NEW.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'You can only react as yourself.';
  END IF;
  IF NOT public.is_session_revealed(NEW.session_id) THEN
    RAISE EXCEPTION 'Reactions wait until you have both answered.';
  END IF;
  NEW.comment := NULLIF(btrim(coalesce(NEW.comment, '')), '');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS answer_reactions_guard ON public.answer_reactions;
CREATE TRIGGER answer_reactions_guard
BEFORE INSERT OR UPDATE ON public.answer_reactions
FOR EACH ROW EXECUTE FUNCTION public.guard_answer_reaction();

CREATE OR REPLACE FUNCTION public.set_answer_reaction_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS answer_reactions_set_updated_at ON public.answer_reactions;
CREATE TRIGGER answer_reactions_set_updated_at
BEFORE UPDATE ON public.answer_reactions
FOR EACH ROW EXECUTE FUNCTION public.set_answer_reaction_updated_at();

CREATE OR REPLACE FUNCTION public.set_couple_settings_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS couple_settings_set_updated_at ON public.couple_settings;
CREATE TRIGGER couple_settings_set_updated_at
BEFORE UPDATE ON public.couple_settings
FOR EACH ROW EXECUTE FUNCTION public.set_couple_settings_updated_at();

-- ============================================================================
-- 10) Reads and writes the phone makes through RPCs
--     SECURITY DEFINER because each one crosses tables (library + consent +
--     sessions) and must apply the same rules to every caller.
-- ============================================================================

-- What the browse screen shows: every category the couple may see, how much of it is
-- left, and how that remainder splits across the five seriousness levels.
CREATE OR REPLACE FUNCTION public.question_categories()
RETURNS TABLE(category TEXT, total BIGINT, remaining BIGINT, adult BOOLEAN, by_level JSONB)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_couple UUID;
  v_adult_ok BOOLEAN;
BEGIN
  v_couple := public.get_user_couple_id(auth.uid());
  IF v_couple IS NULL THEN
    RETURN;
  END IF;
  v_adult_ok := public.couple_adult_questions_enabled(v_couple);

  RETURN QUERY
  SELECT
    q.category,
    count(*)::BIGINT,
    count(*) FILTER (WHERE NOT EXISTS (
      SELECT 1 FROM public.question_sessions s
      WHERE s.couple_id = v_couple AND s.question_id = q.id
    ))::BIGINT,
    bool_or(q.is_adult),
    coalesce((
      SELECT jsonb_object_agg(level_counts.seriousness, level_counts.remaining)
      FROM (
        SELECT l.seriousness, count(*) FILTER (WHERE NOT EXISTS (
                 SELECT 1 FROM public.question_sessions s2
                 WHERE s2.couple_id = v_couple AND s2.question_id = l.id
               ))::BIGINT AS remaining
        FROM public.questions l
        WHERE l.category = q.category AND (NOT l.is_adult OR v_adult_ok)
        GROUP BY l.seriousness
      ) AS level_counts
    ), '{}'::JSONB)
  FROM public.questions q
  WHERE NOT q.is_adult OR v_adult_ok
  GROUP BY q.category
  ORDER BY q.category;
END;
$$;

-- One random question this couple has not asked yet: the same call powers a category +
-- seriousness pick and "Surprise me" (both arguments NULL).
CREATE OR REPLACE FUNCTION public.pick_question(p_category TEXT DEFAULT NULL, p_seriousness INT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_couple UUID;
  v_adult_ok BOOLEAN;
  v_question public.questions%ROWTYPE;
  v_found BOOLEAN;
  v_remaining BIGINT;
  v_total BIGINT;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Please sign in first.');
  END IF;
  SELECT couple_id INTO v_couple FROM public.profiles WHERE id = v_user;
  IF v_couple IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pair with your partner before asking questions.');
  END IF;
  v_adult_ok := public.couple_adult_questions_enabled(v_couple);

  SELECT * INTO v_question
  FROM public.questions q
  WHERE (p_category IS NULL OR q.category = public.canonical_question_category(p_category))
    AND (p_seriousness IS NULL OR q.seriousness = p_seriousness)
    AND (NOT q.is_adult OR v_adult_ok)
    AND NOT EXISTS (
      SELECT 1 FROM public.question_sessions s
      WHERE s.couple_id = v_couple AND s.question_id = q.id
    )
  ORDER BY random()
  LIMIT 1;
  v_found := FOUND;

  SELECT
    count(*) FILTER (WHERE NOT EXISTS (
      SELECT 1 FROM public.question_sessions s
      WHERE s.couple_id = v_couple AND s.question_id = q.id
    )),
    count(*)
  INTO v_remaining, v_total
  FROM public.questions q
  WHERE (p_category IS NULL OR q.category = public.canonical_question_category(p_category))
    AND (p_seriousness IS NULL OR q.seriousness = p_seriousness)
    AND (NOT q.is_adult OR v_adult_ok);

  RETURN jsonb_build_object(
    'success', true,
    'question', CASE WHEN v_found THEN to_jsonb(v_question) ELSE NULL END,
    'remaining', v_remaining,
    'total', v_total,
    'adult_enabled', v_adult_ok
  );
END;
$$;

-- "Ask my partner". Idempotent: asking the same question twice returns the session that
-- already exists instead of failing, so a double tap is harmless.
CREATE OR REPLACE FUNCTION public.ask_question(p_question TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_couple UUID;
  v_question public.questions%ROWTYPE;
  v_existing UUID;
  v_session UUID;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Please sign in first.');
  END IF;
  SELECT couple_id INTO v_couple FROM public.profiles WHERE id = v_user;
  IF v_couple IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pair with your partner before asking questions.');
  END IF;
  SELECT * INTO v_question FROM public.questions WHERE id = p_question;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'That question is not in your library any more.');
  END IF;
  IF v_question.is_adult AND NOT public.couple_adult_questions_enabled(v_couple) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Intimacy questions stay hidden until you both turn them on in settings.'
    );
  END IF;

  SELECT id INTO v_existing FROM public.question_sessions
  WHERE couple_id = v_couple AND question_id = p_question;
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'session_id', v_existing, 'already_asked', true);
  END IF;

  BEGIN
    INSERT INTO public.question_sessions (couple_id, question_id, started_by)
    VALUES (v_couple, p_question, v_user)
    RETURNING id INTO v_session;
  EXCEPTION WHEN unique_violation THEN
    -- Two taps at once: whoever lost the race simply gets the winner's session.
    SELECT id INTO v_session FROM public.question_sessions
    WHERE couple_id = v_couple AND question_id = p_question;
  END;

  RETURN jsonb_build_object('success', true, 'session_id', v_session, 'already_asked', false);
END;
$$;

-- The RLS policies above call the predicates as the *invoking* user, so authenticated
-- needs EXECUTE on them; anon and the world get nothing. The canonical_* helpers stay
-- private: only the import trigger and the SECURITY DEFINER RPCs use them.
REVOKE ALL ON FUNCTION public.canonical_question_category(TEXT),
  public.canonical_question_input_type(TEXT), public.canonical_question_options(JSONB),
  public.get_session_couple_id(UUID), public.get_answer_couple_id(UUID),
  public.is_session_revealed(UUID), public.couple_adult_questions_enabled(UUID),
  public.question_categories(), public.pick_question(TEXT, INT), public.ask_question(TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_session_couple_id(UUID), public.get_answer_couple_id(UUID),
  public.is_session_revealed(UUID), public.couple_adult_questions_enabled(UUID),
  public.question_categories(), public.pick_question(TEXT, INT), public.ask_question(TEXT)
  TO authenticated;

-- ============================================================================
-- 11) API-role privileges
-- ============================================================================

GRANT SELECT ON public.questions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.couple_settings TO authenticated;
GRANT SELECT, INSERT ON public.question_sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.answers TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.answer_reactions TO authenticated;
REVOKE ALL ON public.questions, public.couple_settings, public.question_sessions,
  public.answers, public.answer_reactions FROM anon;

-- Revoked as well as simply not granted: on a project that still carries Supabase's
-- legacy default privileges, `authenticated` would otherwise inherit write access to both
-- of these. The library is imported by the owner (or a service-role import), and a
-- session's progress columns belong to the trigger rather than to a phone. Row-level
-- security would refuse either way; this removes the privilege as well, so the two can
-- never disagree.
REVOKE INSERT, UPDATE, DELETE ON public.questions FROM authenticated;
REVOKE UPDATE, DELETE ON public.question_sessions FROM authenticated;

-- ============================================================================
-- 12) Realtime: a partner's answer, the reveal and their reaction should arrive
--     without a refresh. RLS still decides what each phone is allowed to see.
-- ============================================================================

ALTER TABLE public.question_sessions REPLICA IDENTITY FULL;
ALTER TABLE public.answers REPLICA IDENTITY FULL;
ALTER TABLE public.answer_reactions REPLICA IDENTITY FULL;
ALTER TABLE public.couple_settings REPLICA IDENTITY FULL;

DO $realtime$
DECLARE
  v_table TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RETURN;
  END IF;
  FOREACH v_table IN ARRAY ARRAY['questions', 'couple_settings', 'question_sessions', 'answers', 'answer_reactions'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = v_table
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
    END IF;
  END LOOP;
END
$realtime$;

COMMIT;
