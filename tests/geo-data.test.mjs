import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { buildCountryDataset, buildCountryIndex, buildGeoData, cityKey, normalizeName } from '../scripts/build-geo-data.mjs';

// The place dataset is generated at build time (npm run build:geo, which predev and
// prebuild run) and fetched at runtime, so a mistake here is a mistake on every phone:
// a country whose zones were dropped asks a question it could have answered, and a city
// filed under the wrong state cannot be found by the person who lives in it.
test('geo data: the generated place dataset keeps its timezones and its grouping', async () => {
  // --- The builders, on a world small enough to read -----------------------------------
  const zones = ['Africa/Lagos'];
  const index = buildCountryIndex([
    { isoCode: 'ng', name: '  Nigeria ', flag: '🇳🇬', timezones: [{ zoneName: 'Africa/Lagos' }, { zoneName: 'Africa/Lagos' }] },
    { isoCode: 'US', name: 'United States', flag: '🇺🇸', timezones: [{ zoneName: 'America/New_York' }, { zoneName: 'America/Chicago' }, { zoneName: 'Not/AZone' }] },
    { name: 'No code at all', timezones: [] },
  ], { canonicalizeZone: (zone) => (zone === 'Not/AZone' ? null : zone) });

  assert.deepEqual(index, [
    { code: 'NG', name: 'Nigeria', flag: '🇳🇬', zones, tz: 'Africa/Lagos' },
    // A zone this browser cannot read is dropped rather than stored, and a country left
    // with several has no single answer, so `tz` stays null and the app asks.
    { code: 'US', name: 'United States', flag: '🇺🇸', zones: ['America/Chicago', 'America/New_York'], tz: null },
  ], 'a country with no code cannot be keyed, so it is not offered');

  const single = buildCountryDataset({
    code: 'NG',
    zones,
    states: [
      { isoCode: 'ri', name: 'Rivers', countryCode: 'NG', latitude: '4.8', longitude: '7.0' },
      { isoCode: 'LA', name: 'Lagos', countryCode: 'NG', latitude: '6.5', longitude: '3.4' },
    ],
    cities: [
      ['Port Harcourt', 'NG', 'RI', '4.77', '7.01'],
      ['  Obonoma ', 'NG', 'RI', '4.6', '6.8'],
      ['Port Harcourt', 'NG', 'RI', '4.78', '7.02'],
      ['Lagos', 'NG', 'LA', '6.45', '3.4'],
      ['Somewhere', 'NG', 'ZZ', '6.0', '3.0'],
      ['Abidjan', 'CI', 'AB', '5.3', '-4.0'],
    ],
    // A single-zone country never needs a per-city lookup: the country is the answer.
    lookupTimezone: () => { throw new Error('a one-zone country should not ask where a city is'); },
  });
  assert.deepEqual(single, {
    code: 'NG',
    zones,
    tz: 'Africa/Lagos',
    states: [
      { code: 'LA', name: 'Lagos', tz: 'Africa/Lagos' },
      { code: 'RI', name: 'Rivers', tz: 'Africa/Lagos' },
    ],
    cities: { LA: ['Lagos'], RI: ['Obonoma', 'Port Harcourt'], '': ['Somewhere'] },
  }, 'cities are deduped and sorted, another country’s are left out, and one the data could not attach to a state is filed under ""');

  const multi = buildCountryDataset({
    code: 'US',
    zones: ['America/Chicago', 'America/Indianapolis', 'America/New_York'],
    states: [
      { isoCode: 'IN', name: 'Indiana', countryCode: 'US', latitude: '39.8', longitude: '-86.2' },
      { isoCode: 'ME', name: 'Maine', countryCode: 'US', latitude: '45.3', longitude: '-69.2' },
    ],
    cities: [
      ['Indianapolis', 'US', 'IN', '39.77', '-86.16'],
      ['Gary', 'US', 'IN', '41.59', '-87.35'],
      ['Portland', 'US', 'ME', '43.66', '-70.26'],
    ],
    lookupTimezone: (lat, lon) => (lon < -85 && lat > 41 ? 'America/Chicago' : lat > 40 ? 'America/New_York' : 'America/Indianapolis'),
  });
  assert.deepEqual(multi.states, [
    { code: 'IN', name: 'Indiana', tz: 'America/Indianapolis' },
    { code: 'ME', name: 'Maine', tz: 'America/New_York' },
  ], 'a state that spans several zones gets the zone at its centre');
  assert.deepEqual(multi.cityZones, { IN: { Gary: 'America/Chicago' } },
    'only the cities that differ from their state are written down, which is what keeps the file small');
  assert.deepEqual(multi.cities, { IN: ['Gary', 'Indianapolis'], ME: ['Portland'] });
  assert.equal(multi.tz, null);

  // A country with subdivisions the data has no cities for still lists them, so the picker
  // can show the states and let the city be typed.
  const empty = buildCountryDataset({ code: 'SG', zones: ['Asia/Singapore'], states: [{ isoCode: '01', name: 'Central', countryCode: 'SG', latitude: '1.3', longitude: '103.8' }], cities: [], lookupTimezone: () => 'Asia/Singapore' });
  assert.deepEqual(empty.cities, { '01': [] });
  // And one with neither: no states to list, no cities to file.
  const bare = buildCountryDataset({ code: 'VA', zones: ['Europe/Vatican'], states: [], cities: [], lookupTimezone: () => 'Europe/Vatican' });
  assert.deepEqual(bare.cities, {});
  assert.deepEqual(bare.states, []);

  assert.equal(normalizeName('  Port\tHarcourt \n'), 'Port Harcourt');
  assert.equal(cityKey({ countryCode: 'NG', stateCode: 'RI', cityName: 'Port Harcourt' }), 'ng/ri/port-harcourt');
  assert.equal(cityKey({ countryCode: 'SG', stateCode: null, cityName: 'Singapore' }), 'sg/-/singapore');

  // --- The real thing, into a throwaway directory --------------------------------------
  // ~148k cities and 250 countries, in a couple of seconds: this is what runs before every
  // dev server and every deploy, so it is worth watching once per test run.
  const outputDir = await mkdtemp(join(tmpdir(), 'nooki-geo-'));
  try {
    const result = await buildGeoData({ outputDir, log: () => {} });
    if (!result.generated) {
      // The source packages are devDependencies; if they are not installed the app falls
      // back to typed fields, and so does this test.
      console.log('# geo: country-state-city is not installed, skipping the generated output');
      return;
    }
    assert.equal(result.countries, 250);
    const read = async (relative) => JSON.parse(await readFile(join(outputDir, relative), 'utf8'));

    const index2 = await read('countries.json');
    assert.equal(index2.length, 250);
    const nigeria = index2.find((country) => country.code === 'NG');
    assert.deepEqual(nigeria, { code: 'NG', name: 'Nigeria', flag: '🇳🇬', zones: ['Africa/Lagos'], tz: 'Africa/Lagos' });
    const multiZone = index2.filter((country) => !country.tz);
    assert.equal(multiZone.length, 31, 'the countries that span several timezones, and so need a state to settle them');
    assert.ok(index2.every((country) => country.zones.length > 0), 'every country can at least offer its zones');

    const ng = await read('country/NG.json');
    assert.equal(ng.tz, 'Africa/Lagos');
    assert.equal(ng.cityZones, undefined, 'a single-zone country writes no per-city exceptions');
    const rivers = ng.states.find((state) => state.name === 'Rivers');
    assert.equal(rivers.code, 'RI');
    assert.equal(rivers.tz, 'Africa/Lagos');
    assert.ok(ng.cities.RI.includes('Port Harcourt'), 'the example the feature was asked for is in the data');

    const us = await read('country/US.json');
    assert.equal(us.tz, null);
    assert.equal(us.states.find((state) => state.name === 'Idaho').tz, 'America/Boise');
    assert.equal(us.cityZones.IN.Gary, 'America/Chicago', 'a city in the corner of its state that keeps another clock');

    // Every zone written into the dataset has to be one a browser can read a clock in, or
    // the header's partner time quietly disappears for that person.
    const readable = new Map();
    const canRead = (zone) => {
      if (!readable.has(zone)) {
        try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); readable.set(zone, true); }
        catch { readable.set(zone, false); }
      }
      return readable.get(zone);
    };
    for (const country of index2) {
      assert.ok(country.zones.every(canRead), `${country.code}: a zone the browser cannot read`);
      if (country.tz) assert.ok(canRead(country.tz), `${country.code}: an unreadable single zone`);
    }
    let stateCount = 0;
    let exceptionCount = 0;
    for (const country of index2) {
      const dataset = await read(`country/${country.code}.json`);
      assert.equal(dataset.code, country.code);
      for (const state of dataset.states) {
        stateCount += 1;
        assert.ok(!state.tz || canRead(state.tz), `${country.code}/${state.name}: an unreadable state zone`);
      }
      for (const byCity of Object.values(dataset.cityZones ?? {})) {
        for (const [city, zone] of Object.entries(byCity)) {
          exceptionCount += 1;
          assert.ok(canRead(zone), `${country.code}/${city}: an unreadable city zone`);
        }
      }
      // A single-zone country writes no per-city exceptions: there is nothing to except.
      if (dataset.tz) assert.equal(dataset.cityZones, undefined, `${country.code} should not need exceptions`);
    }
    assert.ok(stateCount > 4000, `the states were generated (${stateCount})`);
    assert.ok(exceptionCount > 0, `cities that keep another clock than their state were found (${exceptionCount})`);

    // And the derivation the app runs on that real data gives the answers the feature was
    // asked for, not just answers that look right on a fixture.
    const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
    try {
      const { deriveTimezone } = await server.ssrLoadModule('/src/lib/geo/location.ts');
      const america = index2.find((country) => country.code === 'US');
      const derived = (country, dataset, stateName, cityName) => deriveTimezone(country, dataset, {
        stateCode: dataset.states.find((state) => state.name === stateName)?.code ?? null,
        cityName,
      });
      assert.deepEqual(derived(nigeria, ng, 'Rivers', 'Port Harcourt'),
        { timezone: 'Africa/Lagos', source: 'state', ambiguous: false });
      assert.deepEqual(derived(nigeria, ng, null, ''),
        { timezone: 'Africa/Lagos', source: 'country', ambiguous: false },
        'choosing Nigeria is enough; no question is asked');
      assert.deepEqual(derived(america, us, 'Indiana', 'Gary'),
        { timezone: 'America/Chicago', source: 'city', ambiguous: false });
      assert.deepEqual(derived(america, us, 'Idaho', 'Boise'),
        { timezone: 'America/Boise', source: 'state', ambiguous: false });
      assert.deepEqual(derived(america, us, null, ''),
        { timezone: null, source: 'none', ambiguous: true },
        'choosing the United States is not enough, and the form says so');
    } finally {
      await server.close();
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
