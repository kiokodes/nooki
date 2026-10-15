-- ============================================================================
-- NOOKI SUPABASE SCHEMA & ROW LEVEL SECURITY (RLS)
-- Couples app for long-distance partners
-- ============================================================================

-- 1. Create couples table
CREATE TABLE IF NOT EXISTS public.couples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_code VARCHAR(6) UNIQUE NOT NULL,
  anniversary_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  breakup_requested_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  breakup_requested_at TIMESTAMPTZ
);

-- 2. Create profiles table
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  couple_id UUID REFERENCES public.couples(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  last_seen_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Index for speedy queries
CREATE INDEX IF NOT EXISTS idx_profiles_couple_id ON public.profiles(couple_id);
CREATE INDEX IF NOT EXISTS idx_couples_invite_code ON public.couples(invite_code);

-- 3. Enable RLS
ALTER TABLE public.couples ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 4. Helper function to check user's couple_id
CREATE OR REPLACE FUNCTION public.get_user_couple_id(user_uid UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT couple_id FROM public.profiles WHERE id = user_uid;
$$;

-- 5. Helper function to count couple members
CREATE OR REPLACE FUNCTION public.get_couple_members_count(cid UUID)
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT COUNT(*) FROM public.profiles WHERE couple_id = cid;
$$;

-- 6. Row Level Security Policies for profiles
-- Users can view their own profile or their partner's profile (profiles in the same couple)
CREATE POLICY "Users can view own profile or partner profile"
ON public.profiles
FOR SELECT
USING (
  auth.uid() = id
  OR (couple_id IS NOT NULL AND couple_id = public.get_user_couple_id(auth.uid()))
);

-- 7/8. Atomic pairing, private invite codes, and anniversary locking after both partners join
-- Pairing membership changes go through authenticated, atomic RPCs only.
DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
CREATE POLICY "Users can insert own profile" ON public.profiles
FOR INSERT TO authenticated WITH CHECK (auth.uid() = id AND couple_id IS NULL);

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile" ON public.profiles
FOR UPDATE TO authenticated USING (auth.uid() = id)
WITH CHECK (auth.uid() = id AND couple_id IS NOT DISTINCT FROM public.get_user_couple_id(auth.uid()));

-- Do not expose everybody's invite codes to unpaired users.
DROP POLICY IF EXISTS "Users can view own couple or query invite code" ON public.couples;
CREATE POLICY "Users can view own couple or query invite code" ON public.couples
FOR SELECT TO authenticated USING (id = public.get_user_couple_id(auth.uid()));
DROP POLICY IF EXISTS "Authenticated users can create couples" ON public.couples;

-- Remove the self-referencing RLS subquery; enforce anniversary locking with a trigger.
DROP POLICY IF EXISTS "Users can update own couple" ON public.couples;
CREATE POLICY "Users can update own couple" ON public.couples
FOR UPDATE TO authenticated USING (id = public.get_user_couple_id(auth.uid()))
WITH CHECK (id = public.get_user_couple_id(auth.uid()));

CREATE OR REPLACE FUNCTION public.guard_paired_anniversary()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.anniversary_date IS DISTINCT FROM OLD.anniversary_date
     AND public.get_couple_members_count(OLD.id) >= 2 THEN
    RAISE EXCEPTION 'Your anniversary is locked now that both partners have joined.';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_paired_anniversary ON public.couples;
CREATE TRIGGER guard_paired_anniversary BEFORE UPDATE ON public.couples
FOR EACH ROW EXECUTE FUNCTION public.guard_paired_anniversary();

CREATE OR REPLACE FUNCTION public.create_couple(anniversary DATE)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_profile public.profiles%ROWTYPE;
  v_couple_id UUID;
  v_code TEXT;
  v_chars CONSTANT TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_attempt INT;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Please sign in before creating a code.');
  END IF;
  SELECT * INTO v_profile FROM public.profiles WHERE id = v_user FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Please finish your profile before creating a code.');
  END IF;
  IF v_profile.couple_id IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'You already have a code. Go back to pairing options first.');
  END IF;
  IF anniversary IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Please select an anniversary date.');
  END IF;

  -- Retry rare invite collisions. Creating the couple and linking its creator are one transaction.
  FOR v_attempt IN 1..10 LOOP
    v_code := '';
    FOR i IN 1..6 LOOP
      v_code := v_code || substr(v_chars, 1 + floor(random() * length(v_chars))::INT, 1);
    END LOOP;
    BEGIN
      INSERT INTO public.couples (invite_code, anniversary_date)
      VALUES (v_code, anniversary) RETURNING id INTO v_couple_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempt = 10 THEN RAISE; END IF;
    END;
  END LOOP;
  UPDATE public.profiles SET couple_id = v_couple_id WHERE id = v_user;
  RETURN jsonb_build_object('success', true, 'couple_id', v_couple_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.leave_pending_couple()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_couple_id UUID;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Please sign in first.');
  END IF;
  SELECT couple_id INTO v_couple_id FROM public.profiles WHERE id = v_user FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'User profile not found.');
  END IF;
  IF v_couple_id IS NULL THEN RETURN jsonb_build_object('success', true); END IF;
  -- Same couple-row lock used by join and anniversary edits: no cancellation after a partner joins.
  PERFORM id FROM public.couples WHERE id = v_couple_id FOR UPDATE;
  IF public.get_couple_members_count(v_couple_id) >= 2 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Your partner has already joined. Refresh to open your shared nook.');
  END IF;
  UPDATE public.profiles SET couple_id = NULL WHERE id = v_user;
  DELETE FROM public.couples WHERE id = v_couple_id;
  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_pending_anniversary(anniversary DATE)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_couple_id UUID;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Please sign in first.');
  END IF;
  SELECT couple_id INTO v_couple_id FROM public.profiles WHERE id = v_user FOR UPDATE;
  IF v_couple_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Couple not found.');
  END IF;
  PERFORM id FROM public.couples WHERE id = v_couple_id FOR UPDATE;
  IF public.get_couple_members_count(v_couple_id) >= 2 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Your anniversary is locked now that both partners have joined.');
  END IF;
  IF anniversary IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Please select an anniversary date.');
  END IF;
  UPDATE public.couples SET anniversary_date = anniversary WHERE id = v_couple_id;
  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.join_couple(code TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_current_couple UUID;
  v_couple public.couples%ROWTYPE;
  v_member_count BIGINT;
  v_code TEXT := upper(regexp_replace(code, '\s', '', 'g'));
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Please sign in before entering a code.');
  END IF;
  SELECT couple_id INTO v_current_couple FROM public.profiles WHERE id = v_user FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Please finish your profile before joining.');
  END IF;
  IF v_code IS NULL OR v_code !~ '^[A-Z0-9]{6}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Please enter a valid 6-character invite code.');
  END IF;
  -- Serialize joins so two people cannot claim the final place simultaneously.
  SELECT * INTO v_couple FROM public.couples WHERE invite_code = v_code FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid or cancelled code. Ask your partner to check their current code.');
  END IF;
  -- A retry after a successful join must not look like a failed login.
  IF v_current_couple = v_couple.id THEN
    RETURN jsonb_build_object('success', true, 'couple_id', v_couple.id);
  END IF;
  IF v_current_couple IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'You already have a code. Go back to pairing options first.');
  END IF;
  v_member_count := public.get_couple_members_count(v_couple.id);
  IF v_member_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'This code is no longer active. Ask your partner for a new code.');
  END IF;
  IF v_member_count >= 2 THEN
    RETURN jsonb_build_object('success', false, 'error', 'This couple already has 2 partners.');
  END IF;
  UPDATE public.profiles SET couple_id = v_couple.id WHERE id = v_user;
  RETURN jsonb_build_object('success', true, 'couple_id', v_couple.id);
