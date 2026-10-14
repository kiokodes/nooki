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

-- Users can insert their own profile
CREATE POLICY "Users can insert own profile"
ON public.profiles
FOR INSERT
WITH CHECK (auth.uid() = id);

-- Users can update their own profile
CREATE POLICY "Users can update own profile"
ON public.profiles
FOR UPDATE
USING (auth.uid() = id)
WITH CHECK (auth.uid() = id);

-- 7. Row Level Security Policies for couples
-- Users can view their own couple or find a couple by invite code when joining
CREATE POLICY "Users can view own couple or query invite code"
ON public.couples
FOR SELECT
USING (
  id = public.get_user_couple_id(auth.uid())
  OR (public.get_user_couple_id(auth.uid()) IS NULL)
);

-- Authenticated users without a couple can create a new couple
CREATE POLICY "Authenticated users can create couples"
ON public.couples
FOR INSERT
WITH CHECK (
  auth.role() = 'authenticated'
  AND (public.get_user_couple_id(auth.uid()) IS NULL)
);

-- Users can update only their own couple (e.g. requesting mutual breakup)
-- Enforce that anniversary_date is set once upon creation and cannot be edited afterward!
CREATE POLICY "Users can update own couple"
ON public.couples
FOR UPDATE
USING (id = public.get_user_couple_id(auth.uid()))
WITH CHECK (
  id = public.get_user_couple_id(auth.uid())
  AND (
    couples.anniversary_date IS NOT DISTINCT FROM (SELECT c.anniversary_date FROM public.couples c WHERE c.id = couples.id)
  )
);

-- 8. Stored Procedure: Join a couple safely (ensuring strictly max 2 members)
CREATE OR REPLACE FUNCTION public.join_couple(code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_couple RECORD;
  v_member_count INT;
  v_current_user_couple UUID;
BEGIN
  -- Verify user doesn't already belong to a couple
  SELECT couple_id INTO v_current_user_couple FROM public.profiles WHERE id = auth.uid();
  IF v_current_user_couple IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'You already belong to a couple.');
  END IF;

  -- Look up couple by uppercase invite code
  SELECT * INTO v_couple FROM public.couples WHERE UPPER(invite_code) = UPPER(TRIM(code));
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid invite code.');
  END IF;

  -- Count existing members
  SELECT COUNT(*) INTO v_member_count FROM public.profiles WHERE couple_id = v_couple.id;
  IF v_member_count >= 2 THEN
    RETURN jsonb_build_object('success', false, 'error', 'This couple already has 2 partners.');
  END IF;

  -- Link user to the couple
  UPDATE public.profiles
  SET couple_id = v_couple.id
  WHERE id = auth.uid();

  RETURN jsonb_build_object('success', true, 'couple_id', v_couple.id);
END;
$$;

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
