/**
 * Pure place maths: what a chosen country/state/city means, and how it is said aloud.
 *
 * No React, no network, no storage — the pickers and the database tests both read from
 * here, so the rules live in one place. The matching build-time rules (which bake the
 * timezones into `public/geo/`) are in `scripts/build-geo-data.mjs`.
 */
import type { GeoCountry, GeoCountryDataset } from './placeData';
import type { Profile } from '../../types/database';
import { isKnownTimezone } from '../timezones';

/** What the pickers hold while somebody is choosing. Empty strings mean "not yet". */
export interface PlaceSelection {
  countryCode: string;
  countryName: string;
  /** Null when the country has no subdivisions, or none has been chosen yet. */
  stateCode: string | null;
  stateName: string | null;
  cityName: string;
}

export const emptyPlaceSelection: PlaceSelection = {
  countryCode: '',
  countryName: '',
  stateCode: null,
  stateName: null,
  cityName: '',
};

/** Collapse the whitespace a phone keyboard leaves behind ("Port  Harcourt "). */
export function normalizePlaceName(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function slug(value: string | null | undefined): string {
  return normalizePlaceName(value)
    .toLowerCase()
    // An apostrophe joins rather than separates: "St John's" is one word, not "st-john-s".
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The stable key for one city: `ng/ri/port-harcourt`, or null when there is no city.
 *
 * This is what the marketplace will join vendors on, so it is built from the codes the
 * dataset publishes (which do not get re-spelled) plus a slugged city name, and never
 * from display text. `-` holds a missing *state*, so a country without subdivisions
 * (`sg/-/singapore`) can never collide with one that has them. A missing country or city
 * is not a key with two holes in it — it is no key at all, because such a row could only
 * ever match other incomplete ones.
 *
 * The database generates the same key as a stored column (`profiles.city_key`, via
 * `public.profile_city_key`) — the SQL is the authority, and
 * `tests/location-database.test.mjs` asserts the two agree, empty places included.
 */
export function buildCityKey(selection: Pick<PlaceSelection, 'countryCode' | 'stateCode' | 'cityName'>): string | null {
  const country = slug(selection.countryCode);
  const city = slug(selection.cityName);
  if (!country || !city) return null;
  return [country, slug(selection.stateCode) || '-', city].join('/');
}

/**
 * The bucket a city lives in inside its country's file. Cities the source data could not
 * attach to a known subdivision are filed under `''`, so a lookup has to ask the same
 * question the build did or it will miss them.
 */
export function stateBucket(dataset: GeoCountryDataset | null, stateCode: string | null): string {
  if (!dataset || !stateCode) return '';
  return dataset.states.some((state) => state.code === stateCode) ? stateCode : '';
}

/** A city's own zone, when it differs from its state's. Null means "the state's is right". */
export function cityZone(
  dataset: GeoCountryDataset | null,
  stateCode: string | null,
  cityName: string,
): string | null {
  if (!dataset?.cityZones) return null;
  const name = normalizePlaceName(cityName);
  if (!name) return null;
  const bucket = dataset.cityZones[stateBucket(dataset, stateCode)];
  return bucket?.[name] ?? null;
}

/** Where a zone came from, which is what decides whether the app asks or just tells. */
export type TimezoneSource = 'city' | 'state' | 'country' | 'none';

export interface TimezoneDerivation {
  /** The zone to use, or null when nothing chosen so far implies one. */
  timezone: string | null;
  source: TimezoneSource;
  /**
   * The country spans several zones and nothing narrower has settled it yet (a
   * subdivision the dataset has no centre for, or a country chosen but no state). The
   * picker then offers that country's own zones instead of the world's 400.
   */
  ambiguous: boolean;
}

/**
 * The zone a place implies, most specific first: the city's own, then its state's, then
 * the country's when the country has exactly one.
 *
 * `country` comes from the index and is available the moment a country is picked;
 * `dataset` arrives a request later and can refine it. Either may be null, and the answer
 * degrades through them rather than failing.
 */
export function deriveTimezone(
  country: GeoCountry | null,
  dataset: GeoCountryDataset | null,
  selection: Pick<PlaceSelection, 'stateCode' | 'cityName'>,
): TimezoneDerivation {
  const zones = dataset?.zones ?? country?.zones ?? [];
  const fromCity = cityZone(dataset, selection.stateCode, selection.cityName);
  if (fromCity) return { timezone: fromCity, source: 'city', ambiguous: false };

  const state = dataset?.states.find((item) => item.code && item.code === selection.stateCode) ?? null;
  if (state?.tz) return { timezone: state.tz, source: 'state', ambiguous: false };

  const single = dataset?.tz ?? country?.tz ?? (zones.length === 1 ? zones[0] : null);
  if (single) return { timezone: single, source: 'country', ambiguous: false };

  return { timezone: null, source: 'none', ambiguous: zones.length > 1 };
}

/** A location is complete when the country and the city are both known; the state is not always on offer. */
export function isCompleteSelection(selection: PlaceSelection): boolean {
  return Boolean(normalizePlaceName(selection.countryCode)) && Boolean(normalizePlaceName(selection.cityName));
}

/** "Port Harcourt, Rivers, Nigeria" — with repeats dropped, so Singapore is not said twice. */
export function describePlace(place: {
  cityName?: string | null;
  stateName?: string | null;
  countryName?: string | null;
}): string {
  const parts: string[] = [];
  for (const part of [place.cityName, place.stateName, place.countryName]) {
    const value = normalizePlaceName(part);
    if (!value) continue;
    const already = parts.some((existing) => existing.toLowerCase() === value.toLowerCase());
    if (!already) parts.push(value);
  }
  return parts.join(', ');
}

/** The compact form for a header or a list row: "Port Harcourt, NG". */
export function describePlaceShort(place: {
  cityName?: string | null;
  countryCode?: string | null;
  countryName?: string | null;
}): string {
  const city = normalizePlaceName(place.cityName);
  const country = normalizePlaceName(place.countryCode) || normalizePlaceName(place.countryName);
  if (!city) return country;
  return country && country.toLowerCase() !== city.toLowerCase() ? `${city}, ${country}` : city;
}

/* -------------------------------------------------------------------------
   The saved shape: what a profile holds, and what the app writes to it.
   ------------------------------------------------------------------------- */

/** One person's place, in the app's own camelCase, ready to validate or to render. */
export interface LocationInput {
  /** ISO 3166-1 alpha-2, uppercased: 'NG'. Required — the city key starts with it. */
  countryCode: string;
  /** 'Nigeria'. Kept for display, so a renamed country in a future dataset still reads right. */
  countryName: string;
  /** The dataset's subdivision code ('RI'), or null where the country has none. */
  stateCode: string | null;
  stateName: string | null;
  /** 'Port Harcourt'. */
  cityName: string;
  /** The zone this place implies, or the one the person chose instead. */
  timezone: string;
}

const COUNTRY_CODE = /^[A-Z]{2}$/;
const HAS_WORD = /[A-Za-z0-9\u00C0-\u024F]/;
const LIMITS = { countryName: 80, stateName: 80, cityName: 120 } as const;

function requireName(value: string | null | undefined, label: string, limit: number): string {
  const name = normalizePlaceName(value);
  if (!name || !HAS_WORD.test(name)) throw new Error(`Please choose ${label}.`);
  if (name.length > limit) throw new Error(`${label[0].toUpperCase()}${label.slice(1)} can be up to ${limit} characters.`);
  return name;
}

/**
 * Clean and check a place before it is written.
 *
 * The database refuses half a location (a city with no country cannot be matched to
 * anything, and a missing country code would make every such key collide), so the same
 * shape is settled here first — where the message can be read by a person rather than by
 * a constraint name. The timezone is checked against this browser's Intl because a zone
 * it cannot format would quietly blank the partner's clock in the header.
 */
export function validateLocationInput(input: LocationInput): LocationInput {
  const countryCode = normalizePlaceName(input.countryCode).toUpperCase();
  if (!COUNTRY_CODE.test(countryCode)) throw new Error('Please choose your country.');
  const countryName = requireName(input.countryName, 'your country', LIMITS.countryName);
  const cityName = requireName(input.cityName, 'your city', LIMITS.cityName);
  // A state is only insisted on when one was offered: 53 countries have no subdivisions
  // in the place data, and a typed one has a name but no code.
  const stateName = normalizePlaceName(input.stateName) || null;
  const stateCode = normalizePlaceName(input.stateCode).toUpperCase() || null;
  if (stateName && stateName.length > LIMITS.stateName) {
    throw new Error(`State names can be up to ${LIMITS.stateName} characters.`);
  }
  if (stateCode && stateCode.length > 12) throw new Error('That state code looks wrong.');
  const timezone = normalizePlaceName(input.timezone);
  if (!isKnownTimezone(timezone)) throw new Error('Please choose a timezone your browser recognises.');
  return {
    countryCode,
    countryName,
    stateCode: stateName ? stateCode : null,
    stateName,
    cityName,
    timezone,
  };
}

/**
 * The columns a save writes. `city_key` is deliberately absent: the database generates it,
 * and Postgres rejects any attempt to send a value for a generated column.
 */
export function locationColumns(input: LocationInput, now: Date = new Date()): Record<string, string | null> {
  const clean = validateLocationInput(input);
  return {
    country_code: clean.countryCode,
    country_name: clean.countryName,
    state_code: clean.stateCode,
    state_name: clean.stateName,
    city_name: clean.cityName,
    timezone: clean.timezone,
    location_updated_at: now.toISOString(),
  };
}

/** A profile back into the picker's shape, or null when that person has no place saved. */
export function profileLocation(profile: Profile | null | undefined): LocationInput | null {
  if (!profile?.country_code || !profile.city_name) return null;
  try {
    return validateLocationInput({
      countryCode: profile.country_code,
      countryName: profile.country_name ?? '',
      stateCode: profile.state_code,
      stateName: profile.state_name,
      cityName: profile.city_name,
      timezone: profile.timezone,
    });
  } catch {
    // A row saved before the rules tightened, or a zone this browser cannot read: treat it
    // as no location so the picker starts fresh instead of showing something it cannot save.
    return null;
  }
}

/* -------------------------------------------------------------------------
   The picker's working copy.
   ------------------------------------------------------------------------- */

/**
 * A place while it is still being chosen: structurally a `LocationInput`, but allowed to
 * be unfinished (an empty country, no city yet). Only `validateLocationInput` turns one
 * into something worth saving.
 */
export type LocationDraft = LocationInput;

/** A blank draft, starting from the timezone this browser already reported. */
export function emptyLocationDraft(timezone: string): LocationDraft {
  return {
    countryCode: '',
    countryName: '',
    stateCode: null,
    stateName: null,
    cityName: '',
    timezone,
  };
}

/**
 * A saved profile back into a draft, for "Update location" in Couple Settings — starting
 * from where they are rather than from a blank form. `timezone` is carried through even
 * when no place was saved, so the form opens on the zone the couple already runs on.
 */
export function draftFromProfile(profile: Profile | null | undefined): LocationDraft {
  const saved = profileLocation(profile);
  return saved ?? emptyLocationDraft(profile?.timezone || 'UTC');
}