END;
$$;

REVOKE ALL ON FUNCTION public.create_couple(DATE), public.leave_pending_couple(),
  public.update_pending_anniversary(DATE), public.join_couple(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_couple(DATE), public.leave_pending_couple(),
  public.update_pending_anniversary(DATE), public.join_couple(TEXT) TO authenticated;


-- 9. Stored Procedure: End couple (Mutual Agreement Danger Zone)
CREATE OR REPLACE FUNCTION public.request_or_confirm_breakup()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_couple_id UUID;
  v_couple RECORD;
BEGIN
  SELECT couple_id INTO v_couple_id FROM public.profiles WHERE id = v_user_id;
  IF v_couple_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not currently in a couple.');
  END IF;

  SELECT * INTO v_couple FROM public.couples WHERE id = v_couple_id;

  -- If no breakup requested yet, mark current user as requester
  IF v_couple.breakup_requested_by IS NULL THEN
    UPDATE public.couples
    SET breakup_requested_by = v_user_id,
        breakup_requested_at = now()
    WHERE id = v_couple_id;

    RETURN jsonb_build_object('success', true, 'status', 'requested', 'message', 'Breakup requested. Waiting for partner confirmation.');
  END IF;

  -- If current user is same as requester, allow cancellation or report waiting
  IF v_couple.breakup_requested_by = v_user_id THEN
    RETURN jsonb_build_object('success', true, 'status', 'waiting_partner', 'message', 'Already requested. Waiting for your partner to confirm.');
  END IF;

  -- Both parties agree! Unlink both partners and delete couple
  UPDATE public.profiles
  SET couple_id = NULL
  WHERE couple_id = v_couple_id;

  DELETE FROM public.couples WHERE id = v_couple_id;

  RETURN jsonb_build_object('success', true, 'status', 'ended', 'message', 'Couple ended by mutual agreement. Both partners are now free to create or join a new couple.');
END;
$$;

-- 10. Cancel breakup request
CREATE OR REPLACE FUNCTION public.cancel_breakup_request()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_couple_id UUID;
BEGIN
  SELECT couple_id INTO v_couple_id FROM public.profiles WHERE id = v_user_id;
  IF v_couple_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not currently in a couple.');
  END IF;

  UPDATE public.couples
  SET breakup_requested_by = NULL,
      breakup_requested_at = NULL
  WHERE id = v_couple_id;

  RETURN jsonb_build_object('success', true, 'message', 'Breakup request cancelled.');
END;
$$;

-- ============================================================================
-- 11. Couple events (the shared calendar) and API-role privileges
-- Added for the Today card and full calendar. Kept identical to
-- supabase/migrations/202610150002_couple_events.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.couple_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  -- Who added it; the row survives that account being deleted.
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  event_date DATE NOT NULL,
  -- 'none' | 'weekly' | 'monthly' | 'yearly'
  repeat_frequency TEXT NOT NULL DEFAULT 'none'
    CONSTRAINT couple_events_repeat_frequency_check
    CHECK (repeat_frequency IN ('none', 'weekly', 'monthly', 'yearly')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT couple_events_title_length CHECK (char_length(btrim(title)) BETWEEN 1 AND 120)
);

-- Upgrade path: a project that ran the earlier revision of this migration has the table
-- already, so CREATE TABLE IF NOT EXISTS skipped it and it has no repeat_frequency yet.
ALTER TABLE public.couple_events ADD COLUMN IF NOT EXISTS repeat_frequency TEXT NOT NULL DEFAULT 'none';

-- An earlier revision also stored a repeats_yearly boolean. Convert it in place, then drop
-- the old column so both paths end up identical.
DO $upgrade$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'couple_events' AND column_name = 'repeats_yearly'
  ) THEN
    EXECUTE $sql$ UPDATE public.couple_events SET repeat_frequency = 'yearly'
                 WHERE repeats_yearly AND repeat_frequency = 'none' $sql$;
    EXECUTE 'ALTER TABLE public.couple_events DROP COLUMN repeats_yearly';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'couple_events_repeat_frequency_check') THEN
    ALTER TABLE public.couple_events ADD CONSTRAINT couple_events_repeat_frequency_check
      CHECK (repeat_frequency IN ('none', 'weekly', 'monthly', 'yearly'));
  END IF;
