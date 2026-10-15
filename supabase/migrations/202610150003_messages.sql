-- Run this migration on existing Supabase projects before deploying the Chat tab.
-- Adds the couple-owned message log with row-level security and Realtime. Nothing
-- existing is modified or removed, so it is safe on a live project and safe to rerun.
--
-- The same statements live at the end of supabase/schema.sql for brand-new projects.
BEGIN;

CREATE TABLE IF NOT EXISTS public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The chat belongs to the couple, never to one partner: both read the same rows.
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  -- Who wrote it. NULL is reserved for 'system' notes (the Discuss tab reuses this chat).
  sender_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  -- 'text' | 'question' | 'answer' | 'system'. Adding the column now means the Discuss
  -- tab can reuse this exact log for prompts and answers later.
  type TEXT NOT NULL DEFAULT 'text'
    CONSTRAINT messages_type_check CHECK (type IN ('text', 'question', 'answer', 'system')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  -- NULL until the partner has actually seen it: this is the read receipt.
  read_at TIMESTAMPTZ,
  CONSTRAINT messages_content_length CHECK (char_length(btrim(content)) BETWEEN 1 AND 4000),
  -- Only a real account can be the sender of a normal message.
  CONSTRAINT messages_system_sender_check CHECK (type = 'system' OR sender_id IS NOT NULL)
);

-- The chat always reads one couple's messages oldest-first; the partial index keeps the
-- unread badge cheap once a couple has a long history.
CREATE INDEX IF NOT EXISTS idx_messages_couple_created
  ON public.messages(couple_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_unread
  ON public.messages(couple_id, sender_id) WHERE read_at IS NULL;

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- Only the two partners of the couple can read their chat. An unpaired account has a
-- NULL couple id, so every policy below denies it.
DROP POLICY IF EXISTS "Couple members can read their messages" ON public.messages;
CREATE POLICY "Couple members can read their messages" ON public.messages
FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

DROP POLICY IF EXISTS "Couple members can send messages" ON public.messages;
CREATE POLICY "Couple members can send messages" ON public.messages
FOR INSERT TO authenticated
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid())
  AND (sender_id = auth.uid() OR (sender_id IS NULL AND type = 'system'))
);

-- Needed for read receipts: the recipient stamps read_at. The trigger below makes sure
-- that is the only thing an update can ever change.
DROP POLICY IF EXISTS "Couple members can mark messages read" ON public.messages;
CREATE POLICY "Couple members can mark messages read" ON public.messages
FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()))
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()));

-- Messages are a permanent log: no delete policy, and an update may only stamp read_at.
CREATE OR REPLACE FUNCTION public.guard_message_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.couple_id <> OLD.couple_id
     OR NEW.sender_id IS DISTINCT FROM OLD.sender_id
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Messages cannot be edited. Only the read receipt can change.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_guard_immutable ON public.messages;
CREATE TRIGGER messages_guard_immutable
BEFORE UPDATE ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.guard_message_immutable();

GRANT SELECT, INSERT, UPDATE ON public.messages TO authenticated;
REVOKE ALL ON public.messages FROM anon;

-- Realtime: new messages and read receipts must arrive without a refresh. REPLICA
-- IDENTITY FULL makes update payloads carry the whole row, so a receipt can update the
-- bubble in place. Guarded so the migration also runs where the publication is absent.
ALTER TABLE public.messages REPLICA IDENTITY FULL;

DO $realtime$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'messages'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
  END IF;
END
$realtime$;

COMMIT;
