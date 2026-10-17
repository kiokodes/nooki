/**
 * Builds the place dataset the location pickers read at runtime.
 *
 * Nooki needs country → state → city in the browser, and it needs an IANA timezone for
 * each of them (that is the whole point: "Nigeria, Rivers, Port Harcourt" says
 * Africa/Lagos without asking, and "United States, Idaho, Boise" says America/Boise
 * rather than guessing one zone for a country that spans 29).
 *
 * The source data is far too big to bundle — every city on earth is ~8MB — so this
 * script reshapes it once, at build time, into one small index plus one file per
 * country that the app fetches only when somebody opens that country's picker:
 *
 *   public/geo/countries.json        250 countries, their flag, their zones  (~25KB)
 *   public/geo/country/{CC}.json     that country's states and cities        (~10KB median)
 *
 * Timezones are baked in here rather than looked up on the phone: the polygons live in
 * `tz-lookup`, which never ships to the browser. A city only carries a zone when it
 * differs from its own state's, so single-zone countries (the large majority) stay tiny.
 *
 * The output is generated, never committed: `public/geo/` is git-ignored and rebuilt by
 * `npm run build:geo`, which `predev` and `prebuild` run for you.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

/** Trim, collapse inner whitespace, and drop surrounding punctuation noise. */
export function normalizeName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * The marketplace's join key for one city: `ng/ri/port-harcourt`.
 *
 * Two partners who both say "Port Harcourt" land on the same key even if one typed
 * "port harcourt" and the other "Port  Harcourt."; a vendor table added later joins on
 * this, so it is deliberately built from the codes (stable) and not from display names
 * (which the dataset may re-spell). States are optional because 53 countries have no
 * subdivisions in the source data, and `-` holds their place so `ng/-/lagos` and
 * `ng/ri/lagos` can never collide.
 */
export function cityKey({ countryCode, stateCode, cityName }) {
  const slug = (value) => normalizeName(value)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return [slug(countryCode) || '-', slug(stateCode) || '-', slug(cityName) || '-'].join('/');
}

/** Sort that reads like a list of places: case- and accent-insensitive, digits last-ish. */
function byName(a, b) {
  return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
}

/**
 * The country index the picker opens with.
 *
 * `tz` is set only when the country has exactly one zone — then choosing the country is
 * enough to know the clock, and the app never asks. `zones` is always the full list, so
 * a country that spans several (US: 29) can offer them instead of the browser's 400.
 */