END
$upgrade$;

-- The calendar always reads one couple's events, ordered by date.
CREATE INDEX IF NOT EXISTS idx_couple_events_couple_date
  ON public.couple_events(couple_id, event_date);

ALTER TABLE public.couple_events ENABLE ROW LEVEL SECURITY;

-- Only the two partners of the event's couple can read or change it.
-- Unpaired users have a NULL couple id, so every policy denies them.
DROP POLICY IF EXISTS "Couple members can view their events" ON public.couple_events;
CREATE POLICY "Couple members can view their events" ON public.couple_events
FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

DROP POLICY IF EXISTS "Couple members can add events" ON public.couple_events;
CREATE POLICY "Couple members can add events" ON public.couple_events
FOR INSERT TO authenticated
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()) AND created_by = auth.uid());

DROP POLICY IF EXISTS "Couple members can edit their events" ON public.couple_events;
CREATE POLICY "Couple members can edit their events" ON public.couple_events
FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()))
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()));

DROP POLICY IF EXISTS "Couple members can delete their events" ON public.couple_events;
CREATE POLICY "Couple members can delete their events" ON public.couple_events
FOR DELETE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

-- Keep updated_at honest without the client having to remember it.
CREATE OR REPLACE FUNCTION public.set_couple_event_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  NEW.updated_at := timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS couple_events_set_updated_at ON public.couple_events;
CREATE TRIGGER couple_events_set_updated_at
BEFORE UPDATE ON public.couple_events
FOR EACH ROW EXECUTE FUNCTION public.set_couple_event_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.couple_events TO authenticated;
REVOKE ALL ON public.couple_events FROM anon;

