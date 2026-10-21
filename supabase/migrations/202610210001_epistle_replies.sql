-- Run this migration on existing Supabase projects before deploying epistle replies.
-- It adds the one column behind a correspondence: `reply_to_id`, the letter a new
-- letter answers. A chain of answers is simply letters pointing at each other, oldest
-- first — the app walks the links, so no thread table is needed.
-- Nothing existing is modified or removed, so it is safe on a live project and safe
-- to rerun.
--
-- The rules of a reply, kept here rather than on the phone:
--   * it answers a letter the writer could actually read — sealed, in their own
--     couple (an unseen draft or a stranger's letter answers nothing);
--   * it never answers a draft, not even the writer's own;
--   * it never answers itself.
-- The link is checked only when it changes: a reply drafted in good faith keeps
-- saving even if the answered letter is later taken back to draft, and deleting an
-- answered letter (only a draft can ever be deleted, and drafts are never answered)
-- simply leaves the reply starting its own correspondence.
BEGIN;

ALTER TABLE public.epistles
  ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES public.epistles(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'epistles_no_self_reply') THEN
    ALTER TABLE public.epistles
      ADD CONSTRAINT epistles_no_self_reply CHECK (reply_to_id IS NULL OR reply_to_id <> id);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_epistles_reply_to ON public.epistles(reply_to_id);

CREATE OR REPLACE FUNCTION public.check_epistle_reply()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE
  target public.epistles;
BEGIN
  IF NEW.reply_to_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- An unchanged link is not re-examined: rewording a reply must never fail because
  -- the answered letter moved on without it.
  IF TG_OP = 'UPDATE' AND NEW.reply_to_id IS NOT DISTINCT FROM OLD.reply_to_id THEN
    RETURN NEW;
  END IF;
  -- This runs as the caller, so the lookup sees exactly the letters they may see: a
  -- partner's draft or another couple's letter is simply not found.
  SELECT * INTO target FROM public.epistles WHERE id = NEW.reply_to_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'You can only reply to a letter in your own mailbox.';
  END IF;
  IF target.couple_id <> NEW.couple_id THEN
    RAISE EXCEPTION 'You can only reply to a letter in your own mailbox.';
  END IF;
  IF target.sealed_at IS NULL THEN
    RAISE EXCEPTION 'You can only reply to a letter that has been sealed.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS epistles_check_reply ON public.epistles;
CREATE TRIGGER epistles_check_reply
BEFORE INSERT OR UPDATE ON public.epistles
FOR EACH ROW EXECUTE FUNCTION public.check_epistle_reply();

COMMIT;
