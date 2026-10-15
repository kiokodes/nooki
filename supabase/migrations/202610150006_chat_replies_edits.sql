-- ============================================================================
-- Migration: chat replies and edits (2026-10-15)
--
-- Two messengers-for-two features, deliberately small:
--
--   1. REPLY — a message can quote the one it answers. WhatsApp does this with a
--      swipe; the chat screen also offers it from a long-press menu. Swiping/quoting
--      never crosses couples: the database refuses a reply_to_id that points at a
--      message this couple does not own.
--
--   2. EDIT — the author (and only the author) can fix the words later. The stamp is
--      edited_at, set by the server's clock so the "edited" marker is trustworthy,
--      and everything else about the row stays frozen. There is still no delete and
--      nothing like a reaction: the log is permanent, in two voices.
--
-- The read-receipt carve-out keeps its rule: only the recipient stamps read_at, and
-- a stamp is never taken back.
-- ============================================================================

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES public.messages(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.messages.reply_to_id IS
  'The message this one answers (set by swipe-to-reply). NULL for ordinary messages.';

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

COMMENT ON COLUMN public.messages.edited_at IS
  'When the author last rewrote the content. NULL while the message is unedited.';

-- The guard, rewritten for replies and edits. What may never move: who said it, in
-- which couple, when, of which type, and what it answers. What may move, and by whom:
--   * content        — only by its author; the trigger stamps edited_at itself.
--   * read_at        — only by the recipient, and only the first time.
CREATE OR REPLACE FUNCTION public.guard_message_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.couple_id <> OLD.couple_id
     OR NEW.sender_id IS DISTINCT FROM OLD.sender_id
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.reply_to_id IS DISTINCT FROM OLD.reply_to_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Most of a message is frozen: only its author can edit the words, and only the recipient can stamp the receipt.';
  END IF;

  IF NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    IF OLD.sender_id IS NOT DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'You cannot mark your own message as read.';
    END IF;
    IF OLD.read_at IS NOT NULL OR NEW.read_at IS NULL THEN
      RAISE EXCEPTION 'A read receipt cannot be taken back.';
    END IF;
  END IF;

  IF NEW.content IS DISTINCT FROM OLD.content THEN
    IF OLD.sender_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'You can only edit your own messages.';
    END IF;
    -- The server stamps the edit: a phone's clock never writes edited_at.
    NEW.edited_at := timezone('utc'::text, now());
  ELSIF NEW.edited_at IS DISTINCT FROM OLD.edited_at THEN
    -- Silently keeping an edited_at the client sent would let it look forged.
    RAISE EXCEPTION 'The edit stamp only moves when the words do.';
  END IF;

  RETURN NEW;
END;
$$;

-- The trigger exists since the chat migration; CREATED here so a rerun on an older
-- base settles the same way.
DROP TRIGGER IF EXISTS messages_guard_immutable ON public.messages;
CREATE TRIGGER messages_guard_immutable
BEFORE UPDATE ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.guard_message_immutable();

-- A reply may only quote a message inside this couple's own chat. The lookup goes
-- through a definer-side function by design: a policy that selects from messages
-- recursively applies the read policy inside itself, and the mutual recursion then
-- refuses even honest replies. Reading as the owner settles it; the check still only
-- answers "is that message part of this couple's chat".
CREATE OR REPLACE FUNCTION public.message_is_in_couple(p_message_id UUID, p_couple_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_message_id IS NOT NULL
     AND p_couple_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.messages parent
       WHERE parent.id = p_message_id AND parent.couple_id = p_couple_id
     );
$$;

DROP POLICY IF EXISTS "Couple members can send messages" ON public.messages;
CREATE POLICY "Couple members can send messages" ON public.messages
FOR INSERT TO authenticated
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid())
  AND (sender_id = auth.uid() OR (sender_id IS NULL AND type = 'system'))
  AND (session_id IS NULL OR public.get_session_couple_id(session_id) = couple_id)
  AND (reply_to_id IS NULL OR public.message_is_in_couple(reply_to_id, couple_id))
);

-- The UPDATE policy covered only the read receipt; it now covers the author's edit
-- too. Which kind of change is legal, and for whom, is the guard's job above.
DROP POLICY IF EXISTS "Couple members can mark messages read" ON public.messages;
DROP POLICY IF EXISTS "Couple members can update their chat" ON public.messages;
CREATE POLICY "Couple members can update their chat" ON public.messages
FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()))
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()));

COMMIT;