-- Pin the API-role privileges explicitly. Supabase used to auto-grant every new table in
-- public to anon/authenticated; projects created since 2026-05-30 never had that, and all
-- projects stop getting it for new tables from 2026-10-30. Without these statements a
-- project on the new behaviour would leave authenticated with no access to these tables.
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT SELECT, UPDATE ON public.couples TO authenticated;
REVOKE ALL ON public.profiles, public.couples FROM anon;


-- ============================================================================
-- 12. Couple messages (the Chat tab) and Realtime
-- Added for the real-time chat between the two partners. Kept identical to
-- supabase/migrations/202610150003_messages.sql.
-- ============================================================================

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
-- bubble in place. Guarded so the schema also loads where the publication is absent.
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


-- ============================================================================
-- 13. Discuss: the shared question library, each couple's private sessions,
-- answers, one comment each, and the 18+ consent both partners must give.
-- Added for the Discuss tab. Kept identical to
-- supabase/migrations/202610150004_discuss_questions.sql.
-- It inserts no questions: the library is imported from the owner's CSV.
-- ============================================================================


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
-- 6) Comments: one per partner, added after the reveal. Anything longer moves to
--    the chat through "Say more" — see section 14 below.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.answer_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.question_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  comment TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT answer_comments_comment_length CHECK (char_length(btrim(comment)) BETWEEN 1 AND 1000)
);

CREATE UNIQUE INDEX IF NOT EXISTS answer_comments_session_user
  ON public.answer_comments(session_id, user_id);
CREATE INDEX IF NOT EXISTS idx_answer_comments_session ON public.answer_comments(session_id);

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
ALTER TABLE public.answer_comments ENABLE ROW LEVEL SECURITY;

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

-- Comments are part of the reveal, so they follow the same rule as answers.
DROP POLICY IF EXISTS "Couple members can view comments" ON public.answer_comments;
CREATE POLICY "Couple members can view comments" ON public.answer_comments
FOR SELECT TO authenticated
USING (
  public.get_session_couple_id(session_id) = public.get_user_couple_id(auth.uid())
  AND public.is_session_revealed(session_id)
);

DROP POLICY IF EXISTS "Couple members can comment on a reveal" ON public.answer_comments;
CREATE POLICY "Couple members can comment on a reveal" ON public.answer_comments
FOR INSERT TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND public.get_session_couple_id(session_id) = public.get_user_couple_id(auth.uid())
  AND public.is_session_revealed(session_id)
);

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

