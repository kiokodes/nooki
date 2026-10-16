-- Run this migration on existing Supabase projects before deploying the "I miss you" button.
-- It adds the one small table behind it: for each partner and each of their own calendar
-- days, how many times they tapped "I miss you" and how many of those taps the other
-- partner has already been shown. Nothing existing is modified or removed, so it is safe
-- on a live project and safe to rerun.
--
-- The button is for the half of the couple who is sitting in the app alone. The taps wait
-- in this table; the next time the partner opens Nooki, their phone reads the waiting taps,
-- greets them with the big heart and marks them received — which is the reset.
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
