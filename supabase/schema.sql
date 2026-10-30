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
-- 2a. The marketplace key rule first: a generated column can only call a function that
-- already exists. Both are the same rule the migration adds to an existing project
-- (202610170001_partner_locations.sql) and the same one src/lib/geo/location.ts keeps.
CREATE OR REPLACE FUNCTION public.place_key_part(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(
    nullif(
      regexp_replace(
        regexp_replace(
          regexp_replace(lower(btrim(coalesce(value, ''))), '[''’]', '', 'g'),
          '[^a-z0-9]+', '-', 'g'),
        '^-+|-+$', '', 'g'),
      ''),
    '-');
$$;

CREATE OR REPLACE FUNCTION public.profile_city_key(p_country_code TEXT, p_state_code TEXT, p_city_name TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p_country_code IS NULL OR p_city_name IS NULL THEN NULL
    ELSE public.place_key_part(p_country_code) || '/'
         || public.place_key_part(p_state_code) || '/'
         || public.place_key_part(p_city_name)
  END;
$$;

CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  couple_id UUID REFERENCES public.couples(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  -- Where this person is. Optional and whole-or-nothing (see the check below): an account
  -- made before the location pickers has none of it and keeps working on `timezone` alone.
  -- The country and state are the codes the place dataset publishes ('NG', 'RI'), so the
  -- marketplace can match on them; the names are kept for display and survive a dataset
  -- that later re-spells a place.
  country_code TEXT,
  country_name TEXT,
  state_code TEXT,
  state_name TEXT,
  city_name TEXT,
  -- Generated: 'ng/ri/port-harcourt'. Never written by the app, so it cannot drift from
  -- the place it came from — a partner who moves gets a new key in the same update.
  city_key TEXT GENERATED ALWAYS AS (public.profile_city_key(country_code, state_code, city_name)) STORED,
  location_updated_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  -- Half a place is worse than none: it cannot be matched to a city, and a NULL country
  -- code would make every such key start '-' and collide with all the others.
  CONSTRAINT profiles_location_complete CHECK (
    (country_code IS NULL AND country_name IS NULL
       AND state_code IS NULL AND state_name IS NULL
       AND city_name IS NULL AND location_updated_at IS NULL)
    OR (btrim(coalesce(country_code, '')) <> ''
        AND btrim(coalesce(country_name, '')) <> ''
        AND btrim(coalesce(city_name, '')) <> '')
  )
);

-- Index for speedy queries
CREATE INDEX IF NOT EXISTS idx_profiles_couple_id ON public.profiles(couple_id);
CREATE INDEX IF NOT EXISTS idx_couples_invite_code ON public.couples(invite_code);
-- The marketplace's first query is "who sells in my partner's city": a scan of keys
-- against one key. Partial, because a profile with no place saved is not in it.
CREATE INDEX IF NOT EXISTS idx_profiles_city_key
  ON public.profiles(city_key)
  WHERE city_key IS NOT NULL;

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
 game text NOT NULL CHECK (game IN ('tic-tac-toe','rock-paper-scissors','snake')),
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
 -- The Snake duel's own state, keyed by player: status, the food the database dealt, the
 -- direction changes reported so far, and the clocks. See section 16.
 snake jsonb NOT NULL DEFAULT '{}'::jsonb,
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
 -- Time keeps passing while nobody reads this: settle anything whose clock ran out first.
 PERFORM public.snake_sweep(cid);
 SELECT jsonb_build_object('today', (now() AT TIME ZONE 'UTC')::date,
 'wins', (SELECT coalesce(jsonb_object_agg(winner_id,n),'{}') FROM
   (SELECT winner_id,count(*) n FROM public.game_matches WHERE couple_id=cid AND finished AND winner_id IS NOT NULL GROUP BY winner_id) w),
 'matches',coalesce((SELECT jsonb_agg(safe ORDER BY created_at DESC) FROM (
 SELECT created_at, (to_jsonb(m)-'pick_x'-'pick_o'-'snake') || jsonb_build_object(
 'my_pick',CASE WHEN auth.uid()=player_x THEN pick_x ELSE pick_o END,
 'partner_locked',CASE WHEN auth.uid()=player_x THEN pick_o IS NOT NULL ELSE pick_x IS NOT NULL END,
 'snake',CASE WHEN m.game='snake' THEN public.snake_view(m.snake, auth.uid(), m.finished, m.player_x, m.player_o) END) safe
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
 IF p_daily IS NULL OR p_game IS NULL OR p_game NOT IN ('tic-tac-toe','rock-paper-scissors','snake') OR p_best_of IS NULL OR p_best_of NOT IN (3,5) THEN RAISE EXCEPTION 'Invalid game settings.'; END IF;
 IF p_daily THEN
   SELECT id INTO mid FROM public.game_matches WHERE couple_id=cid AND daily_date=(now() AT TIME ZONE 'UTC')::date;
 ELSE
   SELECT id INTO mid FROM public.game_matches WHERE couple_id=cid AND game=p_game AND daily_date IS NULL AND NOT finished;
 END IF;
 IF mid IS NOT NULL THEN RETURN mid; END IF;
 -- Snake is never the daily challenge: a duel waits for both partners to play whenever
 -- suits them, which is not a thing a single UTC day should be asked to hold.
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


-- 15b. The Snake duel: one ranked run each, highest score wins, and no pause.
-- Mirrors supabase/migrations/202610150010_snake_duel.sql for brand-new projects.
-- A run is the food the database dealt plus the direction changes the phone reported, and
-- `snake_replay` walks those through the same rules as src/lib/snake.ts — so the score is
-- never something a phone can claim, and it cannot be re-rolled or replayed later. Leaving
-- a live run forfeits the duel to the partner (see the Games tab rules in the README).
BEGIN;

-- The duel lives on the same match row as the other games, so the Games tab badge, the
-- one-open-match-per-couple rule and the win scoreboard all keep working untouched.
ALTER TABLE public.game_matches DROP CONSTRAINT IF EXISTS game_matches_game_check;
ALTER TABLE public.game_matches ADD CONSTRAINT game_matches_game_check
  CHECK (game IN ('tic-tac-toe','rock-paper-scissors','snake'));
ALTER TABLE public.game_matches ADD COLUMN IF NOT EXISTS snake jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Mirror of src/lib/snake.ts: a 20×20 board, four cells long to start, 160ms a tick,
-- four minutes to a run, 30 seconds of silence before a run is lost.
CREATE OR REPLACE FUNCTION public.snake_max_ticks() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 1500 $$;

-- How many ticks a run may have reported after this much real time. Two ticks of slack
-- for the round trip; the run's own cap holds the ceiling.
CREATE OR REPLACE FUNCTION public.snake_budget(p_started timestamptz) RETURNS integer
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT least(greatest(floor(extract(epoch FROM (now() - p_started)) * 1000 / 160)::integer + 2, 0), public.snake_max_ticks())
$$;

-- Walk one side's run and return what it really scored. This is the authority: the score
-- a phone claims is never read, only this result is.
CREATE OR REPLACE FUNCTION public.snake_replay(p_foods jsonb, p_dirs jsonb, p_ticks integer, p_cap integer DEFAULT 1500)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  cols constant integer := 20;
  rows_ constant integer := 20;
  cap integer := least(coalesce(p_cap, public.snake_max_ticks()), public.snake_max_ticks());
  goal integer;
  body integer[];                 -- cell ids, head first
  food_ids integer[];
  food_at integer := 1;           -- which food is on the board
  planned text[];                 -- the direction change recorded for each tick
  dir text := 'right';
  head integer; nx integer; ny integer; dx integer; dy integer;
  entry integer; staying integer[]; eating boolean;
  ticks integer := 0; score integer := 0; ended text := NULL;
  change jsonb; change_tick integer; change_dir text;
BEGIN
  ticks := 0;
  goal := least(greatest(coalesce(p_ticks, 0), 0), cap);
  -- Four cells across the middle, heading right — the same start as the phone's.
  body := ARRAY[10 * cols + 10, 10 * cols + 9, 10 * cols + 8, 10 * cols + 7];
  SELECT coalesce(array_agg((value->>1)::integer * cols + (value->>0)::integer ORDER BY ord), ARRAY[]::integer[]) INTO food_ids
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(coalesce(p_foods,'[]'::jsonb)) = 'array' THEN p_foods ELSE '[]'::jsonb END) WITH ORDINALITY AS t(value, ord)
   WHERE jsonb_typeof(value) = 'array' AND jsonb_array_length(value) = 2
     AND (value->>0) ~ '^[0-9]{1,2}$' AND (value->>1) ~ '^[0-9]{1,2}$'
     AND (value->>0)::integer < cols AND (value->>1)::integer < rows_;
  planned := array_fill(''::text, ARRAY[goal]);
  IF jsonb_typeof(coalesce(p_dirs,'[]'::jsonb)) = 'array' THEN
    FOR change IN SELECT value FROM jsonb_array_elements(p_dirs) LOOP
      IF jsonb_typeof(change) = 'array' AND jsonb_array_length(change) = 2
         AND (change->>0) ~ '^[0-9]{1,4}$' AND (change->>1) IN ('up','down','left','right') THEN
        change_tick := (change->>0)::integer;
        change_dir := change->>1;
        -- The first change written for a tick is the one that happens; the phone can only
        -- send one per tick anyway.
        IF change_tick >= 0 AND change_tick < goal AND planned[change_tick + 1] = '' THEN
          planned[change_tick + 1] := change_dir;
        END IF;
      END IF;
    END LOOP;
  END IF;

  WHILE ticks < goal AND ended IS NULL LOOP
    -- Turning straight back into your own neck is not a move.
    IF planned[ticks + 1] IS NOT NULL AND planned[ticks + 1] <> '' AND planned[ticks + 1] <> dir
       AND NOT ((planned[ticks + 1] = 'up' AND dir = 'down') OR (planned[ticks + 1] = 'down' AND dir = 'up')
             OR (planned[ticks + 1] = 'left' AND dir = 'right') OR (planned[ticks + 1] = 'right' AND dir = 'left')) THEN
      dir := planned[ticks + 1];
    END IF;
    dx := CASE dir WHEN 'left' THEN -1 WHEN 'right' THEN 1 ELSE 0 END;
    dy := CASE dir WHEN 'up' THEN -1 WHEN 'down' THEN 1 ELSE 0 END;
    head := body[1];
    nx := (head % cols) + dx;
    ny := (head / cols) + dy;
    ticks := ticks + 1;
    IF nx < 0 OR nx >= cols OR ny < 0 OR ny >= rows_ THEN
      ended := 'wall';
    ELSE
      entry := ny * cols + nx;
      eating := food_at <= coalesce(array_length(food_ids, 1), 0) AND food_ids[food_at] = entry;
      -- The tail vacates its cell on the same tick unless the snake is growing.
      IF eating THEN staying := body; ELSE staying := body[1:greatest(coalesce(array_length(body, 1), 1) - 1, 0)]; END IF;
      IF entry = ANY(staying) THEN
        ended := 'self';
      ELSE
        IF eating THEN
          score := score + 1;
          food_at := food_at + 1;
          body := ARRAY[entry] || body;
        ELSE
          body := ARRAY[entry] || staying;
        END IF;
      END IF;
    END IF;
  END LOOP;
  IF ended IS NULL AND ticks >= cap THEN ended := 'cap'; END IF;
  RETURN jsonb_build_object('score', score, 'ticks', ticks, 'ended', ended);
END $$;

-- Decide the duel once it can be decided. Called with the match row already locked.
CREATE OR REPLACE FUNCTION public.snake_settle(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m public.game_matches;
  x_entry jsonb; o_entry jsonb;
  x_score integer; o_score integer;
  winner uuid := NULL;
BEGIN
  SELECT * INTO m FROM public.game_matches WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR m.finished OR m.game <> 'snake' THEN RETURN; END IF;
  x_entry := coalesce(m.snake -> m.player_x::text, '{}'::jsonb);
  o_entry := coalesce(m.snake -> m.player_o::text, '{}'::jsonb);
  IF x_entry->>'status' = 'forfeit' OR o_entry->>'status' = 'forfeit' THEN
    -- Leaving loses the duel there and then, whether or not the other partner has played.
    IF x_entry->>'status' = 'forfeit' AND o_entry->>'status' = 'forfeit' THEN winner := NULL;
    ELSIF x_entry->>'status' = 'forfeit' THEN winner := m.player_o;
    ELSE winner := m.player_x; END IF;
  ELSIF x_entry->>'status' = 'done' AND o_entry->>'status' = 'done' THEN
    x_score := coalesce((x_entry->>'score')::integer, 0);
    o_score := coalesce((o_entry->>'score')::integer, 0);
    IF x_score > o_score THEN winner := m.player_x;
    ELSIF o_score > x_score THEN winner := m.player_o; END IF;
  ELSE
    RETURN;                                  -- still waiting on a run
  END IF;
  UPDATE public.game_matches SET finished = true, winner_id = winner WHERE id = m.id;
END $$;

-- Time never stands still, and the app has no server clock of its own: the sweep runs
-- whenever either phone reads its state. A run that has gone quiet for longer than the
-- grace is lost; a run that is still reporting in when its four minutes are up simply
-- ends where it stood.
CREATE OR REPLACE FUNCTION public.snake_sweep(p_couple uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m public.game_matches;
  state jsonb; who text; entry jsonb; result jsonb;
BEGIN
  FOR m IN SELECT * FROM public.game_matches WHERE couple_id = p_couple AND game = 'snake' AND NOT finished FOR UPDATE LOOP
    state := coalesce(m.snake, '{}'::jsonb);
    FOR who IN SELECT jsonb_object_keys(state) LOOP
      entry := state -> who;
      IF entry->>'status' = 'running' THEN
        IF (entry->>'last_seen')::timestamptz < now() - make_interval(secs => 30) THEN
          result := public.snake_replay(entry->'foods', entry->'dirs', coalesce((entry->>'ticks')::integer, 0));
          entry := entry || jsonb_build_object('status','forfeit','ended','forfeit',
            'score',coalesce((result->>'score')::integer, 0),'finished_at',now());
        ELSIF (entry->>'deadline')::timestamptz <= now() THEN
          -- Four minutes are up: the run ends exactly where the last report left it.
          result := public.snake_replay(entry->'foods', entry->'dirs', coalesce((entry->>'ticks')::integer, 0));
          entry := entry || jsonb_build_object('status','done','ended','cap',
            'score',coalesce((result->>'score')::integer, 0),'finished_at',now());
        ELSE
          CONTINUE;
        END IF;
        state := jsonb_set(state, ARRAY[who], entry);
      END IF;
    END LOOP;
    IF state IS DISTINCT FROM coalesce(m.snake, '{}'::jsonb) THEN
      UPDATE public.game_matches SET snake = state WHERE id = m.id;
    END IF;
    PERFORM public.snake_settle(m.id);
  END LOOP;
END $$;

-- Deal the food and start the clock. Calling it again while a run is live hands the same
-- run back, which is how a phone picks a run up after a reload; it never deals a second
-- chance at a run that has already been played.
CREATE OR REPLACE FUNCTION public.snake_start(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  m public.game_matches;
  state jsonb; entry jsonb; foods jsonb;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM public.snake_sweep(cid);           -- a run that went quiet in the meantime is already lost
  SELECT * INTO m FROM public.game_matches WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.'; END IF;
  IF m.game <> 'snake' THEN RAISE EXCEPTION 'That is not a snake duel.'; END IF;
  IF m.finished THEN RAISE EXCEPTION 'This duel is already over.'; END IF;
  state := coalesce(m.snake, '{}'::jsonb);
  entry := state -> uid::text;
  IF entry IS NOT NULL AND entry->>'status' = 'running' THEN RETURN entry; END IF;
  IF entry IS NOT NULL THEN RAISE EXCEPTION 'You have already played your run in this duel.'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_array(floor(random() * 20)::integer, floor(random() * 20)::integer)), '[]'::jsonb)
    INTO foods FROM generate_series(1, 200);
  entry := jsonb_build_object('status','running','score',0,'ticks',0,'dirs','[]'::jsonb,'foods',foods,
    'started_at',now(),'last_seen',now(),'deadline',now() + make_interval(secs => 240));
  UPDATE public.game_matches SET snake = state || jsonb_build_object(uid::text, entry) WHERE id = m.id;
  RETURN entry;
END $$;

-- A progress report: where the run is, and the direction changes made since the last one.
-- The report is append-only and cannot outrun real time, so a run cannot be rewound,
-- accelerated or handed in twice.
CREATE OR REPLACE FUNCTION public.snake_commit(p_id uuid, p_ticks integer, p_dirs jsonb, p_final boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  m public.game_matches;
  state jsonb; entry jsonb; changes jsonb; result jsonb;
  last_tick integer := -1; change jsonb; change_tick integer; change_dir text;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  -- A phone that went quiet for longer than the grace has already lost its run: settle that
  -- before reading anything, so a report that arrives late cannot revive it.
  PERFORM public.snake_sweep(cid);
  SELECT * INTO m FROM public.game_matches WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.'; END IF;
  IF m.game <> 'snake' THEN RAISE EXCEPTION 'That is not a snake duel.'; END IF;
  state := coalesce(m.snake, '{}'::jsonb);
  entry := state -> uid::text;
  IF entry IS NULL THEN RAISE EXCEPTION 'Start your run first.'; END IF;
  -- Someone else (or the sweep) already settled this run; report it instead of arguing.
  IF entry->>'status' <> 'running' THEN RETURN entry; END IF;
  IF m.finished THEN RETURN entry || jsonb_build_object('match_finished', true); END IF;
  IF p_ticks IS NULL OR p_ticks < 0 OR p_dirs IS NULL OR jsonb_typeof(p_dirs) <> 'array' THEN
    RAISE EXCEPTION 'That run report cannot be read.';
  END IF;
  IF p_ticks < coalesce((entry->>'ticks')::integer, 0) THEN RAISE EXCEPTION 'That run report is older than the last one.'; END IF;
  IF p_ticks > public.snake_budget((entry->>'started_at')::timestamptz) THEN RAISE EXCEPTION 'That run is moving faster than real time.'; END IF;
  changes := coalesce(entry->'dirs', '[]'::jsonb);
  IF jsonb_array_length(changes) > 0 THEN last_tick := (changes->-1->>0)::integer; END IF;
  FOR change IN SELECT value FROM jsonb_array_elements(p_dirs) LOOP
    IF jsonb_typeof(change) <> 'array' OR jsonb_array_length(change) <> 2
       OR (change->>0) !~ '^[0-9]{1,4}$' OR (change->>1) NOT IN ('up','down','left','right') THEN
      RAISE EXCEPTION 'That run report cannot be read.';
    END IF;
    change_tick := (change->>0)::integer;
    change_dir := change->>1;
    IF change_tick <= last_tick OR change_tick >= p_ticks THEN RAISE EXCEPTION 'That run report is out of order.'; END IF;
    changes := changes || jsonb_build_array(jsonb_build_array(change_tick, change_dir));
    last_tick := change_tick;
  END LOOP;
  entry := entry || jsonb_build_object('ticks', p_ticks, 'dirs', changes, 'last_seen', now());
  IF p_final OR p_ticks >= public.snake_max_ticks() THEN
    result := public.snake_replay(entry->'foods', changes, p_ticks);
    entry := entry || jsonb_build_object('status','done',
      'score',coalesce((result->>'score')::integer, 0),
      'ended',coalesce(result->>'ended','alive'),
      'ticks',coalesce((result->>'ticks')::integer, p_ticks),'finished_at',now());
  END IF;
  UPDATE public.game_matches SET snake = state || jsonb_build_object(uid::text, entry) WHERE id = m.id;
  IF p_final OR p_ticks >= public.snake_max_ticks() THEN PERFORM public.snake_settle(m.id); END IF;
  RETURN entry;
END $$;

CREATE OR REPLACE FUNCTION public.snake_beat(p_id uuid, p_ticks integer, p_dirs jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT public.snake_commit(p_id, p_ticks, p_dirs, false) $$;
CREATE OR REPLACE FUNCTION public.snake_finish(p_id uuid, p_ticks integer, p_dirs jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT public.snake_commit(p_id, p_ticks, p_dirs, true) $$;

-- Walking out. The partner takes the duel immediately: waiting to be beaten is not part of
-- the deal. Safe to call twice, and safe to call after the duel ended some other way.
CREATE OR REPLACE FUNCTION public.snake_forfeit(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  m public.game_matches;
  state jsonb; entry jsonb; result jsonb;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT * INTO m FROM public.game_matches WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.'; END IF;
  IF m.game <> 'snake' THEN RAISE EXCEPTION 'That is not a snake duel.'; END IF;
  state := coalesce(m.snake, '{}'::jsonb);
  entry := state -> uid::text;
  IF entry IS NULL THEN RETURN '{}'::jsonb; END IF;
  IF entry->>'status' <> 'running' THEN RETURN entry; END IF;
  IF m.finished THEN RETURN entry || jsonb_build_object('match_finished', true); END IF;
  -- Keep what the run had reached: the forfeit is the loss, not the score.
  result := public.snake_replay(entry->'foods', entry->'dirs', coalesce((entry->>'ticks')::integer, 0));
  entry := entry || jsonb_build_object('status','forfeit','ended','forfeit',
    'score',coalesce((result->>'score')::integer, 0),'finished_at',now());
  UPDATE public.game_matches SET snake = state || jsonb_build_object(uid::text, entry) WHERE id = m.id;
  PERFORM public.snake_settle(m.id);
  RETURN entry;
END $$;

-- One side of a duel as this phone may see it. A blind duel: the partner's score is sealed
-- until the duel is over, and their live run shows only that they are playing.
CREATE OR REPLACE FUNCTION public.snake_view(p_state jsonb, p_uid uuid, p_finished boolean, p_x uuid, p_o uuid)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  me jsonb; them jsonb;
BEGIN
  IF p_state IS NULL THEN RETURN NULL; END IF;
  me := p_state -> p_uid::text;
  them := p_state -> (CASE WHEN p_x = p_uid THEN p_o ELSE p_x END)::text;
  RETURN jsonb_build_object(
    'mine', coalesce(me, 'null'::jsonb),
    'partner', CASE WHEN them IS NULL THEN jsonb_build_object('status','waiting') ELSE
      jsonb_build_object('status', them->>'status', 'ended', them->>'ended')
      || CASE WHEN them->>'status' = 'running' THEN jsonb_build_object('last_seen', them->>'last_seen') ELSE '{}'::jsonb END
      || CASE WHEN p_finished THEN jsonb_build_object('score', coalesce((them->>'score')::integer, 0)) ELSE '{}'::jsonb END
    END);
END $$;

-- `authenticated` is revoked by name, not just PUBLIC and anon: a real Supabase project
-- carries default privileges that grant EXECUTE on every newly created public function
-- directly to anon and authenticated, so revoking only PUBLIC (and anon) leaves every
-- signed-in phone able to call the internals below — snake_commit/snake_sweep/snake_settle
-- included. verify-games.sql fails on exactly that. The public entry points are handed
-- back to authenticated by the GRANT that follows; the rest stay server-side, reached
-- only through those SECURITY DEFINER entry points (which run as their owner).
REVOKE ALL ON FUNCTION public.snake_max_ticks(), public.snake_budget(timestamptz), public.snake_replay(jsonb,jsonb,integer,integer),
  public.snake_settle(uuid), public.snake_sweep(uuid), public.snake_start(uuid), public.snake_commit(uuid,integer,jsonb,boolean),
  public.snake_beat(uuid,integer,jsonb), public.snake_finish(uuid,integer,jsonb), public.snake_forfeit(uuid),
  public.snake_view(jsonb,uuid,boolean,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.snake_start(uuid), public.snake_beat(uuid,integer,jsonb), public.snake_finish(uuid,integer,jsonb),
  public.snake_forfeit(uuid) TO authenticated;
COMMIT;

-- ============================================================================
-- 16. Shared books ("Read together")
-- Mirrors supabase/migrations/202610150008_shared_books.sql for brand-new projects.
-- The couples shelf (one active book), each partners place in it, the shared
-- highlights with one colour per person, the messages.highlight_id chat bridge, and
-- the private shared-books storage bucket with couple-scoped policies.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1) shared_books: the couple's shelf. One book "reading" at a time.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.shared_books (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  -- Storage path, always books/{couple_id}/{id}.{epub|pdf} so the RLS folder check can
  -- read the owning couple straight off the object name.
  file_path TEXT NOT NULL,
  file_type TEXT NOT NULL,
  -- 'reading' is the one active book; 'left' is paused; 'finished' is done but kept.
  status TEXT NOT NULL DEFAULT 'reading',
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT shared_books_title_length CHECK (char_length(btrim(title)) BETWEEN 1 AND 300),
  CONSTRAINT shared_books_file_path_length CHECK (char_length(btrim(file_path)) BETWEEN 1 AND 500),
  CONSTRAINT shared_books_file_type_check CHECK (file_type IN ('epub', 'pdf')),
  CONSTRAINT shared_books_status_check CHECK (status IN ('reading', 'left', 'finished'))
);

-- The rule that cannot break even if the app has a bug: one active book per couple.
CREATE UNIQUE INDEX IF NOT EXISTS shared_books_one_reading
  ON public.shared_books(couple_id) WHERE status = 'reading';

CREATE INDEX IF NOT EXISTS idx_shared_books_couple
  ON public.shared_books(couple_id, created_at);

ALTER TABLE public.shared_books ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Couple members can read their books" ON public.shared_books;
CREATE POLICY "Couple members can read their books" ON public.shared_books
FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

DROP POLICY IF EXISTS "Couple members can shelve books" ON public.shared_books;
CREATE POLICY "Couple members can shelve books" ON public.shared_books
FOR INSERT TO authenticated
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid())
  AND uploaded_by = auth.uid()
);

-- Either partner may pause, finish or resume a book: the shelf belongs to the couple.
DROP POLICY IF EXISTS "Couple members can change book status" ON public.shared_books;
CREATE POLICY "Couple members can change book status" ON public.shared_books
FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()))
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()));

-- Deleting the row is the "Delete" action (the file goes separately, from the app).
DROP POLICY IF EXISTS "Couple members can remove books" ON public.shared_books;
CREATE POLICY "Couple members can remove books" ON public.shared_books
FOR DELETE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

-- Which book a row points at can never move: only the title and the status are editable.
CREATE OR REPLACE FUNCTION public.guard_book_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.couple_id <> OLD.couple_id
     OR NEW.file_path <> OLD.file_path
     OR NEW.file_type <> OLD.file_type
     OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'The book file itself is fixed. Only the title and the status can change.';
  END IF;
  NEW.updated_at := timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shared_books_guard_immutable ON public.shared_books;
CREATE TRIGGER shared_books_guard_immutable
BEFORE UPDATE ON public.shared_books
FOR EACH ROW EXECUTE FUNCTION public.guard_book_immutable();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.shared_books TO authenticated;
REVOKE ALL ON public.shared_books FROM anon;

-- ============================================================================
-- 2) reading_progress: where each partner is. Debounced saves from the reader;
--    the "Jump to partner" button reads the other row and lands there.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.reading_progress (
  book_id UUID NOT NULL REFERENCES public.shared_books(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- An EPUB CFI or a PDF page reference: opaque to the database, meaningful to the
  -- reader that wrote it.
  location TEXT NOT NULL,
  -- 0..100, kept as a whole number so the card can say "42%".
  percent INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (book_id, user_id),
  CONSTRAINT reading_progress_location_length CHECK (char_length(btrim(location)) BETWEEN 1 AND 1000),
  CONSTRAINT reading_progress_percent_check CHECK (percent BETWEEN 0 AND 100)
);

ALTER TABLE public.reading_progress ENABLE ROW LEVEL SECURITY;

-- Both partners read each other's row — that is the whole point of the feature.
DROP POLICY IF EXISTS "Couple members can read book progress" ON public.reading_progress;
CREATE POLICY "Couple members can read book progress" ON public.reading_progress
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.shared_books b
  WHERE b.id = book_id AND b.couple_id = public.get_user_couple_id(auth.uid())
));

-- You may only ever write your own place in the book.
DROP POLICY IF EXISTS "Couples can save their own book progress" ON public.reading_progress;
CREATE POLICY "Couples can save their own book progress" ON public.reading_progress
FOR INSERT TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.shared_books b
    WHERE b.id = book_id AND b.couple_id = public.get_user_couple_id(auth.uid())
  )
);

DROP POLICY IF EXISTS "Couples can move their own bookmark" ON public.reading_progress;
CREATE POLICY "Couples can move their own bookmark" ON public.reading_progress
FOR UPDATE TO authenticated
USING (user_id = auth.uid())
WITH CHECK (
  user_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.shared_books b
    WHERE b.id = book_id AND b.couple_id = public.get_user_couple_id(auth.uid())
  )
);

-- The server's clock stamps the save, so "Jump to partner" always trusts the timestamp.
CREATE OR REPLACE FUNCTION public.set_reading_progress_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  NEW.updated_at := timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reading_progress_set_updated_at ON public.reading_progress;
CREATE TRIGGER reading_progress_set_updated_at
BEFORE INSERT OR UPDATE ON public.reading_progress
FOR EACH ROW EXECUTE FUNCTION public.set_reading_progress_updated_at();

GRANT SELECT, INSERT, UPDATE ON public.reading_progress TO authenticated;
REVOKE ALL ON public.reading_progress FROM anon;

-- ============================================================================
-- 3) highlights: the shared margin notes. Two colours, one per person.
--
-- book_id is ON DELETE SET NULL on purpose: deleting the book removes the file and
-- the shelf row, but a quote that reached the chat must stay readable there. The
-- orphaned highlight keeps its words and loses only its way back into the book.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.highlights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL only when the book this passage came from has been deleted.
  book_id UUID REFERENCES public.shared_books(id) ON DELETE SET NULL,
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- EPUB: the CFI range of the selection. PDF: a page reference (the exact rectangles
  -- live in `rects` so the paint can be redrawn at any zoom).
  location TEXT NOT NULL,
  rects JSONB,
  quote_text TEXT NOT NULL,
  -- 'rose' or 'sage': one fixed colour per partner, chosen so both phones agree.
  color TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT highlights_location_length CHECK (char_length(btrim(location)) BETWEEN 1 AND 1000),
  CONSTRAINT highlights_quote_length CHECK (char_length(btrim(quote_text)) BETWEEN 1 AND 2000),
  CONSTRAINT highlights_color_check CHECK (color IN ('rose', 'sage'))
);

CREATE INDEX IF NOT EXISTS idx_highlights_book ON public.highlights(book_id) WHERE book_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_highlights_couple ON public.highlights(couple_id, created_at);

ALTER TABLE public.highlights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Couple members can read their highlights" ON public.highlights;
CREATE POLICY "Couple members can read their highlights" ON public.highlights
FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

DROP POLICY IF EXISTS "Couple members can highlight" ON public.highlights;
CREATE POLICY "Couple members can highlight" ON public.highlights
FOR INSERT TO authenticated
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid())
  AND user_id = auth.uid()
  AND (book_id IS NULL OR EXISTS (
    SELECT 1 FROM public.shared_books b
    WHERE b.id = book_id AND b.couple_id = public.get_user_couple_id(auth.uid())
  ))
);

-- Highlights are permanent margin notes: no update, no delete. They go away only with
-- the couple, the account, or (as orphans) when the book itself is deleted.

GRANT SELECT, INSERT ON public.highlights TO authenticated;
REVOKE ALL ON public.highlights FROM anon;

-- ============================================================================
-- 4) messages.highlight_id: "highlight to chat", and the way back ("chat to book").
--
-- The message carries the quote and the optional comment; the link points at the
-- highlight so the bubble can jump back to the passage. When the book dies the
-- highlight survives (book_id NULL), so the quote stays on the bubble and only the
-- jump is disabled.
-- ============================================================================

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS highlight_id UUID REFERENCES public.highlights(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.messages.highlight_id IS
  'The book highlight this message shares (set by "highlight to chat"). NULL for ordinary messages.';

-- The link is frozen with the rest of the message: only the read receipt and the
-- author's edit can change anything on a stored row.
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
     OR NEW.highlight_id IS DISTINCT FROM OLD.highlight_id
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

-- A highlight link may only point at a highlight inside this couple's own shelf —
-- quoting another couple's margin notes in your chat is refused row by row. The lookup
-- goes through a definer-side function by design, exactly like message_is_in_couple:
-- a policy that selects from highlights recursively would apply highlights' own read
-- policy inside itself.
CREATE OR REPLACE FUNCTION public.highlight_is_in_couple(p_highlight_id UUID, p_couple_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_highlight_id IS NOT NULL
     AND p_couple_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.highlights h
       WHERE h.id = p_highlight_id AND h.couple_id = p_couple_id
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
  AND (highlight_id IS NULL OR public.highlight_is_in_couple(highlight_id, couple_id))
);

-- ============================================================================
-- 5) Live updates: new highlights and moved bookmarks arrive without a refresh.
-- ============================================================================

ALTER TABLE public.shared_books REPLICA IDENTITY FULL;
ALTER TABLE public.reading_progress REPLICA IDENTITY FULL;
ALTER TABLE public.highlights REPLICA IDENTITY FULL;

DO $realtime$
DECLARE t TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['shared_books', 'reading_progress', 'highlights'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END
$realtime$;

-- ============================================================================
-- 6) Storage: a private bucket for the files themselves.
--
-- The path is always books/{couple_id}/{book_id}.{ext}, and the policies below read
-- the couple straight off that folder name: only the two partners can upload, read
-- (via signed URLs) or delete their own book's file. The bucket is never public and
-- nothing here creates a shareable link.
--
-- The storage schema is absent on a bare database (and in the test backend), so every
-- statement is guarded and a rerun is always safe.
-- ============================================================================

DO $books_storage$
DECLARE
  has_size_limit BOOLEAN;
  has_mime_types BOOLEAN;
BEGIN
  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO storage.buckets (id, name, public)
  VALUES ('shared-books', 'shared-books', false)
  ON CONFLICT (id) DO UPDATE SET public = false;

  -- ~40 MB per file: big enough for a heavy PDF, small enough for weak mobile data.
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit'
  ) INTO has_size_limit;
  IF has_size_limit THEN
    EXECUTE 'UPDATE storage.buckets SET file_size_limit = 41943040 WHERE id = ''shared-books''';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'allowed_mime_types'
  ) INTO has_mime_types;
  IF has_mime_types THEN
    EXECUTE $sql$UPDATE storage.buckets
      SET allowed_mime_types = ARRAY['application/epub+zip', 'application/pdf']
      WHERE id = 'shared-books'$sql$;
  END IF;

  -- Read (for signed URLs), upload and delete are all scoped to the couple's own
  -- folder: books/{couple_id}/... — the folder name IS the couple id.
  EXECUTE 'DROP POLICY IF EXISTS "Couple members can read their book files" ON storage.objects';
  EXECUTE $sql$CREATE POLICY "Couple members can read their book files" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'shared-books'
    AND (storage.foldername(name))[1] = 'books'
    AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text
  )$sql$;

  EXECUTE 'DROP POLICY IF EXISTS "Couple members can upload their book files" ON storage.objects';
  EXECUTE $sql$CREATE POLICY "Couple members can upload their book files" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'shared-books'
    AND (storage.foldername(name))[1] = 'books'
    AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text
  )$sql$;

  EXECUTE 'DROP POLICY IF EXISTS "Couple members can delete their book files" ON storage.objects';
  EXECUTE $sql$CREATE POLICY "Couple members can delete their book files" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'shared-books'
    AND (storage.foldername(name))[1] = 'books'
    AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text
  )$sql$;
END
$books_storage$;

COMMIT;

-- ---------------------------------------------------------------------------
-- Mirrors supabase/migrations/202610150011_chess.sql for brand-new projects.
-- The chess engine lives in the database too: a phone sends only a move in
-- coordinate notation, and chess_legal/chess_has_move (the mirror of
-- src/lib/chess.ts) decide whether it stands, what it captured, and whether
-- checkmate, a draw, the Capture Race or the Queen Hunt ends the match.
-- ---------------------------------------------------------------------------
-- Chess: classic checkmate, the Capture Race (first to 7 captures) and the Queen Hunt
-- (capture the opponent's original queen) — over entirely normal chess rules.
--
-- The point of this migration, like the Snake duel's, is that the *database* decides.
-- `src/lib/chess.ts` is mirrored here function for function (`chess_attacked`,
-- `chess_pseudo`, `chess_legal`, `chess_has_move`), and the only thing a phone may
-- send is a move in coordinate notation (`e2e4`, `e7e8q`, or `resign`). The server
-- checks the move is legal for the side to move, applies it, counts the capture
-- itself, spots checkmate/stalemate/draws itself and scores the situational goal
-- itself — so a phone can never claim a capture, or a queen, it did not really make.
-- Kings are never captured: legal-move filtering means checkmate ends the game first.
--
-- A chess match lives on the same match row as the other games: player_x is White,
-- turn_id is the side to move, round is the ply count + 1 (the optimistic-concurrency
-- token `chess_move` checks, exactly as `play_game` does), finished/winner_id are the
-- result. The position itself lives in the `chess` jsonb: the board as 64 codes
-- (`wP`, `bQ`, `wQ*` for a *promoted* queen — the hunt only counts the original),
-- castling rights, the en-passant square, captures by each colour, the move history
-- and position counts for threefold repetition.
--
-- Chess is RPC-only like the rest of Games, and it is never the daily challenge.
BEGIN;

ALTER TABLE public.game_matches DROP CONSTRAINT IF EXISTS game_matches_game_check;
ALTER TABLE public.game_matches ADD CONSTRAINT game_matches_game_check
  CHECK (game IN ('tic-tac-toe','rock-paper-scissors','snake','chess'));
ALTER TABLE public.game_matches ADD COLUMN IF NOT EXISTS chess jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The starting position, index 0 = a8 as on the phone. `*` marks a promoted piece.
CREATE OR REPLACE FUNCTION public.chess_start_board() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT jsonb_agg(cell ORDER BY n) FROM (
    SELECT n, CASE
      WHEN n IN (0,7) THEN 'bR' WHEN n IN (1,6) THEN 'bN' WHEN n IN (2,5) THEN 'bB'
      WHEN n = 3 THEN 'bQ' WHEN n = 4 THEN 'bK'
      WHEN n BETWEEN 8 AND 15 THEN 'bP' WHEN n BETWEEN 48 AND 55 THEN 'wP'
      WHEN n IN (56,63) THEN 'wR' WHEN n IN (57,62) THEN 'wN' WHEN n IN (58,61) THEN 'wB'
      WHEN n = 59 THEN 'wQ' WHEN n = 60 THEN 'wK' ELSE '' END AS cell
    FROM generate_series(0,63) AS n) s
$$;

-- Mirror of isSquareAttacked in src/lib/chess.ts (squares are 0-based here too).
CREATE OR REPLACE FUNCTION public.chess_attacked(p_board text[], p_sq integer, p_by text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  r integer := p_sq / 8; c integer := p_sq % 8;
  pr integer; pc integer; cell text;
  dr integer; dc integer; rr integer; cc integer;
  steps integer[][] := ARRAY[[0,1],[0,-1],[1,0],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]];
  kinds text;
BEGIN
  pr := CASE WHEN p_by = 'w' THEN r + 1 ELSE r - 1 END;
  FOREACH pc IN ARRAY ARRAY[c-1,c+1] LOOP
    IF pr BETWEEN 0 AND 7 AND pc BETWEEN 0 AND 7 AND p_board[pr*8+pc+1] = p_by||'P' THEN RETURN true; END IF;
  END LOOP;
  FOREACH dr IN ARRAY ARRAY[-2,-1,1,2] LOOP
    FOREACH dc IN ARRAY ARRAY[-2,-1,1,2] LOOP
      IF abs(dr) <> abs(dc) AND r+dr BETWEEN 0 AND 7 AND c+dc BETWEEN 0 AND 7
         AND p_board[(r+dr)*8+c+dc+1] = p_by||'N' THEN RETURN true; END IF;
    END LOOP;
  END LOOP;
  FOR dr IN -1..1 LOOP FOR dc IN -1..1 LOOP
    IF (dr <> 0 OR dc <> 0) AND r+dr BETWEEN 0 AND 7 AND c+dc BETWEEN 0 AND 7
       AND p_board[(r+dr)*8+c+dc+1] = p_by||'K' THEN RETURN true; END IF;
  END LOOP; END LOOP;
  FOR i IN 1..8 LOOP
    dr := steps[i][1]; dc := steps[i][2];
    kinds := CASE WHEN i <= 4 THEN 'RQ' ELSE 'BQ' END;
    rr := r + dr; cc := c + dc;
    WHILE rr BETWEEN 0 AND 7 AND cc BETWEEN 0 AND 7 LOOP
      cell := p_board[rr*8+cc+1];
      IF cell <> '' THEN
        IF left(cell,1) = p_by AND kinds LIKE '%'||substring(cell,2,1)||'%' THEN RETURN true; END IF;
        EXIT;
      END IF;
      rr := rr + dr; cc := cc + dc;
    END LOOP;
  END LOOP;
  RETURN false;
END $$;

-- Mirror of pseudoMoves, for one candidate move: movement rules only, no king safety.
-- Castling's "not out of, through or into check" is part of king safety (chess_legal);
-- what is checked here is rights, empty squares and the rook being home.
CREATE OR REPLACE FUNCTION public.chess_pseudo(p_board text[], p_castling text, p_ep integer, p_from integer, p_to integer) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  moving text := p_board[p_from+1]; target text := p_board[p_to+1];
  colour text; kind text;
  fr integer := p_from / 8; fc integer := p_from % 8;
  tr integer := p_to / 8; tc integer := p_to % 8;
  dr integer; dc integer; dir integer; step_r integer; step_c integer; rr integer; cc integer;
BEGIN
  IF moving = '' OR p_from = p_to THEN RETURN false; END IF;
  colour := left(moving,1); kind := substring(moving,2,1);
  IF target <> '' AND left(target,1) = colour THEN RETURN false; END IF;
  dr := tr - fr; dc := tc - fc;
  IF kind = 'P' THEN
      dir := CASE WHEN colour = 'w' THEN -1 ELSE 1 END;
      IF dc = 0 AND target = '' THEN
        RETURN dr = dir OR (dr = 2*dir AND fr = CASE WHEN colour='w' THEN 6 ELSE 1 END AND p_board[(fr+dir)*8+fc+1] = '');
      END IF;
      RETURN abs(dc) = 1 AND dr = dir AND (target <> '' OR (p_ep IS NOT NULL AND p_to = p_ep));
  ELSIF kind = 'N' THEN
      RETURN (abs(dr),abs(dc)) IN ((1,2),(2,1));
  ELSIF kind IN ('B','R','Q') THEN
      IF kind = 'B' AND abs(dr) <> abs(dc) THEN RETURN false; END IF;
      IF kind = 'R' AND dr <> 0 AND dc <> 0 THEN RETURN false; END IF;
      IF kind = 'Q' AND abs(dr) <> abs(dc) AND dr <> 0 AND dc <> 0 THEN RETURN false; END IF;
      step_r := sign(dr); step_c := sign(dc); rr := fr + step_r; cc := fc + step_c;
      WHILE rr <> tr OR cc <> tc LOOP
        IF p_board[rr*8+cc+1] <> '' THEN RETURN false; END IF;
        rr := rr + step_r; cc := cc + step_c;
      END LOOP;
      RETURN true;
  ELSIF kind = 'K' THEN
      IF greatest(abs(dr),abs(dc)) = 1 THEN RETURN true; END IF;
      IF dr = 0 AND abs(dc) = 2 AND p_from = (CASE WHEN colour='w' THEN 60 ELSE 4 END) THEN
        IF dc > 0 THEN
          RETURN p_castling LIKE '%'||(CASE WHEN colour='w' THEN 'K' ELSE 'k' END)||'%'
             AND p_board[p_from+2] = '' AND p_board[p_from+3] = '' AND p_board[p_from+4] = colour||'R';
        ELSE
          RETURN p_castling LIKE '%'||(CASE WHEN colour='w' THEN 'Q' ELSE 'q' END)||'%'
             AND p_board[p_from] = '' AND p_board[p_from-1] = '' AND p_board[p_from-2] = '' AND p_board[p_from-3] = colour||'R';
        END IF;
      END IF;
      RETURN false;
  END IF;
  RETURN false;
END $$;

-- Mirror of movedBoard: apply a pseudo-legal move to a bare board.
CREATE OR REPLACE FUNCTION public.chess_apply(p_board text[], p_from integer, p_to integer, p_promo text, p_ep integer) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  b text[] := p_board; moving text := p_board[p_from+1];
  colour text := left(moving,1); kind text := substring(moving,2,1);
BEGIN
  b[p_from+1] := '';
  IF kind = 'P' AND p_to = p_ep AND p_board[p_to+1] = '' AND (p_to % 8) <> (p_from % 8) THEN
    b[p_to + CASE WHEN colour='w' THEN 8 ELSE -8 END + 1] := '';   -- the pawn that double-stepped
  END IF;
  b[p_to+1] := CASE WHEN kind = 'P' AND p_to / 8 IN (0,7)
    THEN colour || coalesce(p_promo,'Q') || (CASE WHEN coalesce(p_promo,'Q') = 'Q' THEN '*' ELSE '' END)
    ELSE moving END;
  IF kind = 'K' AND abs(p_to - p_from) = 2 THEN                 -- castling: bring the rook over
    IF p_to > p_from THEN b[p_from+2] := b[p_from+4]; b[p_from+4] := '';
    ELSE b[p_from-1] := b[p_from-3]; b[p_from-3] := ''; END IF;
  END IF;
  RETURN b;
END $$;

-- Mirror of legalMoves' king-safety filter, for one candidate move (incl. castling
-- not out of, through or into check).
CREATE OR REPLACE FUNCTION public.chess_legal(p_board text[], p_castling text, p_ep integer, p_from integer, p_to integer, p_promo text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  moving text := p_board[p_from+1]; colour text := left(moving,1);
  enemy text := CASE WHEN colour='w' THEN 'b' ELSE 'w' END;
  b text[]; king_at integer;
BEGIN
  IF NOT public.chess_pseudo(p_board, p_castling, p_ep, p_from, p_to) THEN RETURN false; END IF;
  IF substring(moving,2,1) = 'K' AND abs(p_to - p_from) = 2 THEN
    IF public.chess_attacked(p_board, p_from, enemy)
       OR public.chess_attacked(p_board, (p_from+p_to)/2, enemy) THEN RETURN false; END IF;
  END IF;
  b := public.chess_apply(p_board, p_from, p_to, p_promo, p_ep);
  SELECT i-1 INTO king_at FROM generate_series(1,64) AS i WHERE b[i] = colour||'K' LIMIT 1;
  RETURN king_at IS NOT NULL AND NOT public.chess_attacked(b, king_at, enemy);
END $$;

-- Mirror of "the side to move has a legal reply": the checkmate/stalemate test.
CREATE OR REPLACE FUNCTION public.chess_has_move(p_board text[], p_castling text, p_ep integer, p_colour text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE f integer; t integer;
BEGIN
  FOR f IN 0..63 LOOP
    IF left(p_board[f+1],1) IS NOT DISTINCT FROM p_colour AND p_board[f+1] <> '' THEN
      FOR t IN 0..63 LOOP
        IF public.chess_legal(p_board, p_castling, p_ep, f, t, 'Q') THEN RETURN true; END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN false;
END $$;

CREATE OR REPLACE FUNCTION public.chess_in_check(p_board text[], p_colour text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE king_at integer;
BEGIN
  SELECT i-1 INTO king_at FROM generate_series(1,64) AS i WHERE p_board[i] = p_colour||'K' LIMIT 1;
  RETURN king_at IS NOT NULL AND public.chess_attacked(p_board, king_at, CASE WHEN p_colour='w' THEN 'b' ELSE 'w' END);
END $$;

-- What a phone may see of a match: everything, minus the repetition counts.
-- (Chess has no secrets to seal, unlike rock-paper-scissors picks or a blind snake run.)
CREATE OR REPLACE FUNCTION public.chess_view(p_chess jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE WHEN p_chess IS NULL OR p_chess = '{}'::jsonb THEN NULL ELSE p_chess - 'repetitions' END
$$;

CREATE OR REPLACE FUNCTION public.chess_state_json(p_mode text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE board jsonb := public.chess_start_board();
BEGIN
  RETURN jsonb_build_object(
    'mode', p_mode, 'board', board, 'castling', 'KQkq', 'en_passant', NULL,
    'halfmove', 0, 'captures', jsonb_build_object('white','[]'::jsonb,'black','[]'::jsonb),
    'history', '[]'::jsonb, 'end_reason', NULL, 'drawn', false,
    'repetitions', jsonb_build_object(
      array_to_string(ARRAY(SELECT jsonb_array_elements_text(board)), ',') || ' w KQkq -', 1));
END $$;

-- Start (or resume) the couple's one open chess match. player_x is White and moves
-- first. The situational mode is chosen by whoever starts; a rematch keeps the mode
-- only if the starter picks it again — the mode lives in the match, not the request.
CREATE OR REPLACE FUNCTION public.start_chess(p_mode text DEFAULT 'classic') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cid uuid := public.get_user_couple_id(auth.uid()); partner uuid; mid uuid;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('classic','capture-race','queen-hunt') THEN
    RAISE EXCEPTION 'Choose a chess duel: classic, capture-race or queen-hunt.';
  END IF;
  PERFORM 1 FROM public.couples WHERE id = cid FOR UPDATE;
  SELECT id INTO partner FROM public.profiles WHERE couple_id = cid AND id <> auth.uid();
  IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;
  SELECT id INTO mid FROM public.game_matches
   WHERE couple_id = cid AND game = 'chess' AND daily_date IS NULL AND NOT finished;
  IF mid IS NOT NULL THEN RETURN mid; END IF;
  INSERT INTO public.game_matches(couple_id, game, daily_date, player_x, player_o, turn_id, best_of, chess)
  VALUES(cid, 'chess', NULL, auth.uid(), partner, auth.uid(), 3, public.chess_state_json(p_mode))
  RETURNING id INTO mid;
  RETURN mid;
END $$;

-- The one door moves come through. p_move is coordinate notation (`e2e4`, `e7e8q`
-- for a promotion, queen by default) or `resign`. p_round is the match's ply count,
-- checked exactly as play_game checks it, so two phones can never both move.
CREATE OR REPLACE FUNCTION public.chess_move(p_id uuid, p_round integer, p_move text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  m public.game_matches;
  st jsonb; board text[]; castling text; ep integer; mode text;
  mover text; enemy text; mover_name text; enemy_name text;
  frm integer; dst integer; promo text;
  moving text; kind text; captured text := ''; captured_name text;
  nb text[]; new_castling text := ''; new_ep integer := NULL; halfmove integer;
  captures jsonb; cap_count integer; key text; reps jsonb;
  winner uuid := NULL; end_reason text := NULL; drawn boolean := false;
  notation text; names jsonb := '{"P":"pawn","N":"knight","B":"bishop","R":"rook","Q":"queen","K":"king"}'::jsonb;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT * INTO m FROM public.game_matches WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.'; END IF;
  IF m.game <> 'chess' THEN RAISE EXCEPTION 'That is not a chess match.'; END IF;
  IF m.finished THEN RAISE EXCEPTION 'This match is finished.'; END IF;
  st := m.chess;
  mode := st->>'mode';

  -- Resignation needs no turn: walking away is always allowed, and no situational
  -- goal protects a king whose owner has given up.
  IF p_move = 'resign' THEN
    st := st || jsonb_build_object('end_reason','resigned');
    UPDATE public.game_matches SET chess = st, finished = true,
      winner_id = CASE WHEN uid = m.player_x THEN m.player_o ELSE m.player_x END WHERE id = m.id;
    RETURN public.chess_view(st);
  END IF;

  IF m.turn_id <> uid THEN RAISE EXCEPTION 'It is your partner''s turn.'; END IF;
  IF p_round IS DISTINCT FROM m.round THEN RAISE EXCEPTION 'The game changed. Try again.'; END IF;
  IF p_move IS NULL OR p_move !~ '^[a-h][1-8][a-h][1-8][qrbn]?$' THEN
    RAISE EXCEPTION 'Send a move like e2e4 (or e7e8q to promote).';
  END IF;
  mover := CASE WHEN uid = m.player_x THEN 'w' ELSE 'b' END;
  enemy := CASE WHEN mover = 'w' THEN 'b' ELSE 'w' END;
  mover_name := CASE WHEN mover = 'w' THEN 'white' ELSE 'black' END;
  enemy_name := CASE WHEN mover = 'w' THEN 'black' ELSE 'white' END;
  frm := (8 - substring(p_move,2,1)::integer) * 8 + (ascii(substring(p_move,1,1)) - 97);
  dst := (8 - substring(p_move,4,1)::integer) * 8 + (ascii(substring(p_move,3,1)) - 97);
  promo := CASE WHEN length(p_move) = 5 THEN upper(substring(p_move,5,1)) END;

  SELECT ARRAY(SELECT jsonb_array_elements_text(st->'board')) INTO board;
  castling := st->>'castling';
  ep := (st->>'en_passant')::integer;
  moving := board[frm+1];
  IF moving = '' OR left(moving,1) <> mover THEN RAISE EXCEPTION 'That is not your piece.'; END IF;
  kind := substring(moving,2,1);
  IF kind = 'P' AND dst / 8 IN (0,7) THEN promo := coalesce(promo,'Q');
  ELSIF promo IS NOT NULL THEN RAISE EXCEPTION 'Only a pawn reaching the last rank promotes.'; END IF;
  IF NOT public.chess_legal(board, castling, ep, frm, dst, promo) THEN
    RAISE EXCEPTION 'That move is not legal.';
  END IF;

  -- What fell: the target square, or the pawn beside an en-passant capture. The
  -- database counts it; the phone only ever named two squares.
  captured := board[dst+1];
  IF kind = 'P' AND dst = ep AND captured = '' AND (dst % 8) <> (frm % 8) THEN
    captured := board[dst + CASE WHEN mover='w' THEN 8 ELSE -8 END + 1];
  END IF;

  nb := public.chess_apply(board, frm, dst, promo, ep);
  -- Castling rights: a king move spends both, a rook leaving (or being taken on) its
  -- home square spends that side's.
  BEGIN
    new_castling := castling;
    IF kind = 'K' THEN
      new_castling := replace(replace(new_castling, CASE WHEN mover='w' THEN 'K' ELSE 'k' END, ''),
                                      CASE WHEN mover='w' THEN 'Q' ELSE 'q' END, '');
    END IF;
    IF frm = 63 OR dst = 63 THEN new_castling := replace(new_castling,'K',''); END IF;
    IF frm = 56 OR dst = 56 THEN new_castling := replace(new_castling,'Q',''); END IF;
    IF frm = 7 OR dst = 7 THEN new_castling := replace(new_castling,'k',''); END IF;
    IF frm = 0 OR dst = 0 THEN new_castling := replace(new_castling,'q',''); END IF;
  END;
  IF kind = 'P' AND abs(dst - frm) = 16 THEN new_ep := (frm + dst) / 2; END IF;
  halfmove := CASE WHEN kind = 'P' OR captured <> '' THEN 0 ELSE (st->>'halfmove')::integer + 1 END;
  captures := st->'captures';
  IF captured <> '' THEN
    captured_name := names->>substring(captured,2,1);
    captures := jsonb_set(captures, ARRAY[mover_name],
      (captures->mover_name) || jsonb_build_array(captured_name));
  END IF;
  cap_count := jsonb_array_length(captures->mover_name);

  -- The situational layer, scored the moment the capturing move lands. Checkmate is
  -- evaluated right after in the same breath (a mating move wins either way — same
  -- player), and a goal move can never have exposed the mover's own king because
  -- chess_legal filtered those out: "first to the goal, unless checkmated" holds.
  IF captured <> '' AND mode = 'capture-race' AND cap_count >= 7 THEN
    winner := uid; end_reason := 'capture-race';
  ELSIF captured <> '' AND mode = 'queen-hunt' AND captured = enemy||'Q' THEN
    winner := uid; end_reason := 'queen-hunt';   -- exact code: a promoted `Q*` does not count
  END IF;

  reps := coalesce(st->'repetitions','{}'::jsonb);
  key := array_to_string(nb, ',') || ' ' || enemy || ' ' || coalesce(nullif(new_castling,''),'-')
         || ' ' || coalesce(new_ep::text,'-');
  reps := jsonb_set(reps, ARRAY[key], to_jsonb(coalesce((reps->>key)::integer,0) + 1));

  IF winner IS NULL THEN
    IF NOT public.chess_has_move(nb, new_castling, new_ep, enemy) THEN
      IF public.chess_in_check(nb, enemy) THEN winner := uid; end_reason := 'checkmate';
      ELSE drawn := true; end_reason := 'stalemate'; END IF;
    ELSIF halfmove >= 100 THEN drawn := true; end_reason := 'fifty-move';
    ELSIF NOT EXISTS (
      SELECT 1 FROM unnest(nb) AS cell WHERE cell <> '' AND substring(cell,2,1) IN ('P','R','Q')
    ) AND (SELECT count(*) FROM unnest(nb) AS cell WHERE cell <> '' AND substring(cell,2,1) IN ('B','N')) <= 1 THEN
      drawn := true; end_reason := 'insufficient-material';
    ELSIF (reps->>key)::integer >= 3 THEN drawn := true; end_reason := 'threefold';
    END IF;
  END IF;

  notation := CASE
    WHEN kind = 'K' AND abs(dst - frm) = 2 THEN CASE WHEN dst > frm THEN 'O-O' ELSE 'O-O-O' END
    WHEN kind = 'P' THEN (CASE WHEN captured <> '' THEN chr(97 + frm % 8) || 'x' ELSE '' END)
        || chr(97 + dst % 8) || (8 - dst / 8)::text || (CASE WHEN promo IS NOT NULL THEN '=' || promo ELSE '' END)
    ELSE (CASE WHEN kind='N' THEN 'N' ELSE kind END) || (CASE WHEN captured <> '' THEN 'x' ELSE '' END)
        || chr(97 + dst % 8) || (8 - dst / 8)::text END;
  IF end_reason = 'checkmate' THEN notation := notation || '#';
  ELSIF public.chess_in_check(nb, enemy) THEN notation := notation || '+'; END IF;

  st := jsonb_build_object(
    'mode', mode, 'board', to_jsonb(nb), 'castling', coalesce(nullif(new_castling,''),'-'),
    'en_passant', new_ep, 'halfmove', halfmove, 'captures', captures,
    'history', (st->'history') || jsonb_build_array(notation),
    'end_reason', end_reason, 'drawn', drawn, 'repetitions', reps);

  UPDATE public.game_matches SET chess = st,
    turn_id = CASE WHEN uid = m.player_x THEN m.player_o ELSE m.player_x END,
    round = m.round + 1,
    finished = winner IS NOT NULL OR drawn,
    winner_id = winner
  WHERE id = m.id;
  RETURN public.chess_view(st);
END $$;

-- `authenticated` is revoked by name, as for the Snake internals above: Supabase's default
-- privileges grant EXECUTE on new public functions directly to authenticated, so a
-- PUBLIC/anon-only revoke would leave the whole chess referee callable by any phone.
REVOKE ALL ON FUNCTION public.chess_start_board(), public.chess_attacked(text[],integer,text),
  public.chess_pseudo(text[],text,integer,integer,integer), public.chess_apply(text[],integer,integer,text,integer),
  public.chess_legal(text[],text,integer,integer,integer,text), public.chess_has_move(text[],text,integer,text),
  public.chess_in_check(text[],text), public.chess_view(jsonb), public.chess_state_json(text),
  public.start_chess(text), public.chess_move(uuid,integer,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_chess(text), public.chess_move(uuid,integer,text) TO authenticated;

-- The snapshot carries the chess position (public information — there is nothing to
-- seal), and start_game refuses chess: a chess match needs its mode, so it starts
-- through start_chess.
CREATE OR REPLACE FUNCTION public.games_state() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); result jsonb;
BEGIN
 IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
 PERFORM public.snake_sweep(cid);
 SELECT jsonb_build_object('today', (now() AT TIME ZONE 'UTC')::date,
 'wins', (SELECT coalesce(jsonb_object_agg(winner_id,n),'{}') FROM
   (SELECT winner_id,count(*) n FROM public.game_matches WHERE couple_id=cid AND finished AND winner_id IS NOT NULL GROUP BY winner_id) w),
 'matches',coalesce((SELECT jsonb_agg(safe ORDER BY created_at DESC) FROM (
 SELECT created_at, (to_jsonb(m)-'pick_x'-'pick_o'-'snake'-'chess') || jsonb_build_object(
 'my_pick',CASE WHEN auth.uid()=player_x THEN pick_x ELSE pick_o END,
 'partner_locked',CASE WHEN auth.uid()=player_x THEN pick_o IS NOT NULL ELSE pick_x IS NOT NULL END,
 'snake',CASE WHEN m.game='snake' THEN public.snake_view(m.snake, auth.uid(), m.finished, m.player_x, m.player_o) END,
 'chess',CASE WHEN m.game='chess' THEN public.chess_view(m.chess) END) safe
 FROM public.game_matches m WHERE couple_id=cid AND (NOT finished OR daily_date=(now() AT TIME ZONE 'UTC')::date OR id IN (SELECT id FROM public.game_matches WHERE couple_id=cid ORDER BY created_at DESC LIMIT 30))
 ) recent),'[]')) INTO result;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.start_game(p_game text, p_daily boolean DEFAULT false, p_best_of integer DEFAULT 3)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); partner uuid; mid uuid; chosen text;
BEGIN
 IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
 PERFORM 1 FROM public.couples WHERE id=cid FOR UPDATE;
 SELECT id INTO partner FROM public.profiles WHERE couple_id=cid AND id<>auth.uid();
 IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;
 IF p_daily IS NULL OR p_game IS NULL OR p_game NOT IN ('tic-tac-toe','rock-paper-scissors','snake') OR p_best_of IS NULL OR p_best_of NOT IN (3,5) THEN RAISE EXCEPTION 'Invalid game settings.'; END IF;
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

COMMIT;

-- ---------------------------------------------------------------------------
-- Mirrors supabase/migrations/202610150012_tetris_duel.sql for brand-new projects.
-- Another game the database referees: the pieces are dealt here, the phone reports only
-- its taps, and `tetris_replay` walks those through the same rules as src/lib/tetris.ts
-- so a score is never something a phone can claim. The rules come from
-- github.com/KPaccarizi/_Tetris_Game, and the three places this parts company with that
-- repo are listed in src/lib/tetris.ts. Leaving a live run forfeits the duel.
-- Must come after the Chess section: both re-create games_state(), and this one carries
-- Chess along with it.
-- ---------------------------------------------------------------------------

BEGIN;

-- The duel lives on the same match row as the other games, so the Games tab badge, the
-- one-open-match-per-mode rule and the win scoreboard all keep working untouched.
ALTER TABLE public.game_matches DROP CONSTRAINT IF EXISTS game_matches_game_check;
ALTER TABLE public.game_matches ADD CONSTRAINT game_matches_game_check
  CHECK (game IN ('tic-tac-toe','rock-paper-scissors','snake','chess','tetris'));
ALTER TABLE public.game_matches ADD COLUMN IF NOT EXISTS tetris jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Which of the two ways this duel is settled. Null on every other game.
ALTER TABLE public.game_matches ADD COLUMN IF NOT EXISTS tetris_mode text;
ALTER TABLE public.game_matches DROP CONSTRAINT IF EXISTS game_matches_tetris_mode_check;
ALTER TABLE public.game_matches ADD CONSTRAINT game_matches_tetris_mode_check
  CHECK (tetris_mode IS NULL OR tetris_mode IN ('sprint','survival'));

-- One open practice match per couple per game is the rule the other three games keep. A
-- Tetris duel is fixed to the mode it was started in, so the rule becomes one open sprint
-- and one open survival: neither is the other's rematch, and opening one never closes it.
DROP INDEX IF EXISTS public.game_one_practice;
CREATE UNIQUE INDEX IF NOT EXISTS game_one_practice ON public.game_matches(couple_id, game)
  WHERE daily_date IS NULL AND NOT finished AND game <> 'tetris';
CREATE UNIQUE INDEX IF NOT EXISTS game_one_practice_tetris ON public.game_matches(couple_id, game, tetris_mode)
  WHERE daily_date IS NULL AND NOT finished AND game = 'tetris';

-- Mirror of src/lib/tetris.ts: a 10×16 well, 50ms a tick, five minutes to a run, thirty
-- seconds of silence before a run is lost, six hundred pieces dealt per duel.
CREATE OR REPLACE FUNCTION public.tetris_max_ticks() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 6000 $$;

-- How many ticks a run may have reported after this much real time. Six ticks of slack for
-- the round trip (300ms — a fiftieth of the run, and far less than the beat interval); the
-- run's own cap holds the ceiling.
CREATE OR REPLACE FUNCTION public.tetris_budget(p_started timestamptz) RETURNS integer
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT least(greatest(floor(extract(epoch FROM (now() - p_started)) * 1000 / 50)::integer + 6, 0), public.tetris_max_ticks())
$$;

-- Walk one side's run and return what it really scored. This is the authority: the score a
-- phone claims is never read, only this result is.
CREATE OR REPLACE FUNCTION public.tetris_replay(p_pieces jsonb, p_inputs jsonb, p_ticks integer, p_cap integer DEFAULT 6000)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  cols constant integer := 10;
  rows_ constant integer := 16;
  cap integer := least(coalesce(p_cap, public.tetris_max_ticks()), public.tetris_max_ticks());
  -- The seven tetrominoes as cell offsets from the spawn; the first cell is the pivot.
  shapes constant jsonb := '[[[-1,0],[-2,0],[0,0],[1,0]],[[0,-1],[-1,-1],[-1,0],[0,0]],[[-1,0],[-1,1],[0,0],[0,-1]],[[0,0],[-1,0],[0,1],[-1,-1]],[[0,0],[0,-1],[0,1],[-1,-1]],[[0,0],[0,-1],[0,1],[1,-1]],[[0,0],[0,-1],[0,1],[-1,0]]]'::jsonb;
  -- Ticks a piece waits before falling a row, by level. Level is one step per ten lines.
  gravity constant integer[] := ARRAY[15,13,11,10,9,8,7,6,5,4,3];
  scores constant integer[] := ARRAY[0,100,300,700,1500];
  spawn_x constant integer := 5;
  spawn_y constant integer := 1;
  max_level constant integer := 10;
  per_tick constant integer := 2;      -- taps acted on in one tick, and that may wait for it
  goal integer;
  pieces integer[];
  npiece integer := 0;
  in_tick integer[];
  in_act text[];
  ninput integer := 0;
  idx integer := 1;
  field integer[] := array_fill(0, ARRAY[160]);
  swept integer[];
  cx integer[] := ARRAY[0,0,0,0]; cy integer[] := ARRAY[0,0,0,0];
  tx integer[] := ARRAY[0,0,0,0]; ty integer[] := ARRAY[0,0,0,0];
  kind integer := 0; piece integer := 0; fall integer := 0;
  lines integer := 0; score integer := 0; ticks integer := 0;
  ended text := NULL;
  i integer; r integer; c integer; w integer; cleared integer; row_full boolean;
  act text; hit boolean; block boolean := false; queued integer; lvl integer;
  px integer; py integer; rx integer; ry integer;
BEGIN
  SELECT coalesce(array_agg((value::text)::integer ORDER BY ord), ARRAY[]::integer[]) INTO pieces
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(coalesce(p_pieces,'[]'::jsonb)) = 'array' THEN p_pieces ELSE '[]'::jsonb END) WITH ORDINALITY AS t(value, ord)
   WHERE jsonb_typeof(value) = 'number' AND value::text ~ '^[0-6]$';
  npiece := coalesce(array_length(pieces, 1), 0);
  SELECT coalesce(array_agg((value->>0)::integer ORDER BY ord), ARRAY[]::integer[]),
         coalesce(array_agg((value->>1)::text ORDER BY ord), ARRAY[]::text[])
    INTO in_tick, in_act
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(coalesce(p_inputs,'[]'::jsonb)) = 'array' THEN p_inputs ELSE '[]'::jsonb END) WITH ORDINALITY AS t(value, ord)
   WHERE jsonb_typeof(value) = 'array' AND jsonb_array_length(value) = 2
     AND (value->>0) ~ '^[0-9]{1,4}$' AND (value->>1) IN ('left','right','rotate','down','drop');
  ninput := coalesce(array_length(in_tick, 1), 0);

  goal := least(greatest(coalesce(p_ticks, 0), 0), cap);
  -- Nothing dealt means nothing played: the run is over before it starts.
  IF npiece = 0 THEN
    RETURN jsonb_build_object('score', 0, 'lines', 0, 'ticks', goal, 'ended', 'cap');
  END IF;
  kind := pieces[1];
  FOR i IN 1..4 LOOP
    cx[i] := spawn_x + (shapes -> kind -> (i-1) ->> 0)::integer;
    cy[i] := spawn_y + (shapes -> kind -> (i-1) ->> 1)::integer;
  END LOOP;

  WHILE ticks < goal AND ended IS NULL LOOP
    block := false;
    -- The taps the phone reported for this tick, oldest first, up to what its own queue
    -- could have held.
    queued := 0;
    WHILE idx <= ninput AND in_tick[idx] <= ticks AND queued < per_tick LOOP
      act := in_act[idx];
      IF act = 'left' OR act = 'right' THEN
        FOR i IN 1..4 LOOP tx[i] := cx[i] + CASE WHEN act = 'left' THEN -1 ELSE 1 END; ty[i] := cy[i]; END LOOP;
        hit := false;
        FOR i IN 1..4 LOOP IF tx[i] < 0 OR tx[i] >= cols OR ty[i] < 0 OR ty[i] >= rows_ OR field[ty[i]*cols + tx[i] + 1] <> 0 THEN hit := true; END IF; END LOOP;
        IF NOT hit THEN FOR i IN 1..4 LOOP cx[i] := tx[i]; END LOOP; END IF;
      ELSIF act = 'down' THEN
        FOR i IN 1..4 LOOP tx[i] := cx[i]; ty[i] := cy[i] + 1; END LOOP;
        hit := false;
        FOR i IN 1..4 LOOP IF tx[i] < 0 OR tx[i] >= cols OR ty[i] < 0 OR ty[i] >= rows_ OR field[ty[i]*cols + tx[i] + 1] <> 0 THEN hit := true; END IF; END LOOP;
        IF NOT hit THEN FOR i IN 1..4 LOOP cy[i] := ty[i]; END LOOP; fall := 0; END IF;
      ELSIF act = 'rotate' THEN
        px := cx[1]; py := cy[1];
        FOR i IN 1..4 LOOP rx := cx[i] - px; ry := cy[i] - py; tx[i] := px - ry; ty[i] := py + rx; END LOOP;
        hit := false;
        FOR i IN 1..4 LOOP IF tx[i] < 0 OR tx[i] >= cols OR ty[i] < 0 OR ty[i] >= rows_ OR field[ty[i]*cols + tx[i] + 1] <> 0 THEN hit := true; END IF; END LOOP;
        IF NOT hit THEN FOR i IN 1..4 LOOP cx[i] := tx[i]; cy[i] := ty[i]; END LOOP; END IF;
      ELSE                                     -- drop: slide to the floor and come to rest
        LOOP
          FOR i IN 1..4 LOOP tx[i] := cx[i]; ty[i] := cy[i] + 1; END LOOP;
          hit := false;
          FOR i IN 1..4 LOOP IF tx[i] < 0 OR tx[i] >= cols OR ty[i] < 0 OR ty[i] >= rows_ OR field[ty[i]*cols + tx[i] + 1] <> 0 THEN hit := true; END IF; END LOOP;
          EXIT WHEN hit;
          FOR i IN 1..4 LOOP cy[i] := ty[i]; END LOOP;
        END LOOP;
        block := true;
      END IF;
      idx := idx + 1;
      queued := queued + 1;
      -- One piece comes to rest per tick, so a hard drop is this tick's last word.
      EXIT WHEN block;
    END LOOP;
    -- Taps the phone's queue had no room for are dropped here, exactly as they were there.
    WHILE idx <= ninput AND in_tick[idx] <= ticks LOOP idx := idx + 1; END LOOP;

    IF NOT block THEN
      lvl := least(lines / 10, max_level);
      fall := fall + 1;
      IF fall >= gravity[lvl + 1] THEN
        FOR i IN 1..4 LOOP tx[i] := cx[i]; ty[i] := cy[i] + 1; END LOOP;
        hit := false;
        FOR i IN 1..4 LOOP IF tx[i] < 0 OR tx[i] >= cols OR ty[i] < 0 OR ty[i] >= rows_ OR field[ty[i]*cols + tx[i] + 1] <> 0 THEN hit := true; END IF; END LOOP;
        IF hit THEN block := true; ELSE FOR i IN 1..4 LOOP cy[i] := ty[i]; END LOOP; fall := 0; END IF;
      END IF;
    END IF;

    -- The one place in the whole run where a piece comes to rest.
    IF block THEN
      FOR i IN 1..4 LOOP
        IF cx[i] >= 0 AND cx[i] < cols AND cy[i] >= 0 AND cy[i] < rows_ THEN
          field[cy[i]*cols + cx[i] + 1] := kind + 1;
        END IF;
      END LOOP;
      -- Collapse from the bottom up, keeping every row that is not row_full. Rows that scroll
      -- in at the top arrive empty: the reference leaves a stale copy behind instead.
      swept := array_fill(0, ARRAY[cols * rows_]);
      w := rows_ - 1;
      cleared := 0;
      FOR r IN REVERSE (rows_ - 1)..0 LOOP
        row_full := true;
        FOR c IN 0..(cols - 1) LOOP IF field[r*cols + c + 1] = 0 THEN row_full := false; END IF; END LOOP;
        IF row_full THEN
          cleared := cleared + 1;
        ELSE
          IF w >= 0 THEN
            FOR c IN 0..(cols - 1) LOOP swept[w*cols + c + 1] := field[r*cols + c + 1]; END LOOP;
          END IF;
          w := w - 1;
        END IF;
      END LOOP;
      field := swept;
      score := score + scores[cleared + 1];
      lines := lines + cleared;
      piece := piece + 1;
      kind := pieces[(piece % npiece) + 1];
      FOR i IN 1..4 LOOP
        cx[i] := spawn_x + (shapes -> kind -> (i-1) ->> 0)::integer;
        cy[i] := spawn_y + (shapes -> kind -> (i-1) ->> 1)::integer;
      END LOOP;
      hit := false;
      FOR i IN 1..4 LOOP IF cx[i] < 0 OR cx[i] >= cols OR cy[i] < 0 OR cy[i] >= rows_ OR field[cy[i]*cols + cx[i] + 1] <> 0 THEN hit := true; END IF; END LOOP;
      IF hit THEN ended := 'top'; END IF;
    END IF;

    ticks := ticks + 1;
    IF ended IS NULL AND ticks >= cap THEN ended := 'cap'; END IF;
  END LOOP;
  RETURN jsonb_build_object('score', score, 'lines', lines, 'ticks', ticks, 'ended', ended);
END $$;

-- Decide the duel once it can be decided. Called with the match row already locked.
CREATE OR REPLACE FUNCTION public.tetris_settle(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m public.game_matches;
  x_entry jsonb; o_entry jsonb;
  x_score integer; o_score integer; x_ticks integer; o_ticks integer;
  winner uuid := NULL;
BEGIN
  SELECT * INTO m FROM public.game_matches WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR m.finished OR m.game <> 'tetris' THEN RETURN; END IF;
  x_entry := coalesce(m.tetris -> m.player_x::text, '{}'::jsonb);
  o_entry := coalesce(m.tetris -> m.player_o::text, '{}'::jsonb);
  IF x_entry->>'status' = 'forfeit' OR o_entry->>'status' = 'forfeit' THEN
    -- Leaving loses the duel there and then, whether or not the other partner has played.
    IF x_entry->>'status' = 'forfeit' AND o_entry->>'status' = 'forfeit' THEN winner := NULL;
    ELSIF x_entry->>'status' = 'forfeit' THEN winner := m.player_o;
    ELSE winner := m.player_x; END IF;
  ELSIF x_entry->>'status' = 'done' AND o_entry->>'status' = 'done' THEN
    x_score := coalesce((x_entry->>'score')::integer, 0);
    o_score := coalesce((o_entry->>'score')::integer, 0);
    IF m.tetris_mode = 'survival' THEN
      -- Whoever kept stacking longer. The score only separates two runs that lasted
      -- exactly as long, which in practice means both ran the clock out.
      x_ticks := coalesce((x_entry->>'ticks')::integer, 0);
      o_ticks := coalesce((o_entry->>'ticks')::integer, 0);
      IF x_ticks <> o_ticks THEN
        winner := CASE WHEN x_ticks > o_ticks THEN m.player_x ELSE m.player_o END;
      ELSIF x_score <> o_score THEN
        winner := CASE WHEN x_score > o_score THEN m.player_x ELSE m.player_o END;
      END IF;
    ELSE
      IF x_score > o_score THEN winner := m.player_x;
      ELSIF o_score > x_score THEN winner := m.player_o; END IF;
    END IF;
  ELSE
    RETURN;                                  -- still waiting on a run
  END IF;
  UPDATE public.game_matches SET finished = true, winner_id = winner WHERE id = m.id;
END $$;

-- Time never stands still, and the app has no server clock of its own: the sweep runs
-- whenever either phone reads its state. A run that has gone quiet for longer than the
-- grace is lost; a run that is still reporting in when its five minutes are up simply ends
-- where it stood.
CREATE OR REPLACE FUNCTION public.tetris_sweep(p_couple uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m public.game_matches;
  state jsonb; who text; entry jsonb; result jsonb;
BEGIN
  FOR m IN SELECT * FROM public.game_matches WHERE couple_id = p_couple AND game = 'tetris' AND NOT finished FOR UPDATE LOOP
    state := coalesce(m.tetris, '{}'::jsonb);
    FOR who IN SELECT jsonb_object_keys(state) LOOP
      entry := state -> who;
      CONTINUE WHEN jsonb_typeof(entry) <> 'object' OR entry->>'status' IS NULL;
      IF entry->>'status' = 'running' THEN
        IF (entry->>'last_seen')::timestamptz < now() - make_interval(secs => 30) THEN
          result := public.tetris_replay(entry->'pieces', entry->'inputs', coalesce((entry->>'ticks')::integer, 0));
          entry := entry || jsonb_build_object('status','forfeit','ended','forfeit',
            'score',coalesce((result->>'score')::integer, 0),'lines',coalesce((result->>'lines')::integer, 0),
            'finished_at',now());
        ELSIF (entry->>'deadline')::timestamptz <= now() THEN
          -- Five minutes are up: the run ends exactly where the last report left it.
          result := public.tetris_replay(entry->'pieces', entry->'inputs', coalesce((entry->>'ticks')::integer, 0));
          entry := entry || jsonb_build_object('status','done','ended','cap',
            'score',coalesce((result->>'score')::integer, 0),'lines',coalesce((result->>'lines')::integer, 0),
            'ticks',coalesce((result->>'ticks')::integer, 0),'finished_at',now());
        ELSE
          CONTINUE;
        END IF;
        state := jsonb_set(state, ARRAY[who], entry);
      END IF;
    END LOOP;
    IF state IS DISTINCT FROM coalesce(m.tetris, '{}'::jsonb) THEN
      UPDATE public.game_matches SET tetris = state WHERE id = m.id;
    END IF;
    PERFORM public.tetris_settle(m.id);
  END LOOP;
END $$;

-- Deal the pieces and start the clock. The sequence is dealt once per duel and both
-- partners play it, so the two runs are like for like. Calling this again while a run is
-- live hands the same run back, which is how a phone picks a run up after a reload; it
-- never deals a second chance at a run that has already been played.
CREATE OR REPLACE FUNCTION public.tetris_start(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  m public.game_matches;
  state jsonb; entry jsonb; other jsonb; pieces jsonb;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM public.tetris_sweep(cid);          -- a run that went quiet in the meantime is already lost
  SELECT * INTO m FROM public.game_matches WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.'; END IF;
  IF m.game <> 'tetris' THEN RAISE EXCEPTION 'That is not a Tetris duel.'; END IF;
  IF m.finished THEN RAISE EXCEPTION 'This duel is already over.'; END IF;
  state := coalesce(m.tetris, '{}'::jsonb);
  entry := state -> uid::text;
  IF entry IS NOT NULL AND entry->>'status' = 'running' THEN RETURN entry; END IF;
  IF entry IS NOT NULL THEN RAISE EXCEPTION 'You have already played your run in this duel.'; END IF;
  -- The partner's run carries the sequence if they have been dealt one already; otherwise
  -- this is the first run of the duel and it is dealt here.
  SELECT value INTO other FROM jsonb_each(state) WHERE value->>'status' IS NOT NULL LIMIT 1;
  pieces := CASE WHEN other IS NOT NULL THEN coalesce(other->'pieces', '[]'::jsonb) ELSE '[]'::jsonb END;
  IF coalesce(jsonb_array_length(pieces), 0) = 0 THEN
    SELECT coalesce(jsonb_agg(floor(random() * 7)::integer), '[]'::jsonb) INTO pieces FROM generate_series(1, 600);
  END IF;
  entry := jsonb_build_object('status','running','score',0,'lines',0,'ticks',0,'inputs','[]'::jsonb,'pieces',pieces,
    'started_at',now(),'last_seen',now(),'deadline',now() + make_interval(secs => 300));
  UPDATE public.game_matches SET tetris = state || jsonb_build_object(uid::text, entry) WHERE id = m.id;
  RETURN entry;
END $$;

-- A progress report: where the run is, and the taps made since the last one. The report is
-- append-only and cannot outrun real time, so a run cannot be rewound, accelerated or
-- handed in twice.
CREATE OR REPLACE FUNCTION public.tetris_commit(p_id uuid, p_ticks integer, p_inputs jsonb, p_final boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  m public.game_matches;
  state jsonb; entry jsonb; inputs jsonb; incoming jsonb; result jsonb;
  last_tick integer := -1; change jsonb; change_tick integer; change_act text;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  -- A phone that went quiet for longer than the grace has already lost its run: settle that
  -- before reading anything, so a report that arrives late cannot revive it.
  PERFORM public.tetris_sweep(cid);
  SELECT * INTO m FROM public.game_matches WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.'; END IF;
  IF m.game <> 'tetris' THEN RAISE EXCEPTION 'That is not a Tetris duel.'; END IF;
  state := coalesce(m.tetris, '{}'::jsonb);
  entry := state -> uid::text;
  IF entry IS NULL THEN RAISE EXCEPTION 'Start your run first.'; END IF;
  -- Someone else (or the sweep) already settled this run; report it instead of arguing.
  IF entry->>'status' <> 'running' THEN RETURN entry; END IF;
  IF m.finished THEN RETURN entry || jsonb_build_object('match_finished', true); END IF;
  IF p_ticks IS NULL OR p_ticks < 0 OR p_inputs IS NULL OR jsonb_typeof(p_inputs) <> 'array' THEN
    RAISE EXCEPTION 'That run report cannot be read.';
  END IF;
  IF p_ticks < coalesce((entry->>'ticks')::integer, 0) THEN RAISE EXCEPTION 'That run report is older than the last one.'; END IF;
  IF p_ticks > public.tetris_budget((entry->>'started_at')::timestamptz) THEN RAISE EXCEPTION 'That run is moving faster than real time.'; END IF;
  inputs := coalesce(entry->'inputs', '[]'::jsonb);
  IF jsonb_array_length(inputs) > 0 THEN last_tick := (inputs->-1->>0)::integer; END IF;
  incoming := '[]'::jsonb;
  FOR change IN SELECT value FROM jsonb_array_elements(p_inputs) LOOP
    IF jsonb_typeof(change) <> 'array' OR jsonb_array_length(change) <> 2
       OR (change->>0) !~ '^[0-9]{1,4}$' OR (change->>1) NOT IN ('left','right','rotate','down','drop') THEN
      RAISE EXCEPTION 'That run report cannot be read.';
    END IF;
    change_tick := (change->>0)::integer;
    change_act := change->>1;
    -- Taps arrive in the order they were made, never before the last one already on file,
    -- and never for a tick the run has not reached yet.
    IF change_tick < last_tick OR change_tick >= p_ticks THEN RAISE EXCEPTION 'That run report is out of order.'; END IF;
    incoming := incoming || jsonb_build_array(jsonb_build_array(change_tick, change_act));
    last_tick := change_tick;
  END LOOP;
  inputs := inputs || incoming;
  entry := entry || jsonb_build_object('ticks', p_ticks, 'inputs', inputs, 'last_seen', now());
  IF p_final OR p_ticks >= public.tetris_max_ticks() THEN
    result := public.tetris_replay(entry->'pieces', inputs, p_ticks);
    entry := entry || jsonb_build_object('status','done',
      'score',coalesce((result->>'score')::integer, 0),
      'lines',coalesce((result->>'lines')::integer, 0),
      'ended',coalesce(result->>'ended','alive'),
      'ticks',coalesce((result->>'ticks')::integer, p_ticks),'finished_at',now());
  END IF;
  UPDATE public.game_matches SET tetris = state || jsonb_build_object(uid::text, entry) WHERE id = m.id;
  IF p_final OR p_ticks >= public.tetris_max_ticks() THEN PERFORM public.tetris_settle(m.id); END IF;
  RETURN entry;
END $$;

CREATE OR REPLACE FUNCTION public.tetris_beat(p_id uuid, p_ticks integer, p_inputs jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT public.tetris_commit(p_id, p_ticks, p_inputs, false) $$;
CREATE OR REPLACE FUNCTION public.tetris_finish(p_id uuid, p_ticks integer, p_inputs jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT public.tetris_commit(p_id, p_ticks, p_inputs, true) $$;

-- Walking out. The partner takes the duel immediately: waiting to be beaten is not part of
-- the deal. Safe to call twice, and safe to call after the duel ended some other way.
CREATE OR REPLACE FUNCTION public.tetris_forfeit(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  m public.game_matches;
  state jsonb; entry jsonb; result jsonb;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT * INTO m FROM public.game_matches WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.'; END IF;
  IF m.game <> 'tetris' THEN RAISE EXCEPTION 'That is not a Tetris duel.'; END IF;
  state := coalesce(m.tetris, '{}'::jsonb);
  entry := state -> uid::text;
  IF entry IS NULL THEN RETURN '{}'::jsonb; END IF;
  IF entry->>'status' <> 'running' THEN RETURN entry; END IF;
  IF m.finished THEN RETURN entry || jsonb_build_object('match_finished', true); END IF;
  -- Keep what the run had reached: the forfeit is the loss, not the score.
  result := public.tetris_replay(entry->'pieces', entry->'inputs', coalesce((entry->>'ticks')::integer, 0));
  entry := entry || jsonb_build_object('status','forfeit','ended','forfeit',
    'score',coalesce((result->>'score')::integer, 0),'lines',coalesce((result->>'lines')::integer, 0),
    'finished_at',now());
  UPDATE public.game_matches SET tetris = state || jsonb_build_object(uid::text, entry) WHERE id = m.id;
  PERFORM public.tetris_settle(m.id);
  RETURN entry;
END $$;

-- One side of a duel as this phone may see it. A blind duel: the partner's score is sealed
-- until the duel is over, and their live run shows only that they are playing.
CREATE OR REPLACE FUNCTION public.tetris_view(p_state jsonb, p_uid uuid, p_finished boolean, p_x uuid, p_o uuid, p_mode text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  me jsonb; them jsonb;
BEGIN
  IF p_state IS NULL THEN RETURN NULL; END IF;
  me := p_state -> p_uid::text;
  them := p_state -> (CASE WHEN p_x = p_uid THEN p_o ELSE p_x END)::text;
  RETURN jsonb_build_object(
    'mode', p_mode,
    'mine', coalesce(me, 'null'::jsonb),
    'partner', CASE WHEN them IS NULL THEN jsonb_build_object('status','waiting') ELSE
      jsonb_build_object('status', them->>'status', 'ended', them->>'ended')
      || CASE WHEN them->>'status' = 'running' THEN jsonb_build_object('last_seen', them->>'last_seen') ELSE '{}'::jsonb END
      || CASE WHEN p_finished THEN jsonb_build_object('score', coalesce((them->>'score')::integer, 0),
                                                      'lines', coalesce((them->>'lines')::integer, 0),
                                                      'ticks', coalesce((them->>'ticks')::integer, 0)) ELSE '{}'::jsonb END
    END);
END $$;

-- `authenticated` is revoked by name, as for the Snake/Chess internals above: Supabase's
-- default privileges grant EXECUTE on new public functions directly to authenticated, so
-- a PUBLIC/anon-only revoke would leave tetris_commit/tetris_settle callable by any phone.
REVOKE ALL ON FUNCTION public.tetris_max_ticks(), public.tetris_budget(timestamptz),
  public.tetris_replay(jsonb,jsonb,integer,integer),
  public.tetris_settle(uuid), public.tetris_sweep(uuid), public.tetris_start(uuid),
  public.tetris_commit(uuid,integer,jsonb,boolean),
  public.tetris_beat(uuid,integer,jsonb), public.tetris_finish(uuid,integer,jsonb), public.tetris_forfeit(uuid),
  public.tetris_view(jsonb,uuid,boolean,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tetris_start(uuid), public.tetris_beat(uuid,integer,jsonb),
  public.tetris_finish(uuid,integer,jsonb), public.tetris_forfeit(uuid) TO authenticated;

-- Games now deal with four games, and the snapshot carries the duel: who has played, who
-- is playing right now, and — only once it is over — what each of them scored.
CREATE OR REPLACE FUNCTION public.games_state() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); result jsonb;
BEGIN IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
 -- Time keeps passing while nobody reads this: settle anything whose clock ran out first.
 PERFORM public.snake_sweep(cid);
 PERFORM public.tetris_sweep(cid);
 SELECT jsonb_build_object('today', (now() AT TIME ZONE 'UTC')::date,
 'wins', (SELECT coalesce(jsonb_object_agg(winner_id,n),'{}') FROM
   (SELECT winner_id,count(*) n FROM public.game_matches WHERE couple_id=cid AND finished AND winner_id IS NOT NULL GROUP BY winner_id) w),
 'matches',coalesce((SELECT jsonb_agg(safe ORDER BY created_at DESC) FROM (
 SELECT created_at, (to_jsonb(m)-'pick_x'-'pick_o'-'snake'-'chess'-'tetris') || jsonb_build_object(
 'my_pick',CASE WHEN auth.uid()=player_x THEN pick_x ELSE pick_o END,
 'partner_locked',CASE WHEN auth.uid()=player_x THEN pick_o IS NOT NULL ELSE pick_x IS NOT NULL END,
 'snake',CASE WHEN m.game='snake' THEN public.snake_view(m.snake, auth.uid(), m.finished, m.player_x, m.player_o) END,
 'chess',CASE WHEN m.game='chess' THEN public.chess_view(m.chess) END,
 'tetris',CASE WHEN m.game='tetris' THEN public.tetris_view(m.tetris, auth.uid(), m.finished, m.player_x, m.player_o, m.tetris_mode) END) safe
 FROM public.game_matches m WHERE couple_id=cid AND (NOT finished OR daily_date=(now() AT TIME ZONE 'UTC')::date OR id IN (SELECT id FROM public.game_matches WHERE couple_id=cid ORDER BY created_at DESC LIMIT 30))
 ) recent),'[]')) INTO result;
 RETURN result;
END $$;

-- Starting a Tetris duel gets its own RPC, the way Chess does, rather than a fourth
-- argument on `start_game`. Two reasons, and the second is the one that matters: a Tetris
-- duel is fixed to a mode in a way no other game is, and adding a fourth parameter would
-- leave *two* `start_game` functions on the project — so a three-argument call (every
-- other game, and any re-run of migration 007 or 011) would stop resolving with
-- "function start_game(...) is not unique". One function per way of starting a game.
CREATE OR REPLACE FUNCTION public.start_tetris(p_mode text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); partner uuid; mid uuid;
BEGIN
 IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
 IF p_mode IS NULL OR p_mode NOT IN ('sprint','survival') THEN RAISE EXCEPTION 'Invalid game settings.'; END IF;
 -- Serialize starts across both phones, so two taps cannot open two duels.
 PERFORM 1 FROM public.couples WHERE id=cid FOR UPDATE;
 SELECT id INTO partner FROM public.profiles WHERE couple_id=cid AND id<>auth.uid();
 IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;
 -- A duel is fixed to the mode it was started in, so a sprint and a survival can both be
 -- open at once without either of them being the other's rematch.
 SELECT id INTO mid FROM public.game_matches
  WHERE couple_id=cid AND game='tetris' AND daily_date IS NULL AND NOT finished AND tetris_mode=p_mode;
 IF mid IS NOT NULL THEN RETURN mid; END IF;
 INSERT INTO public.game_matches(couple_id,game,player_x,player_o,turn_id,best_of,tetris_mode)
 VALUES(cid,'tetris',auth.uid(),partner,auth.uid(),3,p_mode) RETURNING id INTO mid;
 RETURN mid;
END $$;

REVOKE ALL ON FUNCTION public.start_tetris(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_tetris(text) TO authenticated;

-- ============================================================================
-- 17. Web push: one row per browser that agreed to be notified
-- Mirrors supabase/migrations/202610150015_web_push.sql (a live project runs that
-- file; this section is what a brand-new project gets in one go). The notifications
-- themselves are sent by the `send-push` Edge Function, called by a Database Webhook
-- on `messages` and signed with Nooki's own VAPID keypair — no third-party push
-- service is involved. See "Push notifications" in the README.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  couple_id UUID REFERENCES public.couples(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint),
  CONSTRAINT push_subscriptions_endpoint_length CHECK (char_length(endpoint) BETWEEN 12 AND 1024),
  CONSTRAINT push_subscriptions_p256dh_length CHECK (char_length(p256dh) BETWEEN 8 AND 255),
  CONSTRAINT push_subscriptions_auth_length CHECK (char_length(auth) BETWEEN 8 AND 255)
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON public.push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_couple ON public.push_subscriptions(couple_id);

CREATE OR REPLACE FUNCTION public.set_push_subscription_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  NEW.updated_at := timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS push_subscriptions_set_updated_at ON public.push_subscriptions;
CREATE TRIGGER push_subscriptions_set_updated_at
BEFORE UPDATE ON public.push_subscriptions
FOR EACH ROW EXECUTE FUNCTION public.set_push_subscription_updated_at();

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read their own push devices" ON public.push_subscriptions;
CREATE POLICY "Users can read their own push devices" ON public.push_subscriptions
FOR SELECT TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can add their own push devices" ON public.push_subscriptions;
CREATE POLICY "Users can add their own push devices" ON public.push_subscriptions
FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can remove their own push devices" ON public.push_subscriptions;
CREATE POLICY "Users can remove their own push devices" ON public.push_subscriptions
FOR DELETE TO authenticated
USING (user_id = auth.uid());

-- Claim this browser as one of the signed-in account's devices, or refresh its keys.
-- `couple_id` comes from the caller's profile, never from the phone. A device that is now
-- signed in as someone else moves to that account: it still only ever receives what the
-- sender would have sent that account anyway.
CREATE OR REPLACE FUNCTION public.register_push_subscription(
  p_endpoint TEXT,
  p_p256dh TEXT,
  p_auth TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  cid UUID;
  clean_endpoint TEXT := btrim(coalesce(p_endpoint, ''));
  clean_p256dh TEXT := btrim(coalesce(p_p256dh, ''));
  clean_auth TEXT := btrim(coalesce(p_auth, ''));
  sid UUID;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Sign in to turn on notifications.';
  END IF;
  IF char_length(clean_endpoint) NOT BETWEEN 12 AND 1024
     OR clean_endpoint !~ '^https://'
     OR char_length(clean_p256dh) NOT BETWEEN 8 AND 255
     OR char_length(clean_auth) NOT BETWEEN 8 AND 255 THEN
    RAISE EXCEPTION 'That push subscription is not valid.';
  END IF;

  SELECT couple_id INTO cid FROM public.profiles WHERE id = caller;

  INSERT INTO public.push_subscriptions (user_id, couple_id, endpoint, p256dh, auth)
  VALUES (caller, cid, clean_endpoint, clean_p256dh, clean_auth)
  ON CONFLICT (endpoint) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        couple_id = EXCLUDED.couple_id,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth
  RETURNING id INTO sid;

  RETURN sid;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_push_subscription(p_endpoint TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  removed INTEGER;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Sign in to turn off notifications.';
  END IF;
  DELETE FROM public.push_subscriptions
   WHERE user_id = caller AND endpoint = btrim(coalesce(p_endpoint, ''));
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_my_push_subscriptions()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  removed INTEGER;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Sign in to turn off notifications.';
  END IF;
  DELETE FROM public.push_subscriptions WHERE user_id = caller;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

GRANT SELECT, INSERT, DELETE ON public.push_subscriptions TO authenticated;
REVOKE ALL ON public.push_subscriptions FROM anon;

REVOKE ALL ON FUNCTION public.register_push_subscription(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_push_subscription(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_my_push_subscriptions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_push_subscription(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_push_subscription(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_my_push_subscriptions() TO authenticated;

COMMIT;

-- ============================================================================
-- 18. Miss you: the taps a partner leaves behind for the half of the couple
-- who is away
-- Mirrors supabase/migrations/202610150016_miss_you.sql (a live project runs
-- that file; this section is what a brand-new project gets in one go). One row
-- per sender per own calendar day: how many times they tapped "I miss you" and
-- how many of those the other partner has already been shown. The button, the
-- heart and the wording live in src/components/home/MissYouButton.tsx,
-- src/components/home/MissYouReveal.tsx and src/lib/missYou.ts.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.miss_you_taps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  -- Who tapped. The row is that account's own record of their own day.
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The sender's own calendar day (`YYYY-MM-DD`), never a UTC guess, so an 11pm tap counts
  -- as tonight for the person who tapped and "missed you 4 times today" stays true.
  tap_date DATE NOT NULL,
  -- Every tap recorded on that day, delivered or not: this is the "number of taps".
  tap_count INTEGER NOT NULL DEFAULT 1,
  -- How many of them the partner has been shown. The difference between the two is what is
  -- still waiting for them, and receiving sets this to tap_count — the reset.
  delivered_count INTEGER NOT NULL DEFAULT 0,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  -- One row per sender per day: a day of tapping is one number, never a pile of rows.
  CONSTRAINT miss_you_taps_one_row_per_day UNIQUE (couple_id, sender_id, tap_date),
  CONSTRAINT miss_you_taps_count_check CHECK (tap_count BETWEEN 1 AND 100000),
  CONSTRAINT miss_you_taps_delivered_check CHECK (delivered_count BETWEEN 0 AND tap_count)
);

-- Keep updated_at honest without the client having to remember it.
CREATE OR REPLACE FUNCTION public.set_miss_you_tap_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  NEW.updated_at := timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS miss_you_taps_set_updated_at ON public.miss_you_taps;
CREATE TRIGGER miss_you_taps_set_updated_at
BEFORE UPDATE ON public.miss_you_taps
FOR EACH ROW EXECUTE FUNCTION public.set_miss_you_tap_updated_at();

ALTER TABLE public.miss_you_taps ENABLE ROW LEVEL SECURITY;

-- The two partners may read their own couple's taps; nobody else, and an unpaired account
-- (a NULL couple id) matches nothing. Every write goes through the two functions below, so
-- there is deliberately no insert, update or delete policy at all.
DROP POLICY IF EXISTS "Couple members can view their miss-yous" ON public.miss_you_taps;
CREATE POLICY "Couple members can view their miss-yous" ON public.miss_you_taps
FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

-- One tap. The couple and the sender come from the caller's own profile, never from the
-- phone, and the day is upserted so rapid tapping is one row and one number.
-- Returns the count still waiting for the partner, which is what the button shows.
CREATE OR REPLACE FUNCTION public.record_miss_you_tap(p_tap_date DATE)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  cid UUID;
  utc_today DATE := (timezone('utc'::text, now()))::date;
  day DATE := coalesce(p_tap_date, utc_today);
  waiting INTEGER;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Sign in to send a miss you.';
  END IF;

  cid := public.get_user_couple_id(caller);
  IF cid IS NULL THEN
    RAISE EXCEPTION 'Pair with your partner before sending a miss you.';
  END IF;

  -- The phone sends its own calendar day; a wrong clock is refused rather than allowed to
  -- invent a row months away. Real timezones are within one day of UTC, so two is generous.
  IF day < utc_today - 2 OR day > utc_today + 2 THEN
    RAISE EXCEPTION 'That miss-you date is not valid.';
  END IF;

  INSERT INTO public.miss_you_taps AS t (couple_id, sender_id, tap_date, tap_count, delivered_count)
  VALUES (cid, caller, day, 1, 0)
  ON CONFLICT (couple_id, sender_id, tap_date) DO UPDATE
    SET tap_count = t.tap_count + 1,
        updated_at = timezone('utc'::text, now())
  RETURNING t.tap_count - t.delivered_count INTO waiting;

  RETURN waiting;
END;
$$;

-- The partner opens Nooki: hand back what was waiting for them and mark it received, in one
-- step, so nothing can be shown twice or marked without being shown. `newly_delivered` is
-- the batch the heart is for; `tap_count` is the whole day, so the message can say
-- "again"/"more times" when part of today was already received earlier.
CREATE OR REPLACE FUNCTION public.receive_miss_you_taps(p_sender_id UUID)
RETURNS TABLE (tap_date DATE, tap_count INTEGER, newly_delivered INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  cid UUID;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Sign in to open your miss-yous.';
  END IF;

  -- Only the other half of a couple ever receives: your own taps are not a message to you,
  -- and a third account may not read a couple's taps by naming a sender.
  IF p_sender_id IS NULL OR p_sender_id = caller THEN
    RAISE EXCEPTION 'That is not your partner.';
  END IF;

  cid := public.get_user_couple_id(caller);
  IF cid IS NULL THEN
    RAISE EXCEPTION 'Pair with your partner before opening your miss-yous.';
  END IF;

  -- `due` is read before the update in the same statement, so the numbers returned are what
  -- was waiting, not what the row says afterwards.
  RETURN QUERY
  WITH due AS (
    SELECT t.id,
           t.tap_date AS day,
           t.tap_count AS total,
           t.tap_count - t.delivered_count AS waiting
    FROM public.miss_you_taps t
    WHERE t.couple_id = cid
      AND t.sender_id = p_sender_id
      AND t.tap_count > t.delivered_count
    ORDER BY t.tap_date
  ),
  received AS (
    UPDATE public.miss_you_taps t
    SET delivered_count = t.tap_count,
        delivered_at = timezone('utc'::text, now()),
        updated_at = timezone('utc'::text, now())
    FROM due
    WHERE t.id = due.id
    RETURNING t.id
  )
  SELECT due.day, due.total, due.waiting FROM due;
END;
$$;

-- Writes are the two functions' business. A project created before 2026-05-30 hands every
-- new table in public to the API roles by default, so the direct grants are taken back
-- explicitly; the app reads the couple's taps and nothing else.
REVOKE ALL ON public.miss_you_taps FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.miss_you_taps FROM authenticated;
GRANT SELECT ON public.miss_you_taps TO authenticated;

REVOKE ALL ON FUNCTION public.record_miss_you_tap(DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.receive_miss_you_taps(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_miss_you_tap(DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.receive_miss_you_taps(UUID) TO authenticated;

COMMIT;

-- ============================================================================
-- 19. Daily decisions: an undated, owner-uploaded three-choice question pool.
-- Each couple is randomly assigned one question a day that they have never
-- been given before, answers stay private until both partners reply, and a
-- decision settles only when the choices match. Mirrors
-- supabase/migrations/202610180001_daily_decision_pool.sql (which upgrades the
-- dated install from 202610170002 in place). Brand-new projects get the final
-- tables and functions here. No questions are seeded: the owner uploads pool
-- rows in Supabase.
-- ============================================================================

-- Run this migration on existing Supabase projects after
-- 202610170002_daily_decisions.sql and before deploying the updated Daily Decisions.
-- It turns the dated prompt table into an undated question pool, like Discuss:
--
--   * The owner uploads questions with no date attached (question, option_a,
--     option_b, option_c). The pool is sized for thousands of rows; the app only
--     ever asks the database for the one question a couple is on today.
--   * Each couple is randomly assigned one question they have never been given
--     before. The assignment is saved (daily_decision_assignments), so both
--     partners see the same question all day, and a question is never assigned
--     to the same couple twice.
--   * When a couple has been assigned every question in the pool, the state RPC
--     reports the pool as exhausted instead of repeating a question. Adding more
--     rows in Supabase makes the feature continue on its own the next day.
--
-- A partner can always read their own choice. The other choice remains private
-- until both partners have replied; then both see the result. A matching pair is
-- the agreed decision and is locked. If they differ, either can revise their
-- choice until they match.
--
-- Upgrading a dated install keeps its data: uploaded questions join the pool,
-- and every existing response keeps the question it was answered against (the
-- response's day becomes that couple's assignment for that question). This
-- migration deliberately inserts NO questions.
--
-- The same statements live at the end of supabase/schema.sql for brand-new projects.
BEGIN;

-- ===========================================================================
-- 1) The question pool: one row per question, no date. `id` is the stable
--    identity an assignment points at. On a dated install the column is added
--    and populated in place; the date column itself is dropped in step 3, once
--    existing responses have been given their assignments.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.daily_decision_questions (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
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

DO $pool_questions$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'daily_decision_questions' AND column_name = 'id'
  ) THEN
    ALTER TABLE public.daily_decision_questions
      ADD COLUMN id BIGINT GENERATED BY DEFAULT AS IDENTITY;
  END IF;

  -- A hand-made table could carry the column without values; fill any gaps from
  -- the identity sequence so the primary key below can be added.
  IF pg_catalog.pg_get_serial_sequence('public.daily_decision_questions', 'id') IS NOT NULL THEN
    EXECUTE 'UPDATE public.daily_decision_questions SET id = nextval('
      || quote_literal(pg_catalog.pg_get_serial_sequence('public.daily_decision_questions', 'id'))
      || ') WHERE id IS NULL';
    ALTER TABLE public.daily_decision_questions ALTER COLUMN id SET NOT NULL;
  END IF;
END
$pool_questions$;

-- Assignments point at `id`, so it must be unique-referencable even on a dated
-- install whose primary key is still the date (the key itself swaps in step 3).
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_decision_questions_id
  ON public.daily_decision_questions(id);

-- ===========================================================================
-- 2) Assignments: the one question a couple has been given for one UTC day.
--    The (couple_id, question_id) uniqueness is the "never twice" guarantee;
--    the (couple_id, decision_date) primary key is the "same question all day,
--    for both partners" guarantee. New questions are picked with a NOT EXISTS
--    against this table, which the unique index keeps cheap at pool sizes in
--    the thousands.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.daily_decision_assignments (
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  decision_date DATE NOT NULL,
  question_id BIGINT NOT NULL REFERENCES public.daily_decision_questions(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT daily_decision_assignments_one_per_day PRIMARY KEY (couple_id, decision_date),
  CONSTRAINT daily_decision_assignments_never_repeated UNIQUE (couple_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_decision_assignments_couple_date
  ON public.daily_decision_assignments(couple_id, decision_date DESC);

-- Responses keep their original shape (one choice per partner per day), but a
-- response now belongs to the day's assignment rather than to a dated prompt.
CREATE TABLE IF NOT EXISTS public.daily_decision_responses (
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  decision_date DATE NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  option_index SMALLINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT daily_decision_responses_option_check CHECK (option_index BETWEEN 1 AND 3),
  CONSTRAINT daily_decision_responses_one_per_partner PRIMARY KEY (couple_id, decision_date, user_id),
  CONSTRAINT daily_decision_responses_assignment_fk
    FOREIGN KEY (couple_id, decision_date)
    REFERENCES public.daily_decision_assignments(couple_id, decision_date) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_daily_decision_responses_couple_date
  ON public.daily_decision_responses(couple_id, decision_date);

-- ===========================================================================
-- 3) Upgrade a dated install in place. Every response a couple already made
--    becomes their assignment for the question they answered, so history and
--    the "never twice" guarantee both survive. Then the date leaves the
--    question table: from here on a question is just a pool row.
-- ===========================================================================

DO $pool_upgrade$
DECLARE
  fk RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'daily_decision_questions' AND column_name = 'decision_date'
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.daily_decision_assignments (couple_id, decision_date, question_id, assigned_at)
  SELECT r.couple_id, r.decision_date, q.id, r.created_at
    FROM public.daily_decision_responses r
    JOIN public.daily_decision_questions q ON q.decision_date = r.decision_date
  ON CONFLICT DO NOTHING;

  -- Responses pointed at the dated prompt; now they point at the assignment.
  FOR fk IN
    SELECT con.conname
      FROM pg_constraint con
     WHERE con.conrelid = 'public.daily_decision_responses'::regclass
       AND con.contype = 'f'
       AND con.confrelid = 'public.daily_decision_questions'::regclass
  LOOP
    EXECUTE format('ALTER TABLE public.daily_decision_responses DROP CONSTRAINT %I', fk.conname);
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'daily_decision_responses_assignment_fk') THEN
    ALTER TABLE public.daily_decision_responses
      ADD CONSTRAINT daily_decision_responses_assignment_fk
      FOREIGN KEY (couple_id, decision_date)
      REFERENCES public.daily_decision_assignments(couple_id, decision_date) ON DELETE CASCADE;
  END IF;

  -- The date was the primary key; the pool row's identity is `id` instead.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.daily_decision_questions'::regclass AND contype = 'p'
  ) THEN
    EXECUTE 'ALTER TABLE public.daily_decision_questions DROP CONSTRAINT '
      || (SELECT quote_ident(conname) FROM pg_constraint
          WHERE conrelid = 'public.daily_decision_questions'::regclass AND contype = 'p');
  END IF;
  ALTER TABLE public.daily_decision_questions DROP COLUMN decision_date;
  ALTER TABLE public.daily_decision_questions
    ADD CONSTRAINT daily_decision_questions_pkey PRIMARY KEY (id);
END
$pool_upgrade$;

ALTER TABLE public.daily_decision_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_decision_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_decision_responses ENABLE ROW LEVEL SECURITY;

-- The pool itself is never read by the app directly: with thousands of rows in
-- it, the only way in is the state RPC below, which hands out exactly one
-- question. (The dated install let signed-in users browse the prompt table;
-- that policy goes away with the date.)
DROP POLICY IF EXISTS "Signed-in users can read daily decision questions" ON public.daily_decision_questions;

-- An assignment carries no answer text, so both partners read their couple's
-- rows freely: this is what lets a phone confirm "same question today" without
-- touching the pool. Writes belong to the assignment function below.
DROP POLICY IF EXISTS "Couple members can view their daily decision assignments" ON public.daily_decision_assignments;
CREATE POLICY "Couple members can view their daily decision assignments" ON public.daily_decision_assignments
FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

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

-- ===========================================================================
-- 4) Picking the day's question. Returns today's assigned question id, or NULL
--    when the couple has been through the whole pool. Callers lock the couple
--    row first, so two partners opening the app at the same moment cannot be
--    handed different questions, and the same question cannot be picked twice.
--    ORDER BY random() over the unassigned remainder is one indexed NOT EXISTS
--    probe per candidate row — comfortably fast at 10,000 questions.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.ensure_daily_decision_assignment(
  p_couple_id UUID,
  p_decision_date DATE
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  picked BIGINT;
BEGIN
  SELECT question_id INTO picked
    FROM public.daily_decision_assignments
   WHERE couple_id = p_couple_id AND decision_date = p_decision_date;
  IF FOUND THEN
    RETURN picked;
  END IF;

  SELECT q.id INTO picked
    FROM public.daily_decision_questions q
   WHERE NOT EXISTS (
     SELECT 1 FROM public.daily_decision_assignments seen
      WHERE seen.couple_id = p_couple_id AND seen.question_id = q.id
   )
   ORDER BY random()
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.daily_decision_assignments (couple_id, decision_date, question_id)
  VALUES (p_couple_id, p_decision_date, picked)
  ON CONFLICT (couple_id, decision_date) DO NOTHING
  RETURNING question_id INTO picked;

  IF picked IS NULL THEN
    -- A concurrent opener won the day (the couple lock makes this a backstop,
    -- not the normal path): today's question is whichever one landed.
    SELECT question_id INTO picked
      FROM public.daily_decision_assignments
     WHERE couple_id = p_couple_id AND decision_date = p_decision_date;
  END IF;
  RETURN picked;
END;
$$;

-- ===========================================================================
-- 5) The state and submit RPCs. Same privacy contract as before — the
--    partner's choice is included only after the caller has also replied —
--    but the question now comes from today's assignment, and the state says
--    how much of the pool is left so the sheet can tell "nothing uploaded
--    yet" apart from "you have been through them all".
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.daily_decision_state()
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
  question_id BIGINT;
  prompt_row public.daily_decision_questions%ROWTYPE;
  own_choice SMALLINT;
  partner_choice SMALLINT;
  both_answered BOOLEAN;
  pool_total BIGINT;
  pool_remaining BIGINT;
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
      'agreed', FALSE,
      'exhausted', FALSE,
      'remaining', 0,
      'total', 0
    );
  END IF;

  -- Serialize the day's pick between the two partners (and against a submit).
  PERFORM 1 FROM public.couples WHERE id = cid FOR UPDATE;

  SELECT id INTO partner
    FROM public.profiles
   WHERE couple_id = cid AND id <> caller
   ORDER BY id
   LIMIT 1;

  question_id := public.ensure_daily_decision_assignment(cid, today_utc);

  SELECT count(*) INTO pool_total FROM public.daily_decision_questions;
  SELECT count(*) INTO pool_remaining
    FROM public.daily_decision_questions q
   WHERE NOT EXISTS (
     SELECT 1 FROM public.daily_decision_assignments seen
      WHERE seen.couple_id = cid AND seen.question_id = q.id
   );

  IF question_id IS NULL THEN
    RETURN jsonb_build_object(
      'today', today_utc,
      'question', NULL,
      'my_choice', NULL,
      'partner_choice', NULL,
      'partner_responded', FALSE,
      'both_answered', FALSE,
      'agreed', FALSE,
      -- Exhausted means the pool had questions and this couple has seen them
      -- all; an empty pool is the owner's cue to upload the first batch.
      'exhausted', pool_total > 0,
      'remaining', pool_remaining,
      'total', pool_total
    );
  END IF;

  SELECT * INTO prompt_row FROM public.daily_decision_questions WHERE id = question_id;

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
      'id', prompt_row.id,
      'question', btrim(prompt_row.question),
      'options', jsonb_build_array(
        btrim(prompt_row.option_a), btrim(prompt_row.option_b), btrim(prompt_row.option_c)
      )
    ),
    'my_choice', own_choice,
    'partner_choice', CASE WHEN both_answered THEN partner_choice ELSE NULL END,
    'partner_responded', partner_choice IS NOT NULL,
    'both_answered', both_answered,
    'agreed', both_answered AND own_choice = partner_choice,
    'exhausted', FALSE,
    'remaining', pool_remaining,
    'total', pool_total
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
  question_id BIGINT;
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

  -- Keep two concurrent submissions from both believing the other answer is still absent,
  -- and keep the day's pick single: the state RPC takes the same lock.
  PERFORM 1 FROM public.couples WHERE id = cid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Your couple could not be found. Please reload and try again.';
  END IF;

  question_id := public.ensure_daily_decision_assignment(cid, today_utc);
  IF question_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.daily_decision_questions) THEN
      RAISE EXCEPTION 'You have been through every daily decision for now. More are on the way.';
    END IF;
    RAISE EXCEPTION 'No daily decisions have been added yet.';
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

-- ===========================================================================
-- 6) Privileges. The pool and the assignments are written only by the
--    functions above (and by the owner importing questions in Supabase);
--    phones read their couple's assignments and revealed responses, and reach
--    everything else through the two RPCs.
-- ===========================================================================

REVOKE ALL ON public.daily_decision_questions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.daily_decision_assignments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.daily_decision_responses FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.daily_decision_assignments TO authenticated;
GRANT SELECT ON public.daily_decision_responses TO authenticated;

REVOKE ALL ON FUNCTION public.can_read_daily_decision_response(UUID, DATE, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ensure_daily_decision_assignment(UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_decision_state() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_daily_decision_choice(SMALLINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_read_daily_decision_response(UUID, DATE, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.daily_decision_state() TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_daily_decision_choice(SMALLINT) TO authenticated;
-- ensure_daily_decision_assignment stays private: it takes any couple id, so
-- only the state/submit functions (which derive the couple from the caller)
-- may use it.

-- Re-read through RLS after a partner's reply. The event is only a nudge; the state RPC is
-- the sole source of revealed answer content.
ALTER TABLE public.daily_decision_responses REPLICA IDENTITY FULL;
ALTER TABLE public.daily_decision_assignments REPLICA IDENTITY FULL;
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
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'daily_decision_assignments'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.daily_decision_assignments;
  END IF;
END
$realtime$;

-- ===========================================================================
-- Couple picture frame: one private photo per couple, standing in the nook
--
-- The Home tab's nook holds a gift-wrapped frame with the couple's own favourite
-- picture of themselves (a higher form of personalisation than any drawn avatar:
-- opening the app shows the two of you). Exactly one row per couple — the couple
-- IS the key — and either partner may replace the picture; the row's couple never
-- moves. The file itself lives in the private `couple-photos` bucket under
-- photos/{couple_id}/{photo_id}.jpg (the folder name IS the couple id, which is
-- what the storage policies check) and is opened only through short-lived signed
-- URLs. Realtime on the table means a picture framed on one phone appears on the
-- other without a refresh.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.couple_photo (
  couple_id UUID PRIMARY KEY REFERENCES public.couples(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT couple_photo_file_path_length CHECK (char_length(btrim(file_path)) BETWEEN 1 AND 500),
  CONSTRAINT couple_photo_file_path_prefix CHECK (left(btrim(file_path), 7) = 'photos/')
);

ALTER TABLE public.couple_photo ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Couple members can see their framed picture" ON public.couple_photo;
CREATE POLICY "Couple members can see their framed picture" ON public.couple_photo
FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

DROP POLICY IF EXISTS "Couple members can frame a picture" ON public.couple_photo;
CREATE POLICY "Couple members can frame a picture" ON public.couple_photo
FOR INSERT TO authenticated
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid())
  AND uploaded_by = auth.uid()
);

DROP POLICY IF EXISTS "Couple members can replace their framed picture" ON public.couple_photo;
CREATE POLICY "Couple members can replace their framed picture" ON public.couple_photo
FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()))
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid())
  AND uploaded_by = auth.uid()
);

DROP POLICY IF EXISTS "Couple members can take their picture down" ON public.couple_photo;
CREATE POLICY "Couple members can take their picture down" ON public.couple_photo
FOR DELETE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

CREATE OR REPLACE FUNCTION public.guard_couple_photo()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF NEW.couple_id <> OLD.couple_id THEN
    RAISE EXCEPTION 'A framed picture belongs to one couple. Replace the file, not the couple.';
  END IF;
  NEW.updated_at := timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS couple_photo_guard ON public.couple_photo;
CREATE TRIGGER couple_photo_guard
BEFORE UPDATE ON public.couple_photo
FOR EACH ROW EXECUTE FUNCTION public.guard_couple_photo();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.couple_photo TO authenticated;
REVOKE ALL ON public.couple_photo FROM anon;

ALTER TABLE public.couple_photo REPLICA IDENTITY FULL;
DO $realtime$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'couple_photo'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.couple_photo;
  END IF;
END
$realtime$;

-- The private bucket for the picture files themselves. Guarded so a bare database
-- (and the test backend, which has no storage schema) simply skips this block.
DO $photo_storage$
DECLARE
  has_size_limit BOOLEAN;
  has_mime_types BOOLEAN;
BEGIN
  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO storage.buckets (id, name, public)
  VALUES ('couple-photos', 'couple-photos', false)
  ON CONFLICT (id) DO UPDATE SET public = false;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit'
  ) INTO has_size_limit;
  IF has_size_limit THEN
    EXECUTE 'UPDATE storage.buckets SET file_size_limit = 10485760 WHERE id = ''couple-photos''';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'allowed_mime_types'
  ) INTO has_mime_types;
  IF has_mime_types THEN
    EXECUTE $sql$UPDATE storage.buckets
      SET allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
      WHERE id = 'couple-photos'$sql$;
  END IF;

  EXECUTE 'DROP POLICY IF EXISTS "Couple members can read their picture files" ON storage.objects';
  EXECUTE $sql$CREATE POLICY "Couple members can read their picture files" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'couple-photos'
    AND (storage.foldername(name))[1] = 'photos'
    AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text
  )$sql$;

  EXECUTE 'DROP POLICY IF EXISTS "Couple members can upload their picture files" ON storage.objects';
  EXECUTE $sql$CREATE POLICY "Couple members can upload their picture files" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'couple-photos'
    AND (storage.foldername(name))[1] = 'photos'
    AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text
  )$sql$;

  EXECUTE 'DROP POLICY IF EXISTS "Couple members can delete their picture files" ON storage.objects';
  EXECUTE $sql$CREATE POLICY "Couple members can delete their picture files" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'couple-photos'
    AND (storage.foldername(name))[1] = 'photos'
    AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text
  )$sql$;
END
$photo_storage$;

COMMIT;


-- ============================================================================
-- 21. Retire daily Games and Tic Tac Toe
-- Mirrors supabase/migrations/202610180002_remove_daily_games_and_tic_tac_toe.sql.
-- ============================================================================

-- Retire the daily Games challenge and Tic Tac Toe. Daily Decisions remain the one
-- daily Home activity; the Games tab contains only always-available rematches.
--
-- Existing daily-game and Tic Tac Toe rows are intentionally removed rather than kept as
-- inaccessible history. Their board/date columns and the old three-argument start RPC go
-- with them, so a client cannot accidentally revive either feature.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.game_matches') IS NULL THEN
    RAISE EXCEPTION 'Apply the Games migrations before 202610180002_remove_daily_games_and_tic_tac_toe.sql.';
  END IF;
END $$;

-- A daily match was meaningful only for the retired challenge. Its results, plus every
-- Tic Tac Toe board, leave with the feature so the shared win tally reflects current games.
-- The column is absent after the first run, so keep the cleanup rerunnable.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'game_matches' AND column_name = 'daily_date'
  ) THEN
    DELETE FROM public.game_matches WHERE game = 'tic-tac-toe' OR daily_date IS NOT NULL;
  ELSE
    DELETE FROM public.game_matches WHERE game = 'tic-tac-toe';
  END IF;
END $$;

-- The two indexes use daily_date as a predicate, so replace them before removing the
-- column. Dropping daily_date also removes its one-daily-match unique constraint.
DROP INDEX IF EXISTS public.game_one_practice;
DROP INDEX IF EXISTS public.game_one_practice_tetris;
ALTER TABLE public.game_matches DROP COLUMN IF EXISTS daily_date CASCADE;
ALTER TABLE public.game_matches DROP COLUMN IF EXISTS board;

ALTER TABLE public.game_matches DROP CONSTRAINT IF EXISTS game_matches_game_check;
ALTER TABLE public.game_matches ADD CONSTRAINT game_matches_game_check
  CHECK (game IN ('rock-paper-scissors', 'snake', 'chess', 'tetris'));

CREATE UNIQUE INDEX game_one_practice ON public.game_matches(couple_id, game)
  WHERE NOT finished AND game <> 'tetris';
CREATE UNIQUE INDEX game_one_practice_tetris ON public.game_matches(couple_id, game, tetris_mode)
  WHERE NOT finished AND game = 'tetris';

-- The former entry point accepted a daily flag. Replace it, instead of leaving an ignored
-- argument behind, so the database API makes the product decision enforceable.
DROP FUNCTION IF EXISTS public.start_game(text, boolean, integer);
CREATE OR REPLACE FUNCTION public.start_game(p_game text, p_best_of integer DEFAULT 3)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); partner uuid; mid uuid;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM 1 FROM public.couples WHERE id = cid FOR UPDATE;
  SELECT id INTO partner FROM public.profiles WHERE couple_id = cid AND id <> auth.uid();
  IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;
  IF p_game IS NULL OR p_game NOT IN ('rock-paper-scissors', 'snake')
     OR p_best_of IS NULL OR p_best_of NOT IN (3, 5) THEN
    RAISE EXCEPTION 'Invalid game settings.';
  END IF;
  SELECT id INTO mid FROM public.game_matches
   WHERE couple_id = cid AND game = p_game AND NOT finished;
  IF mid IS NOT NULL THEN RETURN mid; END IF;
  INSERT INTO public.game_matches(couple_id, game, player_x, player_o, turn_id, best_of)
  VALUES (cid, p_game, auth.uid(), partner, auth.uid(), p_best_of)
  RETURNING id INTO mid;
  RETURN mid;
END $$;

-- Rock Paper Scissors is the one game that still uses the generic move endpoint. Chess,
-- Snake and Tetris each keep their dedicated authoritative referee.
CREATE OR REPLACE FUNCTION public.play_game(p_id uuid, p_round integer, p_move text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m public.game_matches; victor uuid;
BEGIN
  SELECT * INTO m FROM public.game_matches
   WHERE id = p_id AND couple_id = public.get_user_couple_id(auth.uid()) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.'; END IF;
  IF m.finished THEN RAISE EXCEPTION 'This match is finished.'; END IF;
  IF m.game <> 'rock-paper-scissors' THEN RAISE EXCEPTION 'That game uses a dedicated referee.'; END IF;
  IF p_round IS DISTINCT FROM m.round THEN RAISE EXCEPTION 'The game changed. Try again.'; END IF;
  IF p_move IS NULL OR p_move NOT IN ('rock', 'paper', 'scissors') THEN
    RAISE EXCEPTION 'Choose rock, paper or scissors.';
  END IF;
  IF auth.uid() = m.player_x THEN
    IF m.pick_x IS NOT NULL THEN RAISE EXCEPTION 'Your pick is already locked.'; END IF;
    m.pick_x := p_move;
  ELSE
    IF m.pick_o IS NOT NULL THEN RAISE EXCEPTION 'Your pick is already locked.'; END IF;
    m.pick_o := p_move;
  END IF;
  IF m.pick_x IS NOT NULL AND m.pick_o IS NOT NULL THEN
    IF m.pick_x <> m.pick_o THEN
      IF (m.pick_x = 'rock' AND m.pick_o = 'scissors')
         OR (m.pick_x = 'paper' AND m.pick_o = 'rock')
         OR (m.pick_x = 'scissors' AND m.pick_o = 'paper') THEN
        m.score_x := m.score_x + 1; victor := m.player_x;
      ELSE
        m.score_o := m.score_o + 1; victor := m.player_o;
      END IF;
    END IF;
    m.rounds := m.rounds || jsonb_build_array(jsonb_build_object(
      'round', m.round, 'x', m.pick_x, 'o', m.pick_o, 'winner', victor));
    IF greatest(m.score_x, m.score_o) > m.best_of / 2 THEN
      m.finished := true; m.winner_id := victor;
    END IF;
    m.pick_x := NULL; m.pick_o := NULL; m.round := m.round + 1;
  END IF;
  UPDATE public.game_matches SET
    turn_id = m.turn_id, round = m.round, pick_x = m.pick_x, pick_o = m.pick_o,
    score_x = m.score_x, score_o = m.score_o, rounds = m.rounds,
    finished = m.finished, winner_id = m.winner_id
  WHERE id = m.id;
END $$;

-- Keep the library snapshot free of retired fields and records. Finished games remain
-- available through the recent-history window; open matches are always available.
CREATE OR REPLACE FUNCTION public.games_state() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); result jsonb;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM public.snake_sweep(cid);
  PERFORM public.tetris_sweep(cid);
  SELECT jsonb_build_object(
    'wins', (SELECT coalesce(jsonb_object_agg(winner_id, n), '{}'::jsonb) FROM
      (SELECT winner_id, count(*) n FROM public.game_matches
       WHERE couple_id = cid AND finished AND winner_id IS NOT NULL GROUP BY winner_id) w),
    'matches', coalesce((SELECT jsonb_agg(safe ORDER BY created_at DESC) FROM (
      SELECT created_at,
        (to_jsonb(m) - 'pick_x' - 'pick_o' - 'snake' - 'chess' - 'tetris') || jsonb_build_object(
          'my_pick', CASE WHEN auth.uid() = player_x THEN pick_x ELSE pick_o END,
          'partner_locked', CASE WHEN auth.uid() = player_x THEN pick_o IS NOT NULL ELSE pick_x IS NOT NULL END,
          'snake', CASE WHEN m.game = 'snake' THEN public.snake_view(m.snake, auth.uid(), m.finished, m.player_x, m.player_o) END,
          'chess', CASE WHEN m.game = 'chess' THEN public.chess_view(m.chess) END,
          'tetris', CASE WHEN m.game = 'tetris' THEN public.tetris_view(m.tetris, auth.uid(), m.finished, m.player_x, m.player_o, m.tetris_mode) END
        ) safe
      FROM public.game_matches m
      WHERE couple_id = cid AND (NOT finished OR id IN (
        SELECT id FROM public.game_matches WHERE couple_id = cid ORDER BY created_at DESC LIMIT 30
      ))
    ) recent), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END $$;

-- Chess and Tetris are dedicated starts, but both previously filtered on daily_date.
CREATE OR REPLACE FUNCTION public.start_chess(p_mode text DEFAULT 'classic') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); partner uuid; mid uuid;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('classic', 'capture-race', 'queen-hunt') THEN
    RAISE EXCEPTION 'Choose a chess duel: classic, capture-race or queen-hunt.';
  END IF;
  PERFORM 1 FROM public.couples WHERE id = cid FOR UPDATE;
  SELECT id INTO partner FROM public.profiles WHERE couple_id = cid AND id <> auth.uid();
  IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;
  SELECT id INTO mid FROM public.game_matches
   WHERE couple_id = cid AND game = 'chess' AND NOT finished;
  IF mid IS NOT NULL THEN RETURN mid; END IF;
  INSERT INTO public.game_matches(couple_id, game, player_x, player_o, turn_id, best_of, chess)
  VALUES (cid, 'chess', auth.uid(), partner, auth.uid(), 3, public.chess_state_json(p_mode))
  RETURNING id INTO mid;
  RETURN mid;
END $$;

CREATE OR REPLACE FUNCTION public.start_tetris(p_mode text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); partner uuid; mid uuid;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('sprint', 'survival') THEN RAISE EXCEPTION 'Invalid game settings.'; END IF;
  PERFORM 1 FROM public.couples WHERE id = cid FOR UPDATE;
  SELECT id INTO partner FROM public.profiles WHERE couple_id = cid AND id <> auth.uid();
  IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;
  SELECT id INTO mid FROM public.game_matches
   WHERE couple_id = cid AND game = 'tetris' AND NOT finished AND tetris_mode = p_mode;
  IF mid IS NOT NULL THEN RETURN mid; END IF;
  INSERT INTO public.game_matches(couple_id, game, player_x, player_o, turn_id, best_of, tetris_mode)
  VALUES (cid, 'tetris', auth.uid(), partner, auth.uid(), 3, p_mode)
  RETURNING id INTO mid;
  RETURN mid;
END $$;

REVOKE ALL ON FUNCTION public.start_game(text, integer), public.play_game(uuid, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_game(text, integer), public.play_game(uuid, integer, text)
  TO authenticated;

COMMIT;

-- ---------------------------------------------------------------------------
-- Mirrors supabase/migrations/202610180004_duel_report_retries.sql.
--
-- A run report whose answer the wire dropped is retried, and a retry can overlap the
-- next progress report — handing over taps the server has already logged. The referees
-- used to refuse the whole report for that, so a finished run could never be marked
-- done: the duel never settled and sat in the couple's ongoing games after both
-- partners had played. A tap already in the log is now skipped on arrival; a tap at a
-- tick already passed that is not in the log is still refused.
-- ---------------------------------------------------------------------------

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.game_matches') IS NULL THEN
    RAISE EXCEPTION 'Apply the Games migrations before 202610180004_duel_report_retries.sql.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.snake_commit(p_id uuid, p_ticks integer, p_dirs jsonb, p_final boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  m public.game_matches;
  state jsonb; entry jsonb; changes jsonb; result jsonb;
  last_tick integer := -1; change jsonb; change_tick integer; change_dir text;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  -- A phone that went quiet for longer than the grace has already lost its run: settle that
  -- before reading anything, so a report that arrives late cannot revive it.
  PERFORM public.snake_sweep(cid);
  SELECT * INTO m FROM public.game_matches WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.'; END IF;
  IF m.game <> 'snake' THEN RAISE EXCEPTION 'That is not a snake duel.'; END IF;
  state := coalesce(m.snake, '{}'::jsonb);
  entry := state -> uid::text;
  IF entry IS NULL THEN RAISE EXCEPTION 'Start your run first.'; END IF;
  -- Someone else (or the sweep) already settled this run; report it instead of arguing.
  IF entry->>'status' <> 'running' THEN RETURN entry; END IF;
  IF m.finished THEN RETURN entry || jsonb_build_object('match_finished', true); END IF;
  IF p_ticks IS NULL OR p_ticks < 0 OR p_dirs IS NULL OR jsonb_typeof(p_dirs) <> 'array' THEN
    RAISE EXCEPTION 'That run report cannot be read.';
  END IF;
  IF p_ticks < coalesce((entry->>'ticks')::integer, 0) THEN RAISE EXCEPTION 'That run report is older than the last one.'; END IF;
  IF p_ticks > public.snake_budget((entry->>'started_at')::timestamptz) THEN RAISE EXCEPTION 'That run is moving faster than real time.'; END IF;
  changes := coalesce(entry->'dirs', '[]'::jsonb);
  IF jsonb_array_length(changes) > 0 THEN last_tick := (changes->-1->>0)::integer; END IF;
  FOR change IN SELECT value FROM jsonb_array_elements(p_dirs) LOOP
    IF jsonb_typeof(change) <> 'array' OR jsonb_array_length(change) <> 2
       OR (change->>0) !~ '^[0-9]{1,4}$' OR (change->>1) NOT IN ('up','down','left','right') THEN
      RAISE EXCEPTION 'That run report cannot be read.';
    END IF;
    change_tick := (change->>0)::integer;
    change_dir := change->>1;
    -- A report whose answer the wire dropped comes again, and the retry can overlap the
    -- next report: a turn already in the log is skipped, not argued with — the log is the
    -- run, and a resend leaves it exactly as it was. (A phone retrying a finish used to
    -- be refused outright here for turns it had already handed over, and a refused finish
    -- is a duel that never settles: it sat in the couple's ongoing games until the grace
    -- window erased the run it could not read.)
    IF change_tick <= last_tick
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(changes) logged
                    WHERE (logged->>0)::integer = change_tick AND logged->>1 = change_dir) THEN
      CONTINUE;
    END IF;
    IF change_tick <= last_tick OR change_tick >= p_ticks THEN RAISE EXCEPTION 'That run report is out of order.'; END IF;
    changes := changes || jsonb_build_array(jsonb_build_array(change_tick, change_dir));
    last_tick := change_tick;
  END LOOP;
  entry := entry || jsonb_build_object('ticks', p_ticks, 'dirs', changes, 'last_seen', now());
  IF p_final OR p_ticks >= public.snake_max_ticks() THEN
    result := public.snake_replay(entry->'foods', changes, p_ticks);
    entry := entry || jsonb_build_object('status','done',
      'score',coalesce((result->>'score')::integer, 0),
      'ended',coalesce(result->>'ended','alive'),
      'ticks',coalesce((result->>'ticks')::integer, p_ticks),'finished_at',now());
  END IF;
  UPDATE public.game_matches SET snake = state || jsonb_build_object(uid::text, entry) WHERE id = m.id;
  IF p_final OR p_ticks >= public.snake_max_ticks() THEN PERFORM public.snake_settle(m.id); END IF;
  RETURN entry;
END $$;

CREATE OR REPLACE FUNCTION public.tetris_commit(p_id uuid, p_ticks integer, p_inputs jsonb, p_final boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  m public.game_matches;
  state jsonb; entry jsonb; inputs jsonb; incoming jsonb; result jsonb;
  last_tick integer := -1; change jsonb; change_tick integer; change_act text;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  -- A phone that went quiet for longer than the grace has already lost its run: settle that
  -- before reading anything, so a report that arrives late cannot revive it.
  PERFORM public.tetris_sweep(cid);
  SELECT * INTO m FROM public.game_matches WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.'; END IF;
  IF m.game <> 'tetris' THEN RAISE EXCEPTION 'That is not a Tetris duel.'; END IF;
  state := coalesce(m.tetris, '{}'::jsonb);
  entry := state -> uid::text;
  IF entry IS NULL THEN RAISE EXCEPTION 'Start your run first.'; END IF;
  -- Someone else (or the sweep) already settled this run; report it instead of arguing.
  IF entry->>'status' <> 'running' THEN RETURN entry; END IF;
  IF m.finished THEN RETURN entry || jsonb_build_object('match_finished', true); END IF;
  IF p_ticks IS NULL OR p_ticks < 0 OR p_inputs IS NULL OR jsonb_typeof(p_inputs) <> 'array' THEN
    RAISE EXCEPTION 'That run report cannot be read.';
  END IF;
  IF p_ticks < coalesce((entry->>'ticks')::integer, 0) THEN RAISE EXCEPTION 'That run report is older than the last one.'; END IF;
  IF p_ticks > public.tetris_budget((entry->>'started_at')::timestamptz) THEN RAISE EXCEPTION 'That run is moving faster than real time.'; END IF;
  inputs := coalesce(entry->'inputs', '[]'::jsonb);
  IF jsonb_array_length(inputs) > 0 THEN last_tick := (inputs->-1->>0)::integer; END IF;
  incoming := '[]'::jsonb;
  FOR change IN SELECT value FROM jsonb_array_elements(p_inputs) LOOP
    IF jsonb_typeof(change) <> 'array' OR jsonb_array_length(change) <> 2
       OR (change->>0) !~ '^[0-9]{1,4}$' OR (change->>1) NOT IN ('left','right','rotate','down','drop') THEN
      RAISE EXCEPTION 'That run report cannot be read.';
    END IF;
    change_tick := (change->>0)::integer;
    change_act := change->>1;
    -- A report whose answer the wire dropped comes again, and the retry can overlap the
    -- next report: a tap already in the log is skipped, not argued with — the log is the
    -- run, and a resend leaves it exactly as it was. (A phone retrying a finish used to
    -- be refused outright here for taps it had already handed over, and a refused finish
    -- is a duel that never settles: it sat in the couple's ongoing games until the grace
    -- window erased the run it could not read.)
    IF change_tick <= last_tick
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(inputs) logged
                    WHERE (logged->>0)::integer = change_tick AND logged->>1 = change_act) THEN
      CONTINUE;
    END IF;
    -- Taps arrive in the order they were made, never before the last one already on file,
    -- and never for a tick the run has not reached yet.
    IF change_tick < last_tick OR change_tick >= p_ticks THEN RAISE EXCEPTION 'That run report is out of order.'; END IF;
    incoming := incoming || jsonb_build_array(jsonb_build_array(change_tick, change_act));
    last_tick := change_tick;
  END LOOP;
  inputs := inputs || incoming;
  entry := entry || jsonb_build_object('ticks', p_ticks, 'inputs', inputs, 'last_seen', now());
  IF p_final OR p_ticks >= public.tetris_max_ticks() THEN
    result := public.tetris_replay(entry->'pieces', inputs, p_ticks);
    entry := entry || jsonb_build_object('status','done',
      'score',coalesce((result->>'score')::integer, 0),
      'lines',coalesce((result->>'lines')::integer, 0),
      'ended',coalesce(result->>'ended','alive'),
      'ticks',coalesce((result->>'ticks')::integer, p_ticks),'finished_at',now());
  END IF;
  UPDATE public.game_matches SET tetris = state || jsonb_build_object(uid::text, entry) WHERE id = m.id;
  IF p_final OR p_ticks >= public.tetris_max_ticks() THEN PERFORM public.tetris_settle(m.id); END IF;
  RETURN entry;
END $$;

-- Replacing a function leaves its privileges as they were: 013 already revoked these
-- two from every phone and granted only the wrappers (snake_beat/finish, tetris_beat/
-- finish), and CREATE OR REPLACE keeps that in place. Nothing else changes.

COMMIT;
-- Private, current-only snapshots. No mood history and no push notifications.
BEGIN;
CREATE TABLE IF NOT EXISTS public.everyday_status (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  couple_id uuid NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  mood text CHECK (mood IN ('Happy','Calm','Tired','Stressed','Sad','Missing you')),
  activity text CHECK (activity IN ('Working','Studying','Resting','Out and about','Free to talk')),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 120),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  CHECK (mood IS NOT NULL OR activity IS NOT NULL OR btrim(note) <> '')
);
ALTER TABLE public.everyday_status ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS everyday_status_read ON public.everyday_status;
CREATE POLICY everyday_status_read ON public.everyday_status FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()) AND expires_at > now());
REVOKE ALL ON public.everyday_status FROM anon, authenticated;
GRANT SELECT ON public.everyday_status TO authenticated;

CREATE OR REPLACE FUNCTION public.save_everyday_status(p_mood text, p_activity text, p_note text, p_hours integer DEFAULT 12)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid;
BEGIN
  cid := public.get_user_couple_id(auth.uid());
  IF auth.uid() IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner first.'; END IF;
  IF p_hours IS NULL OR p_hours NOT IN (1,4,12) THEN RAISE EXCEPTION 'Choose 1, 4 or 12 hours.'; END IF;
  INSERT INTO public.everyday_status(user_id,couple_id,mood,activity,note,updated_at,expires_at)
  VALUES(auth.uid(),cid,p_mood,p_activity,btrim(coalesce(p_note,'')),clock_timestamp(),now()+make_interval(hours => p_hours))
  ON CONFLICT(user_id) DO UPDATE SET couple_id=excluded.couple_id,mood=excluded.mood,
    activity=excluded.activity,note=excluded.note,updated_at=excluded.updated_at,
    expires_at=excluded.expires_at,acknowledged_at=NULL;
END; $$;
CREATE OR REPLACE FUNCTION public.clear_everyday_status()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM public.everyday_status WHERE user_id=auth.uid();
$$;
CREATE OR REPLACE FUNCTION public.acknowledge_everyday_status(p_user_id uuid, p_updated_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.everyday_status SET acknowledged_at=now()
  WHERE user_id=p_user_id AND user_id<>auth.uid()
    AND couple_id=public.get_user_couple_id(auth.uid())
    AND updated_at=p_updated_at AND expires_at>now() AND acknowledged_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'This update has changed or is no longer available.'; END IF;
END; $$;
REVOKE ALL ON FUNCTION public.save_everyday_status(text,text,text,integer), public.clear_everyday_status(), public.acknowledge_everyday_status(uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_everyday_status(text,text,text,integer), public.clear_everyday_status(), public.acknowledge_everyday_status(uuid,timestamptz) TO authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') AND NOT EXISTS
    (SELECT 1 FROM pg_publication_tables WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='everyday_status') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.everyday_status;
  END IF;
END $$;
COMMIT;
-- Connect Four: turns and outcomes are validated under a row lock in Postgres.
BEGIN;
ALTER TABLE public.game_matches DROP CONSTRAINT IF EXISTS game_matches_game_check;
ALTER TABLE public.game_matches ADD CONSTRAINT game_matches_game_check
  CHECK (game IN ('rock-paper-scissors','snake','chess','tetris','connect-four'));
ALTER TABLE public.game_matches ADD COLUMN IF NOT EXISTS board text[] NOT NULL DEFAULT array_fill(''::text, ARRAY[42]);

CREATE OR REPLACE FUNCTION public.start_connect_four() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); partner uuid; mid uuid;
BEGIN
 IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
 PERFORM 1 FROM public.couples WHERE id=cid FOR UPDATE;
 SELECT id INTO partner FROM public.profiles WHERE couple_id=cid AND id<>auth.uid();
 IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;
 SELECT id INTO mid FROM public.game_matches WHERE couple_id=cid AND game='connect-four' AND NOT finished;
 IF mid IS NOT NULL THEN RETURN mid; END IF;
 INSERT INTO public.game_matches(couple_id,game,player_x,player_o,turn_id,best_of,board)
 VALUES(cid,'connect-four',auth.uid(),partner,auth.uid(),3,array_fill(''::text,ARRAY[42])) RETURNING id INTO mid;
 RETURN mid;
END $$;

CREATE OR REPLACE FUNCTION public.connect_four_move(p_id uuid, p_round integer, p_column integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m public.game_matches; row_n integer; idx integer; mark text; r integer; c integer; dr integer; dc integer; dir integer; count_n integer; won boolean := false;
BEGIN
 SELECT * INTO m FROM public.game_matches WHERE id=p_id AND couple_id=public.get_user_couple_id(auth.uid()) FOR UPDATE;
 IF NOT FOUND OR m.game<>'connect-four' THEN RAISE EXCEPTION 'Game not found.'; END IF;
 IF m.finished THEN RAISE EXCEPTION 'This match is finished.'; END IF;
 IF p_round IS DISTINCT FROM m.round THEN RAISE EXCEPTION 'The game changed. Try again.'; END IF;
 IF m.turn_id<>auth.uid() THEN RAISE EXCEPTION 'It is your partner''s turn.'; END IF;
 IF p_column IS NULL OR p_column NOT BETWEEN 0 AND 6 THEN RAISE EXCEPTION 'Choose a column.'; END IF;
 FOR row_n IN REVERSE 5..0 LOOP
   idx:=row_n*7+p_column+1;
   IF m.board[idx]='' THEN EXIT; END IF;
   idx:=NULL;
 END LOOP;
 IF idx IS NULL OR m.board[idx]<>'' THEN RAISE EXCEPTION 'That column is full.'; END IF;
 mark:=CASE WHEN auth.uid()=m.player_x THEN 'X' ELSE 'O' END;
 m.board[idx]:=mark;
 FOR r IN 0..5 LOOP FOR c IN 0..6 LOOP
   IF m.board[r*7+c+1]<>mark THEN CONTINUE; END IF;
   FOR dir IN 1..4 LOOP
     dr:=CASE dir WHEN 1 THEN 0 WHEN 2 THEN 1 ELSE 1 END;
     dc:=CASE dir WHEN 1 THEN 1 WHEN 2 THEN 0 WHEN 3 THEN 1 ELSE -1 END;
     count_n:=0;
     FOR row_n IN 0..3 LOOP
       IF r+dr*row_n BETWEEN 0 AND 5 AND c+dc*row_n BETWEEN 0 AND 6 AND m.board[(r+dr*row_n)*7+c+dc*row_n+1]=mark THEN count_n:=count_n+1; END IF;
     END LOOP;
     IF count_n=4 THEN won:=true; END IF;
   END LOOP;
 END LOOP; END LOOP;
 m.finished:=won OR NOT (''=ANY(m.board));
 m.winner_id:=CASE WHEN won THEN auth.uid() ELSE NULL END;
 m.turn_id:=CASE WHEN auth.uid()=m.player_x THEN m.player_o ELSE m.player_x END;
 m.round:=m.round+1;
 UPDATE public.game_matches SET board=m.board,turn_id=m.turn_id,round=m.round,finished=m.finished,winner_id=m.winner_id WHERE id=m.id;
END $$;
REVOKE ALL ON FUNCTION public.start_connect_four(), public.connect_four_move(uuid,integer,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_connect_four(), public.connect_four_move(uuid,integer,integer) TO authenticated;
COMMIT;
-- Together tab: planned visits and the shared someday list.
-- The same statements live in 202610180007_together_visits_and_someday_list.sql
-- and 202610180008_someday_details_order_and_visit_link.sql for existing projects.
BEGIN;
CREATE TABLE IF NOT EXISTS public.visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE,
  location TEXT,
  timezone TEXT DEFAULT 'UTC',
  is_tentative BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT valid_dates CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_visits_couple_id ON public.visits(couple_id);
CREATE INDEX IF NOT EXISTS idx_visits_start_date ON public.visits(start_date);
ALTER TABLE public.visits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS visits_read ON public.visits;
CREATE POLICY visits_read ON public.visits FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));
DROP POLICY IF EXISTS visits_insert ON public.visits;
CREATE POLICY visits_insert ON public.visits FOR INSERT TO authenticated
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()));
DROP POLICY IF EXISTS visits_update ON public.visits;
CREATE POLICY visits_update ON public.visits FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()))
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()));
DROP POLICY IF EXISTS visits_delete ON public.visits;
CREATE POLICY visits_delete ON public.visits FOR DELETE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));
REVOKE ALL ON public.visits FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.visits TO authenticated;

CREATE TABLE IF NOT EXISTS public.someday_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (char_length(text) > 0 AND char_length(text) <= 500),
  details TEXT,
  sort_order DOUBLE PRECISION NOT NULL DEFAULT 0,
  visit_id UUID REFERENCES public.visits(id) ON DELETE SET NULL,
  completed BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT completed_at_check CHECK (
    (completed = false AND completed_at IS NULL) OR
    (completed = true AND completed_at IS NOT NULL)
  ),
  CONSTRAINT someday_details_length_check CHECK (details IS NULL OR char_length(details) <= 1000)
);
CREATE INDEX IF NOT EXISTS idx_someday_items_couple_id ON public.someday_items(couple_id);
CREATE INDEX IF NOT EXISTS idx_someday_items_completed ON public.someday_items(completed);
CREATE INDEX IF NOT EXISTS idx_someday_items_created_at ON public.someday_items(created_at);
CREATE INDEX IF NOT EXISTS idx_someday_items_order ON public.someday_items(couple_id, sort_order, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_someday_items_visit_id ON public.someday_items(visit_id) WHERE visit_id IS NOT NULL;
ALTER TABLE public.someday_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS someday_items_read ON public.someday_items;
CREATE POLICY someday_items_read ON public.someday_items FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));
DROP POLICY IF EXISTS someday_items_insert ON public.someday_items;
CREATE POLICY someday_items_insert ON public.someday_items FOR INSERT TO authenticated
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()));
DROP POLICY IF EXISTS someday_items_update ON public.someday_items;
CREATE POLICY someday_items_update ON public.someday_items FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()))
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()));
DROP POLICY IF EXISTS someday_items_delete ON public.someday_items;
CREATE POLICY someday_items_delete ON public.someday_items FOR DELETE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));
REVOKE ALL ON public.someday_items FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.someday_items TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_someday_item_visit()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF NEW.visit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.visits
    WHERE id = NEW.visit_id AND couple_id = NEW.couple_id
  ) THEN
    RAISE EXCEPTION 'That visit is not part of your plans.';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_someday_item_visit ON public.someday_items;
CREATE TRIGGER guard_someday_item_visit
BEFORE INSERT OR UPDATE OF visit_id, couple_id ON public.someday_items
FOR EACH ROW EXECUTE FUNCTION public.guard_someday_item_visit();

CREATE OR REPLACE FUNCTION public.reorder_someday_items(p_ids UUID[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  cid UUID := public.get_user_couple_id(auth.uid());
  distinct_count INTEGER;
  owned_count INTEGER;
BEGIN
  IF cid IS NULL THEN
    RAISE EXCEPTION 'Pair with your partner first.';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN;
  END IF;
  SELECT count(DISTINCT id) INTO distinct_count FROM unnest(p_ids) AS id;
  IF distinct_count <> cardinality(p_ids) THEN
    RAISE EXCEPTION 'A list item can only appear once.';
  END IF;
  SELECT count(*) INTO owned_count
  FROM public.someday_items
  WHERE couple_id = cid AND id = ANY(p_ids);
  IF owned_count <> cardinality(p_ids) THEN
    RAISE EXCEPTION 'That someday list is not yours.';
  END IF;
  UPDATE public.someday_items AS item
  SET sort_order = ordered.position - 1,
      updated_at = now()
  FROM unnest(p_ids) WITH ORDINALITY AS ordered(id, position)
  WHERE item.id = ordered.id AND item.couple_id = cid;
END;
$$;
REVOKE ALL ON FUNCTION public.reorder_someday_items(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reorder_someday_items(UUID[]) TO authenticated;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'visits'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.visits;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'someday_items'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.someday_items;
    END IF;
  END IF;
END $$;
COMMIT;
-- Dash Duel: same-course runs for a couple, with an asynchronous challenge mode,
-- a ready-gated live-together mode and a local-only free run in the client.
-- The database deals the ranked course and replays every submitted action: distance,
-- hearts and the winner are never accepted from a phone.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.game_matches') IS NULL THEN
    RAISE EXCEPTION 'Apply the Games migrations before 202610180009_dash_duel.sql.';
  END IF;
END $$;

ALTER TABLE public.game_matches DROP CONSTRAINT IF EXISTS game_matches_game_check;
ALTER TABLE public.game_matches ADD CONSTRAINT game_matches_game_check
  CHECK (game IN ('rock-paper-scissors','snake','chess','tetris','connect-four','dash-duel'));
ALTER TABLE public.game_matches ADD COLUMN IF NOT EXISTS dash jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.game_matches ADD COLUMN IF NOT EXISTS dash_mode text;
ALTER TABLE public.game_matches ADD COLUMN IF NOT EXISTS dash_level text;
ALTER TABLE public.game_matches DROP CONSTRAINT IF EXISTS game_matches_dash_mode_check;
ALTER TABLE public.game_matches ADD CONSTRAINT game_matches_dash_mode_check
  CHECK (dash_mode IS NULL OR dash_mode IN ('challenge','together'));
ALTER TABLE public.game_matches DROP CONSTRAINT IF EXISTS game_matches_dash_level_check;
ALTER TABLE public.game_matches ADD CONSTRAINT game_matches_dash_level_check
  CHECK (dash_level IS NULL OR dash_level IN ('easy','steady','spicy'));

-- The non-Tetris index covers ordinary games. Dash has one open match per mode, while
-- Tetris retains its own per-mode index; no older game is allowed to regress.
DROP INDEX IF EXISTS public.game_one_practice;
CREATE UNIQUE INDEX IF NOT EXISTS game_one_practice ON public.game_matches(couple_id, game)
  WHERE NOT finished AND game NOT IN ('tetris','dash-duel');
CREATE UNIQUE INDEX IF NOT EXISTS game_one_practice_dash ON public.game_matches(couple_id, game, dash_mode)
  WHERE NOT finished AND game = 'dash-duel';

CREATE OR REPLACE FUNCTION public.dash_max_ticks() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 900 $$;

CREATE OR REPLACE FUNCTION public.dash_budget(p_started timestamptz) RETURNS integer
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT least(greatest(floor(extract(epoch FROM (now() - p_started)) * 1000 / 120)::integer + 6, 0), public.dash_max_ticks())
$$;

-- One server-dealt shared course. The first partner to create a challenge chooses its
-- level; later openers resume that exact immutable route. Barriers always leave at least
-- one unblocked lane (and are jumpable), while later thirds tighten the cadence.
CREATE OR REPLACE FUNCTION public.dash_deal_course(p_level text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = public AS $$
DECLARE
  course jsonb := '[]'::jsonb;
  tick integer := 30;
  cadence integer;
  heart_chance double precision;
  double_chance double precision;
  first_lane integer;
  second_lane integer;
  lanes integer[];
BEGIN
  IF p_level NOT IN ('easy','steady','spicy') THEN RAISE EXCEPTION 'Choose an Easy, Steady or Spicy route.'; END IF;
  IF p_level = 'easy' THEN heart_chance := 0.18; double_chance := 0.20;
  ELSIF p_level = 'spicy' THEN heart_chance := 0.08; double_chance := 0.56;
  ELSE heart_chance := 0.11; double_chance := 0.38;
  END IF;
  WHILE tick <= public.dash_max_ticks() LOOP
    IF random() < heart_chance THEN
      course := course || jsonb_build_array(jsonb_build_object(
        'tick',tick,'kind','heart','lane',floor(random()*3)::integer));
    ELSE
      first_lane := floor(random()*3)::integer;
      lanes := ARRAY[first_lane];
      IF random() < double_chance THEN
        second_lane := (first_lane + 1 + floor(random()*2)::integer) % 3;
        lanes := ARRAY[first_lane,second_lane];
      END IF;
      course := course || jsonb_build_array(jsonb_build_object(
        'tick',tick,'kind','barrier','lanes',to_jsonb(lanes),'jumpable',true));
    END IF;
    cadence := CASE
      WHEN tick < 300 THEN CASE p_level WHEN 'easy' THEN 13 WHEN 'spicy' THEN 10 ELSE 11 END
      WHEN tick < 600 THEN CASE p_level WHEN 'easy' THEN 12 WHEN 'spicy' THEN 9 ELSE 10 END
      ELSE CASE p_level WHEN 'easy' THEN 11 WHEN 'spicy' THEN 8 ELSE 9 END
    END;
    tick := tick + cadence + floor(random()*3)::integer - 1;
  END LOOP;
  RETURN course;
END $$;

-- Deterministic referee, kept in lockstep with src/lib/dash.ts. Input ticks are zero-based;
-- event ticks are one-based. Each processed tick applies input, resolves an event, then
-- increments distance only if the runner survived. The collision tick is included in ticks
-- but not in distance. Jump covers exactly three collision checks.
CREATE OR REPLACE FUNCTION public.dash_replay(
  p_course jsonb, p_actions jsonb, p_ticks integer, p_cap integer DEFAULT 900
) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  cap integer := least(greatest(coalesce(p_cap, public.dash_max_ticks()),0), public.dash_max_ticks());
  goal integer := least(greatest(coalesce(p_ticks,0),0), least(greatest(coalesce(p_cap,public.dash_max_ticks()),0), public.dash_max_ticks()));
  events jsonb[];
  action_ticks integer[];
  action_names text[];
  event_count integer := 0;
  action_count integer := 0;
  event_idx integer := 1;
  action_idx integer := 1;
  tick integer := 0;
  lane integer := 1;
  hearts integer := 0;
  distance integer := 0;
  jump_ticks integer := 0;
  current_action text;
  current_event jsonb;
  event_lanes jsonb;
  event_lane integer;
  airborne boolean;
  crashed boolean;
  ended text := NULL;
BEGIN
  SELECT coalesce(array_agg(value ORDER BY ord), ARRAY[]::jsonb[])
    INTO events
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(coalesce(p_course,'[]'::jsonb))='array' THEN p_course ELSE '[]'::jsonb END)
      WITH ORDINALITY AS e(value,ord);
  event_count := coalesce(array_length(events,1),0);
  SELECT coalesce(array_agg((value->>0)::integer ORDER BY ord), ARRAY[]::integer[]),
         coalesce(array_agg(value->>1 ORDER BY ord), ARRAY[]::text[])
    INTO action_ticks, action_names
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(coalesce(p_actions,'[]'::jsonb))='array' THEN p_actions ELSE '[]'::jsonb END)
      WITH ORDINALITY AS a(value,ord)
   WHERE jsonb_typeof(value)='array' AND jsonb_array_length(value)=2
     AND (value->>0) ~ '^[0-9]{1,4}$'
     AND (value->>1) IN ('left','right','jump');
  action_count := coalesce(array_length(action_ticks,1),0);

  WHILE tick < goal AND ended IS NULL LOOP
    tick := tick + 1;
    current_action := NULL;
    WHILE action_idx <= action_count AND action_ticks[action_idx] < tick - 1 LOOP
      action_idx := action_idx + 1;
    END LOOP;
    IF action_idx <= action_count AND action_ticks[action_idx] = tick - 1 THEN
      current_action := action_names[action_idx];
      action_idx := action_idx + 1;
    END IF;
    IF current_action = 'left' AND lane > 0 THEN lane := lane - 1;
    ELSIF current_action = 'right' AND lane < 2 THEN lane := lane + 1;
    ELSIF current_action = 'jump' AND jump_ticks = 0 THEN jump_ticks := 3;
    END IF;

    WHILE event_idx <= event_count LOOP
      IF jsonb_typeof(events[event_idx]) <> 'object'
         OR coalesce((events[event_idx]->>'tick')::integer,0) >= tick THEN EXIT; END IF;
      event_idx := event_idx + 1;
    END LOOP;
    current_event := CASE WHEN event_idx <= event_count THEN events[event_idx] ELSE NULL END;
    airborne := jump_ticks > 0;
    crashed := false;
    IF current_event IS NOT NULL AND (current_event->>'tick')::integer = tick THEN
      IF current_event->>'kind' = 'heart' THEN
        IF (current_event->>'lane') ~ '^[0-2]$' AND (current_event->>'lane')::integer = lane THEN hearts := hearts + 1; END IF;
      ELSIF current_event->>'kind' = 'barrier' THEN
        event_lanes := current_event->'lanes';
        IF jsonb_typeof(event_lanes) = 'array' THEN
          FOR event_lane IN SELECT value::integer FROM jsonb_array_elements_text(event_lanes)
             WHERE value ~ '^[0-2]$' LOOP
            IF event_lane = lane THEN crashed := true; END IF;
          END LOOP;
        END IF;
        IF crashed AND NOT (coalesce((current_event->>'jumpable')::boolean,false) AND airborne) THEN
          ended := 'barrier';
        ELSE
          crashed := false;
        END IF;
      END IF;
      IF ended IS NULL THEN event_idx := event_idx + 1; END IF;
    END IF;
    IF ended IS NOT NULL THEN EXIT; END IF;
    distance := distance + 1;
    jump_ticks := greatest(jump_ticks - 1,0);
    IF tick >= cap THEN ended := 'cap'; END IF;
  END LOOP;

  RETURN jsonb_build_object('lane',lane,'hearts',hearts,'ticks',tick,'distance',distance,
    'jump_ticks',jump_ticks,'ended',ended);
END $$;

CREATE OR REPLACE FUNCTION public.dash_settle(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m public.game_matches;
  state jsonb;
  x_run jsonb;
  o_run jsonb;
  x_status text;
  o_status text;
  x_distance integer;
  o_distance integer;
  x_hearts integer;
  o_hearts integer;
  victor uuid;
BEGIN
  SELECT * INTO m FROM public.game_matches WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR m.game<>'dash-duel' OR m.finished THEN RETURN; END IF;
  state := coalesce(m.dash,'{}'::jsonb);
  x_run := state -> m.player_x::text;
  o_run := state -> m.player_o::text;
  x_status := coalesce(x_run->>'status','waiting');
  o_status := coalesce(o_run->>'status','waiting');

  -- In live-together mode a crash/forfeit immediately hands the race to the active runner.
  -- Completing the full course is not a crash: let the other runner finish, then compare
  -- verified distance/hearts just as in an async challenge.
  IF m.dash_mode='together' AND x_status IN ('crash','forfeit') AND o_status IN ('ready','running') THEN
    o_run := o_run || jsonb_build_object('status','done','ended','opponent-crash','finished_at',now());
    state := state || jsonb_build_object(m.player_o::text,o_run);
    UPDATE public.game_matches SET dash=state,finished=true,winner_id=m.player_o WHERE id=m.id;
    RETURN;
  ELSIF m.dash_mode='together' AND o_status IN ('crash','forfeit') AND x_status IN ('ready','running') THEN
    x_run := x_run || jsonb_build_object('status','done','ended','opponent-crash','finished_at',now());
    state := state || jsonb_build_object(m.player_x::text,x_run);
    UPDATE public.game_matches SET dash=state,finished=true,winner_id=m.player_x WHERE id=m.id;
    RETURN;
  END IF;

  IF x_status NOT IN ('crash','done','forfeit') OR o_status NOT IN ('crash','done','forfeit') THEN RETURN; END IF;
  x_distance := coalesce((x_run->>'distance')::integer,0);
  o_distance := coalesce((o_run->>'distance')::integer,0);
  x_hearts := coalesce((x_run->>'hearts')::integer,0);
  o_hearts := coalesce((o_run->>'hearts')::integer,0);
  IF x_distance > o_distance OR (x_distance=o_distance AND x_hearts>o_hearts) THEN victor := m.player_x;
  ELSIF o_distance > x_distance OR (x_distance=o_distance AND o_hearts>x_hearts) THEN victor := m.player_o;
  ELSE victor := NULL;
  END IF;
  UPDATE public.game_matches SET finished=true,winner_id=victor,
    dash=state || jsonb_build_object('settled_at',now()) WHERE id=m.id;
END $$;

-- An async match expires after seven days. Missing or unfinished attempts become zero-score
-- forfeits so an offline partner never blocks a rematch forever.
CREATE OR REPLACE FUNCTION public.dash_sweep(p_couple uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m public.game_matches;
  state jsonb;
  side_id uuid;
  entry jsonb;
BEGIN
  FOR m IN SELECT * FROM public.game_matches
    WHERE couple_id=p_couple AND game='dash-duel' AND NOT finished
      AND created_at <= now()-interval '7 days'
    FOR UPDATE LOOP
    state := coalesce(m.dash,'{}'::jsonb);
    FOREACH side_id IN ARRAY ARRAY[m.player_x,m.player_o] LOOP
      entry := state -> side_id::text;
      IF entry IS NULL OR entry->>'status' IN ('waiting','ready','running') THEN
        entry := coalesce(entry,'{}'::jsonb) || jsonb_build_object(
          'status','forfeit','ended','forfeit','distance',0,'hearts',0,
          'ticks',0,'jump_ticks',0,'actions','[]'::jsonb,'finished_at',now());
        state := state || jsonb_build_object(side_id::text,entry);
      END IF;
    END LOOP;
    UPDATE public.game_matches SET dash=state WHERE id=m.id;
    PERFORM public.dash_settle(m.id);
  END LOOP;
END $$;

-- Create or resume one shared course for the couple. An existing challenge ignores a later
-- level choice by design: its first creator owns the course everyone else must chase.
CREATE OR REPLACE FUNCTION public.start_dash(p_mode text DEFAULT 'challenge', p_level text DEFAULT 'steady') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cid uuid := public.get_user_couple_id(auth.uid());
  partner uuid;
  mid uuid;
  course jsonb;
  state jsonb;
BEGIN
  IF auth.uid() IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('challenge','together') THEN RAISE EXCEPTION 'Choose a Dash Duel mode.'; END IF;
  IF p_level IS NULL OR p_level NOT IN ('easy','steady','spicy') THEN RAISE EXCEPTION 'Choose an Easy, Steady or Spicy route.'; END IF;
  PERFORM 1 FROM public.couples WHERE id=cid FOR UPDATE;
  SELECT id INTO partner FROM public.profiles WHERE couple_id=cid AND id<>auth.uid();
  IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;
  PERFORM public.dash_sweep(cid);
  SELECT id INTO mid FROM public.game_matches
   WHERE couple_id=cid AND game='dash-duel' AND dash_mode=p_mode AND NOT finished;
  IF mid IS NOT NULL THEN RETURN mid; END IF;
  course := public.dash_deal_course(p_level);
  state := jsonb_build_object('course_version',1,'course',course,'mode',p_mode,
    'level',p_level,'created_by',auth.uid(),'created_at',now());
  INSERT INTO public.game_matches(couple_id,game,player_x,player_o,turn_id,best_of,dash,dash_mode,dash_level)
  VALUES(cid,'dash-duel',auth.uid(),partner,auth.uid(),3,state,p_mode,p_level) RETURNING id INTO mid;
  RETURN mid;
END $$;

CREATE OR REPLACE FUNCTION public.dash_start(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  partner uuid;
  m public.game_matches;
  state jsonb;
  entry jsonb;
  other jsonb;
  shared_start timestamptz;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM public.dash_sweep(cid);
  SELECT * INTO m FROM public.game_matches WHERE id=p_id AND couple_id=cid FOR UPDATE;
  IF NOT FOUND OR m.game<>'dash-duel' OR uid NOT IN (m.player_x,m.player_o) THEN RAISE EXCEPTION 'Dash Duel not found.'; END IF;
  IF m.finished THEN RAISE EXCEPTION 'This Dash Duel is already over.'; END IF;
  partner := CASE WHEN uid=m.player_x THEN m.player_o ELSE m.player_x END;
  state := coalesce(m.dash,'{}'::jsonb);
  entry := state -> uid::text;
  IF entry IS NOT NULL AND entry->>'status' IN ('running','ready') THEN RETURN entry; END IF;
  IF entry IS NOT NULL THEN RAISE EXCEPTION 'You have already played your run in this Dash Duel.'; END IF;

  IF m.dash_mode='together' THEN
    entry := jsonb_build_object('status','ready','ended',NULL,'distance',0,'hearts',0,'ticks',0,
      'jump_ticks',0,'actions','[]'::jsonb,'ready_at',now(),'last_seen',now());
    other := state -> partner::text;
    IF other IS NOT NULL AND other->>'status'='ready' THEN
      shared_start := now();
      entry := entry || jsonb_build_object('status','running','started_at',shared_start,'last_seen',shared_start);
      other := other || jsonb_build_object('status','running','started_at',shared_start,'last_seen',shared_start);
      state := state || jsonb_build_object(partner::text,other);
    END IF;
  ELSE
    entry := jsonb_build_object('status','running','ended',NULL,'distance',0,'hearts',0,'ticks',0,
      'jump_ticks',0,'actions','[]'::jsonb,'started_at',now(),'last_seen',now());
  END IF;
  state := state || jsonb_build_object(uid::text,entry);
  UPDATE public.game_matches SET dash=state WHERE id=m.id;
  RETURN entry;
END $$;

-- Merge a retry-safe action delta, replay the full run, and persist only referee-derived
-- progress. A same-tick identical retry is ignored; a conflicting action is rejected.
CREATE OR REPLACE FUNCTION public.dash_commit(p_id uuid,p_ticks integer,p_actions jsonb,p_final boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  m public.game_matches;
  state jsonb;
  entry jsonb;
  actions jsonb;
  delta jsonb;
  incoming jsonb;
  action_row jsonb;
  result jsonb;
  existing jsonb;
  action_tick integer;
  action_name text;
  previous_tick integer := -1;
  max_actions integer := 900;
  i integer;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM public.dash_sweep(cid);
  SELECT * INTO m FROM public.game_matches WHERE id=p_id AND couple_id=cid FOR UPDATE;
  IF NOT FOUND OR m.game<>'dash-duel' OR uid NOT IN (m.player_x,m.player_o) THEN RAISE EXCEPTION 'Dash Duel not found.'; END IF;
  state := coalesce(m.dash,'{}'::jsonb);
  entry := state -> uid::text;
  IF entry IS NULL THEN RAISE EXCEPTION 'Start your run first.'; END IF;
  IF entry->>'status' NOT IN ('running','ready') THEN RETURN entry; END IF;
  IF entry->>'status'='ready' THEN RAISE EXCEPTION 'Wait for your partner to be ready before running.'; END IF;
  IF m.finished THEN RETURN entry || jsonb_build_object('match_finished',true); END IF;
  IF p_ticks IS NULL OR p_ticks<0 OR p_ticks>public.dash_max_ticks()
     OR p_actions IS NULL OR jsonb_typeof(p_actions)<>'array' THEN
    RAISE EXCEPTION 'That Dash run report cannot be read.';
  END IF;
  IF p_ticks < coalesce((entry->>'ticks')::integer,0) THEN RAISE EXCEPTION 'That run report is older than the last one.'; END IF;
  IF p_ticks > public.dash_budget((entry->>'started_at')::timestamptz) THEN RAISE EXCEPTION 'That run is moving faster than real time.'; END IF;

  actions := coalesce(entry->'actions','[]'::jsonb);
  IF jsonb_array_length(actions)>max_actions OR jsonb_array_length(p_actions)>max_actions THEN
    RAISE EXCEPTION 'That Dash run has too many inputs.';
  END IF;
  delta := '[]'::jsonb;
  FOR action_row IN SELECT value FROM jsonb_array_elements(p_actions) LOOP
    IF jsonb_typeof(action_row)<>'array' OR jsonb_array_length(action_row)<>2
       OR (action_row->>0) !~ '^[0-9]{1,4}$'
       OR (action_row->>1) NOT IN ('left','right','jump') THEN
      RAISE EXCEPTION 'That Dash run report cannot be read.';
    END IF;
    action_tick := (action_row->>0)::integer;
    action_name := action_row->>1;
    IF action_tick<0 OR action_tick>=p_ticks THEN RAISE EXCEPTION 'That input is outside your reached ticks.'; END IF;
    IF action_tick<previous_tick THEN RAISE EXCEPTION 'Dash inputs must be in tick order.'; END IF;
    IF action_tick=previous_tick THEN
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(delta) prior WHERE (prior->>0)::integer=action_tick AND prior->>1=action_name)
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(actions) prior WHERE (prior->>0)::integer=action_tick AND prior->>1=action_name) THEN
        RAISE EXCEPTION 'Only one action is allowed per tick.';
      END IF;
      CONTINUE;
    END IF;
    previous_tick := action_tick;
    SELECT value INTO existing FROM jsonb_array_elements(actions) WHERE (value->>0)::integer=action_tick LIMIT 1;
    IF existing IS NOT NULL THEN
      IF existing->>1<>action_name THEN RAISE EXCEPTION 'That tick already has a different action.'; END IF;
      CONTINUE;
    END IF;
    SELECT value INTO existing FROM jsonb_array_elements(delta) WHERE (value->>0)::integer=action_tick LIMIT 1;
    IF existing IS NOT NULL THEN
      IF existing->>1<>action_name THEN RAISE EXCEPTION 'Only one action is allowed per tick.'; END IF;
      CONTINUE;
    END IF;
    IF action_tick < coalesce((entry->>'ticks')::integer,0) THEN RAISE EXCEPTION 'That run report is out of order.'; END IF;
    delta := delta || jsonb_build_array(jsonb_build_array(action_tick,action_name));
  END LOOP;
  actions := actions || delta;
  result := public.dash_replay(state->'course',actions,p_ticks,public.dash_max_ticks());
  -- Actions beyond a replayed collision cannot affect the result and are discarded so
  -- retries after a crash cannot smuggle extra moves into a finished attempt.
  IF result->>'ended'='barrier' THEN
    SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]'::jsonb) INTO actions
      FROM jsonb_array_elements(actions) WITH ORDINALITY AS a(value,ord)
     WHERE (value->>0)::integer < (result->>'ticks')::integer;
  END IF;
  entry := entry || jsonb_build_object('ticks',(result->>'ticks')::integer,
    'distance',(result->>'distance')::integer,'hearts',(result->>'hearts')::integer,
    'lane',(result->>'lane')::integer,'jump_ticks',(result->>'jump_ticks')::integer,
    'actions',actions,'last_seen',now());
  IF result->>'ended'='barrier' THEN
    entry := entry || jsonb_build_object('status','crash','ended','barrier','finished_at',now());
  ELSIF result->>'ended'='cap' THEN
    entry := entry || jsonb_build_object('status','done','ended','cap','finished_at',now());
  ELSIF p_final THEN
    RAISE EXCEPTION 'Your run is not finished yet.';
  END IF;
  state := state || jsonb_build_object(uid::text,entry);
  UPDATE public.game_matches SET dash=state WHERE id=m.id;
  IF result->>'ended' IN ('barrier','cap') THEN PERFORM public.dash_settle(m.id); END IF;
  RETURN entry;
END $$;

CREATE OR REPLACE FUNCTION public.dash_beat(p_id uuid,p_ticks integer,p_actions jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.dash_commit(p_id,p_ticks,p_actions,false)
$$;
CREATE OR REPLACE FUNCTION public.dash_finish(p_id uuid,p_ticks integer,p_actions jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.dash_commit(p_id,p_ticks,p_actions,true)
$$;

CREATE OR REPLACE FUNCTION public.dash_forfeit(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  m public.game_matches;
  state jsonb;
  entry jsonb;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT * INTO m FROM public.game_matches WHERE id=p_id AND couple_id=cid FOR UPDATE;
  IF NOT FOUND OR m.game<>'dash-duel' OR uid NOT IN (m.player_x,m.player_o) THEN RAISE EXCEPTION 'Dash Duel not found.'; END IF;
  state := coalesce(m.dash,'{}'::jsonb);
  entry := state -> uid::text;
  IF entry IS NULL THEN RETURN '{}'::jsonb; END IF;
  IF entry->>'status' NOT IN ('running','ready') THEN RETURN entry; END IF;
  entry := entry || jsonb_build_object('status','forfeit','ended','forfeit','distance',0,
    'hearts',0,'ticks',0,'jump_ticks',0,'finished_at',now());
  state := state || jsonb_build_object(uid::text,entry);
  UPDATE public.game_matches SET dash=state WHERE id=m.id;
  PERFORM public.dash_settle(m.id);
  RETURN entry;
END $$;

-- The partner's distance/heart count is visible while running, but their input log is not.
CREATE OR REPLACE FUNCTION public.dash_view(
  p_state jsonb,p_uid uuid,p_finished boolean,p_x uuid,p_o uuid,p_mode text,p_level text
) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  mine jsonb;
  theirs jsonb;
  partner jsonb;
  partner_id uuid := CASE WHEN p_x=p_uid THEN p_o ELSE p_x END;
BEGIN
  IF p_state IS NULL THEN RETURN NULL; END IF;
  mine := p_state -> p_uid::text;
  theirs := p_state -> partner_id::text;
  IF theirs IS NULL THEN
    partner := jsonb_build_object('status','waiting');
  ELSE
    partner := jsonb_build_object('status',theirs->>'status','ended',theirs->>'ended',
      'distance',coalesce((theirs->>'distance')::integer,0),
      'hearts',coalesce((theirs->>'hearts')::integer,0),
      'ticks',coalesce((theirs->>'ticks')::integer,0));
    IF theirs->>'status' IN ('running','ready') THEN
      partner := partner || jsonb_build_object('last_seen',theirs->>'last_seen','ready_at',theirs->>'ready_at');
    END IF;
  END IF;
  RETURN jsonb_build_object('course_version',coalesce((p_state->>'course_version')::integer,1),
    'course',coalesce(p_state->'course','[]'::jsonb),'level',p_level,'mode',p_mode,
    'created_by',p_state->>'created_by','mine',coalesce(mine,'null'::jsonb),'partner',partner);
END $$;

-- Keep the canonical Games snapshot in sync; all run details remain behind this RPC.
CREATE OR REPLACE FUNCTION public.games_state() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); result jsonb;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM public.snake_sweep(cid);
  PERFORM public.tetris_sweep(cid);
  PERFORM public.dash_sweep(cid);
  SELECT jsonb_build_object(
    'wins',(SELECT coalesce(jsonb_object_agg(winner_id,n),'{}'::jsonb) FROM
      (SELECT winner_id,count(*) n FROM public.game_matches WHERE couple_id=cid AND finished AND winner_id IS NOT NULL GROUP BY winner_id) w),
    'matches',coalesce((SELECT jsonb_agg(safe ORDER BY created_at DESC) FROM (
      SELECT created_at,(to_jsonb(m)-'pick_x'-'pick_o'-'snake'-'chess'-'tetris'-'dash') || jsonb_build_object(
        'my_pick',CASE WHEN auth.uid()=player_x THEN pick_x ELSE pick_o END,
        'partner_locked',CASE WHEN auth.uid()=player_x THEN pick_o IS NOT NULL ELSE pick_x IS NOT NULL END,
        'snake',CASE WHEN m.game='snake' THEN public.snake_view(m.snake,auth.uid(),m.finished,m.player_x,m.player_o) END,
        'chess',CASE WHEN m.game='chess' THEN public.chess_view(m.chess) END,
        'tetris',CASE WHEN m.game='tetris' THEN public.tetris_view(m.tetris,auth.uid(),m.finished,m.player_x,m.player_o,m.tetris_mode) END,
        'dash',CASE WHEN m.game='dash-duel' THEN public.dash_view(m.dash,auth.uid(),m.finished,m.player_x,m.player_o,m.dash_mode,m.dash_level) END
      ) safe
      FROM public.game_matches m WHERE couple_id=cid AND (NOT finished OR id IN
        (SELECT id FROM public.game_matches WHERE couple_id=cid ORDER BY created_at DESC LIMIT 30))
    ) recent),'[]'::jsonb)
  ) INTO result;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.dash_max_ticks(),public.dash_budget(timestamptz),
  public.dash_deal_course(text),public.dash_replay(jsonb,jsonb,integer,integer),
  public.dash_settle(uuid),public.dash_sweep(uuid),public.dash_commit(uuid,integer,jsonb,boolean),
  public.dash_view(jsonb,uuid,boolean,uuid,uuid,text,text),
  public.dash_beat(uuid,integer,jsonb),public.dash_finish(uuid,integer,jsonb),
  public.dash_forfeit(uuid),public.dash_start(uuid),public.start_dash(text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.start_dash(text,text),public.dash_start(uuid),
  public.dash_beat(uuid,integer,jsonb),public.dash_finish(uuid,integer,jsonb),
  public.dash_forfeit(uuid) TO authenticated;

COMMIT;

-- ============================================================================
-- Word Wheel (202610190001)
-- ============================================================================
-- Word Wheel: one shared seven-letter wheel, a fixed hidden-word list, and a timed
-- sixty-second-to-five-minute race between the couple.
--
-- Puzzles are prepared ahead of time (scripts/build-word-puzzles.mjs) and uploaded by
-- supabase/seed/word_puzzles.sql. This migration owns the round, the ready handshake,
-- the server start time, word validation and the result comparison. The phone may run
-- its own countdown, but it never gets to declare a winner: the database only counts
-- words that are in the round's hidden list.

DO $$
BEGIN
  IF to_regclass('public.game_matches') IS NULL
     OR to_regclass('public.couples') IS NULL
     OR to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'Apply the Games and pairing migrations before 202610190001_word_wheel.sql.';
  END IF;
  IF to_regprocedure('public.dash_view(jsonb,uuid,boolean,uuid,uuid,text,text)') IS NULL
     OR to_regprocedure('public.get_user_couple_id(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Apply 202610180009_dash_duel.sql before 202610190001_word_wheel.sql.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Puzzle bank
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.word_puzzles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  letters text NOT NULL CHECK (letters ~ '^[a-z]{7}$'),
  base_word text NOT NULL CHECK (base_word ~ '^[a-z]{7}$'),
  -- Union of every word used by the packs. Kept as a simple vocabulary record;
  -- the round only ever deals `packs`.
  words text[] NOT NULL DEFAULT '{}'::text[],
  -- {"easy":{"60":[...],"180":[...],"300":[...]},"medium":{...},"hard":{...}}
  -- Each list is the complete hidden-word set for that difficulty and duration.
  packs jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS word_puzzles_base_word_key ON public.word_puzzles(base_word);
ALTER TABLE public.word_puzzles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.word_puzzles FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Rounds
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.word_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id uuid NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  puzzle_id uuid NOT NULL REFERENCES public.word_puzzles(id) ON DELETE RESTRICT,
  difficulty text NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
  duration_seconds integer NOT NULL CHECK (duration_seconds IN (60,180,300)),
  letters text NOT NULL CHECK (letters ~ '^[a-z]{7}$'),
  grand_word text NOT NULL CHECK (grand_word ~ '^[a-z]{7}$'),
  -- Exact hidden words for this round, chosen when the round is created. Both phones
  -- receive this same immutable list so they can give instant swipe feedback.
  words text[] NOT NULL CHECK (cardinality(words) BETWEEN 2 AND 24),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  player_x uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  player_o uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','running','finished','cancelled')),
  start_at timestamptz,
  finished_at timestamptz,
  winner_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT word_rounds_players_distinct CHECK (player_x <> player_o),
  CONSTRAINT word_rounds_started_has_time CHECK (status <> 'running' OR start_at IS NOT NULL)
);
-- One lobby or live round per couple. A finished round is history and never blocks a
-- rematch; the couple's old rounds remain as the last-duel record.
CREATE UNIQUE INDEX IF NOT EXISTS word_one_open_round
  ON public.word_rounds(couple_id) WHERE status IN ('waiting','running');
CREATE INDEX IF NOT EXISTS word_rounds_couple_created ON public.word_rounds(couple_id, created_at DESC);
ALTER TABLE public.word_rounds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.word_rounds FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.word_round_results (
  round_id uuid NOT NULL REFERENCES public.word_rounds(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  words_found text[] NOT NULL DEFAULT '{}'::text[],
  -- Elapsed milliseconds at the player's last found word (or the end of the clock).
  -- The earlier last-word time wins a tie on word count.
  finished_ms integer CHECK (finished_ms IS NULL OR finished_ms BETWEEN 0 AND 300000),
  ready_at timestamptz,
  submitted_at timestamptz,
  PRIMARY KEY (round_id, user_id)
);
ALTER TABLE public.word_round_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.word_round_results FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.word_layout(p_words text[]) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('length', length, 'count', n) ORDER BY length), '[]'::jsonb)
  FROM (
    SELECT length(word) AS length, count(*) AS n
    FROM unnest(coalesce(p_words, '{}'::text[])) AS word
    GROUP BY length(word)
  ) grouped
$$;

-- The round as one phone sees it. Words are deliberately included: this is a couples
-- game, the puzzle is shared, and instant local feedback matters more than hiding the
-- answer from DevTools. The database still validates every submitted word.
CREATE OR REPLACE FUNCTION public.word_view(p_round public.word_rounds, p_uid uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  partner uuid := CASE WHEN p_round.player_x = p_uid THEN p_round.player_o ELSE p_round.player_x END;
  mine public.word_round_results;
  theirs public.word_round_results;
  reveal boolean := p_round.status = 'finished';
BEGIN
  SELECT * INTO mine FROM public.word_round_results
   WHERE round_id = p_round.id AND user_id = p_uid;
  SELECT * INTO theirs FROM public.word_round_results
   WHERE round_id = p_round.id AND user_id = partner;
  RETURN jsonb_build_object(
    'letters', p_round.letters,
    'difficulty', p_round.difficulty,
    'duration_seconds', p_round.duration_seconds,
    'grand_word', p_round.grand_word,
    'words', to_jsonb(p_round.words),
    'layout', public.word_layout(p_round.words),
    'words_total', cardinality(p_round.words),
    'status', p_round.status,
    'start_at', p_round.start_at,
    'server_now', now(),
    'created_by', p_round.created_by,
    'winner_id', p_round.winner_id,
    'mine', jsonb_build_object(
      'ready', mine.ready_at IS NOT NULL,
      'ready_at', mine.ready_at,
      'submitted', mine.submitted_at IS NOT NULL,
      'words', to_jsonb(coalesce(mine.words_found, '{}'::text[])),
      'count', coalesce(cardinality(mine.words_found), 0),
      'finished_ms', mine.finished_ms
    ),
    -- The partner's words and time stay sealed until the round is settled. Before
    -- that the phone only learns whether they have readied or submitted.
    'partner', jsonb_build_object(
      'ready', theirs.ready_at IS NOT NULL,
      'ready_at', CASE WHEN reveal THEN theirs.ready_at END,
      'submitted', theirs.submitted_at IS NOT NULL,
      'words', CASE WHEN reveal THEN to_jsonb(coalesce(theirs.words_found, '{}'::text[])) ELSE '[]'::jsonb END,
      'count', CASE WHEN reveal THEN coalesce(cardinality(theirs.words_found), 0) ELSE 0 END,
      'finished_ms', CASE WHEN reveal THEN theirs.finished_ms END
    )
  );
END $$;

-- Compare two finished attempts: most words, then the earlier last-word time. Equal
-- counts and equal times are a draw.
CREATE OR REPLACE FUNCTION public.word_settle(p_id uuid) RETURNS public.word_rounds
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r public.word_rounds;
  a public.word_round_results;
  b public.word_round_results;
  a_count integer;
  b_count integer;
  victor uuid;
BEGIN
  SELECT * INTO r FROM public.word_rounds WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'running' THEN RETURN r; END IF;
  IF EXISTS (SELECT 1 FROM public.word_round_results WHERE round_id = p_id AND submitted_at IS NULL) THEN
    RETURN r;
  END IF;
  SELECT * INTO a FROM public.word_round_results WHERE round_id = p_id AND user_id = r.player_x;
  SELECT * INTO b FROM public.word_round_results WHERE round_id = p_id AND user_id = r.player_o;
  a_count := coalesce(cardinality(a.words_found), 0);
  b_count := coalesce(cardinality(b.words_found), 0);
  IF a_count > b_count THEN victor := r.player_x;
  ELSIF b_count > a_count THEN victor := r.player_o;
  ELSIF coalesce(a.finished_ms, r.duration_seconds * 1000) < coalesce(b.finished_ms, r.duration_seconds * 1000) THEN victor := r.player_x;
  ELSIF coalesce(b.finished_ms, r.duration_seconds * 1000) < coalesce(a.finished_ms, r.duration_seconds * 1000) THEN victor := r.player_o;
  ELSE victor := NULL;
  END IF;
  UPDATE public.word_rounds
     SET status = 'finished', winner_id = victor, finished_at = now()
   WHERE id = p_id
   RETURNING * INTO r;
  RETURN r;
END $$;

-- Housekeeping, called inside games_state so neither phone needs a timer of its own.
-- A lobby nobody accepted is dropped after half an hour. A live round whose deadline
-- passed plus a network grace window is settled with whatever each phone managed to
-- submit (a phone that never reported counts as zero words).
CREATE OR REPLACE FUNCTION public.word_sweep(p_couple uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.word_rounds;
BEGIN
  UPDATE public.word_rounds
     SET status = 'cancelled', finished_at = now()
   WHERE couple_id = p_couple AND status = 'waiting' AND created_at < now() - interval '30 minutes';
  FOR r IN
    SELECT * FROM public.word_rounds
     WHERE couple_id = p_couple AND status = 'running'
       AND start_at + make_interval(secs => duration_seconds) + interval '45 seconds' < now()
     FOR UPDATE
  LOOP
    INSERT INTO public.word_round_results (round_id, user_id, words_found, finished_ms, submitted_at)
    VALUES (r.id, r.player_x, '{}'::text[], r.duration_seconds * 1000, now()),
           (r.id, r.player_o, '{}'::text[], r.duration_seconds * 1000, now())
    ON CONFLICT (round_id, user_id) DO UPDATE
      SET submitted_at = coalesce(public.word_round_results.submitted_at, EXCLUDED.submitted_at),
          finished_ms = coalesce(public.word_round_results.finished_ms, EXCLUDED.finished_ms);
    PERFORM public.word_settle(r.id);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_word_round(p_difficulty text, p_seconds integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cid uuid := public.get_user_couple_id(auth.uid());
  partner uuid;
  mid uuid;
  lvl text := p_difficulty;
  sec text := p_seconds::text;
  puzzle public.word_puzzles;
  targets text[];
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  IF p_difficulty IS NULL OR p_difficulty NOT IN ('easy','medium','hard')
     OR p_seconds IS NULL OR p_seconds NOT IN (60,180,300) THEN
    RAISE EXCEPTION 'Choose Easy, Medium or Hard and a 1, 3 or 5 minute round.';
  END IF;
  PERFORM 1 FROM public.couples WHERE id = cid FOR UPDATE;
  SELECT id INTO partner FROM public.profiles WHERE couple_id = cid AND id <> auth.uid();
  IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;

  -- An open lobby or live round is the couple's round; reopening resumes it rather
  -- than silently replacing the puzzle underneath the other phone.
  SELECT id INTO mid FROM public.word_rounds
   WHERE couple_id = cid AND status IN ('waiting','running') LIMIT 1;
  IF mid IS NOT NULL THEN RETURN mid; END IF;

  SELECT * INTO puzzle FROM public.word_puzzles p
   WHERE p.packs ? lvl
     AND p.packs -> lvl ? sec
     AND jsonb_array_length(p.packs -> lvl -> sec) > 0
   ORDER BY
     (p.id IN (SELECT puzzle_id FROM public.word_rounds
                WHERE couple_id = cid AND created_at > now() - interval '60 days')) ASC,
     random()
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No Word Wheel puzzles are installed. Run supabase/seed/word_puzzles.sql.';
  END IF;

  targets := ARRAY(SELECT jsonb_array_elements_text(puzzle.packs -> lvl -> sec));
  INSERT INTO public.word_rounds
    (couple_id, puzzle_id, difficulty, duration_seconds, letters, grand_word, words, created_by, player_x, player_o)
  VALUES
    (cid, puzzle.id, p_difficulty, p_seconds, puzzle.letters, puzzle.base_word, targets, auth.uid(), auth.uid(), partner)
  RETURNING id INTO mid;

  INSERT INTO public.word_round_results (round_id, user_id)
  VALUES (mid, auth.uid()), (mid, partner);
  RETURN mid;
END $$;

-- One phone says it is ready. When both are ready the server sets one shared start
-- time a few seconds ahead; both countdowns then use that exact timestamp.
CREATE OR REPLACE FUNCTION public.word_ready(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cid uuid := public.get_user_couple_id(auth.uid());
  r public.word_rounds;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT * INTO r FROM public.word_rounds WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Word Wheel round not found.'; END IF;
  IF auth.uid() NOT IN (r.player_x, r.player_o) THEN RAISE EXCEPTION 'This is not your round.'; END IF;
  IF r.status = 'cancelled' THEN RAISE EXCEPTION 'This round was cancelled.'; END IF;
  IF r.status = 'finished' THEN RETURN public.word_view(r, auth.uid()); END IF;

  UPDATE public.word_round_results SET ready_at = coalesce(ready_at, now())
   WHERE round_id = r.id AND user_id = auth.uid();

  IF r.status = 'waiting' AND NOT EXISTS (
    SELECT 1 FROM public.word_round_results
     WHERE round_id = r.id AND user_id IN (r.player_x, r.player_o) AND ready_at IS NULL
  ) THEN
    UPDATE public.word_rounds
       SET status = 'running', start_at = now() + interval '8 seconds'
     WHERE id = r.id
     RETURNING * INTO r;
  END IF;
  RETURN public.word_view(r, auth.uid());
END $$;

-- A phone reports the words it found and the elapsed time of its last find. Only
-- words from this round's hidden list survive; duplicates are ignored. A retry after
-- the result is stored never changes the score.
CREATE OR REPLACE FUNCTION public.word_submit(p_id uuid, p_words text[], p_finished_ms integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cid uuid := public.get_user_couple_id(auth.uid());
  r public.word_rounds;
  mine public.word_round_results;
  clean text[];
  elapsed integer;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT * INTO r FROM public.word_rounds WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Word Wheel round not found.'; END IF;
  IF auth.uid() NOT IN (r.player_x, r.player_o) THEN RAISE EXCEPTION 'This is not your round.'; END IF;
  IF r.status = 'cancelled' THEN RAISE EXCEPTION 'This round was cancelled.'; END IF;
  IF r.status = 'finished' THEN RETURN public.word_view(r, auth.uid()); END IF;
  IF r.status = 'waiting' OR r.start_at IS NULL THEN RAISE EXCEPTION 'The round has not started yet.'; END IF;
  IF now() < r.start_at THEN RAISE EXCEPTION 'The round has not started yet.'; END IF;

  SELECT * INTO mine FROM public.word_round_results
   WHERE round_id = r.id AND user_id = auth.uid() FOR UPDATE;
  IF mine.submitted_at IS NOT NULL THEN RETURN public.word_view(r, auth.uid()); END IF;

  clean := ARRAY(
    SELECT DISTINCT lower(word)
      FROM unnest(coalesce(p_words, '{}'::text[])) AS word
     WHERE lower(word) = ANY(r.words)
       AND lower(word) ~ '^[a-z]{2,7}$'
  );

  elapsed := least(
    greatest(
      coalesce(p_finished_ms, floor(extract(epoch FROM (now() - r.start_at)) * 1000)::integer),
      0
    ),
    r.duration_seconds * 1000
  );

  UPDATE public.word_round_results
     SET words_found = clean, finished_ms = elapsed, submitted_at = now()
   WHERE round_id = r.id AND user_id = auth.uid();

  PERFORM public.word_settle(r.id);
  SELECT * INTO r FROM public.word_rounds WHERE id = r.id;
  RETURN public.word_view(r, auth.uid());
END $$;

-- Either partner can drop a lobby before it starts. A live round cannot be cancelled.
CREATE OR REPLACE FUNCTION public.word_cancel(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cid uuid := public.get_user_couple_id(auth.uid());
  r public.word_rounds;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT * INTO r FROM public.word_rounds WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Word Wheel round not found.'; END IF;
  IF auth.uid() NOT IN (r.player_x, r.player_o) THEN RAISE EXCEPTION 'This is not your round.'; END IF;
  IF r.status <> 'waiting' THEN RAISE EXCEPTION 'This round has already started.'; END IF;
  UPDATE public.word_rounds SET status = 'cancelled', finished_at = now()
   WHERE id = r.id RETURNING * INTO r;
  RETURN public.word_view(r, auth.uid());
END $$;

-- ---------------------------------------------------------------------------
-- Games snapshot: word rounds ride in the same list as the other games, so ongoing
-- cards, the Games badge, Last duel and rematches all keep working.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.games_state() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); result jsonb;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM public.snake_sweep(cid);
  PERFORM public.tetris_sweep(cid);
  PERFORM public.dash_sweep(cid);
  PERFORM public.word_sweep(cid);
  SELECT jsonb_build_object(
    'wins',(SELECT coalesce(jsonb_object_agg(winner_id,total),'{}'::jsonb) FROM (
      SELECT winner_id,sum(n) AS total FROM (
        SELECT winner_id,count(*) AS n FROM public.game_matches
         WHERE couple_id=cid AND finished AND winner_id IS NOT NULL GROUP BY winner_id
        UNION ALL
        SELECT winner_id,count(*) AS n FROM public.word_rounds
         WHERE couple_id=cid AND status='finished' AND winner_id IS NOT NULL GROUP BY winner_id
      ) unioned GROUP BY winner_id
    ) w),
    'matches',coalesce((SELECT jsonb_agg(safe ORDER BY created_at DESC) FROM (
      SELECT created_at,safe FROM (
        SELECT m.created_at,(to_jsonb(m)-'pick_x'-'pick_o'-'snake'-'chess'-'tetris'-'dash') || jsonb_build_object(
          'my_pick',CASE WHEN auth.uid()=player_x THEN pick_x ELSE pick_o END,
          'partner_locked',CASE WHEN auth.uid()=player_x THEN pick_o IS NOT NULL ELSE pick_x IS NOT NULL END,
          'snake',CASE WHEN m.game='snake' THEN public.snake_view(m.snake,auth.uid(),m.finished,m.player_x,m.player_o) END,
          'chess',CASE WHEN m.game='chess' THEN public.chess_view(m.chess) END,
          'tetris',CASE WHEN m.game='tetris' THEN public.tetris_view(m.tetris,auth.uid(),m.finished,m.player_x,m.player_o,m.tetris_mode) END,
          'dash',CASE WHEN m.game='dash-duel' THEN public.dash_view(m.dash,auth.uid(),m.finished,m.player_x,m.player_o,m.dash_mode,m.dash_level) END
        ) AS safe
        FROM public.game_matches m WHERE m.couple_id=cid AND (NOT m.finished OR m.id IN
          (SELECT id FROM public.game_matches WHERE couple_id=cid ORDER BY created_at DESC LIMIT 30))
        UNION ALL
        SELECT r.created_at,jsonb_build_object(
          'id',r.id,
          'couple_id',r.couple_id,
          'game','word-wheel',
          'player_x',r.player_x,
          'player_o',r.player_o,
          'turn_id',r.player_x,
          'best_of',1,
          'round',1,
          'score_x',coalesce((SELECT cardinality(words_found) FROM public.word_round_results
                               WHERE round_id=r.id AND user_id=r.player_x),0),
          'score_o',coalesce((SELECT cardinality(words_found) FROM public.word_round_results
                               WHERE round_id=r.id AND user_id=r.player_o),0),
          'my_pick',NULL,
          'partner_locked',false,
          'finished',(r.status='finished'),
          'winner_id',r.winner_id,
          'rounds','[]'::jsonb,
          'created_at',r.created_at,
          'word',public.word_view(r,auth.uid())
        ) AS safe
        FROM public.word_rounds r
        WHERE r.couple_id=cid AND r.status<>'cancelled'
          AND (r.status IN ('waiting','running') OR r.id IN
            (SELECT id FROM public.word_rounds WHERE couple_id=cid AND status<>'cancelled'
              ORDER BY created_at DESC LIMIT 30))
      ) combined
    ) recent),'[]'::jsonb)
  ) INTO result;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.word_layout(text[]),public.word_view(public.word_rounds,uuid),
  public.word_settle(uuid),public.word_sweep(uuid),public.start_word_round(text,integer),
  public.word_ready(uuid),public.word_submit(uuid,text[],integer),public.word_cancel(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.start_word_round(text,integer),public.word_ready(uuid),
  public.word_submit(uuid,text[],integer),public.word_cancel(uuid),
  public.games_state() TO authenticated;

-- Dash Duel v2: make the road flow top-to-bottom, remove jumping from new courses,
-- and ramp simulation speed in lockstep with the client. The original replay remains
-- able to read a saved v1 jump log so an already-open course can finish after upgrade.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.game_matches') IS NULL
     OR to_regprocedure('public.dash_replay(jsonb,jsonb,integer,integer)') IS NULL
     OR to_regprocedure('public.start_dash(text,text)') IS NULL THEN
    RAISE EXCEPTION 'Apply supabase/migrations/202610180009_dash_duel.sql before 202610190002_dash_duel_dodge_speed.sql.';
  END IF;
END $$;

-- A tick is 120 ms for the opening 300 ticks, then 105 ms through tick 600,
-- then 90 ms to the 900-tick cap. The browser clock and referee share these bands.
CREATE OR REPLACE FUNCTION public.dash_tick_duration(p_tick integer) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN coalesce(p_tick,1) <= 300 THEN 120
    WHEN p_tick <= 600 THEN 105
    ELSE 90
  END
$$;

-- Cumulative real milliseconds at a completed tick, used by parity tests and the
-- anti-fast-forward budget. The cap keeps all results inside a 900-tick course.
CREATE OR REPLACE FUNCTION public.dash_elapsed_ms(p_ticks integer) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN ticks <= 300 THEN ticks * 120
    WHEN ticks <= 600 THEN 300 * 120 + (ticks - 300) * 105
    ELSE 300 * 120 + 300 * 105 + (ticks - 600) * 90
  END
  FROM (SELECT least(greatest(coalesce(p_ticks,0),0),900) AS ticks) bounded
$$;

-- Invert the same ramp and keep six ticks of network/scheduling slack, matching the
-- client-side dashTickBudget helper without allowing a faster-than-real-time report.
CREATE OR REPLACE FUNCTION public.dash_budget(p_started timestamptz) RETURNS integer
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH elapsed AS (
    SELECT greatest(coalesce(floor(extract(epoch FROM (now() - p_started)) * 1000)::integer,0),0) AS ms
  ), reached AS (
    SELECT CASE
      WHEN ms < 36000 THEN floor(ms::numeric / 120)::integer
      WHEN ms < 67500 THEN 300 + floor((ms - 36000)::numeric / 105)::integer
      ELSE 600 + floor((ms - 67500)::numeric / 90)::integer
    END AS ticks
    FROM elapsed
  )
  SELECT least(greatest(ticks + 6,0),public.dash_max_ticks()) FROM reached
$$;

-- Version-two courses no longer mark barriers as jumpable. Every barrier still leaves
-- one lane open; later sections also tighten their cadence, on top of the faster clock.
CREATE OR REPLACE FUNCTION public.dash_deal_course(p_level text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = public AS $$
DECLARE
  course jsonb := '[]'::jsonb;
  tick integer := 30;
  cadence integer;
  heart_chance double precision;
  double_chance double precision;
  first_lane integer;
  second_lane integer;
  lanes integer[];
BEGIN
  IF p_level NOT IN ('easy','steady','spicy') THEN RAISE EXCEPTION 'Choose an Easy, Steady or Spicy route.'; END IF;
  IF p_level = 'easy' THEN heart_chance := 0.18; double_chance := 0.20;
  ELSIF p_level = 'spicy' THEN heart_chance := 0.08; double_chance := 0.56;
  ELSE heart_chance := 0.11; double_chance := 0.38;
  END IF;
  WHILE tick <= public.dash_max_ticks() LOOP
    IF random() < heart_chance THEN
      course := course || jsonb_build_array(jsonb_build_object(
        'tick',tick,'kind','heart','lane',floor(random()*3)::integer));
    ELSE
      first_lane := floor(random()*3)::integer;
      lanes := ARRAY[first_lane];
      IF random() < double_chance THEN
        second_lane := (first_lane + 1 + floor(random()*2)::integer) % 3;
        lanes := ARRAY[first_lane,second_lane];
      END IF;
      course := course || jsonb_build_array(jsonb_build_object(
        'tick',tick,'kind','barrier','lanes',to_jsonb(lanes)));
    END IF;
    cadence := CASE
      WHEN tick < 300 THEN CASE p_level WHEN 'easy' THEN 13 WHEN 'spicy' THEN 10 ELSE 11 END
      WHEN tick < 600 THEN CASE p_level WHEN 'easy' THEN 12 WHEN 'spicy' THEN 9 ELSE 10 END
      ELSE CASE p_level WHEN 'easy' THEN 11 WHEN 'spicy' THEN 8 ELSE 9 END
    END;
    tick := tick + cadence + floor(random()*3)::integer - 1;
  END LOOP;
  RETURN course;
END $$;

-- New matches use course version 2. Existing open version-one matches keep their original
-- course/version and saved actions, so the legacy replay can finish them safely.
CREATE OR REPLACE FUNCTION public.start_dash(p_mode text DEFAULT 'challenge', p_level text DEFAULT 'steady') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cid uuid := public.get_user_couple_id(auth.uid());
  partner uuid;
  mid uuid;
  course jsonb;
  state jsonb;
BEGIN
  IF auth.uid() IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('challenge','together') THEN RAISE EXCEPTION 'Choose a Dash Duel mode.'; END IF;
  IF p_level IS NULL OR p_level NOT IN ('easy','steady','spicy') THEN RAISE EXCEPTION 'Choose an Easy, Steady or Spicy route.'; END IF;
  PERFORM 1 FROM public.couples WHERE id=cid FOR UPDATE;
  SELECT id INTO partner FROM public.profiles WHERE couple_id=cid AND id<>auth.uid();
  IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;
  PERFORM public.dash_sweep(cid);
  SELECT id INTO mid FROM public.game_matches
   WHERE couple_id=cid AND game='dash-duel' AND dash_mode=p_mode AND NOT finished;
  IF mid IS NOT NULL THEN RETURN mid; END IF;
  course := public.dash_deal_course(p_level);
  state := jsonb_build_object('course_version',2,'course',course,'mode',p_mode,
    'level',p_level,'created_by',auth.uid(),'created_at',now());
  INSERT INTO public.game_matches(couple_id,game,player_x,player_o,turn_id,best_of,dash,dash_mode,dash_level)
  VALUES(cid,'dash-duel',auth.uid(),partner,auth.uid(),3,state,p_mode,p_level) RETURNING id INTO mid;
  RETURN mid;
END $$;

-- New input deltas accept only lane changes. Previously saved v1 logs are left untouched
-- and dash_replay can still read them, but no client can submit a new jump action.
CREATE OR REPLACE FUNCTION public.dash_commit(p_id uuid,p_ticks integer,p_actions jsonb,p_final boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  m public.game_matches;
  state jsonb;
  entry jsonb;
  actions jsonb;
  delta jsonb;
  action_row jsonb;
  result jsonb;
  existing jsonb;
  action_tick integer;
  action_name text;
  previous_tick integer := -1;
  max_actions integer := 900;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM public.dash_sweep(cid);
  SELECT * INTO m FROM public.game_matches WHERE id=p_id AND couple_id=cid FOR UPDATE;
  IF NOT FOUND OR m.game<>'dash-duel' OR uid NOT IN (m.player_x,m.player_o) THEN RAISE EXCEPTION 'Dash Duel not found.'; END IF;
  state := coalesce(m.dash,'{}'::jsonb);
  entry := state -> uid::text;
  IF entry IS NULL THEN RAISE EXCEPTION 'Start your run first.'; END IF;
  IF entry->>'status' NOT IN ('running','ready') THEN RETURN entry; END IF;
  IF entry->>'status'='ready' THEN RAISE EXCEPTION 'Wait for your partner to be ready before running.'; END IF;
  IF m.finished THEN RETURN entry || jsonb_build_object('match_finished',true); END IF;
  IF p_ticks IS NULL OR p_ticks<0 OR p_ticks>public.dash_max_ticks()
     OR p_actions IS NULL OR jsonb_typeof(p_actions)<>'array' THEN
    RAISE EXCEPTION 'That Dash run report cannot be read.';
  END IF;
  IF p_ticks < coalesce((entry->>'ticks')::integer,0) THEN RAISE EXCEPTION 'That run report is older than the last one.'; END IF;
  IF p_ticks > public.dash_budget((entry->>'started_at')::timestamptz) THEN RAISE EXCEPTION 'That run is moving faster than real time.'; END IF;

  actions := coalesce(entry->'actions','[]'::jsonb);
  IF jsonb_array_length(actions)>max_actions OR jsonb_array_length(p_actions)>max_actions THEN
    RAISE EXCEPTION 'That Dash run has too many inputs.';
  END IF;
  delta := '[]'::jsonb;
  FOR action_row IN SELECT value FROM jsonb_array_elements(p_actions) LOOP
    IF jsonb_typeof(action_row)<>'array' OR jsonb_array_length(action_row)<>2
       OR (action_row->>0) !~ '^[0-9]{1,4}$'
       OR (action_row->>1) NOT IN ('left','right') THEN
      RAISE EXCEPTION 'That Dash run report cannot be read.';
    END IF;
    action_tick := (action_row->>0)::integer;
    action_name := action_row->>1;
    IF action_tick<0 OR action_tick>=p_ticks THEN RAISE EXCEPTION 'That input is outside your reached ticks.'; END IF;
    IF action_tick<previous_tick THEN RAISE EXCEPTION 'Dash inputs must be in tick order.'; END IF;
    IF action_tick=previous_tick THEN
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(delta) prior WHERE (prior->>0)::integer=action_tick AND prior->>1=action_name)
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(actions) prior WHERE (prior->>0)::integer=action_tick AND prior->>1=action_name) THEN
        RAISE EXCEPTION 'Only one action is allowed per tick.';
      END IF;
      CONTINUE;
    END IF;
    previous_tick := action_tick;
    SELECT value INTO existing FROM jsonb_array_elements(actions) WHERE (value->>0)::integer=action_tick LIMIT 1;
    IF existing IS NOT NULL THEN
      IF existing->>1<>action_name THEN RAISE EXCEPTION 'That tick already has a different action.'; END IF;
      CONTINUE;
    END IF;
    SELECT value INTO existing FROM jsonb_array_elements(delta) WHERE (value->>0)::integer=action_tick LIMIT 1;
    IF existing IS NOT NULL THEN
      IF existing->>1<>action_name THEN RAISE EXCEPTION 'Only one action is allowed per tick.'; END IF;
      CONTINUE;
    END IF;
    IF action_tick < coalesce((entry->>'ticks')::integer,0) THEN RAISE EXCEPTION 'That run report is out of order.'; END IF;
    delta := delta || jsonb_build_array(jsonb_build_array(action_tick,action_name));
  END LOOP;
  actions := actions || delta;
  result := public.dash_replay(state->'course',actions,p_ticks,public.dash_max_ticks());
  IF result->>'ended'='barrier' THEN
    SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]'::jsonb) INTO actions
      FROM jsonb_array_elements(actions) WITH ORDINALITY AS a(value,ord)
     WHERE (value->>0)::integer < (result->>'ticks')::integer;
  END IF;
  entry := entry || jsonb_build_object('ticks',(result->>'ticks')::integer,
    'distance',(result->>'distance')::integer,'hearts',(result->>'hearts')::integer,
    'lane',(result->>'lane')::integer,'jump_ticks',(result->>'jump_ticks')::integer,
    'actions',actions,'last_seen',now());
  IF result->>'ended'='barrier' THEN
    entry := entry || jsonb_build_object('status','crash','ended','barrier','finished_at',now());
  ELSIF result->>'ended'='cap' THEN
    entry := entry || jsonb_build_object('status','done','ended','cap','finished_at',now());
  ELSIF p_final THEN
    RAISE EXCEPTION 'Your run is not finished yet.';
  END IF;
  state := state || jsonb_build_object(uid::text,entry);
  UPDATE public.game_matches SET dash=state WHERE id=m.id;
  IF result->>'ended' IN ('barrier','cap') THEN PERFORM public.dash_settle(m.id); END IF;
  RETURN entry;
END $$;

REVOKE ALL ON FUNCTION public.dash_tick_duration(integer),public.dash_elapsed_ms(integer),
  public.dash_max_ticks(),public.dash_budget(timestamptz),public.dash_deal_course(text),
  public.dash_replay(jsonb,jsonb,integer,integer),public.dash_settle(uuid),public.dash_sweep(uuid),
  public.dash_commit(uuid,integer,jsonb,boolean),public.dash_view(jsonb,uuid,boolean,uuid,uuid,text,text),
  public.dash_beat(uuid,integer,jsonb),public.dash_finish(uuid,integer,jsonb),
  public.dash_forfeit(uuid),public.dash_start(uuid),public.start_dash(text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.start_dash(text,text),public.dash_start(uuid),
  public.dash_beat(uuid,integer,jsonb),public.dash_finish(uuid,integer,jsonb),
  public.dash_forfeit(uuid) TO authenticated;

COMMIT;

-- Word Wheel v2: each partner gets an independent timer, while practice runs stay
-- entirely local to the phone. The couple still shares one immutable puzzle.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.word_rounds') IS NULL
     OR to_regclass('public.word_round_results') IS NULL
     OR to_regprocedure('public.word_view(public.word_rounds,uuid)') IS NULL
     OR to_regprocedure('public.word_settle(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Apply supabase/migrations/202610190001_word_wheel.sql before 202610190003_word_wheel_async_practice.sql.';
  END IF;
END $$;

-- The shared round start remains as a v1/history field. New attempts use this
-- per-player timestamp, so one person's timer can never start the partner's clock.
ALTER TABLE public.word_round_results
  ADD COLUMN IF NOT EXISTS started_at timestamptz;

-- Keep already-running and completed v1 rounds replayable with their original
-- shared start. A waiting v1 lobby has not started either clock yet.
UPDATE public.word_round_results AS result
   SET started_at = rounds.start_at
  FROM public.word_rounds AS rounds
 WHERE result.round_id = rounds.id
   AND rounds.status IN ('running','finished')
   AND rounds.start_at IS NOT NULL
   AND result.started_at IS NULL;

CREATE OR REPLACE FUNCTION public.word_view(p_round public.word_rounds, p_uid uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  partner uuid := CASE WHEN p_round.player_x = p_uid THEN p_round.player_o ELSE p_round.player_x END;
  mine public.word_round_results;
  theirs public.word_round_results;
  reveal boolean := p_round.status = 'finished';
BEGIN
  SELECT * INTO mine FROM public.word_round_results
   WHERE round_id = p_round.id AND user_id = p_uid;
  SELECT * INTO theirs FROM public.word_round_results
   WHERE round_id = p_round.id AND user_id = partner;
  RETURN jsonb_build_object(
    'letters', p_round.letters,
    'difficulty', p_round.difficulty,
    'duration_seconds', p_round.duration_seconds,
    'grand_word', p_round.grand_word,
    'words', to_jsonb(p_round.words),
    'layout', public.word_layout(p_round.words),
    'words_total', cardinality(p_round.words),
    'status', p_round.status,
    'start_at', p_round.start_at,
    'server_now', now(),
    'created_by', p_round.created_by,
    'winner_id', p_round.winner_id,
    'mine', jsonb_build_object(
      'ready', mine.ready_at IS NOT NULL,
      'ready_at', mine.ready_at,
      'started', mine.started_at IS NOT NULL,
      'started_at', mine.started_at,
      'submitted', mine.submitted_at IS NOT NULL,
      'words', to_jsonb(coalesce(mine.words_found, '{}'::text[])),
      'count', coalesce(cardinality(mine.words_found), 0),
      'finished_ms', mine.finished_ms
    ),
    -- The partner's score, words and exact time stay sealed until settlement. Their
    -- started flag is public so the UI can say whether the asynchronous attempt began.
    'partner', jsonb_build_object(
      'ready', theirs.ready_at IS NOT NULL,
      'ready_at', CASE WHEN reveal THEN theirs.ready_at END,
      'started', theirs.started_at IS NOT NULL,
      'started_at', CASE WHEN reveal THEN theirs.started_at END,
      'submitted', theirs.submitted_at IS NOT NULL,
      'words', CASE WHEN reveal THEN to_jsonb(coalesce(theirs.words_found, '{}'::text[])) ELSE '[]'::jsonb END,
      'count', CASE WHEN reveal THEN coalesce(cardinality(theirs.words_found), 0) ELSE 0 END,
      'finished_ms', CASE WHEN reveal THEN theirs.finished_ms END
    )
  );
END $$;

-- The first player may start immediately. An unstarted partner is allowed a week
-- to play; each started attempt gets its own duration plus a short network grace.
CREATE OR REPLACE FUNCTION public.word_sweep(p_couple uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.word_rounds;
BEGIN
  UPDATE public.word_rounds
     SET status = 'cancelled', finished_at = now()
   WHERE couple_id = p_couple AND status = 'waiting'
     AND created_at < now() - interval '7 days';

  FOR r IN
    SELECT * FROM public.word_rounds
     WHERE couple_id = p_couple AND status = 'running'
     FOR UPDATE
  LOOP
    -- A started run that never reports by its own deadline + grace is zero-filled.
    UPDATE public.word_round_results
       SET words_found = '{}'::text[],
           finished_ms = r.duration_seconds * 1000,
           submitted_at = now()
     WHERE round_id = r.id
       AND submitted_at IS NULL
       AND started_at IS NOT NULL
       AND started_at + make_interval(secs => r.duration_seconds) + interval '45 seconds' < now();

    -- If the other person never starts, close the challenge after seven days rather
    -- than allowing a dormant round to block new ones forever.
    IF r.created_at < now() - interval '7 days' THEN
      UPDATE public.word_round_results
         SET words_found = '{}'::text[],
             finished_ms = r.duration_seconds * 1000,
             submitted_at = now()
       WHERE round_id = r.id
         AND submitted_at IS NULL
         AND started_at IS NULL;
    END IF;

    PERFORM public.word_settle(r.id);
  END LOOP;
END $$;

-- The library button creates or resumes the couple's one shared puzzle. Sweep stale
-- rounds first so a new challenge can be created as soon as the old one expires.
CREATE OR REPLACE FUNCTION public.start_word_round(p_difficulty text, p_seconds integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cid uuid := public.get_user_couple_id(auth.uid());
  partner uuid;
  mid uuid;
  lvl text := p_difficulty;
  sec text := p_seconds::text;
  puzzle public.word_puzzles;
  targets text[];
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  IF p_difficulty IS NULL OR p_difficulty NOT IN ('easy','medium','hard')
     OR p_seconds IS NULL OR p_seconds NOT IN (60,180,300) THEN
    RAISE EXCEPTION 'Choose Easy, Medium or Hard and a 1, 3 or 5 minute round.';
  END IF;
  PERFORM 1 FROM public.couples WHERE id = cid FOR UPDATE;
  PERFORM public.word_sweep(cid);
  SELECT id INTO partner FROM public.profiles WHERE couple_id = cid AND id <> auth.uid();
  IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;

  SELECT id INTO mid FROM public.word_rounds
   WHERE couple_id = cid AND status IN ('waiting','running') LIMIT 1;
  IF mid IS NOT NULL THEN RETURN mid; END IF;

  SELECT * INTO puzzle FROM public.word_puzzles p
   WHERE p.packs ? lvl
     AND p.packs -> lvl ? sec
     AND jsonb_array_length(p.packs -> lvl -> sec) > 0
   ORDER BY
     (p.id IN (SELECT puzzle_id FROM public.word_rounds
                WHERE couple_id = cid AND created_at > now() - interval '60 days')) ASC,
     random()
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No Word Wheel puzzles are installed. Run supabase/seed/word_puzzles.sql.';
  END IF;

  targets := ARRAY(SELECT jsonb_array_elements_text(puzzle.packs -> lvl -> sec));
  INSERT INTO public.word_rounds
    (couple_id, puzzle_id, difficulty, duration_seconds, letters, grand_word, words, created_by, player_x, player_o)
  VALUES
    (cid, puzzle.id, p_difficulty, p_seconds, puzzle.letters, puzzle.base_word, targets, auth.uid(), auth.uid(), partner)
  RETURNING id INTO mid;

  INSERT INTO public.word_round_results (round_id, user_id)
  VALUES (mid, auth.uid()), (mid, partner);
  RETURN mid;
END $$;

-- Start only the caller's clock. The couple's round becomes running on the first
-- start, but the partner can wait and begin their own full-duration attempt later.
CREATE OR REPLACE FUNCTION public.word_start(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cid uuid := public.get_user_couple_id(auth.uid());
  r public.word_rounds;
  mine public.word_round_results;
  started timestamptz;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM public.word_sweep(cid);
  SELECT * INTO r FROM public.word_rounds WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Word Wheel round not found.'; END IF;
  IF auth.uid() NOT IN (r.player_x, r.player_o) THEN RAISE EXCEPTION 'This is not your round.'; END IF;
  IF r.status = 'cancelled' THEN RAISE EXCEPTION 'This round was cancelled.'; END IF;
  IF r.status = 'finished' THEN RETURN public.word_view(r, auth.uid()); END IF;

  SELECT * INTO mine FROM public.word_round_results
   WHERE round_id = r.id AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Your Word Wheel attempt was not found.'; END IF;
  IF mine.submitted_at IS NOT NULL THEN RETURN public.word_view(r, auth.uid()); END IF;

  IF mine.started_at IS NULL THEN
    started := now();
    UPDATE public.word_round_results
       SET started_at = started,
           ready_at = coalesce(ready_at, started)
     WHERE round_id = r.id AND user_id = auth.uid();
    UPDATE public.word_rounds
       SET status = 'running', start_at = coalesce(start_at, started)
     WHERE id = r.id
     RETURNING * INTO r;
  END IF;
  RETURN public.word_view(r, auth.uid());
END $$;

-- Keep the old RPC name callable for already-shipped clients. Its tap now starts that
-- player's own attempt instead of waiting for a two-phone ready handshake.
CREATE OR REPLACE FUNCTION public.word_ready(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN public.word_start(p_id);
END $$;

-- Validate and save only the caller's attempt, using their own start time and clock.
CREATE OR REPLACE FUNCTION public.word_submit(p_id uuid, p_words text[], p_finished_ms integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cid uuid := public.get_user_couple_id(auth.uid());
  r public.word_rounds;
  mine public.word_round_results;
  clean text[];
  elapsed integer;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM public.word_sweep(cid);
  SELECT * INTO r FROM public.word_rounds WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Word Wheel round not found.'; END IF;
  IF auth.uid() NOT IN (r.player_x, r.player_o) THEN RAISE EXCEPTION 'This is not your round.'; END IF;
  IF r.status = 'cancelled' THEN RAISE EXCEPTION 'This round was cancelled.'; END IF;
  IF r.status = 'finished' THEN RETURN public.word_view(r, auth.uid()); END IF;

  SELECT * INTO mine FROM public.word_round_results
   WHERE round_id = r.id AND user_id = auth.uid() FOR UPDATE;
  IF mine.submitted_at IS NOT NULL THEN RETURN public.word_view(r, auth.uid()); END IF;
  IF mine.started_at IS NULL THEN RAISE EXCEPTION 'Start your own Word Wheel clock first.'; END IF;
  IF now() < mine.started_at THEN RAISE EXCEPTION 'Your clock has not started yet.'; END IF;

  clean := ARRAY(
    SELECT DISTINCT lower(word)
      FROM unnest(coalesce(p_words, '{}'::text[])) AS word
     WHERE lower(word) = ANY(r.words)
       AND lower(word) ~ '^[a-z]{2,7}$'
  );

  elapsed := least(
    greatest(
      coalesce(p_finished_ms, floor(extract(epoch FROM (now() - mine.started_at)) * 1000)::integer),
      0
    ),
    r.duration_seconds * 1000
  );

  UPDATE public.word_round_results
     SET words_found = clean, finished_ms = elapsed, submitted_at = now()
   WHERE round_id = r.id AND user_id = auth.uid();

  PERFORM public.word_settle(r.id);
  SELECT * INTO r FROM public.word_rounds WHERE id = r.id;
  RETURN public.word_view(r, auth.uid());
END $$;

REVOKE ALL ON FUNCTION public.word_layout(text[]),public.word_view(public.word_rounds,uuid),
  public.word_settle(uuid),public.word_sweep(uuid),public.start_word_round(text,integer),
  public.word_start(uuid),public.word_ready(uuid),public.word_submit(uuid,text[],integer),
  public.word_cancel(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.start_word_round(text,integer),public.word_start(uuid),
  public.word_ready(uuid),public.word_submit(uuid,text[],integer),public.word_cancel(uuid),
  public.games_state() TO authenticated;

COMMIT;
-- Together tab: visit reflection and planning, scheduled Together time, idea matching,
-- and a private-by-couple memory timeline.
--
-- Additive migration: existing visit dates, books, and someday ideas are preserved.
BEGIN;

-- A once-private answer stays private until both partners have saved their wish.
CREATE TABLE IF NOT EXISTS public.visit_wishes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wish TEXT NOT NULL CHECK (char_length(btrim(wish)) BETWEEN 1 AND 240),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT visit_wishes_one_per_partner UNIQUE (visit_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_visit_wishes_couple_visit ON public.visit_wishes(couple_id, visit_id);
ALTER TABLE public.visit_wishes ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.visit_wishes_are_revealed(p_visit_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT count(DISTINCT wish.user_id) >= 2
  FROM public.visit_wishes AS wish
  JOIN public.visits AS visit ON visit.id = wish.visit_id
  WHERE wish.visit_id = p_visit_id
    AND visit.couple_id = public.get_user_couple_id(auth.uid())
$$;
REVOKE ALL ON FUNCTION public.visit_wishes_are_revealed(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.visit_wishes_are_revealed(UUID) TO authenticated;

DROP POLICY IF EXISTS visit_wishes_read ON public.visit_wishes;
CREATE POLICY visit_wishes_read ON public.visit_wishes FOR SELECT TO authenticated
USING (
  couple_id = public.get_user_couple_id(auth.uid())
  AND (user_id = auth.uid() OR public.visit_wishes_are_revealed(visit_id))
);
DROP POLICY IF EXISTS visit_wishes_insert ON public.visit_wishes;
CREATE POLICY visit_wishes_insert ON public.visit_wishes FOR INSERT TO authenticated
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid()) AND user_id = auth.uid()
  AND EXISTS (SELECT 1 FROM public.visits v WHERE v.id = visit_id AND v.couple_id = couple_id)
);
DROP POLICY IF EXISTS visit_wishes_update ON public.visit_wishes;
CREATE POLICY visit_wishes_update ON public.visit_wishes FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()) AND user_id = auth.uid())
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid()) AND user_id = auth.uid()
  AND EXISTS (SELECT 1 FROM public.visits v WHERE v.id = visit_id AND v.couple_id = couple_id)
);
GRANT SELECT, INSERT, UPDATE ON public.visit_wishes TO authenticated;
REVOKE ALL ON public.visit_wishes FROM anon;

-- A short shared checklist. Each item has one clear owner, while either partner may
-- check it off or update it as the plan changes.
CREATE TABLE IF NOT EXISTS public.visit_checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (char_length(btrim(text)) BETWEEN 1 AND 120),
  assigned_to UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  completed BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_visit_checklist_visit ON public.visit_checklist_items(couple_id, visit_id, created_at);
ALTER TABLE public.visit_checklist_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS visit_checklist_read ON public.visit_checklist_items;
CREATE POLICY visit_checklist_read ON public.visit_checklist_items FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));
DROP POLICY IF EXISTS visit_checklist_insert ON public.visit_checklist_items;
CREATE POLICY visit_checklist_insert ON public.visit_checklist_items FOR INSERT TO authenticated
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid())
  AND created_by = auth.uid()
  AND EXISTS (SELECT 1 FROM public.visits v WHERE v.id = visit_id AND v.couple_id = couple_id)
  AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = assigned_to AND p.couple_id = couple_id)
);
DROP POLICY IF EXISTS visit_checklist_update ON public.visit_checklist_items;
CREATE POLICY visit_checklist_update ON public.visit_checklist_items FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()))
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid())
  AND EXISTS (SELECT 1 FROM public.visits v WHERE v.id = visit_id AND v.couple_id = couple_id)
  AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = assigned_to AND p.couple_id = couple_id)
);
DROP POLICY IF EXISTS visit_checklist_delete ON public.visit_checklist_items;
CREATE POLICY visit_checklist_delete ON public.visit_checklist_items FOR DELETE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.visit_checklist_items TO authenticated;
REVOKE ALL ON public.visit_checklist_items FROM anon;

CREATE OR REPLACE FUNCTION public.guard_visit_checklist_item()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.couple_id IS DISTINCT FROM OLD.couple_id
    OR NEW.visit_id IS DISTINCT FROM OLD.visit_id
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
  ) THEN
    RAISE EXCEPTION 'A checklist item stays with its visit and creator.';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_visit_checklist_item ON public.visit_checklist_items;
CREATE TRIGGER guard_visit_checklist_item
BEFORE UPDATE ON public.visit_checklist_items
FOR EACH ROW EXECUTE FUNCTION public.guard_visit_checklist_item();

-- Give existing someday ideas an open-by-default visibility to preserve today's
-- shared-list behaviour. A linked idea can be placed on a specific visit day.
ALTER TABLE public.someday_items
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS visit_date DATE;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'someday_visibility_check'
      AND conrelid = 'public.someday_items'::regclass
  ) THEN
    ALTER TABLE public.someday_items
      ADD CONSTRAINT someday_visibility_check CHECK (visibility IN ('open', 'private'));
  END IF;
END $$;
UPDATE public.someday_items AS item
SET visit_date = visit.start_date
FROM public.visits AS visit
WHERE item.visit_id = visit.id AND item.visit_date IS NULL;

CREATE OR REPLACE FUNCTION public.guard_someday_item_visibility_and_day()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE
  planned_visit public.visits;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'An idea stays with the partner who added it.';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.visibility IS DISTINCT FROM OLD.visibility AND auth.uid() IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Only the person who added a private idea can share it.';
  END IF;
  IF NEW.visit_id IS NULL THEN
    NEW.visit_date := NULL;
    RETURN NEW;
  END IF;
  IF NEW.visibility <> 'open' THEN
    RAISE EXCEPTION 'Share this idea before adding it to a visit.';
  END IF;
  SELECT * INTO planned_visit FROM public.visits
  WHERE id = NEW.visit_id AND couple_id = NEW.couple_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That visit is not part of your plans.'; END IF;
  IF NEW.visit_date IS NULL THEN NEW.visit_date := planned_visit.start_date; END IF;
  IF NEW.visit_date < planned_visit.start_date
     OR NEW.visit_date > coalesce(planned_visit.end_date, planned_visit.start_date) THEN
    RAISE EXCEPTION 'Choose a day inside this visit.';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_someday_item_visit ON public.someday_items;
DROP TRIGGER IF EXISTS guard_someday_item_visibility_and_day ON public.someday_items;
CREATE TRIGGER guard_someday_item_visibility_and_day
BEFORE INSERT OR UPDATE OF visit_id, visit_date, visibility, couple_id, created_by
ON public.someday_items FOR EACH ROW
EXECUTE FUNCTION public.guard_someday_item_visibility_and_day();

DROP POLICY IF EXISTS someday_items_read ON public.someday_items;
CREATE POLICY someday_items_read ON public.someday_items FOR SELECT TO authenticated
USING (
  couple_id = public.get_user_couple_id(auth.uid())
  AND (visibility = 'open' OR created_by = auth.uid())
);
DROP POLICY IF EXISTS someday_items_insert ON public.someday_items;
CREATE POLICY someday_items_insert ON public.someday_items FOR INSERT TO authenticated
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()) AND created_by = auth.uid());
DROP POLICY IF EXISTS someday_items_update ON public.someday_items;
CREATE POLICY someday_items_update ON public.someday_items FOR UPDATE TO authenticated
USING (
  couple_id = public.get_user_couple_id(auth.uid())
  AND (visibility = 'open' OR created_by = auth.uid())
)
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()));
DROP POLICY IF EXISTS someday_items_delete ON public.someday_items;
CREATE POLICY someday_items_delete ON public.someday_items FOR DELETE TO authenticated
USING (
  couple_id = public.get_user_couple_id(auth.uid())
  AND (visibility = 'open' OR created_by = auth.uid())
);

-- Each partner can quietly record whether they want to do an open idea. For a private
-- idea, only its author can add/read their own vote; making it open reveals the match.
CREATE TABLE IF NOT EXISTS public.someday_item_votes (
  idea_id UUID NOT NULL REFERENCES public.someday_items(id) ON DELETE CASCADE,
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (idea_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_someday_item_votes_couple ON public.someday_item_votes(couple_id, idea_id);
ALTER TABLE public.someday_item_votes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS someday_item_votes_read ON public.someday_item_votes;
CREATE POLICY someday_item_votes_read ON public.someday_item_votes FOR SELECT TO authenticated
USING (
  couple_id = public.get_user_couple_id(auth.uid())
  AND EXISTS (
    SELECT 1 FROM public.someday_items idea
    WHERE idea.id = idea_id AND idea.couple_id = couple_id
      AND (idea.visibility = 'open' OR idea.created_by = auth.uid())
  )
);
DROP POLICY IF EXISTS someday_item_votes_insert ON public.someday_item_votes;
CREATE POLICY someday_item_votes_insert ON public.someday_item_votes FOR INSERT TO authenticated
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid()) AND user_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.someday_items idea
    WHERE idea.id = idea_id AND idea.couple_id = couple_id
      AND (idea.visibility = 'open' OR idea.created_by = auth.uid())
  )
);
DROP POLICY IF EXISTS someday_item_votes_delete ON public.someday_item_votes;
CREATE POLICY someday_item_votes_delete ON public.someday_item_votes FOR DELETE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()) AND user_id = auth.uid());
GRANT SELECT, INSERT, DELETE ON public.someday_item_votes TO authenticated;
REVOKE ALL ON public.someday_item_votes FROM anon;

-- A shared activity at a specific time. It starts as a suggestion ('proposed') from
-- one partner and only locks in ('scheduled', with one reminder for both partners)
-- when the other partner agrees to the exact time suggested.
CREATE TABLE IF NOT EXISTS public.together_time_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  activity_type TEXT NOT NULL CHECK (activity_type IN ('book', 'game')),
  activity_id TEXT NOT NULL CHECK (char_length(btrim(activity_id)) BETWEEN 1 AND 80),
  activity_name TEXT NOT NULL CHECK (char_length(btrim(activity_name)) BETWEEN 1 AND 120),
  scheduled_at TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'scheduled', 'done', 'cancelled')),
  proposed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  agreed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  agreed_at TIMESTAMPTZ,
  reminder_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS idx_together_time_due ON public.together_time_sessions(scheduled_at)
  WHERE status = 'scheduled' AND reminder_sent_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_together_time_couple ON public.together_time_sessions(couple_id, scheduled_at);
ALTER TABLE public.together_time_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS together_time_read ON public.together_time_sessions;
CREATE POLICY together_time_read ON public.together_time_sessions FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));
DROP POLICY IF EXISTS together_time_insert ON public.together_time_sessions;
CREATE POLICY together_time_insert ON public.together_time_sessions FOR INSERT TO authenticated
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()) AND created_by = auth.uid());
DROP POLICY IF EXISTS together_time_update ON public.together_time_sessions;
CREATE POLICY together_time_update ON public.together_time_sessions FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()))
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()));
GRANT SELECT, INSERT, UPDATE ON public.together_time_sessions TO authenticated;
REVOKE ALL ON public.together_time_sessions FROM anon;

CREATE OR REPLACE FUNCTION public.guard_together_time_session()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE
  actor UUID := auth.uid();
  plan_changed BOOLEAN;
BEGIN
  IF NEW.activity_type = 'game' AND NEW.activity_id NOT IN (
    'rock-paper-scissors', 'snake', 'chess', 'sudoku', 'tetris',
    'connect-four', 'dash-duel', 'word-wheel'
  ) THEN
    RAISE EXCEPTION 'Choose one of the games in Nooki.';
  END IF;
  IF NEW.activity_type = 'book' AND NOT EXISTS (
    SELECT 1 FROM public.shared_books
    WHERE id::text = NEW.activity_id AND couple_id = NEW.couple_id
  ) THEN
    RAISE EXCEPTION 'Choose a book from your shared shelf.';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF actor IS NOT NULL THEN
      IF NEW.status <> 'proposed' THEN
        RAISE EXCEPTION 'A Together time starts as a suggestion. It locks in when your partner agrees.';
      END IF;
      NEW.proposed_by := actor;
      NEW.agreed_by := NULL;
      NEW.agreed_at := NULL;
      NEW.reminder_sent_at := NULL;
    ELSIF NEW.proposed_by IS NULL THEN
      NEW.proposed_by := NEW.created_by;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.couple_id <> OLD.couple_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'A scheduled date stays with the couple who made it.';
  END IF;
  IF actor IS NOT NULL
     AND NEW.reminder_sent_at IS DISTINCT FROM OLD.reminder_sent_at THEN
    RAISE EXCEPTION 'Only the reminder service can change reminder status.';
  END IF;

  IF actor IS NOT NULL THEN
    plan_changed := NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
      OR NEW.timezone IS DISTINCT FROM OLD.timezone
      OR NEW.activity_type IS DISTINCT FROM OLD.activity_type
      OR NEW.activity_id IS DISTINCT FROM OLD.activity_id
      OR NEW.activity_name IS DISTINCT FROM OLD.activity_name;

    IF OLD.status IN ('done', 'cancelled') AND NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'That Together time is over. Suggest a new one instead.';
    END IF;
    IF OLD.status = 'proposed' AND NEW.status = 'done' THEN
      RAISE EXCEPTION 'Agree on a time together before marking it done.';
    END IF;

    IF OLD.status = 'proposed' AND NEW.status = 'scheduled' THEN
      IF actor IS NOT DISTINCT FROM OLD.proposed_by THEN
        RAISE EXCEPTION 'Your partner needs to agree before this locks in.';
      END IF;
      IF plan_changed THEN
        RAISE EXCEPTION 'Agree to the suggested time as it is, or suggest a different one.';
      END IF;
      NEW.proposed_by := OLD.proposed_by;
      NEW.agreed_by := actor;
      NEW.agreed_at := now();
    ELSIF NEW.status = 'proposed' AND (OLD.status = 'scheduled' OR plan_changed) THEN
      -- Whoever just (re)suggested now waits for the other partner to agree.
      NEW.proposed_by := actor;
      NEW.agreed_by := NULL;
      NEW.agreed_at := NULL;
      NEW.reminder_sent_at := NULL;
    ELSIF OLD.status = 'scheduled' AND NEW.status = 'scheduled' AND plan_changed THEN
      RAISE EXCEPTION 'This time is locked in. Suggest a different time and let your partner agree.';
    ELSE
      -- Done/cancelled and no-op updates keep the agreement record as it was.
      NEW.proposed_by := OLD.proposed_by;
      NEW.agreed_by := OLD.agreed_by;
      NEW.agreed_at := OLD.agreed_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_together_time_session ON public.together_time_sessions;
CREATE TRIGGER guard_together_time_session
BEFORE INSERT OR UPDATE ON public.together_time_sessions
FOR EACH ROW EXECUTE FUNCTION public.guard_together_time_session();

-- Each partner contributes one photo and one short line after a visit ends.
CREATE TABLE IF NOT EXISTS public.visit_memory_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  photo_path TEXT NOT NULL,
  note TEXT NOT NULL CHECK (char_length(btrim(note)) BETWEEN 1 AND 240),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT visit_memory_one_per_partner UNIQUE (visit_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_visit_memories_timeline ON public.visit_memory_entries(couple_id, visit_id, created_at DESC);
ALTER TABLE public.visit_memory_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS visit_memories_read ON public.visit_memory_entries;
CREATE POLICY visit_memories_read ON public.visit_memory_entries FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));
DROP POLICY IF EXISTS visit_memories_insert ON public.visit_memory_entries;
CREATE POLICY visit_memories_insert ON public.visit_memory_entries FOR INSERT TO authenticated
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()) AND user_id = auth.uid());
DROP POLICY IF EXISTS visit_memories_update ON public.visit_memory_entries;
CREATE POLICY visit_memories_update ON public.visit_memory_entries FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()) AND user_id = auth.uid())
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()) AND user_id = auth.uid());
GRANT SELECT, INSERT, UPDATE ON public.visit_memory_entries TO authenticated;
REVOKE ALL ON public.visit_memory_entries FROM anon;

CREATE OR REPLACE FUNCTION public.guard_visit_memory_entry()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE ended DATE; visit_timezone TEXT;
BEGIN
  IF NEW.couple_id <> public.get_user_couple_id(auth.uid()) OR NEW.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'This memory does not belong to your couple.';
  END IF;
  SELECT coalesce(end_date, start_date), coalesce(timezone, 'UTC') INTO ended, visit_timezone FROM public.visits
  WHERE id = NEW.visit_id AND couple_id = NEW.couple_id;
  IF ended IS NULL THEN RAISE EXCEPTION 'That visit is not part of your plans.'; END IF;
  IF ended >= (now() AT TIME ZONE visit_timezone)::date THEN RAISE EXCEPTION 'Save this memory after your visit ends.'; END IF;
  IF NEW.photo_path !~ ('^memories/' || NEW.couple_id::text || '/' || NEW.user_id::text || '/' || NEW.visit_id::text || '/[^/]+[.](jpg|jpeg|png|webp|heic|heif)$') THEN
    RAISE EXCEPTION 'Choose a photo for this visit.';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_visit_memory_entry ON public.visit_memory_entries;
CREATE TRIGGER guard_visit_memory_entry
BEFORE INSERT OR UPDATE ON public.visit_memory_entries
FOR EACH ROW EXECUTE FUNCTION public.guard_visit_memory_entry();

-- Private storage for memory photos. Every file is readable by the couple, writable
-- only in the uploader's own folder. Database rows enforce the visit/user/path match.
DO $memory_storage$
DECLARE has_size_limit BOOLEAN; has_mime_types BOOLEAN;
BEGIN
  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN RETURN; END IF;
  INSERT INTO storage.buckets (id, name, public)
  VALUES ('visit-memories', 'visit-memories', false)
  ON CONFLICT (id) DO UPDATE SET public = false;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit'
  ) INTO has_size_limit;
  IF has_size_limit THEN EXECUTE 'UPDATE storage.buckets SET file_size_limit = 10485760 WHERE id = ''visit-memories'''; END IF;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'allowed_mime_types'
  ) INTO has_mime_types;
  IF has_mime_types THEN
    EXECUTE $sql$UPDATE storage.buckets SET allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] WHERE id = 'visit-memories'$sql$;
  END IF;
  EXECUTE 'DROP POLICY IF EXISTS "Couple can read visit memory photos" ON storage.objects';
  EXECUTE $sql$CREATE POLICY "Couple can read visit memory photos" ON storage.objects FOR SELECT TO authenticated
    USING (bucket_id = 'visit-memories' AND (storage.foldername(name))[1] = 'memories'
      AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text)$sql$;
  EXECUTE 'DROP POLICY IF EXISTS "Partners can upload their own memory photos" ON storage.objects';
  EXECUTE $sql$CREATE POLICY "Partners can upload their own memory photos" ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'visit-memories' AND (storage.foldername(name))[1] = 'memories'
      AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text
      AND (storage.foldername(name))[3] = auth.uid()::text)$sql$;
  EXECUTE 'DROP POLICY IF EXISTS "Partners can replace their own memory photos" ON storage.objects';
  EXECUTE $sql$CREATE POLICY "Partners can replace their own memory photos" ON storage.objects FOR UPDATE TO authenticated
    USING (bucket_id = 'visit-memories' AND (storage.foldername(name))[1] = 'memories'
      AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text
      AND (storage.foldername(name))[3] = auth.uid()::text)
    WITH CHECK (bucket_id = 'visit-memories' AND (storage.foldername(name))[1] = 'memories'
      AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text
      AND (storage.foldername(name))[3] = auth.uid()::text)$sql$;
  EXECUTE 'DROP POLICY IF EXISTS "Partners can remove their own memory photos" ON storage.objects';
  EXECUTE $sql$CREATE POLICY "Partners can remove their own memory photos" ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'visit-memories' AND (storage.foldername(name))[1] = 'memories'
      AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text
      AND (storage.foldername(name))[3] = auth.uid()::text)$sql$;
END
$memory_storage$;

-- Called only by the trusted push function every minute. Marking rows in one locked
-- transaction prevents two overlapping sweeps from notifying the same couple twice.
CREATE OR REPLACE FUNCTION public.claim_due_together_time_reminders()
RETURNS TABLE (
  id UUID,
  couple_id UUID,
  activity_type TEXT,
  activity_id TEXT,
  activity_name TEXT,
  scheduled_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT session.id
    FROM public.together_time_sessions AS session
    WHERE session.status = 'scheduled'
      AND session.reminder_sent_at IS NULL
      AND session.scheduled_at <= now()
      AND session.scheduled_at >= now() - interval '1 day'
    ORDER BY session.scheduled_at
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.together_time_sessions AS session
  SET reminder_sent_at = now(), updated_at = now()
  FROM due
  WHERE session.id = due.id
  RETURNING session.id, session.couple_id, session.activity_type,
    session.activity_id, session.activity_name, session.scheduled_at;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_due_together_time_reminders() FROM PUBLIC, anon, authenticated;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.claim_due_together_time_reminders() TO service_role;
  END IF;
END $$;

-- pg_cron calls this every minute; the URL and shared webhook secret live only in
-- Supabase Vault, never in a migration or on a partner's device.
CREATE OR REPLACE FUNCTION public.invoke_together_time_reminder_sweep()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE endpoint TEXT; webhook_secret TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')
     OR to_regclass('vault.decrypted_secrets') IS NULL THEN
    RETURN;
  END IF;
  SELECT decrypted_secret INTO endpoint FROM vault.decrypted_secrets WHERE name = 'nooki_send_push_url' LIMIT 1;
  SELECT decrypted_secret INTO webhook_secret FROM vault.decrypted_secrets WHERE name = 'nooki_push_webhook_secret' LIMIT 1;
  IF endpoint IS NULL OR webhook_secret IS NULL THEN RETURN; END IF;
  PERFORM net.http_post(
    url := endpoint,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || webhook_secret),
    body := jsonb_build_object('type', 'SCHEDULED', 'table', 'together_time_sessions'),
    timeout_milliseconds := 10000
  );
END;
$$;
REVOKE ALL ON FUNCTION public.invoke_together_time_reminder_sweep() FROM PUBLIC, anon, authenticated;

-- Supabase commonly enables pg_cron and pg_net for projects. On an instance where either
-- extension is not enabled yet, the migration stays safe; enable both and rerun this
-- schedule block (or schedule the same SELECT from the SQL editor).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    EXECUTE 'SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = ''nooki-together-time-reminders''';
    PERFORM cron.schedule(
      'nooki-together-time-reminders',
      '* * * * *',
      'SELECT public.invoke_together_time_reminder_sweep();'
    );
  END IF;
END $$;

-- Realtime keeps the shared cards fresh on both phones.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'visit_wishes') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.visit_wishes;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'visit_checklist_items') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.visit_checklist_items;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'someday_item_votes') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.someday_item_votes;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'together_time_sessions') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.together_time_sessions;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'visit_memory_entries') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.visit_memory_entries;
    END IF;
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- Remove Read together (shared books).
-- Mirrors supabase/migrations/202610190006_remove_shared_books.sql.
-- The shelf, reader, highlights and chat-to-book link are retired. Together time
-- schedules games only. Quoted chat text stays on the message itself.
-- ============================================================================

-- Retire Read together. The Together tab no longer has a shared shelf, a reader,
-- or a highlight-to-chat bridge. Book files, shelf rows, saved places and margin
-- notes are removed rather than left unreachable. A chat message that quoted a
-- passage keeps its own words (they were stored on the message); only the link
-- back into a book goes away. Together time can only schedule a game.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.together_time_sessions') IS NULL
     OR to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'Apply the Together tab and chat migrations before 202610190006_remove_shared_books.sql.';
  END IF;
END $$;

-- A book date has nothing left to open. Drop it before the activity check tightens.
DELETE FROM public.together_time_sessions WHERE activity_type = 'book';

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'together_time_sessions'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%activity_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.together_time_sessions DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE public.together_time_sessions
  DROP CONSTRAINT IF EXISTS together_time_sessions_activity_type_check;
ALTER TABLE public.together_time_sessions
  ADD CONSTRAINT together_time_sessions_activity_type_check
  CHECK (activity_type = 'game');

-- The agreement rules stay. The only change is that a book is no longer a valid activity.
CREATE OR REPLACE FUNCTION public.guard_together_time_session()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE
  actor UUID := auth.uid();
  plan_changed BOOLEAN;
BEGIN
  IF NEW.activity_type IS DISTINCT FROM 'game' THEN
    RAISE EXCEPTION 'Choose a game to play together.';
  END IF;
  IF NEW.activity_id NOT IN (
    'rock-paper-scissors', 'snake', 'chess', 'sudoku', 'tetris',
    'connect-four', 'dash-duel', 'word-wheel'
  ) THEN
    RAISE EXCEPTION 'Choose one of the games in Nooki.';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF actor IS NOT NULL THEN
      IF NEW.status <> 'proposed' THEN
        RAISE EXCEPTION 'A Together time starts as a suggestion. It locks in when your partner agrees.';
      END IF;
      NEW.proposed_by := actor;
      NEW.agreed_by := NULL;
      NEW.agreed_at := NULL;
      NEW.reminder_sent_at := NULL;
    ELSIF NEW.proposed_by IS NULL THEN
      NEW.proposed_by := NEW.created_by;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.couple_id <> OLD.couple_id OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'A scheduled date stays with the couple who made it.';
  END IF;
  IF actor IS NOT NULL
     AND NEW.reminder_sent_at IS DISTINCT FROM OLD.reminder_sent_at THEN
    RAISE EXCEPTION 'Only the reminder service can change reminder status.';
  END IF;

  IF actor IS NOT NULL THEN
    plan_changed := NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
      OR NEW.timezone IS DISTINCT FROM OLD.timezone
      OR NEW.activity_type IS DISTINCT FROM OLD.activity_type
      OR NEW.activity_id IS DISTINCT FROM OLD.activity_id
      OR NEW.activity_name IS DISTINCT FROM OLD.activity_name;

    IF OLD.status IN ('done', 'cancelled') AND NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'That Together time is over. Suggest a new one instead.';
    END IF;
    IF OLD.status = 'proposed' AND NEW.status = 'done' THEN
      RAISE EXCEPTION 'Agree on a time together before marking it done.';
    END IF;

    IF OLD.status = 'proposed' AND NEW.status = 'scheduled' THEN
      IF actor IS NOT DISTINCT FROM OLD.proposed_by THEN
        RAISE EXCEPTION 'Your partner needs to agree before this locks in.';
      END IF;
      IF plan_changed THEN
        RAISE EXCEPTION 'Agree to the suggested time as it is, or suggest a different one.';
      END IF;
      NEW.proposed_by := OLD.proposed_by;
      NEW.agreed_by := actor;
      NEW.agreed_at := now();
    ELSIF NEW.status = 'proposed' AND (OLD.status = 'scheduled' OR plan_changed) THEN
      NEW.proposed_by := actor;
      NEW.agreed_by := NULL;
      NEW.agreed_at := NULL;
      NEW.reminder_sent_at := NULL;
    ELSIF OLD.status = 'scheduled' AND NEW.status = 'scheduled' AND plan_changed THEN
      RAISE EXCEPTION 'This time is locked in. Suggest a different time and let your partner agree.';
    ELSE
      NEW.proposed_by := OLD.proposed_by;
      NEW.agreed_by := OLD.agreed_by;
      NEW.agreed_at := OLD.agreed_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Chat no longer links a bubble to a book passage. Replace the guard and the send
-- policy before the column goes, so neither still names it.
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
    NEW.edited_at := timezone('utc'::text, now());
  ELSIF NEW.edited_at IS DISTINCT FROM OLD.edited_at THEN
    RAISE EXCEPTION 'The edit stamp only moves when the words do.';
  END IF;

  RETURN NEW;
END;
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

ALTER TABLE public.messages DROP COLUMN IF EXISTS highlight_id;
DROP FUNCTION IF EXISTS public.highlight_is_in_couple(UUID, UUID);

DO $$
DECLARE t TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['shared_books', 'reading_progress', 'highlights'] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

DROP TABLE IF EXISTS public.reading_progress;
DROP TABLE IF EXISTS public.highlights;
DROP TABLE IF EXISTS public.shared_books;

DROP FUNCTION IF EXISTS public.guard_book_immutable();
DROP FUNCTION IF EXISTS public.guard_book_limit();
DROP FUNCTION IF EXISTS public.set_reading_progress_updated_at();

DO $drop_books_storage$
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'DROP POLICY IF EXISTS "Couple members can read their book files" ON storage.objects';
  EXECUTE 'DROP POLICY IF EXISTS "Couple members can upload their book files" ON storage.objects';
  EXECUTE 'DROP POLICY IF EXISTS "Couple members can delete their book files" ON storage.objects';
  -- Hosted Supabase refuses direct deletes from storage.objects and storage.buckets
  -- (storage.protect_delete). A local database still accepts them. Either way the
  -- policies are gone, so a phone can no longer read the files.
  BEGIN
    DELETE FROM storage.objects WHERE bucket_id = 'shared-books';
    IF to_regclass('storage.buckets') IS NOT NULL THEN
      DELETE FROM storage.buckets WHERE id = 'shared-books';
    END IF;
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
  END;
END
$drop_books_storage$;

COMMIT;

-- ============================================================================
-- 202610190007_someday_notebook_and_remove_together_time.sql
-- Mirror the latest migration: the Together tab is a plain shared task notebook.
-- ============================================================================
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE 'SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = ''nooki-together-time-reminders''';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.invoke_together_time_reminder_sweep();
DROP FUNCTION IF EXISTS public.claim_due_together_time_reminders();
DROP TABLE IF EXISTS public.together_time_sessions CASCADE;
DROP FUNCTION IF EXISTS public.guard_together_time_session();

DROP TRIGGER IF EXISTS guard_someday_item_visit ON public.someday_items;
DROP TRIGGER IF EXISTS guard_someday_item_visibility_and_day ON public.someday_items;
DROP FUNCTION IF EXISTS public.guard_someday_item_visibility_and_day();
DROP TABLE IF EXISTS public.someday_item_votes CASCADE;
DROP POLICY IF EXISTS someday_items_read ON public.someday_items;
DROP POLICY IF EXISTS someday_items_update ON public.someday_items;
DROP POLICY IF EXISTS someday_items_delete ON public.someday_items;
ALTER TABLE public.someday_items DROP CONSTRAINT IF EXISTS someday_visibility_check;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'someday_items' AND column_name = 'visibility') THEN
    UPDATE public.someday_items SET visibility = 'open' WHERE visibility IS DISTINCT FROM 'open';
  END IF;
END $$;
ALTER TABLE public.someday_items DROP COLUMN IF EXISTS visibility;

CREATE OR REPLACE FUNCTION public.guard_someday_item_visit()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE planned_visit public.visits;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'A task stays with the partner who added it.';
  END IF;
  IF NEW.visit_id IS NULL THEN
    NEW.visit_date := NULL;
    RETURN NEW;
  END IF;
  SELECT * INTO planned_visit FROM public.visits
    WHERE id = NEW.visit_id AND couple_id = NEW.couple_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That visit is not part of your plans.'; END IF;
  IF NEW.visit_date IS NULL THEN NEW.visit_date := planned_visit.start_date; END IF;
  IF NEW.visit_date < planned_visit.start_date
     OR NEW.visit_date > coalesce(planned_visit.end_date, planned_visit.start_date) THEN
    RAISE EXCEPTION 'Choose a day inside this visit.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_someday_item_visit
BEFORE INSERT OR UPDATE OF visit_id, visit_date, couple_id, created_by
ON public.someday_items FOR EACH ROW
EXECUTE FUNCTION public.guard_someday_item_visit();

DROP POLICY IF EXISTS someday_items_read ON public.someday_items;
CREATE POLICY someday_items_read ON public.someday_items FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));
DROP POLICY IF EXISTS someday_items_update ON public.someday_items;
CREATE POLICY someday_items_update ON public.someday_items FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()))
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()));
DROP POLICY IF EXISTS someday_items_delete ON public.someday_items;
CREATE POLICY someday_items_delete ON public.someday_items FOR DELETE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));


-- ===========================================================================
-- Epistles: long, sealed letters written to each other, kept apart from the
-- chat. A letter is a draft (sealed_at NULL, the sender's alone), then sealed
-- (standing in the partner's mailbox with the wax intact), optionally waiting
-- for a chosen day (opens_at), and finally opened — the moment it becomes a
-- final keepsake for both. See supabase/migrations/202610200001_epistles.sql;
-- this section matches it, and the migration stays rerunnable over it.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.epistles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  -- Who wrote it. The row carries the author's own words.
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- An optional name for the letter, shown on the envelope.
  title TEXT CHECK (char_length(btrim(title)) <= 80),
  -- The letter itself. Long-form on purpose: at most 20,000 characters.
  body TEXT NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 20000),
  -- NULL while it is a draft. Sealing stamps the moment it was sent.
  sealed_at TIMESTAMPTZ,
  -- The calendar day before which the partner's seal refuses to break.
  opens_at DATE,
  -- When the partner broke the seal; once set, the letter is final for both.
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

-- Rewriting: while the letter has not been opened it still belongs to its author.
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

-- The one write the partner ever makes: breaking the seal. "Is it the day yet?"
-- is answered by the server's own clock, never the phone's.
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
    RETURN QUERY SELECT * FROM public.epistles WHERE id = p_epistle_id;
    RETURN;
  END IF;
  IF letter.opens_at IS NOT NULL AND letter.opens_at > (timezone('utc'::text, now()))::date THEN
    RAISE EXCEPTION 'This letter opens on %. Not yet.', letter.opens_at;
  END IF;

  UPDATE public.epistles
  SET opened_at = timezone('utc'::text, now())
  WHERE id = p_epistle_id;

  RETURN QUERY SELECT * FROM public.epistles WHERE id = p_epistle_id;
END;
$$;

-- Every role that reaches this table is granted here, by name: Supabase stopped
-- granting Data API access to new "public" tables automatically (2026-10-30).
-- service_role matters: send-push counts unopened letters with the service key.
REVOKE ALL ON public.epistles FROM anon;
REVOKE ALL ON public.epistles FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.epistles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.epistles TO service_role;

REVOKE ALL ON FUNCTION public.open_epistle(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_epistle(UUID) TO authenticated;

-- Realtime: a sealed letter appears in the partner's mailbox without a refresh.
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

-- ===========================================================================
-- Data API exposure for service_role, spelled out.
--
-- Until 2026-10-30 Supabase granted every new "public" table to anon,
-- authenticated and service_role automatically; new and existing projects stop
-- receiving those automatic grants for tables created from that date onwards.
-- The sections above always granted anon and authenticated explicitly, so the
-- couple's own access never depended on the defaults — but service_role did:
-- nothing in this file ever granted it, because the platform did. send-push
-- runs with the service key and reads profiles, messages, push_subscriptions,
-- question_sessions, answers, game_matches and epistles directly, so on a
-- project built from this file after the cutover those reads would fail with
-- "permission denied" without the grant below. This restores exactly what the
-- old defaults did, for every table this schema ends up with (service_role
-- bypasses RLS anyway, so this changes reachability, not row visibility).
-- ===========================================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END;
$$;

COMMIT;
-- Truth or Dare: additive tables only. Existing profiles, couples and game tables are
-- intentionally left untouched. Age is read from an existing DOB column when present;
-- otherwise the player can store a one-time, self-reported age threshold here.
BEGIN;

CREATE TABLE IF NOT EXISTS public.tod_prompts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('truth', 'dare')),
  theme TEXT NOT NULL CHECK (theme IN ('random', 'flirty', 'spicy')),
  intensity SMALLINT NOT NULL CHECK (intensity BETWEEN 1 AND 5),
  text TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  mode TEXT NOT NULL CHECK (mode IN ('text', 'voice', 'video_call', 'solo')),
  active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tod_prompts_text_length CHECK (
    char_length(btrim(text)) BETWEEN 1 AND CASE type WHEN 'truth' THEN 199 ELSE 279 END
  ),
  CONSTRAINT tod_prompts_bucket_text_unique UNIQUE (type, theme, intensity, text)
);

CREATE INDEX IF NOT EXISTS tod_prompts_active_bucket
  ON public.tod_prompts (theme, type, intensity)
  WHERE active = true;

ALTER TABLE public.tod_prompts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tod_prompts_read_active ON public.tod_prompts;
CREATE POLICY tod_prompts_read_active ON public.tod_prompts
  FOR SELECT TO authenticated USING (active = true);
REVOKE ALL ON public.tod_prompts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tod_prompts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tod_prompts TO service_role;

-- One open round per couple. A selected prompt is snapshotted in the room so both
-- phones continue to see it even if an owner later pauses that prompt in the library.
CREATE TABLE IF NOT EXISTS public.tod_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  theme TEXT NOT NULL CHECK (theme IN ('random', 'flirty', 'spicy')),
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  player_one UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  player_two UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  turn_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'inviting'
    CHECK (status IN ('inviting', 'active', 'paused', 'ended')),
  accepted_by UUID[] NOT NULL DEFAULT '{}',
  current_prompt JSONB,
  completed_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  CONSTRAINT tod_rounds_two_distinct_players CHECK (player_one <> player_two),
  CONSTRAINT tod_rounds_prompt_object CHECK (
    current_prompt IS NULL OR jsonb_typeof(current_prompt) = 'object'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS tod_one_open_round_per_couple
  ON public.tod_rounds (couple_id)
  WHERE status IN ('inviting', 'active', 'paused');
CREATE INDEX IF NOT EXISTS tod_rounds_couple_recent
  ON public.tod_rounds (couple_id, created_at DESC);

ALTER TABLE public.tod_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tod_rounds REPLICA IDENTITY FULL;
DROP POLICY IF EXISTS tod_rounds_read_couple ON public.tod_rounds;
CREATE POLICY tod_rounds_read_couple ON public.tod_rounds
  FOR SELECT TO authenticated
  USING (couple_id = public.get_user_couple_id(auth.uid()));
REVOKE ALL ON public.tod_rounds FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tod_rounds TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tod_rounds TO service_role;

-- The prompt history is private to the database functions. Its unique key means a
-- couple sees each row once per theme/type pool, including prompts they skip. When an
-- entire pool is exhausted, only that bucket's history is cleared and it can cycle.
CREATE TABLE IF NOT EXISTS public.tod_seen_prompts (
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  prompt_id TEXT NOT NULL REFERENCES public.tod_prompts(id) ON DELETE CASCADE,
  round_id UUID NOT NULL REFERENCES public.tod_rounds(id) ON DELETE CASCADE,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (couple_id, prompt_id)
);
CREATE INDEX IF NOT EXISTS tod_seen_prompts_round ON public.tod_seen_prompts (round_id);
ALTER TABLE public.tod_seen_prompts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tod_seen_prompts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tod_seen_prompts TO service_role;

CREATE TABLE IF NOT EXISTS public.tod_age_confirmations (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  attested_minimum_age SMALLINT NOT NULL CHECK (attested_minimum_age IN (18, 20)),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- DOB is intentionally discovered from the profile row as JSON so this migration does
-- not add or alter a profiles column. This supports date_of_birth (and common legacy
-- spellings) if a project already has one.
CREATE OR REPLACE FUNCTION public.tod_birth_date(p_user_id UUID)
RETURNS DATE
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_value TEXT;
BEGIN
  SELECT coalesce(
    to_jsonb(p) ->> 'date_of_birth',
    to_jsonb(p) ->> 'birth_date',
    to_jsonb(p) ->> 'dob'
  ) INTO v_value
  FROM public.profiles p
  WHERE p.id = p_user_id;

  IF v_value IS NULL OR v_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RETURN NULL;
  END IF;
  BEGIN
    RETURN v_value::DATE;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.tod_age_tier(p_user_id UUID)
RETURNS SMALLINT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_birth DATE; v_attested SMALLINT; v_years INTEGER;
BEGIN
  IF p_user_id IS NULL THEN RETURN 0; END IF;
  v_birth := public.tod_birth_date(p_user_id);
  IF v_birth IS NOT NULL THEN
    v_years := extract(year FROM age(current_date, v_birth))::INTEGER;
    RETURN CASE WHEN v_years >= 20 THEN 20 WHEN v_years >= 18 THEN 18 ELSE 0 END;
  END IF;
  SELECT attested_minimum_age INTO v_attested
  FROM public.tod_age_confirmations
  WHERE user_id = p_user_id;
  RETURN coalesce(v_attested, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.tod_age_source(p_user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF public.tod_birth_date(p_user_id) IS NOT NULL THEN RETURN 'date_of_birth'; END IF;
  IF EXISTS (SELECT 1 FROM public.tod_age_confirmations WHERE user_id = p_user_id) THEN
    RETURN 'confirmation';
  END IF;
  RETURN 'missing';
END;
$$;

-- Spicy is locked until marriage verification exists. Age and relationship status are not
-- proof of marriage, so no client path may open the theme. Replace this function when
-- marriage verification ships, then re-activate the reviewed Spicy prompts and restore
-- the Spicy bucket in public.tod_state().
CREATE OR REPLACE FUNCTION public.tod_theme_locked(p_theme TEXT)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(p_theme = 'spicy', false);
$$;

ALTER TABLE public.tod_age_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tod_age_confirmations REPLICA IDENTITY FULL;
DROP POLICY IF EXISTS tod_age_confirmations_read_couple ON public.tod_age_confirmations;
CREATE POLICY tod_age_confirmations_read_couple ON public.tod_age_confirmations
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR (
      public.get_user_couple_id(user_id) IS NOT NULL
      AND public.get_user_couple_id(user_id) = public.get_user_couple_id(auth.uid())
    )
  );
REVOKE ALL ON public.tod_age_confirmations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tod_age_confirmations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tod_age_confirmations TO service_role;

CREATE OR REPLACE FUNCTION public.tod_confirm_age(p_minimum_age SMALLINT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_user UUID := auth.uid();
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Sign in to confirm your age.'; END IF;
  IF p_minimum_age NOT IN (18, 20) THEN RAISE EXCEPTION 'Choose a valid age confirmation.'; END IF;
  IF public.tod_birth_date(v_user) IS NOT NULL THEN
    RAISE EXCEPTION 'Your date of birth is already on file.';
  END IF;
  INSERT INTO public.tod_age_confirmations (user_id, attested_minimum_age, confirmed_at)
  VALUES (v_user, p_minimum_age, now())
  ON CONFLICT (user_id) DO UPDATE
    SET attested_minimum_age = greatest(
          public.tod_age_confirmations.attested_minimum_age,
          EXCLUDED.attested_minimum_age
        ),
        confirmed_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.tod_state()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user UUID := auth.uid();
  v_couple UUID;
  v_partner UUID;
  v_round JSONB;
  v_counts JSONB;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Sign in to play.'; END IF;
  v_couple := public.get_user_couple_id(v_user);
  IF v_couple IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT p.id INTO v_partner
    FROM public.profiles p
    WHERE p.couple_id = v_couple AND p.id <> v_user
    ORDER BY p.id LIMIT 1;
  IF v_partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;

  SELECT jsonb_build_object(
    'id', r.id,
    'couple_id', r.couple_id,
    'theme', r.theme,
    'created_by', r.created_by,
    'player_one', r.player_one,
    'player_two', r.player_two,
    'turn_id', r.turn_id,
    'status', r.status,
    'accepted_by', to_jsonb(r.accepted_by),
    'current_prompt', r.current_prompt,
    'completed_count', r.completed_count,
    'created_at', r.created_at,
    'updated_at', r.updated_at
  ) INTO v_round
  FROM public.tod_rounds r
  WHERE r.couple_id = v_couple
    AND r.status IN ('inviting', 'active', 'paused')
    AND NOT public.tod_theme_locked(r.theme)
  ORDER BY r.created_at DESC LIMIT 1;

  SELECT jsonb_object_agg(
    bucket.theme,
    jsonb_build_object('truth', bucket.truth_count, 'dare', bucket.dare_count)
  ) INTO v_counts
  FROM (
    SELECT themes.theme,
      count(p.id) FILTER (WHERE p.type = 'truth')::INTEGER AS truth_count,
      count(p.id) FILTER (WHERE p.type = 'dare')::INTEGER AS dare_count
    FROM (VALUES ('random'::TEXT), ('flirty'::TEXT), ('spicy'::TEXT)) AS themes(theme)
    LEFT JOIN public.tod_prompts p
      ON p.theme = themes.theme AND p.active = true
    GROUP BY themes.theme
  ) AS bucket;

  -- A locked theme reports an empty pool even if stale prompts are still active.
  v_counts := jsonb_set(
    coalesce(v_counts, '{}'::JSONB),
    '{spicy}',
    '{"truth": 0, "dare": 0}'::JSONB,
    true
  );

  RETURN jsonb_build_object(
    'round', v_round,
    'ages', jsonb_build_object(
      'mine', jsonb_build_object('tier', public.tod_age_tier(v_user), 'source', public.tod_age_source(v_user)),
      'partner', jsonb_build_object('tier', public.tod_age_tier(v_partner), 'source', public.tod_age_source(v_partner))
    ),
    'active_counts', v_counts
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.tod_start_round(p_theme TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user UUID := auth.uid();
  v_couple UUID;
  v_partner UUID;
  v_round_id UUID;
  v_required_age INTEGER;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Sign in to play.'; END IF;
  IF p_theme NOT IN ('random', 'flirty', 'spicy') THEN RAISE EXCEPTION 'Choose a valid theme.'; END IF;
  IF public.tod_theme_locked(p_theme) THEN
    RAISE EXCEPTION 'Spicy is locked until marriage verification is available.';
  END IF;
  v_couple := public.get_user_couple_id(v_user);
  IF v_couple IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM 1 FROM public.couples WHERE id = v_couple FOR UPDATE;
  SELECT p.id INTO v_partner
    FROM public.profiles p
    WHERE p.couple_id = v_couple AND p.id <> v_user
    ORDER BY p.id LIMIT 1;
  IF v_partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;

  -- Self-heal: a Spicy room left open by an older build must not block a new round.
  UPDATE public.tod_rounds
    SET status = 'ended', current_prompt = NULL, ended_at = coalesce(ended_at, now()), updated_at = now()
    WHERE couple_id = v_couple AND status IN ('inviting', 'active', 'paused')
      AND public.tod_theme_locked(theme);

  v_required_age := CASE p_theme WHEN 'flirty' THEN 18 ELSE 0 END;
  IF v_required_age > 0 AND (
    public.tod_age_tier(v_user) < v_required_age
    OR public.tod_age_tier(v_partner) < v_required_age
  ) THEN
    RAISE EXCEPTION '% opens only when both partners meet its age rule.', initcap(p_theme);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.tod_prompts WHERE theme = p_theme AND type = 'truth' AND active)
     OR NOT EXISTS (SELECT 1 FROM public.tod_prompts WHERE theme = p_theme AND type = 'dare' AND active) THEN
    RAISE EXCEPTION 'This theme is not available yet.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tod_rounds
    WHERE couple_id = v_couple AND status IN ('inviting', 'active', 'paused')
  ) THEN
    RAISE EXCEPTION 'Finish or end your current round before starting another.';
  END IF;

  INSERT INTO public.tod_rounds (
    couple_id, theme, created_by, player_one, player_two, turn_id, status, accepted_by
  ) VALUES (
    v_couple, p_theme, v_user, v_user, v_partner, v_user, 'inviting', '{}'::UUID[]
  ) RETURNING id INTO v_round_id;
  RETURN v_round_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.tod_accept_round(p_round_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_couple UUID := public.get_user_couple_id(auth.uid());
  v_round public.tod_rounds%ROWTYPE;
  v_accepted UUID[];
  v_required_age INTEGER;
BEGIN
  IF auth.uid() IS NULL OR v_couple IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT * INTO v_round FROM public.tod_rounds
    WHERE id = p_round_id AND couple_id = v_couple FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Round not found.'; END IF;
  IF auth.uid() NOT IN (v_round.player_one, v_round.player_two) THEN RAISE EXCEPTION 'This round is not yours.'; END IF;
  IF public.tod_theme_locked(v_round.theme) THEN
    RAISE EXCEPTION 'Spicy is locked until marriage verification is available.';
  END IF;
  IF v_round.status = 'active' THEN RETURN; END IF;
  IF v_round.status <> 'inviting' THEN RAISE EXCEPTION 'This round is not waiting for partners.'; END IF;

  v_required_age := CASE v_round.theme WHEN 'flirty' THEN 18 ELSE 0 END;
  IF v_required_age > 0 AND (
    public.tod_age_tier(v_round.player_one) < v_required_age
    OR public.tod_age_tier(v_round.player_two) < v_required_age
  ) THEN
    RAISE EXCEPTION '% opens only when both partners meet its age rule.', initcap(v_round.theme);
  END IF;

  v_accepted := CASE
    WHEN auth.uid() = ANY(v_round.accepted_by) THEN v_round.accepted_by
    ELSE array_append(v_round.accepted_by, auth.uid())
  END;
  UPDATE public.tod_rounds
    SET accepted_by = v_accepted,
        status = CASE WHEN cardinality(v_accepted) = 2 THEN 'active' ELSE 'inviting' END,
        updated_at = now()
    WHERE id = v_round.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.tod_choose_prompt(p_round_id UUID, p_type TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_couple UUID := public.get_user_couple_id(auth.uid());
  v_round public.tod_rounds%ROWTYPE;
  v_prompt public.tod_prompts%ROWTYPE;
  v_required_age INTEGER;
  v_target_intensity INTEGER;
  v_snapshot JSONB;
BEGIN
  IF auth.uid() IS NULL OR v_couple IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  IF p_type NOT IN ('truth', 'dare') THEN RAISE EXCEPTION 'Choose Truth or Dare.'; END IF;
  SELECT * INTO v_round FROM public.tod_rounds
    WHERE id = p_round_id AND couple_id = v_couple FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Round not found.'; END IF;
  IF public.tod_theme_locked(v_round.theme) THEN
    RAISE EXCEPTION 'Spicy is locked until marriage verification is available.';
  END IF;
  IF v_round.status <> 'active' THEN RAISE EXCEPTION 'This round is not active.'; END IF;
  IF auth.uid() <> v_round.turn_id THEN RAISE EXCEPTION 'It is your partner’s turn.'; END IF;
  IF v_round.current_prompt IS NOT NULL THEN RAISE EXCEPTION 'Finish or skip the current prompt first.'; END IF;

  v_required_age := CASE v_round.theme WHEN 'flirty' THEN 18 ELSE 0 END;
  IF v_required_age > 0 AND (
    public.tod_age_tier(v_round.player_one) < v_required_age
    OR public.tod_age_tier(v_round.player_two) < v_required_age
  ) THEN
    RAISE EXCEPTION '% opens only when both partners meet its age rule.', initcap(v_round.theme);
  END IF;

  v_target_intensity := least(5, 1 + (v_round.completed_count / 2));

  -- Prefer the current intensity or the next stronger level. If those have all been
  -- seen, use the strongest remaining level instead of repeating an unseen-lower row.
  SELECT p.* INTO v_prompt
    FROM public.tod_prompts p
    WHERE p.active AND p.theme = v_round.theme AND p.type = p_type
      AND p.intensity >= v_target_intensity
      AND NOT EXISTS (
        SELECT 1 FROM public.tod_seen_prompts seen
        WHERE seen.couple_id = v_couple AND seen.prompt_id = p.id
      )
    ORDER BY p.intensity ASC, random()
    LIMIT 1;
  IF NOT FOUND THEN
    SELECT p.* INTO v_prompt
      FROM public.tod_prompts p
      WHERE p.active AND p.theme = v_round.theme AND p.type = p_type
        AND NOT EXISTS (
          SELECT 1 FROM public.tod_seen_prompts seen
          WHERE seen.couple_id = v_couple AND seen.prompt_id = p.id
        )
      ORDER BY p.intensity DESC, random()
      LIMIT 1;
  END IF;

  -- Recycle only when this couple has seen every active prompt in this theme/type pool.
  IF NOT FOUND THEN
    DELETE FROM public.tod_seen_prompts seen
      USING public.tod_prompts p
      WHERE seen.couple_id = v_couple
        AND seen.prompt_id = p.id
        AND p.active AND p.theme = v_round.theme AND p.type = p_type;
    SELECT p.* INTO v_prompt
      FROM public.tod_prompts p
      WHERE p.active AND p.theme = v_round.theme AND p.type = p_type
      ORDER BY CASE WHEN p.intensity >= v_target_intensity THEN 0 ELSE 1 END,
               CASE WHEN p.intensity >= v_target_intensity THEN p.intensity ELSE -p.intensity END,
               random()
      LIMIT 1;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'No reviewed prompts are active for this theme yet.'; END IF;

  v_snapshot := jsonb_build_object(
    'id', v_prompt.id,
    'type', v_prompt.type,
    'theme', v_prompt.theme,
    'intensity', v_prompt.intensity,
    'text', v_prompt.text,
    'tags', to_jsonb(v_prompt.tags),
    'mode', v_prompt.mode
  );
  INSERT INTO public.tod_seen_prompts (couple_id, prompt_id, round_id, seen_at)
    VALUES (v_couple, v_prompt.id, v_round.id, now())
    ON CONFLICT (couple_id, prompt_id) DO UPDATE
      SET round_id = EXCLUDED.round_id, seen_at = EXCLUDED.seen_at;
  UPDATE public.tod_rounds
    SET current_prompt = v_snapshot, updated_at = now()
    WHERE id = v_round.id;
  RETURN v_snapshot;
END;
$$;

CREATE OR REPLACE FUNCTION public.tod_complete_prompt(p_round_id UUID, p_result TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_couple UUID := public.get_user_couple_id(auth.uid());
  v_round public.tod_rounds%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_couple IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  IF p_result NOT IN ('done', 'skip') THEN RAISE EXCEPTION 'Choose Done or Skip.'; END IF;
  SELECT * INTO v_round FROM public.tod_rounds
    WHERE id = p_round_id AND couple_id = v_couple FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Round not found.'; END IF;
  IF public.tod_theme_locked(v_round.theme) THEN
    RAISE EXCEPTION 'Spicy is locked until marriage verification is available.';
  END IF;
  IF v_round.status <> 'active' THEN RAISE EXCEPTION 'This round is not active.'; END IF;
  IF auth.uid() <> v_round.turn_id THEN RAISE EXCEPTION 'It is your partner’s turn.'; END IF;
  IF v_round.current_prompt IS NULL THEN RAISE EXCEPTION 'Choose a prompt first.'; END IF;

  UPDATE public.tod_rounds
    SET current_prompt = NULL,
        completed_count = completed_count + 1,
        turn_id = CASE WHEN turn_id = player_one THEN player_two ELSE player_one END,
        updated_at = now()
    WHERE id = v_round.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.tod_pause_round(p_round_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_couple UUID := public.get_user_couple_id(auth.uid()); v_round public.tod_rounds%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_couple IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT * INTO v_round FROM public.tod_rounds
    WHERE id = p_round_id AND couple_id = v_couple FOR UPDATE;
  IF NOT FOUND OR auth.uid() NOT IN (v_round.player_one, v_round.player_two) THEN RAISE EXCEPTION 'Round not found.'; END IF;
  IF public.tod_theme_locked(v_round.theme) THEN
    RAISE EXCEPTION 'Spicy is locked until marriage verification is available.';
  END IF;
  IF v_round.status NOT IN ('inviting', 'active', 'paused') THEN RAISE EXCEPTION 'This round has ended.'; END IF;
  UPDATE public.tod_rounds SET status = 'paused', updated_at = now() WHERE id = v_round.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.tod_resume_round(p_round_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_couple UUID := public.get_user_couple_id(auth.uid()); v_round public.tod_rounds%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_couple IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT * INTO v_round FROM public.tod_rounds
    WHERE id = p_round_id AND couple_id = v_couple FOR UPDATE;
  IF NOT FOUND OR auth.uid() NOT IN (v_round.player_one, v_round.player_two) THEN RAISE EXCEPTION 'Round not found.'; END IF;
  IF public.tod_theme_locked(v_round.theme) THEN
    RAISE EXCEPTION 'Spicy is locked until marriage verification is available.';
  END IF;
  IF v_round.status <> 'paused' THEN RAISE EXCEPTION 'This round is not paused.'; END IF;
  UPDATE public.tod_rounds
    SET status = CASE WHEN cardinality(accepted_by) = 2 THEN 'active' ELSE 'inviting' END,
        updated_at = now()
    WHERE id = v_round.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.tod_end_round(p_round_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_couple UUID := public.get_user_couple_id(auth.uid()); v_round public.tod_rounds%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_couple IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT * INTO v_round FROM public.tod_rounds
    WHERE id = p_round_id AND couple_id = v_couple FOR UPDATE;
  IF NOT FOUND OR auth.uid() NOT IN (v_round.player_one, v_round.player_two) THEN RAISE EXCEPTION 'Round not found.'; END IF;
  IF v_round.status = 'ended' THEN RETURN; END IF;
  UPDATE public.tod_rounds
    SET status = 'ended', current_prompt = NULL, ended_at = now(), updated_at = now()
    WHERE id = v_round.id;
END;
$$;

-- Only the server-side RPCs can alter round state or seen history. The content table
-- remains service-role writable only; authenticated clients can read active prompts.
REVOKE ALL ON FUNCTION public.tod_birth_date(UUID), public.tod_age_tier(UUID), public.tod_age_source(UUID),
  public.tod_theme_locked(TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tod_confirm_age(SMALLINT), public.tod_state(),
  public.tod_start_round(TEXT), public.tod_accept_round(UUID), public.tod_choose_prompt(UUID, TEXT),
  public.tod_complete_prompt(UUID, TEXT), public.tod_pause_round(UUID), public.tod_resume_round(UUID),
  public.tod_end_round(UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tod_confirm_age(SMALLINT), public.tod_state(),
  public.tod_start_round(TEXT), public.tod_accept_round(UUID), public.tod_choose_prompt(UUID, TEXT),
  public.tod_complete_prompt(UUID, TEXT), public.tod_pause_round(UUID), public.tod_resume_round(UUID),
  public.tod_end_round(UUID)
  TO authenticated;

-- Live room and age-gate changes are delivered to both phones by Supabase Realtime.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'tod_rounds'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.tod_rounds;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'tod_age_confirmations'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.tod_age_confirmations;
    END IF;
  END IF;
END;
$$;

COMMIT;

-- ============================================================================
-- RAISE A CHILD (202610300001_raise_a_child.sql)
-- The same statements the migration applies to existing projects, verbatim.
-- ============================================================================

-- Raise a Child: two partners raising one child, from birth to eighteen, deciding every
-- big moment together. Additive only — no existing table is altered or removed.
--
-- Where the truth lives:
--   game_config          the only place the pacing numbers live (moments per day,
--                        timeout hours, chapters per day, gifts per day)
--   trait_catalog        the parent traits to choose from and the child traits that can
--                        show up, so the owner can add more without a deploy
--   families             one open family per couple (archived ones stay for the album)
--   family_parents       each parent's three traits and hidden bond
--   child_state          the child: name, look, hidden temperament, up to four visible
--                        traits, mood, age, and whose year it is
--   event_templates      the owner's own content, uploaded and validated by
--                        scripts/raise-a-child-events.mjs; never seeded here
--   family_moments       one row per moment instance in this family
--   family_votes         the private picks; RLS shows the partner's only after the reveal
--   album_entries        every outcome, gift, milestone and note, with the child's age
--   family_gifts         the little surprise cards the child leaves a parent
--
-- All the resolving happens in this file's functions, so both phones always agree.
BEGIN;

-- ---------------------------------------------------------------------------------
-- 1. Tuning, traits and temperaments (data, not code)
-- ---------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.game_config (
  id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  moments_per_day SMALLINT NOT NULL DEFAULT 1 CHECK (moments_per_day BETWEEN 0 AND 3),
  timeout_hours SMALLINT NOT NULL DEFAULT 24 CHECK (timeout_hours BETWEEN 1 AND 168),
  chapters_per_day SMALLINT NOT NULL DEFAULT 1 CHECK (chapters_per_day BETWEEN 0 AND 1),
  gifts_per_day SMALLINT NOT NULL DEFAULT 1 CHECK (gifts_per_day BETWEEN 0 AND 2),
  -- A chapter is a year: three moments in it, two while the child is very small.
  moments_per_chapter SMALLINT NOT NULL DEFAULT 3 CHECK (moments_per_chapter BETWEEN 1 AND 4),
  moments_young SMALLINT NOT NULL DEFAULT 2 CHECK (moments_young BETWEEN 1 AND 3),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.game_config
  ADD COLUMN IF NOT EXISTS moments_per_chapter SMALLINT NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS moments_young SMALLINT NOT NULL DEFAULT 2;
INSERT INTO public.game_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.game_config IS
  'One row. Tune the game''s pacing here; no code change and no deploy needed.';

CREATE TABLE IF NOT EXISTS public.trait_catalog (
  slug TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('parent', 'child')),
  blurb TEXT,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.trait_catalog (slug, label, kind, blurb, sort_order) VALUES
  ('patient', 'Patient', 'parent', 'You wait for the second telling.', 10),
  ('funny', 'Funny', 'parent', 'You find the joke in the middle of it.', 20),
  ('strict', 'Strict', 'parent', 'You like the line where you drew it.', 30),
  ('adventurous', 'Adventurous', 'parent', 'You say yes before the plan is finished.', 40),
  ('anxious', 'Anxious', 'parent', 'You think of the thing that could go wrong.', 50),
  ('creative', 'Creative', 'parent', 'You make something out of nothing.', 60),
  ('calm', 'Calm', 'parent', 'Your voice stays low when the room doesn''t.', 70),
  ('curious', 'Curious', 'parent', 'You ask one more question.', 80),
  ('warm', 'Warm', 'parent', 'You make the room easier to be in.', 90),
  ('organised', 'Organised', 'parent', 'You know where the forms are.', 100)
ON CONFLICT (slug) DO UPDATE SET label = EXCLUDED.label, kind = EXCLUDED.kind,
  blurb = coalesce(EXCLUDED.blurb, public.trait_catalog.blurb), sort_order = EXCLUDED.sort_order;

-- The child's visible traits. The first word of each outcome effect key must be one of
-- these (or a future row the owner adds).
INSERT INTO public.trait_catalog (slug, label, kind, blurb, sort_order) VALUES
  ('kind', 'Kind', 'child', 'Notices who needs something.', 210),
  ('stubborn', 'Stubborn', 'child', 'Holds on to a decision.', 230),
  ('shy', 'Shy', 'child', 'Takes a while to warm up.', 240),
  ('brave', 'Brave', 'child', 'Goes first, sometimes scared.', 250),
  ('playful', 'Playful', 'child', 'Finds the game in the day.', 260),
  ('thoughtful', 'Thoughtful', 'child', 'Thinks before saying.', 270),
  ('honest', 'Honest', 'child', 'Says the true thing.', 280),
  ('gentle', 'Gentle', 'child', 'Handles things carefully.', 290),
  ('messy', 'Messy', 'child', 'Leaves a trail of happy evidence.', 300),
  ('proud', 'Proud', 'child', 'Stands a little taller.', 310),
  ('restless', 'Restless', 'child', 'Needs to be moving.', 320)
ON CONFLICT (slug) DO UPDATE SET label = EXCLUDED.label, kind = EXCLUDED.kind,
  blurb = coalesce(EXCLUDED.blurb, public.trait_catalog.blurb), sort_order = EXCLUDED.sort_order;

CREATE TABLE IF NOT EXISTS public.temperaments (
  slug TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  base_weight SMALLINT NOT NULL DEFAULT 10 CHECK (base_weight BETWEEN 0 AND 100),
  active BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO public.temperaments (slug, label, base_weight) VALUES
  ('sunny', 'Sunny', 14),
  ('dreamy', 'Dreamy', 12),
  ('bold', 'Bold', 12),
  ('steady', 'Steady', 14),
  ('gentle', 'Gentle', 12),
  ('spirited', 'Spirited', 12)
ON CONFLICT (slug) DO NOTHING;

-- Which parent traits make which temperament more likely. Never a guarantee: the
-- function below is a weighted draw, and nothing on a phone is ever told the result.
CREATE TABLE IF NOT EXISTS public.temperament_bias (
  trait_slug TEXT NOT NULL REFERENCES public.trait_catalog(slug) ON DELETE CASCADE,
  temperament_slug TEXT NOT NULL REFERENCES public.temperaments(slug) ON DELETE CASCADE,
  weight SMALLINT NOT NULL DEFAULT 0 CHECK (weight BETWEEN -20 AND 20),
  PRIMARY KEY (trait_slug, temperament_slug)
);

INSERT INTO public.temperament_bias (trait_slug, temperament_slug, weight) VALUES
  ('creative', 'dreamy', 8), ('creative', 'sunny', 4),
  ('funny', 'sunny', 8), ('funny', 'spirited', 4),
  ('adventurous', 'bold', 8), ('adventurous', 'spirited', 4),
  ('calm', 'steady', 8), ('calm', 'gentle', 4),
  ('warm', 'gentle', 8), ('warm', 'sunny', 4),
  ('curious', 'dreamy', 6), ('curious', 'bold', 4),
  ('strict', 'steady', 6), ('strict', 'spirited', 3),
  ('anxious', 'gentle', 5), ('anxious', 'steady', 3),
  ('organised', 'steady', 7),
  ('patient', 'gentle', 6), ('patient', 'steady', 4)
ON CONFLICT (trait_slug, temperament_slug) DO NOTHING;

-- ---------------------------------------------------------------------------------
-- 2. The family
-- ---------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.families (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'active', 'letter', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS families_one_open_per_couple
  ON public.families (couple_id) WHERE status <> 'archived';
CREATE INDEX IF NOT EXISTS families_couple_idx ON public.families (couple_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.family_parents (
  family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  traits TEXT[] NOT NULL DEFAULT '{}',
  bond SMALLINT NOT NULL DEFAULT 55 CHECK (bond BETWEEN 0 AND 100),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, user_id),
  CONSTRAINT family_parents_three_traits CHECK (cardinality(traits) <= 3)
);

CREATE TABLE IF NOT EXISTS public.child_state (
  family_id UUID PRIMARY KEY REFERENCES public.families(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  look JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(look) = 'object'),
  -- The temperament is for the server's eyes only: no RPC ever returns it.
  temperament TEXT REFERENCES public.temperaments(slug) ON DELETE SET NULL,
  visible_traits TEXT[] NOT NULL DEFAULT '{}',
  mood TEXT NOT NULL DEFAULT 'content',
  age SMALLINT NOT NULL DEFAULT 0 CHECK (age BETWEEN 0 AND 18),
  lead_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  last_tick_day DATE,
  last_age_up_day DATE,
  letter JSONB,
  letter_written_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT child_state_four_traits CHECK (cardinality(visible_traits) <= 4)
);

-- ---------------------------------------------------------------------------------
-- 3. The owner's content, and this family's play through it
-- ---------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.event_templates (
  slug TEXT PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  min_age SMALLINT NOT NULL CHECK (min_age BETWEEN 0 AND 17),
  max_age SMALLINT NOT NULL CHECK (max_age BETWEEN 0 AND 17),
  category TEXT NOT NULL CHECK (category IN ('home', 'school', 'friends', 'health', 'money', 'values', 'fun')),
  required_trait_tags TEXT[] NOT NULL DEFAULT '{}',
  excluded_trait_tags TEXT[] NOT NULL DEFAULT '{}',
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 80),
  setup_text TEXT NOT NULL CHECK (char_length(btrim(setup_text)) BETWEEN 1 AND 220),
  choices JSONB NOT NULL CHECK (jsonb_typeof(choices) = 'array' AND jsonb_array_length(choices) BETWEEN 2 AND 4),
  tone TEXT,
  active BOOLEAN NOT NULL DEFAULT false,
  batch TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT event_templates_age_range CHECK (min_age <= max_age)
);

CREATE INDEX IF NOT EXISTS event_templates_active_age
  ON public.event_templates (min_age, max_age, category) WHERE active = true;

CREATE TABLE IF NOT EXISTS public.family_moments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  age SMALLINT NOT NULL CHECK (age BETWEEN 0 AND 18),
  day DATE NOT NULL DEFAULT (timezone('utc'::text, now()))::date,
  event_slug TEXT NOT NULL REFERENCES public.event_templates(slug) ON DELETE RESTRICT,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  lead_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  agreement BOOLEAN,
  chosen_choice SMALLINT CHECK (chosen_choice BETWEEN 1 AND 4),
  outcome_text TEXT,
  outcome JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT family_moments_once_per_family UNIQUE (family_id, event_slug)
);

CREATE INDEX IF NOT EXISTS family_moments_family_age ON public.family_moments (family_id, age, created_at);

CREATE TABLE IF NOT EXISTS public.family_votes (
  moment_id UUID NOT NULL REFERENCES public.family_moments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  choice_index SMALLINT NOT NULL CHECK (choice_index BETWEEN 1 AND 4),
  -- One change of mind per parent: two decisions, and then it is settled.
  revisions SMALLINT NOT NULL DEFAULT 0 CHECK (revisions BETWEEN 0 AND 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (moment_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.album_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('moment', 'gift', 'milestone', 'note', 'letter')),
  age SMALLINT NOT NULL CHECK (age BETWEEN 0 AND 18),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  moment_id UUID REFERENCES public.family_moments(id) ON DELETE SET NULL,
  author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS album_entries_family_age ON public.album_entries (family_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.family_gifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day DATE NOT NULL DEFAULT (timezone('utc'::text, now()))::date,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  opened_at TIMESTAMPTZ,
  album_entry_id UUID REFERENCES public.album_entries(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (family_id, user_id, day)
);

-- The outbox behind the one warm notification a parent may get in a day. The primary
-- key is what makes "at most one per day per user" true in the database, not in code.
CREATE TABLE IF NOT EXISTS public.raise_child_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  day DATE NOT NULL DEFAULT (timezone('utc'::text, now()))::date,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  UNIQUE (user_id, day)
);

-- ---------------------------------------------------------------------------------
-- 4. Row Level Security: the couple, and only the couple
-- ---------------------------------------------------------------------------------

ALTER TABLE public.game_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trait_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.temperaments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.temperament_bias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.families ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_parents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.child_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_moments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.album_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_gifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.raise_child_notifications ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.family_moments REPLICA IDENTITY FULL;
ALTER TABLE public.family_votes REPLICA IDENTITY FULL;
ALTER TABLE public.family_gifts REPLICA IDENTITY FULL;
ALTER TABLE public.album_entries REPLICA IDENTITY FULL;

-- The tuning row and the trait lists are read by every signed-in phone and written by
-- the owner only.
DROP POLICY IF EXISTS game_config_read ON public.game_config;
CREATE POLICY game_config_read ON public.game_config FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS trait_catalog_read ON public.trait_catalog;
CREATE POLICY trait_catalog_read ON public.trait_catalog FOR SELECT TO authenticated USING (active = true);
DROP POLICY IF EXISTS temperaments_read ON public.temperaments;
CREATE POLICY temperaments_read ON public.temperaments FOR SELECT TO authenticated USING (active = true);
DROP POLICY IF EXISTS temperament_bias_read ON public.temperament_bias;
CREATE POLICY temperament_bias_read ON public.temperament_bias FOR SELECT TO authenticated USING (true);

-- Content: active rows only, and only signed-in accounts. Only the service role writes.
DROP POLICY IF EXISTS event_templates_read_active ON public.event_templates;
CREATE POLICY event_templates_read_active ON public.event_templates
  FOR SELECT TO authenticated USING (active = true);

-- The family's own rows.
DROP POLICY IF EXISTS families_read_couple ON public.families;
CREATE POLICY families_read_couple ON public.families FOR SELECT TO authenticated
  USING (couple_id = public.get_user_couple_id(auth.uid()));
DROP POLICY IF EXISTS family_parents_read_couple ON public.family_parents;
CREATE POLICY family_parents_read_couple ON public.family_parents FOR SELECT TO authenticated
  USING (family_id IN (SELECT id FROM public.families WHERE couple_id = public.get_user_couple_id(auth.uid())));
DROP POLICY IF EXISTS child_state_read_couple ON public.child_state;
CREATE POLICY child_state_read_couple ON public.child_state FOR SELECT TO authenticated
  USING (family_id IN (SELECT id FROM public.families WHERE couple_id = public.get_user_couple_id(auth.uid())));
DROP POLICY IF EXISTS family_moments_read_couple ON public.family_moments;
CREATE POLICY family_moments_read_couple ON public.family_moments FOR SELECT TO authenticated
  USING (family_id IN (SELECT id FROM public.families WHERE couple_id = public.get_user_couple_id(auth.uid())));
DROP POLICY IF EXISTS album_entries_read_couple ON public.album_entries;
CREATE POLICY album_entries_read_couple ON public.album_entries FOR SELECT TO authenticated
  USING (family_id IN (SELECT id FROM public.families WHERE couple_id = public.get_user_couple_id(auth.uid())));
DROP POLICY IF EXISTS family_gifts_read_own ON public.family_gifts;
CREATE POLICY family_gifts_read_own ON public.family_gifts FOR SELECT TO authenticated
  USING (user_id = auth.uid()
    AND family_id IN (SELECT id FROM public.families WHERE couple_id = public.get_user_couple_id(auth.uid())));
DROP POLICY IF EXISTS raise_child_notifications_read_own ON public.raise_child_notifications;
CREATE POLICY raise_child_notifications_read_own ON public.raise_child_notifications FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- A vote is private until both parents have voted: the same shape Daily Decisions uses.
CREATE OR REPLACE FUNCTION public.can_read_family_vote(p_moment_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  fam UUID;
BEGIN
  IF caller IS NULL THEN RETURN FALSE; END IF;
  SELECT m.family_id INTO fam
    FROM public.family_moments m
   WHERE m.id = p_moment_id
     AND m.family_id IN (SELECT id FROM public.families WHERE couple_id = public.get_user_couple_id(caller));
  IF fam IS NULL THEN RETURN FALSE; END IF;
  IF p_user_id = caller THEN RETURN TRUE; END IF;
  RETURN EXISTS (SELECT 1 FROM public.family_votes v WHERE v.moment_id = p_moment_id AND v.user_id = caller)
     AND EXISTS (SELECT 1 FROM public.family_votes v WHERE v.moment_id = p_moment_id AND v.user_id = p_user_id);
END;
$$;

DROP POLICY IF EXISTS family_votes_read_until_reveal ON public.family_votes;
CREATE POLICY family_votes_read_until_reveal ON public.family_votes FOR SELECT TO authenticated
  USING (public.can_read_family_vote(moment_id, user_id));

-- The app never writes these tables directly: every write is a function below.
REVOKE ALL ON public.game_config, public.trait_catalog, public.temperaments, public.temperament_bias,
  public.families, public.family_parents, public.child_state, public.event_templates,
  public.family_moments, public.family_votes, public.album_entries, public.family_gifts,
  public.raise_child_notifications
  FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.game_config, public.trait_catalog, public.temperaments, public.temperament_bias,
  public.families, public.event_templates,
  public.family_moments, public.family_votes, public.album_entries, public.family_gifts,
  public.raise_child_notifications
  TO authenticated;

-- Two tables are only ever read through the state function, so the client cannot
-- select the columns that must stay hidden: the temperament the child was born with,
-- and either parent's bond. Column grants make that a database fact, not a promise.
GRANT SELECT (family_id, user_id, traits, joined_at) ON public.family_parents TO authenticated;
GRANT SELECT (family_id, name, look, visible_traits, mood, age, lead_user_id, letter,
  letter_written_at, created_at, updated_at) ON public.child_state TO authenticated;

GRANT ALL ON public.game_config, public.trait_catalog, public.temperaments, public.temperament_bias,
  public.families, public.family_parents, public.child_state, public.event_templates,
  public.family_moments, public.family_votes, public.album_entries, public.family_gifts,
  public.raise_child_notifications
  TO service_role;

-- ---------------------------------------------------------------------------------
-- 5. Helpers: who is asking, and the family they belong to
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_config()
RETURNS public.game_config
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT * FROM public.game_config WHERE id;
$$;

-- The caller's couple, or an exception. Every app-facing function starts here.
CREATE OR REPLACE FUNCTION public.raise_child_require_couple()
RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE cid UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in to raise a child.';
  END IF;
  SELECT couple_id INTO cid FROM public.profiles WHERE id = auth.uid();
  IF cid IS NULL THEN
    RAISE EXCEPTION 'Pair with your partner first.';
  END IF;
  RETURN cid;
END;
$$;

-- This couple's family, archived ones excluded: one child at a time.
CREATE OR REPLACE FUNCTION public.raise_child_open_family()
RETURNS public.families
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE fam public.families%ROWTYPE;
BEGIN
  SELECT * INTO fam
    FROM public.families
   WHERE couple_id = public.raise_child_require_couple()
     AND status <> 'archived'
   ORDER BY created_at DESC
   LIMIT 1;
  RETURN fam;
END;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_guard_family(p_family_id UUID)
RETURNS public.families
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE fam public.families%ROWTYPE;
BEGIN
  SELECT * INTO fam FROM public.families WHERE id = p_family_id;
  IF fam.id IS NULL THEN
    RAISE EXCEPTION 'That family is not here any more.';
  END IF;
  IF fam.couple_id <> public.get_user_couple_id(auth.uid()) THEN
    RAISE EXCEPTION 'That family belongs to another couple.';
  END IF;
  RETURN fam;
END;
$$;

-- The two parents, oldest first: parent A is the one who started the family.
CREATE OR REPLACE FUNCTION public.raise_child_parents(p_family_id UUID)
RETURNS UUID[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT coalesce(array_agg(user_id ORDER BY joined_at, user_id), '{}'::UUID[])
    FROM public.family_parents WHERE family_id = p_family_id;
$$;

-- --- Traits ----------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_validate_traits(p_traits TEXT[])
RETURNS TEXT[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE cleaned TEXT[];
BEGIN
  SELECT array_agg(DISTINCT btrim(t) ORDER BY btrim(t)) INTO cleaned
    FROM unnest(coalesce(p_traits, '{}'::TEXT[])) AS t
   WHERE btrim(t) <> '';
  IF cleaned IS NULL OR cardinality(cleaned) <> 3 THEN
    RAISE EXCEPTION 'Choose exactly three traits.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(cleaned) AS t
     WHERE NOT EXISTS (
       SELECT 1 FROM public.trait_catalog c WHERE c.slug = t AND c.kind = 'parent' AND c.active
     )
  ) THEN
    RAISE EXCEPTION 'One of those traits is not available.';
  END IF;
  RETURN cleaned;
END;
$$;

-- The weighted draw. Both parents' traits nudge the odds; nothing is guaranteed, and
-- the result never leaves the server.
CREATE OR REPLACE FUNCTION public.raise_child_temperament(p_traits_a TEXT[], p_traits_b TEXT[])
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  all_traits TEXT[] := coalesce(p_traits_a, '{}') || coalesce(p_traits_b, '{}');
  total NUMERIC := 0;
  picked TEXT;
  roll NUMERIC;
  running NUMERIC := 0;
  row RECORD;
BEGIN
  SELECT sum(greatest(1, t.base_weight + coalesce((
      SELECT sum(b.weight) FROM public.temperament_bias b
       WHERE b.temperament_slug = t.slug AND b.trait_slug = ANY(all_traits)
    ), 0))) INTO total
    FROM public.temperaments t WHERE t.active;
  IF total IS NULL OR total <= 0 THEN
    RETURN (SELECT slug FROM public.temperaments WHERE active ORDER BY slug LIMIT 1);
  END IF;
  roll := random() * total;
  FOR row IN
    SELECT t.slug,
           greatest(1, t.base_weight + coalesce((
             SELECT sum(b.weight) FROM public.temperament_bias b
              WHERE b.temperament_slug = t.slug AND b.trait_slug = ANY(all_traits)
           ), 0))::NUMERIC AS weight
      FROM public.temperaments t
     WHERE t.active
     ORDER BY t.slug
  LOOP
    running := running + row.weight;
    IF picked IS NULL AND roll <= running THEN
      picked := row.slug;
    END IF;
  END LOOP;
  RETURN coalesce(picked, (SELECT slug FROM public.temperaments WHERE active ORDER BY slug LIMIT 1));
END;
$$;

-- --- Bond: a number the server keeps, and a sentence the parent reads -------------

CREATE OR REPLACE FUNCTION public.raise_child_bond_band(p_bond SMALLINT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_bond >= 75 THEN 'close'
    WHEN p_bond >= 55 THEN 'warming'
    WHEN p_bond >= 35 THEN 'steady'
    ELSE 'finding'
  END;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_bond_line(p_bond SMALLINT, p_child TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_bond >= 75 THEN p_child || ' runs to you first when the door opens.'
    WHEN p_bond >= 55 THEN p_child || ' looks for you in the room before anyone else.'
    WHEN p_bond >= 35 THEN p_child || ' settles beside you when the day is quiet.'
    ELSE p_child || ' is still learning how to reach for you — gently, in their own time.'
  END;
$$;

-- --- Effects --------------------------------------------------------------------

-- Applies one choice's effects: at most four visible traits (oldest fades), a mood,
-- and a bond nudge. On a split the child feels it: the parent whose call it was
-- edges closer, the other is left a little further off. Nobody is punished for
-- their answer; the bond simply records what the child felt.
CREATE OR REPLACE FUNCTION public.raise_child_apply_effects(
  p_family_id UUID,
  p_effects JSONB,
  p_deciding UUID,
  p_other UUID,
  p_agreement BOOLEAN,
  p_deciding_bond_delta_extra SMALLINT DEFAULT 0
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  cs public.child_state%ROWTYPE;
  traits TEXT[];
  key TEXT;
  value SMALLINT;
  delta SMALLINT;
BEGIN
  SELECT * INTO cs FROM public.child_state WHERE family_id = p_family_id FOR UPDATE;
  IF cs.family_id IS NULL THEN RETURN; END IF;

  traits := coalesce(cs.visible_traits, '{}');
  IF jsonb_typeof(p_effects -> 'traits') = 'object' THEN
    FOR key, value IN SELECT k, (v #>> '{}')::SMALLINT FROM jsonb_each(p_effects -> 'traits') AS e(k, v) LOOP
      IF value > 0 THEN
        IF NOT (key = ANY(traits)) THEN
          traits := traits || key;
        END IF;
        WHILE cardinality(traits) > 4 LOOP
          traits := traits[2:cardinality(traits)];
        END LOOP;
      ELSIF value < 0 THEN
        traits := array_remove(traits, key);
      END IF;
    END LOOP;
  END IF;

  UPDATE public.child_state
     SET visible_traits = coalesce(traits, '{}'),
         mood = coalesce(nullif(p_effects ->> 'mood', ''), mood),
         updated_at = now()
   WHERE family_id = p_family_id;

  -- When the two of you picked differently, the option's own bond effect is not applied
  -- to either of you: the year simply carries the small split nudge, nothing more.
  delta := CASE WHEN p_agreement THEN coalesce((p_effects ->> 'bond')::SMALLINT, 0) ELSE 0 END;
  IF p_agreement THEN
    UPDATE public.family_parents SET bond = least(100, greatest(0, bond + delta))
     WHERE family_id = p_family_id;
  ELSE
    IF p_deciding IS NOT NULL THEN
      UPDATE public.family_parents SET bond = least(100, greatest(0, bond + delta + p_deciding_bond_delta_extra))
       WHERE family_id = p_family_id AND user_id = p_deciding;
    END IF;
    IF p_other IS NOT NULL THEN
      UPDATE public.family_parents SET bond = least(100, greatest(0, bond - p_deciding_bond_delta_extra))
       WHERE family_id = p_family_id AND user_id = p_other;
    END IF;
  END IF;
END;
$$;

-- --- Choosing the next event ------------------------------------------------------

-- Active events that fit this age, that this family has never seen, whose required
-- tags the parents (or the child so far) can meet and whose excluded tags they do
-- not. Categories the family has used least come first, so a year does not become
-- three school moments in a row.
CREATE OR REPLACE FUNCTION public.raise_child_pick_event(
  p_family_id UUID,
  p_age SMALLINT,
  p_traits TEXT[],
  p_wide BOOLEAN DEFAULT false,
  p_use_traits BOOLEAN DEFAULT true
)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  picked TEXT;
  age_low SMALLINT := CASE WHEN p_wide THEN greatest(0, p_age - 1) ELSE p_age END;
  age_high SMALLINT := CASE WHEN p_wide THEN least(17, p_age + 1) ELSE p_age END;
BEGIN
  SELECT t.slug INTO picked
    FROM public.event_templates t
   WHERE t.active
     AND t.min_age <= age_high
     AND t.max_age >= age_low
     AND NOT EXISTS (
       SELECT 1 FROM public.family_moments m
        WHERE m.family_id = p_family_id AND m.event_slug = t.slug
     )
     AND (NOT p_use_traits OR cardinality(t.required_trait_tags) = 0 OR t.required_trait_tags <@ coalesce(p_traits, '{}'))
     AND (NOT p_use_traits OR NOT (t.excluded_trait_tags && coalesce(p_traits, '{}')))
   ORDER BY (
       SELECT count(*) FROM public.family_moments m
        WHERE m.family_id = p_family_id AND m.category = t.category
     ) ASC,
     random()
   LIMIT 1;
  RETURN picked;
END;
$$;

-- The whole search: the right fit first, then a little wider, then any age, then a
-- quiet day. It never raises for missing content, because an empty library is a
-- normal state on the first day the game ships.
-- How many moments this chapter can hold: fewer while the child is tiny.
CREATE OR REPLACE FUNCTION public.raise_child_chapter_target(p_age SMALLINT)
RETURNS INTEGER
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT CASE WHEN coalesce(p_age, 0) <= 3
    THEN (SELECT moments_young FROM public.game_config WHERE id)
    ELSE (SELECT moments_per_chapter FROM public.game_config WHERE id)
  END;
$$;

/**
 * Whether this chapter has said everything it has to say. True when nothing is waiting on
 * either parent and the chapter has reached its size, or when there is no card left that
 * would fit the family. A quiet year can therefore end; a chapter that still has a card to
 * come cannot be skipped past.
 */
CREATE OR REPLACE FUNCTION public.raise_child_chapter_complete(p_family_id UUID, p_age SMALLINT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  held INTEGER;
  target INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.family_moments
     WHERE family_id = p_family_id AND age = p_age AND status = 'open'
  ) THEN
    RETURN FALSE;
  END IF;
  SELECT count(*) INTO held FROM public.family_moments
   WHERE family_id = p_family_id AND age = p_age;
  target := public.raise_child_chapter_target(p_age);
  IF held >= coalesce(target, 3) THEN
    RETURN TRUE;
  END IF;
  RETURN public.raise_child_choose_event(p_family_id, p_age) IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_choose_event(p_family_id UUID, p_age SMALLINT)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  traits TEXT[];
  picked TEXT;
BEGIN
  SELECT coalesce(array_agg(DISTINCT t), '{}')
    INTO traits
    FROM (
      SELECT unnest(fp.traits) AS t FROM public.family_parents fp WHERE fp.family_id = p_family_id
      UNION
      SELECT unnest(cs.visible_traits) FROM public.child_state cs WHERE cs.family_id = p_family_id
    ) s
   WHERE t IS NOT NULL;

  picked := public.raise_child_pick_event(p_family_id, p_age, traits, false, true);
  IF picked IS NULL THEN
    picked := public.raise_child_pick_event(p_family_id, p_age, traits, true, true);
  END IF;
  IF picked IS NULL THEN
    picked := public.raise_child_pick_event(p_family_id, p_age, traits, false, false);
  END IF;
  IF picked IS NULL THEN
    picked := public.raise_child_pick_event(p_family_id, p_age, traits, true, false);
  END IF;
  RETURN picked;
END;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_create_moment(p_family_id UUID, p_age SMALLINT, p_day DATE)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  chosen_slug TEXT;
  tpl public.event_templates%ROWTYPE;
  new_id UUID;
BEGIN
  chosen_slug := public.raise_child_choose_event(p_family_id, p_age);
  IF chosen_slug IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO tpl FROM public.event_templates WHERE event_templates.slug = chosen_slug;
  INSERT INTO public.family_moments (family_id, age, day, event_slug, category)
  VALUES (p_family_id, p_age, p_day, tpl.slug, tpl.category)
  ON CONFLICT (family_id, event_slug) DO NOTHING
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

-- ---------------------------------------------------------------------------------
-- 6. Resolving a moment: the lead parent rule, the effects and the album
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_resolve_as(
  p_moment_id UUID,
  p_force BOOLEAN DEFAULT false,
  p_decision TEXT DEFAULT 'auto'
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  m public.family_moments%ROWTYPE;
  fam public.families%ROWTYPE;
  cfg public.game_config%ROWTYPE;
  cs public.child_state%ROWTYPE;
  tpl public.event_templates%ROWTYPE;
  parents UUID[];
  parent_a UUID;
  parent_b UUID;
  a_choice SMALLINT;
  b_choice SMALLINT;
  both_voted BOOLEAN;
  agreed BOOLEAN := false;
  chosen SMALLINT;
  deciding UUID;
  other UUID;
  lead UUID;
  lagger UUID;
  choice JSONB;
  outcome_line TEXT;
  outcome_json JSONB;
  notes TEXT;
  decider_name TEXT;
  child_name TEXT;
  due BOOLEAN;
  kind TEXT;
BEGIN
  IF p_decision NOT IN ('auto', 'lead') THEN
    RAISE EXCEPTION 'Unknown kind of decision.';
  END IF;

  SELECT * INTO m FROM public.family_moments WHERE id = p_moment_id FOR UPDATE;
  IF m.id IS NULL THEN RAISE EXCEPTION 'That moment is not here any more.'; END IF;
  IF m.status = 'resolved' THEN RETURN m.outcome; END IF;

  SELECT * INTO fam FROM public.families WHERE id = m.family_id;
  -- A signed-in caller must be one of the two parents; the daily job has no caller.
  IF auth.uid() IS NOT NULL AND fam.couple_id IS DISTINCT FROM public.get_user_couple_id(auth.uid()) THEN
    RAISE EXCEPTION 'That moment belongs to another couple.';
  END IF;

  cfg := public.raise_child_config();
  parents := public.raise_child_parents(m.family_id);
  parent_a := parents[1];
  parent_b := parents[2];
  SELECT choice_index INTO a_choice FROM public.family_votes WHERE moment_id = m.id AND user_id = parent_a;
  SELECT choice_index INTO b_choice FROM public.family_votes WHERE moment_id = m.id AND user_id = parent_b;
  both_voted := a_choice IS NOT NULL AND b_choice IS NOT NULL;
  due := now() >= m.created_at + make_interval(hours => cfg.timeout_hours);

  IF NOT both_voted THEN
    -- One answer, or none. Nothing happens until the clock runs out.
    IF a_choice IS NULL AND b_choice IS NULL THEN RETURN NULL; END IF;
    IF p_decision = 'lead' OR NOT (p_force AND due) THEN RETURN NULL; END IF;
    kind := 'lone';
  ELSE
    agreed := a_choice = b_choice;
    IF NOT agreed AND p_decision <> 'lead' AND NOT (p_force AND due) THEN
      -- A split is not a decision. The two of them can take it to chat, change a pick,
      -- or let the year's lead parent use their call; the clock is only the backstop.
      RETURN NULL;
    END IF;
    IF agreed THEN
      kind := 'agreement';
    ELSIF p_decision = 'lead' THEN
      kind := 'lead';
    ELSE
      kind := 'timeout';
    END IF;
  END IF;

  SELECT * INTO cs FROM public.child_state WHERE family_id = m.family_id;
  SELECT * INTO tpl FROM public.event_templates WHERE slug = m.event_slug;
  lead := coalesce(cs.lead_user_id, parent_a);
  lagger := CASE WHEN lead = parent_a THEN parent_b ELSE parent_a END;

  IF both_voted THEN
    IF agreed THEN
      chosen := a_choice;
      deciding := NULL;
      other := NULL;
    ELSE
      chosen := CASE WHEN lead = parent_a THEN a_choice ELSE b_choice END;
      deciding := lead;
      other := lagger;
    END IF;
  ELSE
    -- Nobody answered in time: the pick that was made counts, quietly.
    chosen := coalesce(a_choice, b_choice);
    deciding := CASE WHEN a_choice IS NOT NULL THEN parent_a ELSE parent_b END;
    other := CASE WHEN a_choice IS NOT NULL THEN parent_b ELSE parent_a END;
  END IF;

  choice := tpl.choices -> (chosen - 1);
  IF choice IS NULL OR jsonb_typeof(choice) <> 'object' THEN
    RAISE EXCEPTION 'That moment has no outcome for that choice.';
  END IF;
  outcome_line := choice ->> 'outcome_text';

  SELECT name INTO decider_name FROM public.profiles WHERE id = coalesce(deciding, lead);
  SELECT name INTO child_name FROM public.child_state WHERE family_id = m.family_id;

  IF kind = 'agreement' THEN
    notes := 'You both wanted the same thing. ' || child_name || ' felt that.';
  ELSIF kind = 'lead' THEN
    notes := 'You wanted different things. ' || coalesce(decider_name, 'Your other half')
      || ' had this year’s call, and used it.';
  ELSIF kind = 'timeout' THEN
    notes := 'You wanted different things. This year went with ' || coalesce(decider_name, 'your other half') || '’s call.';
  ELSE
    notes := 'We went with ' || coalesce(decider_name, 'the pick that was made') || '’s pick.';
  END IF;

  -- A timeout is not a split and carries no penalty: the picked outcome happens, and
  -- neither parent's bond moves. A real split nudges both by one, and no further.
  PERFORM public.raise_child_apply_effects(
    m.family_id,
    coalesce(choice -> 'effects', '{}'::JSONB),
    CASE WHEN both_voted AND NOT agreed THEN deciding ELSE NULL END,
    CASE WHEN both_voted AND NOT agreed THEN other ELSE NULL END,
    agreed,
    (CASE WHEN both_voted AND NOT agreed THEN 1 ELSE 0 END)::SMALLINT
  );

  outcome_json := jsonb_build_object(
    'agreement', agreed,
    'split', both_voted AND NOT agreed,
    'timed_out', NOT both_voted,
    'decision', kind,
    'chosen_index', chosen,
    'chosen_label', choice ->> 'label',
    'outcome_text', outcome_line,
    'note', notes,
    'decided_by', coalesce(deciding, lead),
    'decided_by_name', decider_name
  );

  UPDATE public.family_moments
     SET status = 'resolved',
         chosen_choice = chosen,
         agreement = agreed,
         lead_user_id = coalesce(deciding, lead),
         outcome_text = outcome_line,
         outcome = outcome_json,
         resolved_at = now()
   WHERE id = m.id;

  INSERT INTO public.album_entries (family_id, kind, age, title, body, moment_id)
  VALUES (m.family_id, 'moment', m.age, tpl.title, outcome_line, m.id);

  RETURN outcome_json;
END;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_resolve(p_moment_id UUID, p_force BOOLEAN DEFAULT false)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN public.raise_child_resolve_as(COALESCE(p_moment_id, NULL), p_force, 'auto');
END;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_resolve_due(p_family_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  cfg public.game_config%ROWTYPE;
  r RECORD;
  resolved INTEGER := 0;
BEGIN
  cfg := public.raise_child_config();
  FOR r IN
    SELECT id FROM public.family_moments
     WHERE family_id = p_family_id
       AND status = 'open'
       AND now() >= created_at + make_interval(hours => cfg.timeout_hours)
  LOOP
    IF public.raise_child_resolve(r.id, true) IS NOT NULL THEN
      resolved := resolved + 1;
    END IF;
  END LOOP;
  RETURN resolved;
END;
$$;

-- ---------------------------------------------------------------------------------
-- 7. The cosy layer: gifts, the daily tick and the one warm notification
-- ---------------------------------------------------------------------------------

-- The child's small gifts are the game's own warmth, not the owner's event content:
-- they are derived from the child's age and the traits the family has grown, and are
-- written here so they can never drift out of tone.
CREATE OR REPLACE FUNCTION public.raise_child_gift_copy(p_age SMALLINT, p_traits TEXT[], p_child TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  kind_trait BOOLEAN := 'kind' = ANY(coalesce(p_traits, '{}'));
  playful BOOLEAN := 'playful' = ANY(coalesce(p_traits, '{}'));
BEGIN
  IF p_age <= 2 THEN
    RETURN jsonb_build_object(
      'slug', 'first-word',
      'title', p_child || ' said your name',
      'body', 'It came out sideways the first time, and then again, much clearer. The whole room went quiet so it could be said twice.'
    );
  ELSIF p_age <= 6 THEN
    RETURN jsonb_build_object(
      'slug', 'drawing',
      'title', p_child || ' left you a drawing',
      'body', 'Three stick people holding hands, a sun in the corner with far too many rays, and you in the middle of it all.'
    );
  ELSIF p_age <= 10 THEN
    RETURN jsonb_build_object(
      'slug', 'note',
      'title', p_child || ' wrote you a note',
      'body', 'It was folded four times and taped shut, and it said — in careful capitals — that you are their favourite grown-up.'
    );
  ELSIF p_age <= 14 THEN
    RETURN jsonb_build_object(
      'slug', 'song',
      'title', p_child || ' sent you a song',
      'body', 'No message with it, just a link and a shy little "this one reminded me of you".'
    );
  ELSIF p_age <= 16 THEN
    RETURN jsonb_build_object(
      'slug', 'tea',
      'title', p_child || ' made you tea',
      'body', 'Made it exactly the way you take it, without being asked, and left it where you always sit.'
    );
  ELSE
    RETURN jsonb_build_object(
      'slug', CASE WHEN kind_trait OR playful THEN 'hug' ELSE 'letter' END,
      'title', p_child || ' left you a line',
      'body', 'Written on the back of a school sheet: "I know you two decided everything together. I noticed. Thank you."'
    );
  END IF;
END;
$$;

-- One gift for one parent, weighted by that parent's bond: the child leans toward
-- whoever has been closest this year, never away from the other.
-- One small surprise for each parent, every day. Nobody is skipped because the other
-- parent was drawn instead: a gift is a hello, not a competition.
CREATE OR REPLACE FUNCTION public.raise_child_create_gift(p_family_id UUID, p_day DATE)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  cs public.child_state%ROWTYPE;
  parent RECORD;
  copy JSONB;
  entry UUID;
  created INTEGER := 0;
BEGIN
  SELECT * INTO cs FROM public.child_state WHERE family_id = p_family_id;
  IF cs.family_id IS NULL THEN RETURN 0; END IF;

  FOR parent IN
    SELECT fp.user_id FROM public.family_parents fp
     WHERE fp.family_id = p_family_id AND fp.bond > 0
     ORDER BY fp.joined_at, fp.user_id
  LOOP
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.family_gifts
       WHERE family_id = p_family_id AND user_id = parent.user_id AND day = p_day
    );
    copy := public.raise_child_gift_copy(cs.age, cs.visible_traits, cs.name);
    INSERT INTO public.album_entries (family_id, kind, age, title, body)
    VALUES (p_family_id, 'gift', cs.age, copy ->> 'title', copy ->> 'body')
    RETURNING id INTO entry;
    INSERT INTO public.family_gifts (family_id, user_id, day, slug, title, body, album_entry_id)
    VALUES (p_family_id, parent.user_id, p_day, copy ->> 'slug', copy ->> 'title', copy ->> 'body', entry);
    created := created + 1;
  END LOOP;

  RETURN created;
END;
$$;

-- One warm line a day at most, per parent, and always in the child's voice.
CREATE OR REPLACE FUNCTION public.raise_child_queue_notification(p_family_id UUID, p_day DATE)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  cs public.child_state%ROWTYPE;
  p RECORD;
  gift RECORD;
  open_moments INTEGER;
BEGIN
  SELECT * INTO cs FROM public.child_state WHERE family_id = p_family_id;
  IF cs.family_id IS NULL THEN RETURN; END IF;
  SELECT count(*) INTO open_moments FROM public.family_moments WHERE family_id = p_family_id AND status = 'open';
  FOR p IN SELECT user_id FROM public.family_parents WHERE family_id = p_family_id LOOP
    SELECT * INTO gift FROM public.family_gifts
      WHERE family_id = p_family_id AND user_id = p.user_id AND day = p_day
      ORDER BY created_at DESC LIMIT 1;
    INSERT INTO public.raise_child_notifications (user_id, family_id, day, title, body)
    VALUES (
      p.user_id,
      p_family_id,
      p_day,
      CASE WHEN gift.id IS NOT NULL THEN gift.title
           WHEN open_moments > 0 THEN cs.name || ' saved you a seat at the table'
           ELSE cs.name || ' is thinking about you' END,
      CASE WHEN gift.id IS NOT NULL THEN left(gift.body, 140)
           WHEN open_moments > 0 THEN cs.name || ' left something small for the two of you on the table.'
           ELSE 'A quiet day in the house. Nothing is waiting on you.' END
    )
    ON CONFLICT (user_id, day) DO NOTHING;
  END LOOP;
END;
$$;

-- Everything a new day needs for one family. Safe to run as often as you like: the
-- last_tick_day guard means the day's content is created once.
CREATE OR REPLACE FUNCTION public.raise_child_tick_family(p_family_id UUID, p_day DATE DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  tick_day DATE := coalesce(p_day, (timezone('utc'::text, now()))::date);
  fam public.families%ROWTYPE;
  cs public.child_state%ROWTYPE;
  cfg public.game_config%ROWTYPE;
  created INTEGER := 0;
  gifts INTEGER := 0;
  resolved INTEGER;
  created_today INTEGER := 0;
  in_chapter INTEGER := 0;
  allowed INTEGER := 0;
  i INTEGER;
BEGIN
  SELECT * INTO fam FROM public.families WHERE id = p_family_id;
  IF fam.id IS NULL OR fam.status <> 'active' THEN
    RETURN jsonb_build_object('family', p_family_id, 'skipped', true);
  END IF;
  SELECT * INTO cs FROM public.child_state WHERE family_id = p_family_id;
  IF cs.family_id IS NULL THEN
    RETURN jsonb_build_object('family', p_family_id, 'skipped', true);
  END IF;
  cfg := public.raise_child_config();
  resolved := public.raise_child_resolve_due(p_family_id);

  IF cs.last_tick_day IS DISTINCT FROM tick_day THEN
    -- Today's allowance is the smaller of the daily pace and what the chapter still needs;
    -- a chapter fills up over days, and never runs past its size.
    SELECT count(*) INTO created_today FROM public.family_moments
     WHERE family_id = p_family_id AND family_moments.day = tick_day;
    SELECT count(*) INTO in_chapter FROM public.family_moments
     WHERE family_id = p_family_id AND family_moments.age = cs.age;
    allowed := least(
      greatest(0, cfg.moments_per_day - created_today),
      greatest(0, public.raise_child_chapter_target(cs.age) - in_chapter)
    );
    FOR i IN 1..allowed LOOP
      IF public.raise_child_create_moment(p_family_id, cs.age, tick_day) IS NULL THEN EXIT; END IF;
      created := created + 1;
    END LOOP;
    FOR i IN 1..cfg.gifts_per_day LOOP
      IF public.raise_child_create_gift(p_family_id, tick_day) IS NOT NULL THEN
        gifts := gifts + 1;
      END IF;
    END LOOP;
    PERFORM public.raise_child_queue_notification(p_family_id, tick_day);
    UPDATE public.child_state SET last_tick_day = tick_day, updated_at = now() WHERE family_id = p_family_id;
  END IF;

  RETURN jsonb_build_object(
    'family', p_family_id, 'day', tick_day, 'moments', created, 'gifts', gifts, 'resolved', resolved
  );
END;
$$;

-- The daily job. pg_cron calls this hourly; content is only created once a day and the
-- 24-hour timeouts are settled every hour, so a family never waits on a phone waking up.
CREATE OR REPLACE FUNCTION public.raise_child_daily_tick(p_day DATE DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  fam RECORD;
  results JSONB := '[]'::JSONB;
BEGIN
  FOR fam IN
    SELECT f.id FROM public.families f
      JOIN public.child_state cs ON cs.family_id = f.id
     WHERE f.status = 'active'
  LOOP
    results := results || jsonb_build_array(public.raise_child_tick_family(fam.id, p_day));
  END LOOP;
  PERFORM public.raise_child_invoke_push();
  RETURN results;
END;
$$;

-- The push outbox is drained by the send-push function (a Database Webhook on
-- raise_child_notifications, or the hourly call below when pg_net is configured).
CREATE OR REPLACE FUNCTION public.raise_child_claim_notifications(p_limit INTEGER DEFAULT 50)
RETURNS SETOF public.raise_child_notifications
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT * FROM public.raise_child_notifications
   WHERE sent_at IS NULL
   ORDER BY created_at
   LIMIT greatest(1, least(coalesce(p_limit, 50), 200));
$$;

CREATE OR REPLACE FUNCTION public.raise_child_mark_notification_sent(p_id UUID)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  UPDATE public.raise_child_notifications SET sent_at = now() WHERE id = p_id AND sent_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_invoke_push()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE endpoint TEXT; webhook_secret TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')
     OR to_regclass('vault.decrypted_secrets') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.raise_child_notifications WHERE sent_at IS NULL) THEN
    RETURN;
  END IF;
  SELECT decrypted_secret INTO endpoint FROM vault.decrypted_secrets WHERE name = 'nooki_send_push_url' LIMIT 1;
  SELECT decrypted_secret INTO webhook_secret FROM vault.decrypted_secrets WHERE name = 'nooki_push_webhook_secret' LIMIT 1;
  IF endpoint IS NULL OR webhook_secret IS NULL THEN RETURN; END IF;
  PERFORM net.http_post(
    url := endpoint,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || webhook_secret),
    body := jsonb_build_object('type', 'SCHEDULED', 'table', 'raise_child_notifications'),
    timeout_milliseconds := 10000
  );
END;
$$;

-- ---------------------------------------------------------------------------------
-- 8. Setup: a name, a look, three traits each, and a temperament only the server knows
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_setup(
  p_name TEXT DEFAULT NULL,
  p_look JSONB DEFAULT NULL,
  p_traits TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  cid UUID;
  fam public.families%ROWTYPE;
  cs public.child_state%ROWTYPE;
  chosen_traits TEXT[] := NULL;
  parents UUID[];
  traits_a TEXT[];
  traits_b TEXT[];
  clean_name TEXT := nullif(btrim(coalesce(p_name, '')), '');
BEGIN
  cid := public.raise_child_require_couple();
  fam := public.raise_child_open_family();

  IF p_traits IS NOT NULL AND cardinality(p_traits) > 0 THEN
    chosen_traits := public.raise_child_validate_traits(p_traits);
  END IF;

  IF fam.id IS NULL THEN
    INSERT INTO public.families (couple_id, created_by) VALUES (cid, caller) RETURNING * INTO fam;
  END IF;

  INSERT INTO public.family_parents (family_id, user_id, traits)
  VALUES (fam.id, caller, coalesce(chosen_traits, '{}'))
  ON CONFLICT (family_id, user_id) DO UPDATE
    SET traits = CASE WHEN cardinality(EXCLUDED.traits) = 3 THEN EXCLUDED.traits ELSE public.family_parents.traits END;

  SELECT * INTO cs FROM public.child_state WHERE family_id = fam.id;
  IF fam.status = 'setup' THEN
    IF clean_name IS NOT NULL AND clean_name <> '' THEN
      IF cs.family_id IS NULL THEN
        INSERT INTO public.child_state (family_id, name, look)
        VALUES (fam.id, clean_name, coalesce(p_look, '{}'::JSONB))
        RETURNING * INTO cs;
      ELSE
        UPDATE public.child_state
           SET name = clean_name,
               look = coalesce(p_look, look),
               updated_at = now()
         WHERE family_id = fam.id
        RETURNING * INTO cs;
      END IF;
    ELSIF p_look IS NOT NULL AND cs.family_id IS NOT NULL THEN
      UPDATE public.child_state SET look = p_look, updated_at = now()
       WHERE family_id = fam.id RETURNING * INTO cs;
    END IF;
  END IF;

  parents := public.raise_child_parents(fam.id);
  IF fam.status = 'setup' AND cardinality(parents) = 2 AND cs.family_id IS NOT NULL THEN
    SELECT traits INTO traits_a FROM public.family_parents WHERE family_id = fam.id AND user_id = parents[1];
    SELECT traits INTO traits_b FROM public.family_parents WHERE family_id = fam.id AND user_id = parents[2];
    IF cardinality(coalesce(traits_a, '{}')) = 3 AND cardinality(coalesce(traits_b, '{}')) = 3 THEN
      UPDATE public.families SET status = 'active', updated_at = now() WHERE id = fam.id;
      UPDATE public.child_state
         SET temperament = public.raise_child_temperament(traits_a, traits_b),
             lead_user_id = fam.created_by,
             last_tick_day = NULL,
             updated_at = now()
       WHERE family_id = fam.id;
      INSERT INTO public.album_entries (family_id, kind, age, title, body)
      VALUES (
        fam.id, 'milestone', 0,
        'The day ' || cs.name || ' arrived',
        'Two parents, three traits each, and a whole childhood ahead. ' || cs.name || ' came home today.'
      );
      PERFORM public.raise_child_tick_family(fam.id);
    END IF;
  END IF;

  RETURN public.raise_child_state();
END;
$$;

-- ---------------------------------------------------------------------------------
-- 9. The state the app reads: never a partner's sealed pick, never a bond number
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_state()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  cfg public.game_config%ROWTYPE;
  fam public.families%ROWTYPE;
  cs public.child_state%ROWTYPE;
  parents UUID[];
  partner UUID;
  my_traits TEXT[];
  partner_traits TEXT[];
  my_bond SMALLINT;
  bond_band TEXT;
  bond_line TEXT;
  child_json JSONB := NULL;
  moments JSONB := '[]'::JSONB;
  gift_json JSONB := NULL;
  open_count INTEGER := 0;
  can_age_up BOOLEAN := false;
  age_hint TEXT := NULL;
  letter_json JSONB := NULL;
  catalog JSONB;
  configured BOOLEAN;
  album_count INTEGER := 0;
  today DATE := (timezone('utc'::text, now()))::date;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Sign in to raise a child.'; END IF;
  cfg := public.raise_child_config();
  SELECT count(*) > 0 INTO configured FROM public.event_templates WHERE active;

  SELECT coalesce(jsonb_agg(jsonb_build_object('slug', t.slug, 'label', t.label, 'blurb', t.blurb) ORDER BY t.sort_order, t.label), '[]'::JSONB)
    INTO catalog
    FROM public.trait_catalog t WHERE t.kind = 'parent' AND t.active;

  fam := public.raise_child_open_family();
  IF fam.id IS NULL THEN
    RETURN jsonb_build_object(
      'family', NULL,
      'configured', configured,
      'config', to_jsonb(cfg) - 'id',
      'setup', jsonb_build_object(
        'name', NULL, 'look', '{}'::JSONB, 'catalog', catalog,
        'mine', '[]'::JSONB, 'partner_joined', false, 'ready', false,
        'content_ready', configured
      ),
      'me', jsonb_build_object('bond', jsonb_build_object('band', NULL, 'line', NULL), 'is_lead', false),
      'child', NULL,
      'today', jsonb_build_object('moments', '[]'::JSONB, 'gift', NULL, 'can_age_up', false, 'age_up_hint', NULL),
      'album', jsonb_build_object('count', 0),
      'letter', NULL
    );
  END IF;

  SELECT * INTO cs FROM public.child_state WHERE family_id = fam.id;
  parents := public.raise_child_parents(fam.id);
  partner := CASE WHEN parents[1] = caller THEN parents[2] ELSE parents[1] END;
  SELECT traits INTO my_traits FROM public.family_parents WHERE family_id = fam.id AND user_id = caller;
  SELECT traits INTO partner_traits FROM public.family_parents WHERE family_id = fam.id AND user_id = partner;
  SELECT bond INTO my_bond FROM public.family_parents WHERE family_id = fam.id AND user_id = caller;

  IF my_bond IS NOT NULL THEN
    bond_band := public.raise_child_bond_band(my_bond);
  END IF;

  IF cs.family_id IS NOT NULL THEN
    bond_line := public.raise_child_bond_line(coalesce(my_bond, 50)::SMALLINT, cs.name);
    child_json := jsonb_build_object(
      'name', cs.name,
      'look', cs.look,
      'age', cs.age,
      'mood', cs.mood,
      'traits', coalesce((
        SELECT jsonb_agg(jsonb_build_object('slug', t.slug, 'label', t.label, 'blurb', t.blurb) ORDER BY t.sort_order)
          FROM public.trait_catalog t
         WHERE t.slug = ANY(coalesce(cs.visible_traits, '{}'))
      ), '[]'::JSONB),
      'age_label', CASE
        WHEN cs.age = 0 THEN 'newborn'
        WHEN cs.age = 1 THEN 'one year old'
        ELSE cs.age || ' years old'
      END
    );

    SELECT count(*) INTO album_count FROM public.album_entries WHERE family_id = fam.id;
    SELECT count(*) INTO open_count FROM public.family_moments WHERE family_id = fam.id AND status = 'open';

    SELECT coalesce(jsonb_agg(moment ORDER BY created_at), '[]'::JSONB) INTO moments
      FROM (
        SELECT
          m.created_at,
          jsonb_build_object(
            'id', m.id,
            'age', m.age,
            'category', m.category,
            'title', t.title,
            'setup_text', t.setup_text,
            'choices', (
              SELECT jsonb_agg(jsonb_build_object('index', ord, 'label', c ->> 'label') ORDER BY ord)
                FROM jsonb_array_elements(t.choices) WITH ORDINALITY AS x(c, ord)
            ),
            'my_choice', mine.choice_index,
            'my_revisions', coalesce(mine.revisions, 0),
            -- The other parent's pick only ever appears once both have answered.
            'partner_voted', theirs.user_id IS NOT NULL,
            'partner_choice', CASE WHEN mine.user_id IS NOT NULL AND theirs.user_id IS NOT NULL
                                   THEN theirs.choice_index ELSE NULL END,
            'disagreement', (m.status = 'open'
                             AND mine.user_id IS NOT NULL AND theirs.user_id IS NOT NULL
                             AND mine.choice_index <> theirs.choice_index),
            'is_lead', coalesce(cs.lead_user_id = caller, false),
            'can_decide', (m.status = 'open'
                           AND cs.lead_user_id = caller
                           AND mine.user_id IS NOT NULL AND theirs.user_id IS NOT NULL
                           AND mine.choice_index <> theirs.choice_index),
            'can_change', (m.status = 'open'
                           AND mine.user_id IS NOT NULL
                           AND coalesce(mine.revisions, 0) < 1),
            'resolved', m.status = 'resolved',
            'outcome', CASE WHEN m.status = 'resolved' THEN m.outcome ELSE NULL END,
            'due_at', m.created_at + make_interval(hours => cfg.timeout_hours),
            'created_at', m.created_at
          ) AS moment
        FROM public.family_moments m
        JOIN public.event_templates t ON t.slug = m.event_slug
        LEFT JOIN public.family_votes mine ON mine.moment_id = m.id AND mine.user_id = caller
        LEFT JOIN public.family_votes theirs ON theirs.moment_id = m.id AND theirs.user_id = partner
        WHERE m.family_id = fam.id
          AND m.age = cs.age
          AND (m.status = 'open' OR m.resolved_at > now() - interval '2 days')
      ) s;

    SELECT jsonb_build_object(
        'id', g.id, 'title', g.title, 'body', g.body, 'day', g.day,
        'opened', g.opened_at IS NOT NULL
      )
      INTO gift_json
      FROM public.family_gifts g
     WHERE g.family_id = fam.id AND g.user_id = caller
     ORDER BY g.created_at DESC
     LIMIT 1;

    can_age_up := fam.status = 'active'
      AND public.raise_child_chapter_complete(fam.id, cs.age)
      AND (
        cs.last_age_up_day IS NULL
        OR cs.last_age_up_day <> today
        OR cfg.chapters_per_day > 1
      );
    age_hint := CASE
      WHEN fam.status = 'letter' THEN NULL
      WHEN open_count > 0 THEN 'A moment is still waiting on you both.'
      WHEN NOT public.raise_child_chapter_complete(fam.id, cs.age) THEN 'The next moment arrives tomorrow.'
      WHEN cs.last_age_up_day = today AND cfg.chapters_per_day <= 1 THEN 'Today''s chapter is done. Come back tomorrow.'
      WHEN NOT configured THEN 'No moments are switched on yet.'
      ELSE NULL
    END;

    letter_json := cs.letter;
  END IF;

  RETURN jsonb_build_object(
    'family', jsonb_build_object('id', fam.id, 'status', fam.status, 'since', fam.created_at),
    'configured', configured,
    'config', to_jsonb(cfg) - 'id',
    'setup', jsonb_build_object(
      'name', cs.name,
      'look', coalesce(cs.look, '{}'::JSONB),
      'catalog', catalog,
      'mine', to_jsonb(coalesce(my_traits, '{}')),
      'partner_joined', partner IS NOT NULL,
      'partner_traits_ready', cardinality(coalesce(partner_traits, '{}')) = 3,
      'ready', fam.status <> 'setup',
      'content_ready', configured
    ),
    'me', jsonb_build_object(
      'user_id', caller,
      'bond', jsonb_build_object('band', bond_band, 'line', bond_line),
      'is_lead', coalesce(cs.lead_user_id = caller, false)
    ),
    'child', child_json,
    'today', jsonb_build_object(
      'moments', moments,
      'gift', gift_json,
      'can_age_up', can_age_up,
      'age_up_hint', age_hint
    ),
    'album', jsonb_build_object('count', album_count),
    'letter', letter_json
  );
END;
$$;

-- ---------------------------------------------------------------------------------
-- 10. Playing: a private pick, an age up, the album, and the letter at eighteen
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_vote(p_moment_id UUID, p_choice INTEGER)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  m public.family_moments%ROWTYPE;
  tpl public.event_templates%ROWTYPE;
  fam public.families%ROWTYPE;
  mine public.family_votes%ROWTYPE;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Sign in to raise a child.'; END IF;

  SELECT * INTO m FROM public.family_moments WHERE id = p_moment_id;
  IF m.id IS NULL THEN RAISE EXCEPTION 'That moment is not here any more.'; END IF;
  fam := public.raise_child_guard_family(m.family_id);
  IF fam.status <> 'active' THEN RAISE EXCEPTION 'This chapter is closed.'; END IF;
  IF m.status = 'resolved' THEN RAISE EXCEPTION 'That moment has already been decided.'; END IF;
  SELECT * INTO tpl FROM public.event_templates WHERE slug = m.event_slug;
  IF p_choice IS NULL OR p_choice < 1 OR p_choice > jsonb_array_length(tpl.choices) THEN
    RAISE EXCEPTION 'Choose one of the options on the card.';
  END IF;

  SELECT * INTO mine FROM public.family_votes WHERE moment_id = m.id AND user_id = caller;
  IF mine.moment_id IS NULL THEN
    INSERT INTO public.family_votes (moment_id, user_id, choice_index)
    VALUES (m.id, caller, p_choice::SMALLINT);
  ELSIF mine.choice_index = p_choice THEN
    -- Asking for the answer already given changes nothing, and uses nothing up.
    NULL;
  ELSIF mine.revisions >= 1 THEN
    RAISE EXCEPTION 'You have already had your second say on this one.';
  ELSE
    UPDATE public.family_votes
       SET choice_index = p_choice::SMALLINT,
           revisions = revisions + 1,
           updated_at = now()
     WHERE moment_id = m.id AND user_id = caller;
  END IF;

  -- This settles an agreement, and only an agreement.
  PERFORM public.raise_child_resolve_as(m.id, false, 'auto');
  RETURN public.raise_child_state();
END;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_lead_decide(p_moment_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  m public.family_moments%ROWTYPE;
  fam public.families%ROWTYPE;
  cs public.child_state%ROWTYPE;
BEGIN
  IF caller IS NULL THEN RAISE EXCEPTION 'Sign in to raise a child.'; END IF;

  SELECT * INTO m FROM public.family_moments WHERE id = p_moment_id;
  IF m.id IS NULL THEN RAISE EXCEPTION 'That moment is not here any more.'; END IF;
  fam := public.raise_child_guard_family(m.family_id);
  IF fam.status <> 'active' THEN RAISE EXCEPTION 'This chapter is closed.'; END IF;
  IF m.status = 'resolved' THEN RAISE EXCEPTION 'That moment has already been decided.'; END IF;

  SELECT * INTO cs FROM public.child_state WHERE family_id = m.family_id;
  IF cs.lead_user_id IS DISTINCT FROM caller THEN
    RAISE EXCEPTION 'This year''s call belongs to your partner. Talk it through instead.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.family_votes WHERE moment_id = m.id AND user_id = caller)
     OR NOT EXISTS (SELECT 1 FROM public.family_votes WHERE moment_id = m.id AND user_id <> caller) THEN
    RAISE EXCEPTION 'Wait until you have both answered.';
  END IF;

  IF public.raise_child_resolve_as(m.id, true, 'lead') IS NULL THEN
    RAISE EXCEPTION 'There is nothing to decide here yet.';
  END IF;
  RETURN public.raise_child_state();
END;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_open_gift(p_gift_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE g public.family_gifts%ROWTYPE;
BEGIN
  SELECT * INTO g FROM public.family_gifts WHERE id = p_gift_id;
  IF g.id IS NULL THEN RAISE EXCEPTION 'That gift is not here any more.'; END IF;
  PERFORM public.raise_child_guard_family(g.family_id);
  IF g.user_id <> auth.uid() THEN RAISE EXCEPTION 'That gift is for your partner.'; END IF;
  UPDATE public.family_gifts SET opened_at = coalesce(opened_at, now()) WHERE id = g.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_age_up()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  fam public.families%ROWTYPE;
  cs public.child_state%ROWTYPE;
  cfg public.game_config%ROWTYPE;
  parents UUID[];
  other UUID;
  waiting INTEGER;
  next_age SMALLINT;
  milestone TEXT;
  milestone_body TEXT;
BEGIN
  fam := public.raise_child_open_family();
  IF fam.id IS NULL THEN RAISE EXCEPTION 'Start the family first.'; END IF;
  IF fam.status <> 'active' THEN RAISE EXCEPTION 'This family is not in a chapter right now.'; END IF;
  SELECT * INTO cs FROM public.child_state WHERE family_id = fam.id;
  IF cs.family_id IS NULL THEN RAISE EXCEPTION 'The family is still being set up.'; END IF;
  cfg := public.raise_child_config();
  PERFORM public.raise_child_resolve_due(fam.id);

  SELECT count(*) INTO waiting FROM public.family_moments
   WHERE family_id = fam.id AND age = cs.age AND status = 'open';
  IF waiting > 0 THEN
    RAISE EXCEPTION 'There is still a moment waiting on both of you.';
  END IF;
  IF NOT public.raise_child_chapter_complete(fam.id, cs.age) THEN
    RAISE EXCEPTION 'This chapter still has a moment to come.';
  END IF;
  IF cfg.chapters_per_day <= 0 THEN
    RAISE EXCEPTION 'Chapters are paused right now.';
  END IF;
  IF cs.last_age_up_day = (timezone('utc'::text, now()))::date AND cfg.chapters_per_day <= 1 THEN
    RAISE EXCEPTION 'Today''s chapter is done. Come back tomorrow.';
  END IF;

  parents := public.raise_child_parents(fam.id);
  other := CASE WHEN parents[1] = cs.lead_user_id THEN parents[2] ELSE parents[1] END;
  next_age := least(18, cs.age + 1);

  UPDATE public.child_state
     SET age = next_age,
         lead_user_id = coalesce(other, lead_user_id),
         last_age_up_day = (timezone('utc'::text, now()))::date,
         last_tick_day = NULL,
         updated_at = now()
   WHERE family_id = fam.id
  RETURNING * INTO cs;

  milestone := CASE cs.age
    WHEN 1 THEN 'First word'
    WHEN 5 THEN 'First day of school'
    WHEN 7 THEN 'First best friend'
    WHEN 14 THEN 'First heartbreak'
    WHEN 18 THEN 'Graduation'
    ELSE NULL END;
  IF milestone IS NOT NULL THEN
    milestone_body := CASE cs.age
      WHEN 1 THEN cs.name || ' said a whole word, and then said it eleven more times to be sure.'
      WHEN 5 THEN 'A bag too big, a uniform too long, and a wave at the gate that lasted a little too long.'
      WHEN 7 THEN 'A friend at last — the kind you wait by the door for.'
      WHEN 14 THEN 'A first heartbreak. Small in the scheme of things, enormous that week. You were there.'
      ELSE cs.name || ' walked out of the school gates for the last time, and back in through your front door.' END;
    INSERT INTO public.album_entries (family_id, kind, age, title, body)
    VALUES (fam.id, 'milestone', cs.age, milestone, milestone_body);
  END IF;

  IF cs.age >= 18 THEN
    UPDATE public.families SET status = 'letter', updated_at = now() WHERE id = fam.id;
    PERFORM public.raise_child_write_letter(fam.id);
  ELSE
    -- The new chapter opens through the same daily pace as any other day: if today's
    -- allowance is spent, the first card arrives tomorrow.
    PERFORM public.raise_child_tick_family(fam.id, (timezone('utc'::text, now()))::date);
  END IF;

  RETURN public.raise_child_state();
END;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_album(p_limit INTEGER DEFAULT 40, p_before TIMESTAMPTZ DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  fam public.families%ROWTYPE;
BEGIN
  fam := public.raise_child_open_family();
  IF fam.id IS NULL THEN RETURN '[]'::JSONB; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
        'id', e.id, 'kind', e.kind, 'age', e.age, 'title', e.title,
        'body', e.body, 'created_at', e.created_at, 'author_id', e.author_id
      ) ORDER BY e.created_at DESC)
      FROM (
        SELECT * FROM public.album_entries
         WHERE family_id = fam.id
           AND (p_before IS NULL OR created_at < p_before)
         ORDER BY created_at DESC
         LIMIT greatest(1, least(coalesce(p_limit, 40), 100))
      ) e
  ), '[]'::JSONB);
END;
$$;

-- ---------------------------------------------------------------------------------
-- 11. Eighteen: the letter, the note back, and a new child when they are ready
-- ---------------------------------------------------------------------------------

-- Assembled from what actually happened — the traits the family grew, how often the
-- two of them found each other, and how many decisions they made — from fixed pieces
-- of text. No outside service, and never cruel: a low bond is written as distance
-- that was worked through, not as blame.
CREATE OR REPLACE FUNCTION public.raise_child_write_letter(p_family_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  cs public.child_state%ROWTYPE;
  traits TEXT;
  trait_count INTEGER;
  decided INTEGER;
  agreed INTEGER;
  paragraphs JSONB;
  letter_json JSONB;
BEGIN
  SELECT * INTO cs FROM public.child_state WHERE family_id = p_family_id;
  IF cs.family_id IS NULL THEN RETURN NULL; END IF;
  IF cs.letter IS NOT NULL THEN RETURN cs.letter; END IF;

  SELECT coalesce(string_agg(t.label, ', ' ORDER BY t.sort_order), ''), count(*)
    INTO traits, trait_count
    FROM public.trait_catalog t
   WHERE t.slug = ANY(coalesce(cs.visible_traits, '{}'));

  SELECT count(*), count(*) FILTER (WHERE m.agreement) INTO decided, agreed
    FROM public.family_moments m
   WHERE m.family_id = p_family_id AND m.status = 'resolved';

  paragraphs := jsonb_build_array(
    'Dear both of you,',
    'I am eighteen today, which is strange to write down. I keep thinking about how many times you must have stood in the kitchen deciding something about me.',
    CASE WHEN trait_count = 0
      THEN 'You always said I was a bit of everything, and never quite one thing.'
      ELSE 'You always say I am ' || traits || '. I think I got that from the two of you, in different measures.'
    END,
    CASE WHEN decided = 0
      THEN 'You did not have many big moments to argue over. The small ones, you did together.'
      WHEN agreed = decided
        THEN 'You made ' || decided || ' decisions about me, and every one of them you agreed on. I never once heard a door slam over me.'
      ELSE 'You made ' || decided || ' decisions about me. ' || agreed || ' of them you saw the same way straight off. The rest you had to talk through, and I noticed that too — how you always came back to the table.'
    END,
    'Whatever else was going on, there was always someone at the door when I came home.',
    -- No signature: the app does not draw a closing for anyone.
    'Thank you for deciding together, even when it was hard, and for letting me be the reason. I am all right. I am going to be all right.'
  );

  letter_json := jsonb_build_object(
    'paragraphs', paragraphs,
    'written_at', now(),
    'child', cs.name
  );

  UPDATE public.child_state SET letter = letter_json, letter_written_at = now(), updated_at = now()
   WHERE family_id = p_family_id;

  INSERT INTO public.album_entries (family_id, kind, age, title, body)
  VALUES (p_family_id, 'letter', 18, cs.name || '’s letter to you both', (SELECT string_agg(value, E'\n\n') FROM jsonb_array_elements_text(paragraphs)));

  RETURN letter_json;
END;
$$;

CREATE OR REPLACE FUNCTION public.raise_child_reply(p_note TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  fam public.families%ROWTYPE;
  cs public.child_state%ROWTYPE;
  clean TEXT := btrim(coalesce(p_note, ''));
BEGIN
  fam := public.raise_child_open_family();
  IF fam.id IS NULL THEN RAISE EXCEPTION 'There is no family here yet.'; END IF;
  IF fam.status <> 'letter' THEN RAISE EXCEPTION 'The letter comes at eighteen.'; END IF;
  SELECT * INTO cs FROM public.child_state WHERE family_id = fam.id;
  IF char_length(clean) = 0 THEN RAISE EXCEPTION 'Write a line first.'; END IF;
  IF char_length(clean) > 400 THEN RAISE EXCEPTION 'Keep it to 400 characters.'; END IF;
  INSERT INTO public.album_entries (family_id, kind, age, title, body, author_id)
  VALUES (fam.id, 'note', 18, 'A note back to ' || cs.name, clean, auth.uid());
END;
$$;

-- Archiving is the only thing that closes a family. The album stays; nothing is deleted.
CREATE OR REPLACE FUNCTION public.raise_child_new_child()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  fam public.families%ROWTYPE;
BEGIN
  fam := public.raise_child_open_family();
  IF fam.id IS NOT NULL THEN
    IF fam.status <> 'letter' THEN
      RAISE EXCEPTION 'The letter at eighteen comes before a new child.';
    END IF;
    UPDATE public.families SET status = 'archived', archived_at = now(), updated_at = now()
     WHERE id = fam.id;
  END IF;
  RETURN public.raise_child_state();
END;
$$;

-- ---------------------------------------------------------------------------------
-- 12. Permissions: the app gets the app functions, the job gets the job functions
-- ---------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.can_read_family_vote(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_read_family_vote(UUID, UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.raise_child_state(), public.raise_child_setup(TEXT, JSONB, TEXT[]),
  public.raise_child_vote(UUID, INTEGER), public.raise_child_open_gift(UUID), public.raise_child_age_up(),
  public.raise_child_album(INTEGER, TIMESTAMPTZ), public.raise_child_reply(TEXT), public.raise_child_new_child(),
  public.raise_child_lead_decide(UUID)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raise_child_state(), public.raise_child_setup(TEXT, JSONB, TEXT[]),
  public.raise_child_vote(UUID, INTEGER), public.raise_child_open_gift(UUID), public.raise_child_age_up(),
  public.raise_child_album(INTEGER, TIMESTAMPTZ), public.raise_child_reply(TEXT), public.raise_child_new_child(),
  public.raise_child_lead_decide(UUID)
  TO authenticated;

REVOKE ALL ON FUNCTION public.raise_child_config(), public.raise_child_require_couple(),
  public.raise_child_open_family(), public.raise_child_guard_family(UUID), public.raise_child_parents(UUID),
  public.raise_child_validate_traits(TEXT[]), public.raise_child_temperament(TEXT[], TEXT[]),
  public.raise_child_bond_band(SMALLINT), public.raise_child_bond_line(SMALLINT, TEXT),
  public.raise_child_apply_effects(UUID, JSONB, UUID, UUID, BOOLEAN, SMALLINT),
  public.raise_child_pick_event(UUID, SMALLINT, TEXT[], BOOLEAN, BOOLEAN),
  public.raise_child_chapter_target(SMALLINT), public.raise_child_chapter_complete(UUID, SMALLINT),
  public.raise_child_choose_event(UUID, SMALLINT), public.raise_child_create_moment(UUID, SMALLINT, DATE),
  public.raise_child_resolve(UUID, BOOLEAN), public.raise_child_resolve_due(UUID),
  public.raise_child_gift_copy(SMALLINT, TEXT[], TEXT), public.raise_child_create_gift(UUID, DATE),
  public.raise_child_queue_notification(UUID, DATE), public.raise_child_tick_family(UUID, DATE),
  public.raise_child_daily_tick(DATE), public.raise_child_claim_notifications(INTEGER),
  public.raise_child_mark_notification_sent(UUID), public.raise_child_invoke_push(),
  public.raise_child_write_letter(UUID)
  FROM PUBLIC, anon, authenticated;

-- The new resolver is the job's alone; the lead parent's call is a signed-in RPC.
REVOKE ALL ON FUNCTION public.raise_child_resolve_as(UUID, BOOLEAN, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.raise_child_resolve_as(UUID, BOOLEAN, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.raise_child_lead_decide(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raise_child_lead_decide(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.raise_child_daily_tick(DATE), public.raise_child_tick_family(UUID, DATE),
  public.raise_child_resolve(UUID, BOOLEAN), public.raise_child_resolve_due(UUID),
  public.raise_child_write_letter(UUID), public.raise_child_claim_notifications(INTEGER),
  public.raise_child_mark_notification_sent(UUID), public.raise_child_invoke_push()
  TO service_role;

-- ---------------------------------------------------------------------------------
-- 13. Realtime: both phones see the same reveal, without a refresh
-- ---------------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'families') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.families;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'child_state') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.child_state;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'family_moments') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.family_moments;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'family_votes') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.family_votes;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'album_entries') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.album_entries;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'family_gifts') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.family_gifts;
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------
-- 14. The hourly job. Content is created once a day inside the function; the hourly
-- call is what settles the 24-hour timeouts promptly and drains the push outbox.
-- ---------------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE 'SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = ''nooki-raise-a-child-hourly''';
    PERFORM cron.schedule(
      'nooki-raise-a-child-hourly',
      '7 * * * *',
      'SELECT public.raise_child_daily_tick();'
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------------
-- 15. The way back from the chat. "Talk it out" posts the split as a normal chat
-- message; this table is the line from that message back to the moment, so either
-- parent can tap it and land on the decision card again. No existing table changes.
-- ---------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.raise_child_chat_links (
  message_id UUID PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  moment_id UUID NOT NULL REFERENCES public.family_moments(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

-- ---------------------------------------------------------------------------------
-- 16. Daily Decisions: the way back from the chat. "Take to chat" posts one short
-- line with a link; that link is what brings either partner back to the card to
-- answer it. The three options never leave the sheet. No existing table changes.
-- ---------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.daily_decision_chat_links (
  message_id UUID PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  question_id BIGINT NOT NULL REFERENCES public.daily_decision_questions(id) ON DELETE CASCADE,
  decision_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

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
-- ---------------------------------------------------------------------------------
-- 17. Mutual naming: the child's name and face belong to both parents. Each parent
-- proposes; the child is only named when the two proposals agree. Additive only.
-- ---------------------------------------------------------------------------------
-- ---------------------------------------------------------------------------------
-- 1. The proposals: one per parent, readable by both, writable only by its author
-- ---------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.family_setup_proposals (
  family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  look JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(look) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, user_id)
);

ALTER TABLE public.family_setup_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_setup_proposals REPLICA IDENTITY FULL;

-- Both partners read both proposals: seeing each other's idea is the whole point.
DROP POLICY IF EXISTS family_setup_proposals_read_couple ON public.family_setup_proposals;
CREATE POLICY family_setup_proposals_read_couple ON public.family_setup_proposals
  FOR SELECT TO authenticated
  USING (family_id IN (
    SELECT id FROM public.families WHERE couple_id = public.get_user_couple_id(auth.uid())
  ));

-- No insert/update/delete policy: the two functions below are the only way in, so a
-- parent can never write the other parent's name for them.
REVOKE ALL ON public.family_setup_proposals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.family_setup_proposals TO authenticated;
GRANT ALL ON public.family_setup_proposals TO service_role;

COMMENT ON TABLE public.family_setup_proposals IS
  'Each parent''s suggested name and face. The child is only named when the two agree.';

-- ---------------------------------------------------------------------------------
-- 2. Agreement: the same name, and the same face, by both parents
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_same_name(p_a TEXT, p_b TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
AS $$
  SELECT btrim(coalesce(p_a, '')) <> ''
     AND lower(btrim(coalesce(p_a, ''))) = lower(btrim(coalesce(p_b, '')));
$$;

-- Only the three things a parent can actually choose are compared, so a future extra key
-- on the look can never stop two parents who agree from being understood to agree.
CREATE OR REPLACE FUNCTION public.raise_child_same_look(p_a JSONB, p_b JSONB)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
AS $$
  SELECT coalesce(p_a -> 'skin', '""'::JSONB) = coalesce(p_b -> 'skin', '""'::JSONB)
     AND coalesce(p_a -> 'hair', '""'::JSONB) = coalesce(p_b -> 'hair', '""'::JSONB)
     AND coalesce(p_a -> 'outfit', '""'::JSONB) = coalesce(p_b -> 'outfit', '""'::JSONB);
$$;

COMMENT ON FUNCTION public.raise_child_same_name(TEXT, TEXT) IS
  'The same name apart from case and stray spaces.';
COMMENT ON FUNCTION public.raise_child_same_look(JSONB, JSONB) IS
  'The same skin, hair and colour.';

-- ---------------------------------------------------------------------------------
-- 3. Settling: when the two proposals agree, that is the child — and if six traits are
--    in as well, the childhood opens. Nothing here runs twice: the family leaves 'setup'.
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_settle_setup(p_family_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  fam public.families%ROWTYPE;
  parents UUID[];
  prop_a public.family_setup_proposals%ROWTYPE;
  prop_b public.family_setup_proposals%ROWTYPE;
  traits_a TEXT[];
  traits_b TEXT[];
  settled_name TEXT;
BEGIN
  SELECT * INTO fam FROM public.families WHERE id = p_family_id;
  IF fam.id IS NULL OR fam.status <> 'setup' THEN RETURN; END IF;

  parents := public.raise_child_parents(fam.id);
  IF cardinality(parents) < 2 THEN RETURN; END IF;

  SELECT * INTO prop_a FROM public.family_setup_proposals
   WHERE family_id = fam.id AND user_id = parents[1];
  SELECT * INTO prop_b FROM public.family_setup_proposals
   WHERE family_id = fam.id AND user_id = parents[2];
  IF prop_a.family_id IS NULL OR prop_b.family_id IS NULL THEN RETURN; END IF;

  IF NOT public.raise_child_same_name(prop_a.name, prop_b.name) THEN RETURN; END IF;
  IF NOT public.raise_child_same_look(prop_a.look, prop_b.look) THEN RETURN; END IF;

  -- Both parents proposed the same child. That is the child.
  settled_name := btrim(prop_a.name);
  INSERT INTO public.child_state (family_id, name, look)
  VALUES (fam.id, settled_name, prop_a.look)
  ON CONFLICT (family_id) DO UPDATE
    SET name = EXCLUDED.name,
        look = EXCLUDED.look,
        updated_at = now();

  -- The childhood opens only when the name, the face and all six traits are agreed.
  SELECT traits INTO traits_a FROM public.family_parents WHERE family_id = fam.id AND user_id = parents[1];
  SELECT traits INTO traits_b FROM public.family_parents WHERE family_id = fam.id AND user_id = parents[2];
  IF cardinality(coalesce(traits_a, '{}')) = 3 AND cardinality(coalesce(traits_b, '{}')) = 3 THEN
    UPDATE public.families SET status = 'active', updated_at = now() WHERE id = fam.id;
    UPDATE public.child_state
       SET temperament = public.raise_child_temperament(traits_a, traits_b),
           lead_user_id = fam.created_by,
           last_tick_day = NULL,
           updated_at = now()
     WHERE family_id = fam.id;
    INSERT INTO public.album_entries (family_id, kind, age, title, body)
    VALUES (
      fam.id, 'milestone', 0,
      'The day ' || settled_name || ' arrived',
      'Two parents, three traits each, and a whole childhood ahead. ' || settled_name || ' came home today.'
    );
    PERFORM public.raise_child_tick_family(fam.id);
  END IF;
END;
$$;

COMMENT ON FUNCTION public.raise_child_settle_setup(UUID) IS
  'Names the child once both parents'' proposals agree, and opens the childhood when the traits are in too.';

-- ---------------------------------------------------------------------------------
-- 4. What each parent sees of the other's idea
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_setup_proposals()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  fam public.families%ROWTYPE;
  mine public.family_setup_proposals%ROWTYPE;
  theirs public.family_setup_proposals%ROWTYPE;
BEGIN
  PERFORM public.raise_child_require_couple();
  fam := public.raise_child_open_family();

  IF fam.id IS NULL THEN
    RETURN jsonb_build_object(
      'mine', NULL, 'partner', NULL,
      'name_same', false, 'look_same', false,
      'agreed', false, 'locked', false
    );
  END IF;

  SELECT * INTO mine FROM public.family_setup_proposals
   WHERE family_id = fam.id AND user_id = auth.uid();
  SELECT * INTO theirs FROM public.family_setup_proposals
   WHERE family_id = fam.id AND user_id <> auth.uid()
   ORDER BY created_at
   LIMIT 1;

  RETURN jsonb_build_object(
    'mine', CASE WHEN mine.family_id IS NULL THEN NULL
                 ELSE jsonb_build_object('name', mine.name, 'look', mine.look) END,
    'partner', CASE WHEN theirs.family_id IS NULL THEN NULL
                    ELSE jsonb_build_object('name', theirs.name, 'look', theirs.look) END,
    'name_same', mine.family_id IS NOT NULL AND theirs.family_id IS NOT NULL
      AND public.raise_child_same_name(mine.name, theirs.name),
    'look_same', mine.family_id IS NOT NULL AND theirs.family_id IS NOT NULL
      AND public.raise_child_same_look(mine.look, theirs.look),
    'agreed', mine.family_id IS NOT NULL AND theirs.family_id IS NOT NULL
      AND public.raise_child_same_name(mine.name, theirs.name)
      AND public.raise_child_same_look(mine.look, theirs.look),
    'locked', fam.status <> 'setup'
  );
END;
$$;

COMMENT ON FUNCTION public.raise_child_setup_proposals() IS
  'Both parents'' suggested names and faces, as this parent is allowed to see them.';

-- ---------------------------------------------------------------------------------
-- 5. Proposing: the same call the app already makes, but it can no longer name the child
--    on its own. A name here is a suggestion and nothing more.
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_setup(
  p_name TEXT DEFAULT NULL,
  p_look JSONB DEFAULT NULL,
  p_traits TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  cid UUID;
  fam public.families%ROWTYPE;
  chosen_traits TEXT[] := NULL;
  clean_name TEXT := nullif(btrim(coalesce(p_name, '')), '');
BEGIN
  cid := public.raise_child_require_couple();
  fam := public.raise_child_open_family();

  IF p_traits IS NOT NULL AND cardinality(p_traits) > 0 THEN
    chosen_traits := public.raise_child_validate_traits(p_traits);
  END IF;

  IF fam.id IS NULL THEN
    INSERT INTO public.families (couple_id, created_by) VALUES (cid, caller) RETURNING * INTO fam;
  END IF;

  INSERT INTO public.family_parents (family_id, user_id, traits)
  VALUES (fam.id, caller, coalesce(chosen_traits, '{}'))
  ON CONFLICT (family_id, user_id) DO UPDATE
    SET traits = CASE WHEN cardinality(EXCLUDED.traits) = 3 THEN EXCLUDED.traits ELSE public.family_parents.traits END;

  -- While the family is still being set up, a name is a proposal. Once the childhood has
  -- begun the name is settled and this is deliberately ignored: neither parent can rename
  -- the child alone, and a late client cannot smuggle one in.
  IF fam.status = 'setup' AND clean_name IS NOT NULL THEN
    INSERT INTO public.family_setup_proposals (family_id, user_id, name, look)
    VALUES (fam.id, caller, clean_name, coalesce(p_look, '{}'::JSONB))
    ON CONFLICT (family_id, user_id) DO UPDATE
      SET name = EXCLUDED.name,
          look = CASE WHEN p_look IS NULL THEN public.family_setup_proposals.look ELSE EXCLUDED.look END,
          updated_at = now();
  END IF;

  PERFORM public.raise_child_settle_setup(fam.id);

  RETURN public.raise_child_state();
END;
$$;

COMMENT ON FUNCTION public.raise_child_setup(TEXT, JSONB, TEXT[]) IS
  'Saves this parent''s traits and their suggested name and face. The child is named only when both parents agree.';

-- ---------------------------------------------------------------------------------
-- 6. Moving to the other's idea: "Use Mia" or "Use their face", deliberately
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_adopt_setup(p_part TEXT DEFAULT 'all')
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  fam public.families%ROWTYPE;
  mine public.family_setup_proposals%ROWTYPE;
  theirs public.family_setup_proposals%ROWTYPE;
  part TEXT := lower(coalesce(nullif(btrim(p_part), ''), 'all'));
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in to raise a child.'; END IF;
  fam := public.raise_child_open_family();
  IF fam.id IS NULL THEN RAISE EXCEPTION 'Start the family first.'; END IF;
  IF fam.status <> 'setup' THEN
    RAISE EXCEPTION 'The name is settled now.';
  END IF;
  IF part NOT IN ('name', 'look', 'all') THEN
    RAISE EXCEPTION 'There is nothing to match there.';
  END IF;

  SELECT * INTO theirs FROM public.family_setup_proposals
   WHERE family_id = fam.id AND user_id <> auth.uid()
   ORDER BY created_at
   LIMIT 1;
  IF theirs.family_id IS NULL THEN
    RAISE EXCEPTION 'Your partner has not suggested a name yet.';
  END IF;

  SELECT * INTO mine FROM public.family_setup_proposals
   WHERE family_id = fam.id AND user_id = auth.uid();

  -- With nothing of my own yet, adopting anything means taking their whole suggestion.
  INSERT INTO public.family_setup_proposals (family_id, user_id, name, look)
  VALUES (fam.id, auth.uid(), theirs.name, theirs.look)
  ON CONFLICT (family_id, user_id) DO UPDATE
    SET name = CASE
          WHEN part IN ('name', 'all') THEN theirs.name
          ELSE public.family_setup_proposals.name
        END,
        look = CASE
          WHEN part IN ('look', 'all') THEN theirs.look
          ELSE public.family_setup_proposals.look
        END,
        updated_at = now();

  PERFORM public.raise_child_settle_setup(fam.id);

  RETURN public.raise_child_state();
END;
$$;

COMMENT ON FUNCTION public.raise_child_adopt_setup(TEXT) IS
  '"Use their name" / "use their face" / both, then settle the child if that made the two agree.';

-- ---------------------------------------------------------------------------------
-- 7. Permissions
-- ---------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.raise_child_same_name(TEXT, TEXT), public.raise_child_same_look(JSONB, JSONB),
  public.raise_child_settle_setup(UUID)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.raise_child_setup_proposals(), public.raise_child_adopt_setup(TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raise_child_setup_proposals(), public.raise_child_adopt_setup(TEXT)
  TO authenticated;

-- raise_child_setup keeps the grant it already had; the body simply proposes now.
GRANT EXECUTE ON FUNCTION public.raise_child_setup(TEXT, JSONB, TEXT[]) TO authenticated;

-- ---------------------------------------------------------------------------------
-- 8. Realtime: the partner's suggestion appears without a refresh
-- ---------------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
         AND tablename = 'family_setup_proposals'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.family_setup_proposals;
    END IF;
  END IF;
END $$;
-- ---------------------------------------------------------------------------------
-- 18. Inheritance: the three traits the child is born with — one from each parent,
-- the third from either — so the years of decisions start from somebody. Additive only.
-- ---------------------------------------------------------------------------------
-- ---------------------------------------------------------------------------------
-- 1. What the child came with, and who it came from
-- ---------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.child_inherited_traits (
  family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  trait TEXT NOT NULL,
  -- Kept per child so the resemblance line never has to guess: if both parents chose the
  -- same trait, the row still remembers which of them it is attributed to.
  from_user UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, trait)
);

ALTER TABLE public.child_inherited_traits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.child_inherited_traits REPLICA IDENTITY FULL;

DROP POLICY IF EXISTS child_inherited_traits_read_couple ON public.child_inherited_traits;
CREATE POLICY child_inherited_traits_read_couple ON public.child_inherited_traits
  FOR SELECT TO authenticated
  USING (family_id IN (
    SELECT id FROM public.families WHERE couple_id = public.get_user_couple_id(auth.uid())
  ));

-- Read by both parents; written only by the function below.
REVOKE ALL ON public.child_inherited_traits FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.child_inherited_traits TO authenticated;
GRANT ALL ON public.child_inherited_traits TO service_role;

COMMENT ON TABLE public.child_inherited_traits IS
  'The three traits the child was born with, and which parent each came from.';

-- ---------------------------------------------------------------------------------
-- 2. The draw
-- ---------------------------------------------------------------------------------

-- A random trait this parent has that the child does not have yet. NULL when there is
-- nothing left to take — two parents with identical lists simply give the child fewer.
CREATE OR REPLACE FUNCTION public.raise_child_pick_untaken(p_from TEXT[], p_taken TEXT[])
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE pool TEXT[];
BEGIN
  SELECT array_agg(t) INTO pool
    FROM unnest(coalesce(p_from, '{}'::TEXT[])) AS t
   WHERE NOT (t = ANY (coalesce(p_taken, '{}'::TEXT[])));
  IF pool IS NULL OR cardinality(pool) = 0 THEN RETURN NULL; END IF;
  RETURN pool[1 + floor(random() * cardinality(pool))::INT];
END;
$$;

-- At least one from each parent, then a third from either of them. Runs once per child:
-- a family that already has traits keeps the ones it was born with, whatever happens next.
CREATE OR REPLACE FUNCTION public.raise_child_seed_inherited_traits(p_family_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  fam public.families%ROWTYPE;
  parents UUID[];
  a_traits TEXT[];
  b_traits TEXT[];
  taken TEXT[] := '{}';
  pick TEXT;
  from_user UUID;
BEGIN
  SELECT * INTO fam FROM public.families WHERE id = p_family_id;
  IF fam.id IS NULL OR fam.status = 'setup' THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.child_inherited_traits WHERE family_id = fam.id) THEN RETURN; END IF;

  parents := public.raise_child_parents(fam.id);
  IF cardinality(parents) < 2 THEN RETURN; END IF;
  SELECT traits INTO a_traits FROM public.family_parents WHERE family_id = fam.id AND user_id = parents[1];
  SELECT traits INTO b_traits FROM public.family_parents WHERE family_id = fam.id AND user_id = parents[2];
  IF cardinality(coalesce(a_traits, '{}')) < 3 OR cardinality(coalesce(b_traits, '{}')) < 3 THEN RETURN; END IF;

  -- One from the first parent.
  pick := public.raise_child_pick_untaken(a_traits, taken);
  IF pick IS NOT NULL THEN
    INSERT INTO public.child_inherited_traits (family_id, trait, from_user, sort_order)
    VALUES (fam.id, pick, parents[1], 1);
    taken := taken || pick;
  END IF;

  -- One from the other, so neither parent is left out of their own child.
  pick := public.raise_child_pick_untaken(b_traits, taken);
  IF pick IS NOT NULL THEN
    INSERT INTO public.child_inherited_traits (family_id, trait, from_user, sort_order)
    VALUES (fam.id, pick, parents[2], 2);
    taken := taken || pick;
  END IF;

  -- And a third from whichever of the two it lands on (a coin toss when they share it).
  pick := public.raise_child_pick_untaken(a_traits || b_traits, taken);
  IF pick IS NOT NULL THEN
    SELECT options.candidate INTO from_user
      FROM (
        SELECT parents[1] AS candidate WHERE pick = ANY (a_traits)
        UNION ALL
        SELECT parents[2] AS candidate WHERE pick = ANY (b_traits)
      ) AS options
     ORDER BY random()
     LIMIT 1;
    INSERT INTO public.child_inherited_traits (family_id, trait, from_user, sort_order)
    VALUES (fam.id, pick, from_user, 3);
  END IF;
END;
$$;

COMMENT ON FUNCTION public.raise_child_seed_inherited_traits(UUID) IS
  'Draws the child''s three inherited traits once: at least one from each parent, the third from either.';

-- ---------------------------------------------------------------------------------
-- 3. What this parent sees of it
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_inheritance()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  caller UUID := auth.uid();
  fam public.families%ROWTYPE;
  cs public.child_state%ROWTYPE;
  parents UUID[];
  partner UUID;
  partner_name TEXT;
  mine INTEGER := 0;
  theirs INTEGER := 0;
  inherited JSONB;
BEGIN
  PERFORM public.raise_child_require_couple();
  fam := public.raise_child_open_family();
  IF fam.id IS NULL THEN
    RETURN jsonb_build_object('inherited', '[]'::JSONB, 'more_like', NULL, 'line', NULL);
  END IF;

  SELECT * INTO cs FROM public.child_state WHERE family_id = fam.id;
  IF cs.family_id IS NULL THEN
    RETURN jsonb_build_object('inherited', '[]'::JSONB, 'more_like', NULL, 'line', NULL);
  END IF;

  SELECT count(*) FILTER (WHERE from_user = caller),
         count(*) FILTER (WHERE from_user <> caller)
    INTO mine, theirs
    FROM public.child_inherited_traits WHERE family_id = fam.id;

  SELECT jsonb_agg(jsonb_build_object(
           'slug', t.trait,
           'label', coalesce(tc.label, t.trait),
           'from_me', t.from_user = caller
         ) ORDER BY t.sort_order, t.trait)
    INTO inherited
    FROM public.child_inherited_traits t
    LEFT JOIN public.trait_catalog tc ON tc.slug = t.trait
   WHERE t.family_id = fam.id;

  parents := public.raise_child_parents(fam.id);
  partner := CASE WHEN parents[1] = caller THEN parents[2] ELSE parents[1] END;
  SELECT name INTO partner_name FROM public.profiles WHERE id = partner;

  RETURN jsonb_build_object(
    'inherited', coalesce(inherited, '[]'::JSONB),
    'more_like', CASE WHEN mine > theirs THEN 'me' WHEN theirs > mine THEN 'partner' ELSE 'both' END,
    'line', CASE
      WHEN mine = 0 AND theirs = 0 THEN NULL
      WHEN mine > theirs THEN cs.name || ' has more of your traits.'
      WHEN theirs > mine THEN cs.name || ' has more of ' || coalesce(partner_name, 'your partner') || '''s traits.'
      ELSE cs.name || ' takes after you both.'
    END
  );
END;
$$;

COMMENT ON FUNCTION public.raise_child_inheritance() IS
  'The traits the child was born with, and the soft sentence about who they take after.';

-- ---------------------------------------------------------------------------------
-- 4. A family that opens from now on gets them at birth
-- ---------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.raise_child_settle_setup(p_family_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  fam public.families%ROWTYPE;
  parents UUID[];
  prop_a public.family_setup_proposals%ROWTYPE;
  prop_b public.family_setup_proposals%ROWTYPE;
  traits_a TEXT[];
  traits_b TEXT[];
  settled_name TEXT;
BEGIN
  SELECT * INTO fam FROM public.families WHERE id = p_family_id;
  IF fam.id IS NULL OR fam.status <> 'setup' THEN RETURN; END IF;

  parents := public.raise_child_parents(fam.id);
  IF cardinality(parents) < 2 THEN RETURN; END IF;

  SELECT * INTO prop_a FROM public.family_setup_proposals
   WHERE family_id = fam.id AND user_id = parents[1];
  SELECT * INTO prop_b FROM public.family_setup_proposals
   WHERE family_id = fam.id AND user_id = parents[2];
  IF prop_a.family_id IS NULL OR prop_b.family_id IS NULL THEN RETURN; END IF;

  IF NOT public.raise_child_same_name(prop_a.name, prop_b.name) THEN RETURN; END IF;
  IF NOT public.raise_child_same_look(prop_a.look, prop_b.look) THEN RETURN; END IF;

  -- Both parents proposed the same child. That is the child.
  settled_name := btrim(prop_a.name);
  INSERT INTO public.child_state (family_id, name, look)
  VALUES (fam.id, settled_name, prop_a.look)
  ON CONFLICT (family_id) DO UPDATE
    SET name = EXCLUDED.name,
        look = EXCLUDED.look,
        updated_at = now();

  -- The childhood opens only when the name, the face and all six traits are agreed.
  SELECT traits INTO traits_a FROM public.family_parents WHERE family_id = fam.id AND user_id = parents[1];
  SELECT traits INTO traits_b FROM public.family_parents WHERE family_id = fam.id AND user_id = parents[2];
  IF cardinality(coalesce(traits_a, '{}')) = 3 AND cardinality(coalesce(traits_b, '{}')) = 3 THEN
    UPDATE public.families SET status = 'active', updated_at = now() WHERE id = fam.id;
    UPDATE public.child_state
       SET temperament = public.raise_child_temperament(traits_a, traits_b),
           lead_user_id = fam.created_by,
           last_tick_day = NULL,
           updated_at = now()
     WHERE family_id = fam.id;
    -- Born with something of both of them.
    PERFORM public.raise_child_seed_inherited_traits(fam.id);
    INSERT INTO public.album_entries (family_id, kind, age, title, body)
    VALUES (
      fam.id, 'milestone', 0,
      'The day ' || settled_name || ' arrived',
      'Two parents, three traits each, and a whole childhood ahead. ' || settled_name || ' came home today.'
    );
    PERFORM public.raise_child_tick_family(fam.id);
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------------
-- 5. Families already in the middle of a childhood get theirs too
-- ---------------------------------------------------------------------------------

DO $$
DECLARE f RECORD;
BEGIN
  FOR f IN SELECT id FROM public.families WHERE status <> 'setup' LOOP
    PERFORM public.raise_child_seed_inherited_traits(f.id);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------
-- 6. Permissions and realtime
-- ---------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.raise_child_pick_untaken(TEXT[], TEXT[]),
  public.raise_child_seed_inherited_traits(UUID)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.raise_child_inheritance() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raise_child_inheritance() TO authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
         AND tablename = 'child_inherited_traits'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.child_inherited_traits;
    END IF;
  END IF;
END $$;

COMMIT;