DROP TRIGGER IF EXISTS answer_comments_guard ON public.answer_comments;
CREATE TRIGGER answer_comments_guard
BEFORE INSERT OR UPDATE ON public.answer_comments
FOR EACH ROW EXECUTE FUNCTION public.guard_answer_comment();

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

DROP TRIGGER IF EXISTS answer_comments_set_updated_at ON public.answer_comments;
CREATE TRIGGER answer_comments_set_updated_at
BEFORE UPDATE ON public.answer_comments
FOR EACH ROW EXECUTE FUNCTION public.set_answer_comment_updated_at();

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
GRANT SELECT, INSERT, UPDATE ON public.answer_comments TO authenticated;
REVOKE ALL ON public.questions, public.couple_settings, public.question_sessions,
  public.answers, public.answer_comments FROM anon;

-- Revoked as well as simply not granted: on a project that still carries Supabase's
-- legacy default privileges, `authenticated` would otherwise inherit write access to both
-- of these. The library is imported by the owner (or a service-role import), and a
-- session's progress columns belong to the trigger rather than to a phone. Row-level
-- security would refuse either way; this removes the privilege as well, so the two can
-- never disagree.
REVOKE INSERT, UPDATE, DELETE ON public.questions FROM authenticated;
REVOKE UPDATE, DELETE ON public.question_sessions FROM authenticated;

-- ============================================================================
-- 12) Realtime: a partner's answer, the reveal and their comment should arrive
--     without a refresh. RLS still decides what each phone is allowed to see.
-- ============================================================================

ALTER TABLE public.question_sessions REPLICA IDENTITY FULL;
ALTER TABLE public.answers REPLICA IDENTITY FULL;
ALTER TABLE public.answer_comments REPLICA IDENTITY FULL;
ALTER TABLE public.couple_settings REPLICA IDENTITY FULL;

DO $realtime$
DECLARE
  v_table TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RETURN;
  END IF;
  FOREACH v_table IN ARRAY ARRAY['questions', 'couple_settings', 'question_sessions', 'answers', 'answer_comments'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = v_table
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
    END IF;
  END LOOP;
END
$realtime$;


-- ============================================================================
-- 14. Comments, and the "Say more" bridge from Discuss into Chat
-- Mirrors supabase/migrations/202610150005_discuss_comments_chat_links.sql for
-- brand-new projects. The comment half (`answer_comments`) is written into section 6
-- above; this half lets a chat message point back at the question it grew out of, so
-- the conversation continues with the revealed answers one tap away.
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

-- A "Say more" link may only point at one of this couple's own questions.
DROP POLICY IF EXISTS "Couple members can send messages" ON public.messages;
CREATE POLICY "Couple members can send messages" ON public.messages
FOR INSERT TO authenticated
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid())
  AND (sender_id = auth.uid() OR (sender_id IS NULL AND type = 'system'))
  AND (session_id IS NULL OR public.get_session_couple_id(session_id) = couple_id)
);

