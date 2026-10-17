-- Run this migration on existing Supabase projects before deploying the location pickers.
--
-- It gives every profile a place: country, state and city, plus the stable key the
-- marketplace will one day join vendors on. Nothing existing is modified or removed —
-- `timezone` stays exactly where it is and keeps its 'UTC' default — so it is safe on a
-- live project and safe to rerun.
--
-- Why a place and not just a timezone: the signup flow already asks for a zone to work
-- out how far apart a couple is, but a zone is a guess when all you know is a country
-- (the United States spans 29), and it says nothing about where a gift should be sent.
-- "Nigeria, Rivers, Port Harcourt" answers both — it implies Africa/Lagos, and it is the
-- city the marketplace opens on for a partner who lives there.
--
-- Every account created before this migration has a NULL location and keeps working:
-- the columns are optional, the couple's clock still runs on `timezone`, and each partner
-- can add their place later from Couple Settings → Update location.
BEGIN;

-- ---------------------------------------------------------------------------
-- 1) The key the marketplace will join on, as one named rule.
--
-- Both halves of a city's identity live here: the codes the place dataset publishes
-- (which do not get re-spelled) and a slugged city name. A missing part becomes '-' so a
-- country without subdivisions ('sg/-/singapore') can never collide with one that has
-- them ('ng/ri/port-harcourt'). The frontend keeps the same rule in
-- src/lib/geo/location.ts (buildCityKey) and tests/location-database.test.mjs asserts the
-- two agree — this function is the authority, because vendors will be matched on it.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 2) The columns. All nullable: an existing profile has no place until its person adds one.
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS country_code TEXT,
  ADD COLUMN IF NOT EXISTS country_name TEXT,
  ADD COLUMN IF NOT EXISTS state_code TEXT,
  ADD COLUMN IF NOT EXISTS state_name TEXT,
  ADD COLUMN IF NOT EXISTS city_name TEXT,
  ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ;

-- Generated, so the key can never disagree with the place it came from: nobody writes it,
-- and a partner who moves from Port Harcourt to Lagos gets a new key in the same update.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS city_key TEXT
    GENERATED ALWAYS AS (public.profile_city_key(country_code, state_code, city_name)) STORED;

-- The marketplace's first query is "vendors in my partner's city", which is a scan of
-- other people's keys against this one. Partial, because most of a young database has no
-- place saved yet and should not be indexed for it.
CREATE INDEX IF NOT EXISTS idx_profiles_city_key
  ON public.profiles(city_key)
  WHERE city_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3) A place is whole or it is nothing.
--
-- Half a location is worse than none: "Rivers" with no country cannot be matched to a
-- city, and a NULL country_code would make the key start '-' and collide with every other
-- codeless row. The frontend validates the same shape before it writes
-- (src/lib/geo/location.ts), and falls back to the old timezone-only signup when the
-- place dataset cannot be fetched, rather than saving a place it cannot key.
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_location_complete;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_location_complete CHECK (
  (country_code IS NULL AND country_name IS NULL
     AND state_code IS NULL AND state_name IS NULL
     AND city_name IS NULL AND location_updated_at IS NULL)
  OR (btrim(coalesce(country_code, '')) <> ''
      AND btrim(coalesce(country_name, '')) <> ''
      AND btrim(coalesce(city_name, '')) <> '')
);

-- Existing rows are all-NULL and pass; this only stops a future half-saved place.
COMMENT ON COLUMN public.profiles.city_key IS
  'Generated: the marketplace key for this person''s city, e.g. ng/ri/port-harcourt.';
COMMENT ON COLUMN public.profiles.location_updated_at IS
  'When this person last told Nooki where they are. NULL with the rest of the place columns.';

-- Writes still go through the existing "Users can update own profile" policy, and the
-- partner still reads this row through "Users can view own profile or partner profile" —
-- which is precisely what lets the marketplace open on the partner's city without a new
-- table or a new grant. No RLS change is needed, and none is made.

COMMIT;
