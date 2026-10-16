-- Run this migration on existing Supabase projects before deploying push notifications.
-- Adds the per-device subscription table, its row-level security, and the three RPCs the
-- browser uses to claim a device, release one, or release every device it owns. Nothing
-- existing is modified or removed, so it is safe on a live project and safe to rerun.
--
-- The same statements live at the end of supabase/schema.sql for brand-new projects.
--
-- This table is only the address book. The notifications themselves are sent by the
-- `send-push` Edge Function (supabase/functions/send-push/index.ts), which a Database
-- Webhook on `messages` calls and which signs every payload with Nooki's own VAPID
-- keypair. There is no third-party push service anywhere in the path: the browser's own
-- push service (FCM, Mozilla autopush, Apple) is the relay it always is, and it needs no
-- account, key or billing from us.
--
-- A row is one *browser*, not one person: the same account signed in on a phone and a
-- laptop has two rows, and either can be switched off without touching the other.
BEGIN;

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The account this device is signed in as. Deleting the account removes its devices.
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The couple the account was in when the device subscribed. Ends with the couple, so
  -- an ended relationship leaves no device able to receive anything (the delete cascades).
  couple_id UUID REFERENCES public.couples(id) ON DELETE CASCADE,
  -- The PushSubscription as the browser handed it over. `endpoint` is a capability URL
  -- that only that one browser instance uses; the two keys are its public encryption
  -- material, and the payload body is encrypted to them by web-push. Nothing secret is
  -- ever stored here — a stolen row cannot be used to read anything, only to send a
  -- notification to that browser, and the endpoint is worthless to any other device.
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  -- One row per browser push subscription: re-subscribing on the same browser updates
  -- the existing row rather than piling up devices that would each get the same alert.
  CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint),
  -- Bounds from the Web Push spec, wide enough for every real endpoint shape and narrow
  -- enough to keep a junk write out of the table the sender reads.
  CONSTRAINT push_subscriptions_endpoint_length CHECK (char_length(endpoint) BETWEEN 12 AND 1024),
  CONSTRAINT push_subscriptions_p256dh_length CHECK (char_length(p256dh) BETWEEN 8 AND 255),
  CONSTRAINT push_subscriptions_auth_length CHECK (char_length(auth) BETWEEN 8 AND 255)
);

-- The sender asks one question only: which devices belong to this partner? The second
-- index keeps the optional pair-scoped reads cheap.
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON public.push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_couple ON public.push_subscriptions(couple_id);

-- Keep updated_at honest without the client having to remember it.
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

-- A device is the account's own business. There is deliberately no policy that would let
-- one partner read the other's rows, and no `anon` access at all: an unpaired account has
-- no couple, so it has nothing to be notified about.
DROP POLICY IF EXISTS "Users can read their own push devices" ON public.push_subscriptions;
CREATE POLICY "Users can read their own push devices" ON public.push_subscriptions
FOR SELECT TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can add their own push devices" ON public.push_subscriptions;
CREATE POLICY "Users can add their own push devices" ON public.push_subscriptions
FOR INSERT TO authenticated
WITH CHECK (user_id = auth.uid());

-- Turning notifications off is a delete. There is no update policy on purpose: the only
-- way a row may change is through the RPC below, which is what keeps `couple_id` honest
-- (a device that re-subscribes after a breakup must not stay pointed at the old couple).
DROP POLICY IF EXISTS "Users can remove their own push devices" ON public.push_subscriptions;
CREATE POLICY "Users can remove their own push devices" ON public.push_subscriptions
FOR DELETE TO authenticated
USING (user_id = auth.uid());

-- Claim this browser as one of the signed-in account's devices, or refresh the row if it
-- already is one (a browser re-subscribes with a new key whenever it likes, and Safari
-- rotates subscriptions on its own).
--
-- `couple_id` is read from the caller's own profile here rather than trusted from the
-- phone, so the address book can never be pointed at another couple by a modified client.
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
  -- A device that is now signed in as someone else is that someone else's device: the
  -- row moves with the sign-in rather than blocking the new account out of its own phone.
  -- It still sends nothing anywhere but back to the browser that registered it.
  ON CONFLICT (endpoint) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        couple_id = EXCLUDED.couple_id,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth
  RETURNING id INTO sid;

  RETURN sid;
END;
$$;

-- Turn notifications off on one device. Only the account that owns the row can remove it,
-- so a partner (or anyone else who somehow learned an endpoint) cannot mute this phone.
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

-- Signing out: the browser keeps its push subscription (so coming back is one tap), but
-- the account stops being reachable on it immediately. Returns how many devices were let go.
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

-- The app may read and claim its own devices; nothing else. No UPDATE grant, because the
-- RPCs are the only supported way to change a row.
GRANT SELECT, INSERT, DELETE ON public.push_subscriptions TO authenticated;
REVOKE ALL ON public.push_subscriptions FROM anon;

REVOKE ALL ON FUNCTION public.register_push_subscription(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_push_subscription(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_my_push_subscriptions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_push_subscription(TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_push_subscription(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_my_push_subscriptions() TO authenticated;

COMMIT;