-- ============================================================================
-- 15. Chat replies and edits
-- Mirrors supabase/migrations/202610150006_chat_replies_edits.sql for brand-new
-- projects. Swipe-to-reply quotes the answered message (couple-scoped, frozen on
-- insert), and the author — and only the author — can edit the words later, with the
-- server stamping edited_at. There is still no delete and no reactions.
-- ============================================================================

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS reply_to_id UUID REFERENCES public.messages(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.messages.reply_to_id IS
  'The message this one answers (set by swipe-to-reply). NULL for ordinary messages.';

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

COMMENT ON COLUMN public.messages.edited_at IS
  'When the author last rewrote the content. NULL while the message is unedited.';

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

DROP TRIGGER IF EXISTS messages_guard_immutable ON public.messages;
CREATE TRIGGER messages_guard_immutable
BEFORE UPDATE ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.guard_message_immutable();

-- Same definer-side reason as the migration: quoting must not recurse the read policy
-- into the send policy, so the couple check reads as the owner.
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

DROP POLICY IF EXISTS "Couple members can mark messages read" ON public.messages;
DROP POLICY IF EXISTS "Couple members can update their chat" ON public.messages;
CREATE POLICY "Couple members can update their chat" ON public.messages
FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()))
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()));
-- Games are RPC-only: never expose the table containing unrevealed picks.
BEGIN;
CREATE TABLE IF NOT EXISTS public.game_matches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 couple_id uuid NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
 game text NOT NULL CHECK (game IN ('tic-tac-toe','rock-paper-scissors')),
 daily_date date,
 player_x uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 player_o uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 board text[] NOT NULL DEFAULT ARRAY['','','','','','','','',''],
 turn_id uuid NOT NULL,
 best_of integer NOT NULL DEFAULT 3 CHECK (best_of IN (3,5)),
 round integer NOT NULL DEFAULT 1,
 pick_x text, pick_o text,
 score_x integer NOT NULL DEFAULT 0, score_o integer NOT NULL DEFAULT 0,
 rounds jsonb NOT NULL DEFAULT '[]',
 finished boolean NOT NULL DEFAULT false,
 winner_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(couple_id, daily_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS game_one_practice ON public.game_matches(couple_id,game) WHERE daily_date IS NULL AND NOT finished;
ALTER TABLE public.game_matches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.game_matches FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.games_state() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); result jsonb;
BEGIN
 IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
 SELECT jsonb_build_object('today', (now() AT TIME ZONE 'UTC')::date,
 'wins', (SELECT coalesce(jsonb_object_agg(winner_id,n),'{}') FROM
   (SELECT winner_id,count(*) n FROM public.game_matches WHERE couple_id=cid AND finished AND winner_id IS NOT NULL GROUP BY winner_id) w),
 'matches',coalesce((SELECT jsonb_agg(safe ORDER BY created_at DESC) FROM (
 SELECT created_at, (to_jsonb(m)-'pick_x'-'pick_o') || jsonb_build_object(
 'my_pick',CASE WHEN auth.uid()=player_x THEN pick_x ELSE pick_o END,
 'partner_locked',CASE WHEN auth.uid()=player_x THEN pick_o IS NOT NULL ELSE pick_x IS NOT NULL END) safe
 FROM public.game_matches m WHERE couple_id=cid AND (NOT finished OR daily_date=(now() AT TIME ZONE 'UTC')::date OR id IN (SELECT id FROM public.game_matches WHERE couple_id=cid ORDER BY created_at DESC LIMIT 30))
 ) recent),'[]')) INTO result;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.start_game(p_game text, p_daily boolean DEFAULT false, p_best_of integer DEFAULT 3)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); partner uuid; mid uuid; chosen text;
BEGIN
 IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
 -- Serialize starts across both phones, including daily random selection.
 PERFORM 1 FROM public.couples WHERE id=cid FOR UPDATE;
 SELECT id INTO partner FROM public.profiles WHERE couple_id=cid AND id<>auth.uid();
 IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;
 IF p_daily IS NULL OR p_game IS NULL OR p_game NOT IN ('tic-tac-toe','rock-paper-scissors') OR p_best_of IS NULL OR p_best_of NOT IN (3,5) THEN RAISE EXCEPTION 'Invalid game settings.'; END IF;
 IF p_daily THEN
   SELECT id INTO mid FROM public.game_matches WHERE couple_id=cid AND daily_date=(now() AT TIME ZONE 'UTC')::date;
 ELSE
   SELECT id INTO mid FROM public.game_matches WHERE couple_id=cid AND game=p_game AND daily_date IS NULL AND NOT finished;
 END IF;
 IF mid IS NOT NULL THEN RETURN mid; END IF;
 chosen := CASE WHEN p_daily THEN (ARRAY['tic-tac-toe','rock-paper-scissors'])[1+floor(random()*2)::integer] ELSE p_game END;
 INSERT INTO public.game_matches(couple_id,game,daily_date,player_x,player_o,turn_id,best_of)
 VALUES(cid,chosen,CASE WHEN p_daily THEN (now() AT TIME ZONE 'UTC')::date END,auth.uid(),partner,auth.uid(),CASE WHEN p_daily THEN 3 ELSE p_best_of END) RETURNING id INTO mid;
 RETURN mid;
