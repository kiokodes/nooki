-- Run this migration on existing Supabase projects before deploying this release.
-- Two changes, one story:
--
--   1. The reveal is no longer answered with emoji. `answer_reactions` becomes
--      `answer_comments`: exactly one comment per partner under the two answers.
--   2. When one comment is not enough, "Say more" carries the question into the chat.
--      `messages.session_id` is that link — the bubble quotes the question, and tapping
--      the quote walks both partners back to the revealed answers.
--
-- Nothing existing is modified or removed beyond the emoji column itself, so it is safe
-- on a live project and safe to rerun. The same statements live at the end of
-- supabase/schema.sql for brand-new projects.
BEGIN;

-- ============================================================================
-- 1) answer_reactions becomes answer_comments
--
-- The emoji picker is gone. A row that only ever held an emoji says nothing in a
-- comment-only world, so those rows go; a row that also had a comment keeps the
-- comment. One comment per partner per session is still the unique index.
-- ============================================================================

DO $comments$
BEGIN
  IF to_regclass('public.answer_reactions') IS NULL THEN
    RETURN;
  END IF;
  -- Emoji-only rows have nothing to say once the picker is gone.
  DELETE FROM public.answer_reactions WHERE comment IS NULL OR btrim(comment) = '';
  IF to_regclass('public.answer_comments') IS NULL THEN
    -- Privileges, policies, trigger membership and Realtime publication all follow the
    -- table across a rename: what the old table could do, the new one still can.
    ALTER TABLE public.answer_reactions RENAME TO answer_comments;
  ELSE
    -- A half-migrated project can hold both: retire the leftover's triggers so the old
    -- guard functions below can be dropped. The stray table itself is left alone.
    DROP TRIGGER IF EXISTS answer_reactions_guard ON public.answer_reactions;
    DROP TRIGGER IF EXISTS answer_reactions_set_updated_at ON public.answer_reactions;
  END IF;
END
$comments$;

-- The comment is the whole point now: no emoji column, and no empty comments.
ALTER TABLE public.answer_comments DROP COLUMN IF EXISTS reaction;
ALTER TABLE public.answer_comments ALTER COLUMN comment SET NOT NULL;

-- Index and constraint names survive a table rename unchanged, so they are set straight.
-- Each rename is scoped to the new table's own objects and skipped when the target name
-- is taken: a rerun (or a half-migrated project that kept a stray answer_reactions
-- around) must not trip over names that belong to the leftover table.
DO $names$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public'
       AND t.relname = 'answer_comments'
       AND c.conname = 'answer_reactions_comment_length'
  ) THEN
    ALTER TABLE public.answer_comments
      RENAME CONSTRAINT answer_reactions_comment_length TO answer_comments_comment_length;
  END IF;

  IF to_regclass('public.answer_reactions_session_user') IS NOT NULL
     AND to_regclass('public.answer_comments_session_user') IS NULL THEN
    ALTER INDEX public.answer_reactions_session_user RENAME TO answer_comments_session_user;
  END IF;

  IF to_regclass('public.idx_answer_reactions_session') IS NOT NULL
     AND to_regclass('public.idx_answer_comments_session') IS NULL THEN
    ALTER INDEX public.idx_answer_reactions_session RENAME TO idx_answer_comments_session;
  END IF;
END
$names$;

-- The guards, rewritten for a comment-only world. Old triggers go first so old
-- functions can be dropped without taking anything new with them.
DROP TRIGGER IF EXISTS answer_reactions_guard ON public.answer_comments;
DROP TRIGGER IF EXISTS answer_reactions_set_updated_at ON public.answer_comments;
DROP TRIGGER IF EXISTS answer_comments_guard ON public.answer_comments;
DROP TRIGGER IF EXISTS answer_comments_set_updated_at ON public.answer_comments;
DROP FUNCTION IF EXISTS public.guard_answer_reaction();
DROP FUNCTION IF EXISTS public.set_answer_reaction_updated_at();

CREATE OR REPLACE FUNCTION public.guard_answer_comment()
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
    RAISE EXCEPTION 'You can only comment inside your own couple.';
  END IF;
  IF NEW.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'You can only comment as yourself.';
  END IF;
  IF NOT public.is_session_revealed(NEW.session_id) THEN
    RAISE EXCEPTION 'Comments wait until you have both answered.';
  END IF;
  NEW.comment := NULLIF(btrim(coalesce(NEW.comment, '')), '');
  IF NEW.comment IS NULL THEN
    RAISE EXCEPTION 'Say something about it first.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_answer_comment_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER answer_comments_guard
BEFORE INSERT OR UPDATE ON public.answer_comments
FOR EACH ROW EXECUTE FUNCTION public.guard_answer_comment();

CREATE TRIGGER answer_comments_set_updated_at
BEFORE UPDATE ON public.answer_comments
FOR EACH ROW EXECUTE FUNCTION public.set_answer_comment_updated_at();

-- The policies keep their rules and get names that say "comment".
DROP POLICY IF EXISTS "Couple members can view reactions" ON public.answer_comments;
DROP POLICY IF EXISTS "Couple members can view comments" ON public.answer_comments;
CREATE POLICY "Couple members can view comments" ON public.answer_comments
FOR SELECT TO authenticated
USING (
  public.get_session_couple_id(session_id) = public.get_user_couple_id(auth.uid())
  AND public.is_session_revealed(session_id)
);

DROP POLICY IF EXISTS "Couple members can react to a reveal" ON public.answer_comments;
DROP POLICY IF EXISTS "Couple members can comment on a reveal" ON public.answer_comments;
CREATE POLICY "Couple members can comment on a reveal" ON public.answer_comments
FOR INSERT TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND public.get_session_couple_id(session_id) = public.get_user_couple_id(auth.uid())
  AND public.is_session_revealed(session_id)
);

DROP POLICY IF EXISTS "Users can change their own reaction" ON public.answer_comments;
DROP POLICY IF EXISTS "Users can change their own comment" ON public.answer_comments;
CREATE POLICY "Users can change their own comment" ON public.answer_comments
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
-- 2) messages.session_id: the "Say more" bridge from Discuss into Chat
--
-- An ordinary message keeps NULL. A message sent from "Say more" points at the question
-- session it grew out of; the chat renders that as a quoted question card, and tapping
-- the card opens the session — that is how both partners get back to the answers.
-- ============================================================================

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES public.question_sessions(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.messages.session_id IS
  'The Discuss question this message continues from (set by "Say more"). NULL for ordinary messages.';

-- The link is frozen with the rest of the message: only the read receipt can change.
CREATE OR REPLACE FUNCTION public.guard_message_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.couple_id <> OLD.couple_id
     OR NEW.sender_id IS DISTINCT FROM OLD.sender_id
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Messages cannot be edited. Only the read receipt can change.';
  END IF;
  RETURN NEW;
END;
$$;

-- A "Say more" link may only point at one of this couple's own questions: quoting
-- another couple's question in your chat is refused row by row.
DROP POLICY IF EXISTS "Couple members can send messages" ON public.messages;
CREATE POLICY "Couple members can send messages" ON public.messages
FOR INSERT TO authenticated
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid())
  AND (sender_id = auth.uid() OR (sender_id IS NULL AND type = 'system'))
  AND (session_id IS NULL OR public.get_session_couple_id(session_id) = couple_id)
);

COMMIT;
