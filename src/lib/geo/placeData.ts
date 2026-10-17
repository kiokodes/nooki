/**
 * The place dataset behind the country → state → city pickers.
 *
 * Nooki asks where each partner is for two reasons: the clock in the header has to be
 * right (a country the size of the United States spans 29 zones, so "America" is not an
 * answer), and the marketplace that is coming needs a city to open on. Both want the
 * same three things — country, state, city — plus the IANA zone they imply.
 *
 * The data itself is not in this bundle. `npm run build:geo` reshapes it once into
 * `public/geo/`: one 28KB index of countries, and one file per country (2KB median,
 * 286KB for the United States) fetched only when somebody opens that country's picker.
 * Timezones are resolved at build time from the timezone-boundary polygons, which never
 * ship to a phone.
 *
 * Everything here degrades: if the files are not there (an old deployment, an offline
 * launch, a project built without the dataset) the pickers become typed fields and the
 * timezone falls back to the browser's own, which is how Nooki worked before.
 */

/** One row of `public/geo/countries.json` — the first picker, and all it needs. */
export interface GeoCountry {
  /** ISO 3166-1 alpha-2, e.g. 'NG'. The stable half of a city's key. */
  code: string;
  name: string;
  /** Emoji flag, so a 250-item list is scannable on a phone. */
  flag: string;
  /** Every IANA zone this country spans, canonicalised at build time and sorted. */
  zones: string[];
  /**
   * The country's one zone when it has exactly one — 219 of 250 do, and for those the
   * clock is settled by the country alone. Null when it spans several.
   */
  tz: string | null;
}

/** One subdivision inside a country's file. */
export interface GeoState {
  /** ISO 3166-2 subdivision code as the source data publishes it; '' when it has none. */
  code: string;
  name: string;
  /** The zone at the state's centre, or null when the country spans several and this is one of them. */
  tz: string | null;
}

/** One country's file: `public/geo/country/{code}.json`. */
export interface GeoCountryDataset {
  code: string;
  zones: string[];
  tz: string | null;
  /** Empty for the 53 countries the source data has no subdivisions for. */
  states: GeoState[];
  /**
   * City names by state code, sorted. `''` holds the cities of a country with no
   * subdivisions, and an empty list means "we have no cities here — type yours".
   */
  cities: Record<string, string[]>;
  /**
   * The exceptions: cities whose zone is not their state's, by state code then city name.
   * Only multi-zone countries have any, which is why this is a small map and not a
   * per-city column — Gary, Indiana reads America/Chicago while its state reads
   * America/Indianapolis.
   */
  cityZones?: Record<string, Record<string, string>>;
}

/** The dataset could not be fetched. Callers fall back to typed fields, never to a blank form. */
export class GeoDataUnavailable extends Error {
  constructor(message = 'The place list could not be loaded.') {
    super(message);
    this.name = 'GeoDataUnavailable';
  }
}

function geoBase(): string {
  const base = (import.meta.env?.BASE_URL as string | undefined) || '/';
  return `${base.endsWith('/') ? base : `${base}/`}geo/`;
}

async function readJson<T>(url: string): Promise<T> {
  if (typeof fetch !== 'function') throw new GeoDataUnavailable();
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new GeoDataUnavailable(`The place list could not be loaded (${response.status}).`);
  return (await response.json()) as T;
}

// One request per country per app run: the picker re-opens as people change their minds,
// and a rejected load is not cached, so a retry after a dropped connection really retries.
let countriesRequest: Promise<GeoCountry[]> | null = null;
const countryRequests = new Map<string, Promise<GeoCountryDataset>>();

export function loadGeoCountries(): Promise<GeoCountry[]> {
  countriesRequest ??= readJson<GeoCountry[]>(`${geoBase()}countries.json`)
    .catch((error: unknown) => { countriesRequest = null; throw error; });
  return countriesRequest;
}

export function loadGeoCountry(code: string): Promise<GeoCountryDataset> {
  const key = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(key)) return Promise.reject(new GeoDataUnavailable('That country code is not recognised.'));
  const pending = countryRequests.get(key)
    ?? readJson<GeoCountryDataset>(`${geoBase()}country/${key}.json`)
      .catch((error: unknown) => { countryRequests.delete(key); throw error; });
  countryRequests.set(key, pending);
  return pending;
}

/**
 * Where the pickers read from. Injectable so a test can hand them a three-country world
 * instead of stubbing `fetch` and hoping the URL shape stays the same.
 */
export interface GeoSource {
  countries(): Promise<GeoCountry[]>;
  country(code: string): Promise<GeoCountryDataset>;
}

export const geoSource: GeoSource = {
  countries: loadGeoCountries,
  country: loadGeoCountry,
};

/** Test-only: forget every loaded country so the next picker fetches again. */
export function resetGeoCache(): void {
  countriesRequest = null;
  countryRequests.clear();
}