END $$;

CREATE OR REPLACE FUNCTION public.play_game(p_id uuid, p_round integer, p_move text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m public.game_matches; mark text; cell integer; line integer[]; victor uuid;
BEGIN
 SELECT * INTO m FROM public.game_matches WHERE id=p_id AND couple_id=public.get_user_couple_id(auth.uid()) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.'; END IF;
 IF m.finished THEN RAISE EXCEPTION 'This match is finished.'; END IF;
 IF p_round IS DISTINCT FROM m.round THEN RAISE EXCEPTION 'The game changed. Try again.'; END IF;
 IF m.game='tic-tac-toe' THEN
   IF m.turn_id<>auth.uid() THEN RAISE EXCEPTION 'It is your partner''s turn.'; END IF;
   IF p_move IS NULL OR p_move !~ '^[0-8]$' THEN RAISE EXCEPTION 'Choose a square.'; END IF;
   cell:=p_move::integer+1;
   IF m.board[cell]<>'' THEN RAISE EXCEPTION 'That square is taken.'; END IF;
   mark:=CASE WHEN auth.uid()=m.player_x THEN 'X' ELSE 'O' END;
   m.board[cell]:=mark;
   FOREACH line SLICE 1 IN ARRAY ARRAY[[1,2,3],[4,5,6],[7,8,9],[1,4,7],[2,5,8],[3,6,9],[1,5,9],[3,5,7]] LOOP
     IF m.board[line[1]]=mark AND m.board[line[2]]=mark AND m.board[line[3]]=mark THEN m.finished:=true; m.winner_id:=auth.uid(); END IF;
   END LOOP;
   IF NOT (''=ANY(m.board)) THEN m.finished:=true; END IF;
   m.turn_id:=CASE WHEN auth.uid()=m.player_x THEN m.player_o ELSE m.player_x END;
   m.round:=m.round+1;
 ELSE
   IF p_move IS NULL OR p_move NOT IN ('rock','paper','scissors') THEN RAISE EXCEPTION 'Choose rock, paper or scissors.'; END IF;
   IF auth.uid()=m.player_x THEN
     IF m.pick_x IS NOT NULL THEN RAISE EXCEPTION 'Your pick is already locked.'; END IF;
     m.pick_x:=p_move;
   ELSE
     IF m.pick_o IS NOT NULL THEN RAISE EXCEPTION 'Your pick is already locked.'; END IF;
     m.pick_o:=p_move;
   END IF;
   IF m.pick_x IS NOT NULL AND m.pick_o IS NOT NULL THEN
     IF m.pick_x<>m.pick_o THEN
       IF (m.pick_x='rock' AND m.pick_o='scissors') OR (m.pick_x='paper' AND m.pick_o='rock') OR (m.pick_x='scissors' AND m.pick_o='paper') THEN
         m.score_x:=m.score_x+1; victor:=m.player_x;
       ELSE m.score_o:=m.score_o+1; victor:=m.player_o; END IF;
     END IF;
     m.rounds:=m.rounds || jsonb_build_array(jsonb_build_object('round',m.round,'x',m.pick_x,'o',m.pick_o,'winner',victor));
     IF greatest(m.score_x,m.score_o)>m.best_of/2 THEN m.finished:=true; m.winner_id:=victor; END IF;
     m.pick_x:=NULL; m.pick_o:=NULL; m.round:=m.round+1;
   END IF;
 END IF;
 UPDATE public.game_matches SET board=m.board,turn_id=m.turn_id,round=m.round,pick_x=m.pick_x,pick_o=m.pick_o,score_x=m.score_x,score_o=m.score_o,rounds=m.rounds,finished=m.finished,winner_id=m.winner_id WHERE id=m.id;
END $$;
REVOKE ALL ON FUNCTION public.games_state(), public.start_game(text,boolean,integer), public.play_game(uuid,integer,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.games_state(), public.start_game(text,boolean,integer), public.play_game(uuid,integer,text) TO authenticated;
COMMIT;