export function buildCountryIndex(countries, { canonicalizeZone }) {
  const canonical = canonicalizeZone ?? ((zone) => zone || null);
  return countries
    .map((country) => {
      const zones = [...new Set(
        (country.timezones ?? [])
          .map((zone) => canonical(normalizeName(zone?.zoneName)))
          .filter(Boolean),
      )].sort();
      return {
        code: normalizeName(country.isoCode).toUpperCase(),
        name: normalizeName(country.name),
        flag: normalizeName(country.flag),
        zones,
        tz: zones.length === 1 ? zones[0] : null,
      };
    })
    .filter((country) => country.code && country.name)
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

/**
 * One country's states and cities, with the timezone each of them implies.
 *
 * `lookupTimezone(lat, lon)` is injected so this stays testable without the polygon data.
 * Cities are grouped under their state's code (`''` where the country has none) and only
 * appear in `cityZones` when they sit in a different zone from the state they belong to —
 * Idaho is the case that matters, where the state centroid says America/Boise and the
 * northern panhandle does not.
 */
export function buildCountryDataset({ code, zones, states, cities, lookupTimezone, canonicalizeZone }) {
  const accept = canonicalizeZone ?? ((zone) => zone || null);
  const zoneAt = (latitude, longitude) => {
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    try {
      return accept(lookupTimezone(lat, lon));
    } catch {
      return null;
    }
  };
  const singleZone = zones.length === 1 ? zones[0] : null;
  // A zone only has to be resolved per city when the country actually spans several;
  // otherwise the country's one zone is already the answer everywhere inside it.
  const needsCityZones = !singleZone;

  const stateIndex = new Map();
  const datasetStates = (states ?? [])
    .map((state) => ({
      code: normalizeName(state.isoCode).toUpperCase(),
      name: normalizeName(state.name),
      // The centroid, which is the honest answer for a state inside one zone and a
      // reasonable default for one that straddles two.
      tz: singleZone ?? zoneAt(state.latitude, state.longitude),
    }))
    .filter((state) => state.name)
    .sort(byName);
  for (const state of datasetStates) {
    // Duplicate codes would make the picker ambiguous; the first spelling wins.
    if (state.code && !stateIndex.has(state.code)) stateIndex.set(state.code, state);
  }

  const grouped = new Map();
  const cityZones = {};
  for (const row of cities ?? []) {
    const [rawName, rawCountry, rawState, latitude, longitude] = row;
    if (normalizeName(rawCountry).toUpperCase() !== code) continue;
    const name = normalizeName(rawName);
    if (!name) continue;
    const stateCode = normalizeName(rawState).toUpperCase();
    const bucket = stateIndex.has(stateCode) ? stateCode : '';
    if (!grouped.has(bucket)) grouped.set(bucket, new Map());
    const inBucket = grouped.get(bucket);
    const zone = needsCityZones ? zoneAt(latitude, longitude) : null;
    // The same town name can appear twice in one state; keep one, and the first zone.
    if (!inBucket.has(name)) {
      inBucket.set(name, zone);
      const stateTz = bucket ? stateIndex.get(bucket)?.tz ?? null : singleZone;
      if (zone && zone !== stateTz) {
        cityZones[bucket] = cityZones[bucket] ?? {};
        cityZones[bucket][name] = zone;
      }
    }
  }

  const datasetCities = {};
  for (const [bucket, inBucket] of grouped) {
    datasetCities[bucket] = [...inBucket.keys()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  }
  // States with no city rows still need an entry, so the picker can say "type yours".
  for (const state of datasetStates) {
    if (state.code && !datasetCities[state.code]) datasetCities[state.code] = [];
  }
  if (!datasetCities['']) delete datasetCities[''];

  return {
    code,
    zones,
    tz: singleZone,
    states: datasetStates,
    cities: datasetCities,
    ...(Object.keys(cityZones).length ? { cityZones } : {}),
  };
}

/** Resolves the two source packages, or null when they are not installed. */
function loadSourceData() {
  const require = createRequire(import.meta.url);
  try {
    return {
      countries: require('country-state-city/lib/assets/country.json'),
      states: require('country-state-city/lib/assets/state.json'),
      cities: require('country-state-city/lib/assets/city.json'),
      lookupTimezone: require('tz-lookup'),
    };
  } catch {
    return null;
  }
}

export async function buildGeoData({ outputDir, log = console.log }) {
  const source = loadSourceData();
  if (!source) {
    // Not fatal: without the dataset the location step falls back to typed fields and the
    // browser's own timezone, which is exactly how Nooki worked before this existed.
    log('geo: country-state-city / tz-lookup are not installed — skipping the place dataset.');
    log('geo: the location pickers will fall back to typed fields and the detected timezone.');
    return { generated: false, countries: 0, files: 0, bytes: 0 };
  }

  // Validate through Intl rather than against `supportedValuesOf`: that list omits the
  // legacy links the source data still uses (America/Indiana/Indianapolis), and what a
  // browser can actually format is the only thing that matters here. Resolving also
  // canonicalises, so a stored zone is always the one `Intl.DateTimeFormat` will echo back.
  const canonicalizeZone = zoneCanonicalizer();
  const index = buildCountryIndex(source.countries, { canonicalizeZone });
  const zonesByCode = new Map(index.map((country) => [country.code, country.zones]));

  const statesByCountry = new Map();
  for (const state of source.states) {
    const code = normalizeName(state.countryCode).toUpperCase();
    if (!statesByCountry.has(code)) statesByCountry.set(code, []);
    statesByCountry.get(code).push(state);
  }
  const citiesByCountry = new Map();
  for (const row of source.cities) {
    const code = normalizeName(row[1]).toUpperCase();
    if (!citiesByCountry.has(code)) citiesByCountry.set(code, []);
    citiesByCountry.get(code).push(row);
  }

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(join(outputDir, 'country'), { recursive: true });

  let bytes = 0;
  const write = async (relative, payload) => {
    const text = `${JSON.stringify(payload)}\n`;
    await writeFile(join(outputDir, relative), text, 'utf8');
    bytes += Buffer.byteLength(text);
    return Buffer.byteLength(text);
  };

  // The index only carries what the first picker needs; zones live here so a
  // single-zone country sets the clock before any second request is made.
  await write('countries.json', index.map(({ code, name, flag, zones, tz }) => ({ code, name, flag, zones, tz })));

  let files = 1;
  for (const country of index) {
    const dataset = buildCountryDataset({
      code: country.code,
      zones: zonesByCode.get(country.code) ?? country.zones,
      states: statesByCountry.get(country.code) ?? [],
      cities: citiesByCountry.get(country.code) ?? [],
      lookupTimezone: source.lookupTimezone,
      canonicalizeZone,
    });
    await write(join('country', `${country.code}.json`), dataset);
    files += 1;
  }

  log(`geo: wrote ${index.length} countries to ${outputDir} (${(bytes / 1024 / 1024).toFixed(1)}MB, ${files} files).`);
  return { generated: true, countries: index.length, files, bytes };
}

/**
 * Returns `zone` as this platform spells it, or null when it cannot be formatted at all.
 * Cached: 148k cities ask about a few hundred distinct zones.
 */
function zoneCanonicalizer() {
  const seen = new Map();
  return (zone) => {
    if (!zone) return null;
    if (seen.has(zone)) return seen.get(zone);
    let canonical = null;
    try {
      canonical = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone || null;
    } catch {
      canonical = null;
    }
    seen.set(zone, canonical);
    return canonical;
  };
}

// Runs as `npm run build:geo`; importing this module (the geo tests do) builds nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputDir = fileURLToPath(new URL('../public/geo/', import.meta.url));
  buildGeoData({ outputDir }).catch((error) => {
    console.error('geo: the place dataset could not be built.', error);
    process.exitCode = 1;
  });
}
