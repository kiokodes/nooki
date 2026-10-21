-- Run this migration on existing Supabase projects before deploying "I miss you" push
-- notifications. It does one thing: let the send-push Edge Function read
-- public.miss_you_taps with the service key, so a tap can knock on the partner's
-- phone. Nothing existing is modified or removed, so it is safe on a live project
-- and safe to rerun.
--
-- Until 2026-10-30 Supabase granted every new "public" table to service_role
-- automatically; projects stop receiving those automatic grants for tables created
-- from that date onwards. The couple's own access never depended on the defaults,
-- but send-push does (service_role bypasses RLS, yet still needs the table grant),
-- so the grant is spelled out here — the same reason the epistles migration grants
-- its own table. Fresh projects built from supabase/schema.sql already cover every
-- table with the grant loop at the end of that file.
BEGIN;

GRANT SELECT ON public.miss_you_taps TO service_role;

COMMIT;
