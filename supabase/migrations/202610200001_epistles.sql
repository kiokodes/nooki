-- Run this migration on existing Supabase projects before deploying Epistles.
-- It adds the one table behind the letters couples write each other: long-form,
-- sealed letters that live apart from the chat — a keepsake, not a bubble.
-- Nothing existing is modified or removed, so it is safe on a live project and safe
-- to rerun.
--
-- The life of a letter:
--   draft    sealed_at IS NULL                 → only the sender can see it.
--   sealed   sealed_at IS NOT NULL             → it stands in the partner's mailbox,
--                                                flap down, wax intact.
--   waiting  opens_at > today (UTC)            → visible, but the seal refuses until
--                                                the chosen day (an anniversary letter).
--   opened   opened_at IS NOT NULL             → the partner broke the seal. The letter
--                                                becomes final: words are given, and
--                                                from here they are never taken back.
--
-- While a letter is sealed but still unopened the sender may recall it back to draft
-- and rewrite it — a letter can be reworded only for as long as it is still theirs.
BEGIN;

CREATE TABLE IF NOT EXISTS public.epistles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  -- Who wrote it. The row carries the author's own words.
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- An optional name for the letter, shown on the envelope. Absent is fine: some
  -- letters need no title, only a beginning.
  title TEXT CHECK (char_length(btrim(title)) <= 80),
  -- The letter itself. Long-form on purpose: this is the one place in Nooki built
  -- for a thousand words, not a sentence.
  body TEXT NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 20000),
  -- NULL while it is a draft. Sealing stamps the moment it was sent.
  sealed_at TIMESTAMPTZ,
  -- The calendar day (sender's promise, `YYYY-MM-DD`) before which the partner's
  -- seal refuses to break. NULL for "as soon as they like". A draft never carries
  -- one: the day means nothing until the letter is sealed.
  opens_at DATE,
  -- The moment the partner broke the seal. NULL while it is still waiting. Once set,
  -- the letter is final for both of them.
  opened_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT epistles_draft_has_no_open_day CHECK (sealed_at IS NOT NULL OR opens_at IS NULL)
);

-- Keep updated_at honest without the client having to remember it.
CREATE OR REPLACE FUNCTION public.set_epistle_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  NEW.updated_at := timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS epistles_set_updated_at ON public.epistles;
CREATE TRIGGER epistles_set_updated_at
BEFORE UPDATE ON public.epistles
FOR EACH ROW EXECUTE FUNCTION public.set_epistle_updated_at();

CREATE INDEX IF NOT EXISTS idx_epistles_couple_created
ON public.epistles(couple_id, created_at DESC);

ALTER TABLE public.epistles ENABLE ROW LEVEL SECURITY;

-- Reading: the couple sees sealed and opened letters; a draft is the sender's alone.
-- An unpaired account (NULL couple id) matches nothing.
DROP POLICY IF EXISTS "Couple members can view their epistles" ON public.epistles;
CREATE POLICY "Couple members can view their epistles" ON public.epistles
FOR SELECT TO authenticated
USING (
  couple_id = public.get_user_couple_id(auth.uid())
  AND (sender_id = auth.uid() OR sealed_at IS NOT NULL)
);

-- Writing: an author starts their own letter as a draft, in their own couple.
DROP POLICY IF EXISTS "Authors start their own drafts" ON public.epistles;
CREATE POLICY "Authors start their own drafts" ON public.epistles
FOR INSERT TO authenticated
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid())
  AND sender_id = auth.uid()
  AND sealed_at IS NULL
  AND opens_at IS NULL
  AND opened_at IS NULL
);

-- Rewriting: while the letter has not been opened it still belongs to its author —
-- draft, sealed, or recalled — and nobody else may touch it.
DROP POLICY IF EXISTS "Authors may rework an unopened letter" ON public.epistles;
CREATE POLICY "Authors may rework an unopened letter" ON public.epistles
FOR UPDATE TO authenticated
USING (
  couple_id = public.get_user_couple_id(auth.uid())
  AND sender_id = auth.uid()
  AND opened_at IS NULL
)
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid())
  AND sender_id = auth.uid()
);

-- Drafts only: a sealed letter is a keepsake, and a keepsake is not deleted.
DROP POLICY IF EXISTS "Authors may discard their own drafts" ON public.epistles;
CREATE POLICY "Authors may discard their own drafts" ON public.epistles
FOR DELETE TO authenticated
USING (
  couple_id = public.get_user_couple_id(auth.uid())
  AND sender_id = auth.uid()
  AND sealed_at IS NULL
);

-- The one write the partner ever makes: breaking the seal. It goes through the
-- function below, so "is it the day yet?" is the database's answer, not the phone's.
CREATE OR REPLACE FUNCTION public.open_epistle(p_epistle_id UUID)
RETURNS SETOF public.epistles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  cid UUID;
  letter public.epistles;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Sign in to open a letter.';
  END IF;
  IF p_epistle_id IS NULL THEN
    RAISE EXCEPTION 'That letter does not exist.';
  END IF;

  cid := public.get_user_couple_id(caller);
  IF cid IS NULL THEN
    RAISE EXCEPTION 'Pair with your partner before opening a letter.';
  END IF;

  SELECT * INTO letter FROM public.epistles WHERE id = p_epistle_id;
  IF NOT FOUND OR letter.couple_id <> cid THEN
    RAISE EXCEPTION 'That letter does not exist.';
  END IF;
  IF letter.sender_id = caller THEN
    RAISE EXCEPTION 'Your own letter was never sealed to you.';
  END IF;
  IF letter.sealed_at IS NULL THEN
    RAISE EXCEPTION 'That letter has not been sent yet.';
  END IF;
  IF letter.opened_at IS NOT NULL THEN
    -- Already opened (the ceremony may have raced a second device): nothing to do,
    -- the letter is simply returned so the reader can go on reading.
    RETURN QUERY SELECT * FROM public.epistles WHERE id = p_epistle_id;
    RETURN;
  END IF;
  -- The waiting game is decided against the server's own clock: an anniversary letter
  -- is not openable early, whatever a phone claims its date is.
  IF letter.opens_at IS NOT NULL AND letter.opens_at > (timezone('utc'::text, now()))::date THEN
    RAISE EXCEPTION 'This letter opens on %. Not yet.', letter.opens_at;
  END IF;

  UPDATE public.epistles
  SET opened_at = timezone('utc'::text, now())
  WHERE id = p_epistle_id;

  RETURN QUERY SELECT * FROM public.epistles WHERE id = p_epistle_id;
END;
$$;

-- The table is read and written by the couple's own phones under the policies above.
-- Supabase stopped granting Data API access to new "public" tables automatically
-- (announced for 2026-10-30), so every role that reaches this table is granted here,
-- by name. service_role matters: send-push counts the couple's unopened letters with
-- the service key, and a project that skips this grant breaks that query.
REVOKE ALL ON public.epistles FROM anon;
REVOKE ALL ON public.epistles FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.epistles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.epistles TO service_role;

REVOKE ALL ON FUNCTION public.open_epistle(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_epistle(UUID) TO authenticated;

-- Realtime: a sealed letter should appear in the partner's mailbox without a refresh,
-- the way a message does. Guarded so the migration also runs where the publication is
-- absent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'epistles'
     )
  THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.epistles;
  END IF;
END;
$$;

COMMIT;
