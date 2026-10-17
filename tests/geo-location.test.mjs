import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

// The place rules are the scaffolding the marketplace will stand on: the key a vendor query
// will one day be scoped to, the timezone a place implies, and which city a gift opens on.
// They are pure, so they are tested without a database, a DOM or a network.
test('places: keys, derived timezones, and the city the marketplace opens on', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const {
      buildCityKey, cityZone, describePlace, describePlaceShort, deriveTimezone, isCompleteSelection,
      normalizePlaceName, stateBucket, validateLocationInput, locationColumns, profileLocation,
      emptyLocationDraft, draftFromProfile,
    } = await server.ssrLoadModule('/src/lib/geo/location.ts');
    const { marketCityFromProfile, resolveMarketCities } = await server.ssrLoadModule('/src/lib/geo/marketplace.ts');

    // --- The key: codes plus a slugged city, so two spellings of one place agree ---------
    assert.equal(
      buildCityKey({ countryCode: 'NG', stateCode: 'RI', cityName: 'Port Harcourt' }),
      'ng/ri/port-harcourt',
    );
    assert.equal(
      buildCityKey({ countryCode: 'ng', stateCode: 'ri', cityName: '  port   harcourt. ' }),
      'ng/ri/port-harcourt',
      'whitespace, case and trailing punctuation do not make a second city',
    );
    assert.equal(buildCityKey({ countryCode: 'SG', stateCode: null, cityName: 'Singapore' }), 'sg/-/singapore');
    assert.notEqual(
      buildCityKey({ countryCode: 'SG', stateCode: null, cityName: 'Singapore' }),
      buildCityKey({ countryCode: 'SG', stateCode: '01', cityName: 'Singapore' }),
      'a missing state cannot collide with a real one',
    );
    assert.equal(buildCityKey({ countryCode: "CA", stateCode: 'NS', cityName: "St John's" }), 'ca/ns/st-johns');
    // No country or no city is no key at all, which is what the database generates too.
    assert.equal(buildCityKey({ countryCode: '', stateCode: null, cityName: 'Lagos' }), null);
    assert.equal(buildCityKey({ countryCode: 'NG', stateCode: 'LA', cityName: '   ' }), null);
    assert.equal(normalizePlaceName('  Port\t Harcourt \n'), 'Port Harcourt');

    // --- Derivation: city beats state beats country, and an unknown place asks ------------
    const nigeria = { code: 'NG', name: 'Nigeria', flag: '🇳🇬', zones: ['Africa/Lagos'], tz: 'Africa/Lagos' };
    const america = {
      code: 'US', name: 'United States', flag: '🇺🇸',
      zones: ['America/Boise', 'America/Chicago', 'America/New_York'], tz: null,
    };
    const us = {
      code: 'US',
      zones: america.zones,
      tz: null,
      states: [
        { code: 'ID', name: 'Idaho', tz: 'America/Boise' },
        { code: 'IN', name: 'Indiana', tz: 'America/Indianapolis' },
        { code: 'NY', name: 'New York', tz: 'America/New_York' },
      ],
      cities: { ID: ['Boise'], IN: ['Gary', 'Indianapolis'], NY: ['New York'] },
      cityZones: { IN: { Gary: 'America/Chicago' } },
    };

    // One zone in the whole country: the country alone settles the clock, before the state
    // or the city has even been chosen.
    assert.deepEqual(
      deriveTimezone(nigeria, null, { stateCode: null, cityName: '' }),
      { timezone: 'Africa/Lagos', source: 'country', ambiguous: false },
    );
    // Several zones and nothing narrower yet: no guess, and the picker says so.
    assert.deepEqual(
      deriveTimezone(america, null, { stateCode: null, cityName: '' }),
      { timezone: null, source: 'none', ambiguous: true },
    );
    assert.deepEqual(
      deriveTimezone(america, us, { stateCode: 'ID', cityName: '' }),
      { timezone: 'America/Boise', source: 'state', ambiguous: false },
    );
    // The state that straddles two: the city corrects its own state's centroid.
    assert.deepEqual(
      deriveTimezone(america, us, { stateCode: 'IN', cityName: 'Gary' }),
      { timezone: 'America/Chicago', source: 'city', ambiguous: false },
    );
    assert.deepEqual(
      deriveTimezone(america, us, { stateCode: 'IN', cityName: 'Indianapolis' }),
      { timezone: 'America/Indianapolis', source: 'state', ambiguous: false },
      'a city with no exception of its own keeps its state’s zone',
    );
    assert.equal(cityZone(us, 'IN', 'Gary'), 'America/Chicago');
    assert.equal(cityZone(us, 'IN', 'Indianapolis'), null);
    assert.equal(stateBucket(us, 'ZZ'), '', 'a city the data could not attach to a state is filed under ""');
    // No place at all: nothing to derive, and nothing claimed.
    assert.deepEqual(deriveTimezone(null, null, { stateCode: null, cityName: '' }), {
      timezone: null, source: 'none', ambiguous: false,
    });

    // --- Saying a place out loud --------------------------------------------------------
    assert.equal(
      describePlace({ cityName: 'Port Harcourt', stateName: 'Rivers', countryName: 'Nigeria' }),
      'Port Harcourt, Rivers, Nigeria',
    );
    assert.equal(describePlace({ cityName: 'Singapore', stateName: null, countryName: 'Singapore' }), 'Singapore');
    assert.equal(describePlace({ cityName: null, stateName: null, countryName: null }), '');
    assert.equal(describePlaceShort({ cityName: 'Lagos', countryCode: 'NG', countryName: 'Nigeria' }), 'Lagos, NG');
    assert.equal(describePlaceShort({ cityName: null, countryCode: 'NG' }), 'NG');

    // --- What may be saved, and what may not --------------------------------------------
    assert.equal(isCompleteSelection({
      countryCode: 'NG', countryName: 'Nigeria', stateCode: 'RI', stateName: 'Rivers', cityName: 'Port Harcourt',
    }), true);
    assert.equal(isCompleteSelection({
      countryCode: '', countryName: '', stateCode: null, stateName: null, cityName: 'Port Harcourt',
    }), false, 'a city with no country is not a place Nooki can key');

    const clean = validateLocationInput({
      countryCode: 'ng', countryName: '  nigeria ', stateCode: 'ri', stateName: 'rivers',
      cityName: ' port  harcourt ', timezone: 'Africa/Lagos',
    });
    assert.deepEqual(clean, {
      countryCode: 'NG', countryName: 'nigeria', stateCode: 'RI', stateName: 'rivers',
      cityName: 'port harcourt', timezone: 'Africa/Lagos',
    });
    assert.deepEqual(locationColumns(clean, new Date('2026-10-17T09:00:00.000Z')), {
      country_code: 'NG', country_name: 'nigeria', state_code: 'RI', state_name: 'rivers',
      city_name: 'port harcourt', timezone: 'Africa/Lagos', location_updated_at: '2026-10-17T09:00:00.000Z',
    }, 'the generated city_key is never sent — the database makes it');
    // A state name with no code is fine (a typed one); a code with no name is dropped, so a
    // key can never carry a subdivision the person never said.
    assert.equal(validateLocationInput({ ...clean, stateCode: 'RI', stateName: '' }).stateCode, null);
    for (const [bad, message] of [
      [{ ...clean, countryCode: 'Nigeria' }, /choose your country/i],
      [{ ...clean, countryCode: '' }, /choose your country/i],
      [{ ...clean, cityName: '   ' }, /choose your city/i],
      [{ ...clean, timezone: 'Not/AZone' }, /timezone/i],
      [{ ...clean, cityName: 'x'.repeat(121) }, /120 characters/i],
    ]) {
      assert.throws(() => validateLocationInput(bad), message, `${JSON.stringify(bad)} should be refused`);
    }

    // --- Round-tripping a saved profile back into the picker ----------------------------
    const saved = {
      id: 'a', couple_id: 'c', name: 'Ada', timezone: 'Africa/Lagos',
      country_code: 'NG', country_name: 'Nigeria', state_code: 'RI', state_name: 'Rivers',
      city_name: 'Port Harcourt', city_key: 'ng/ri/port-harcourt',
      location_updated_at: '2026-10-17T09:00:00.000Z', last_seen_at: '2026-10-17T09:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    };
    assert.deepEqual(profileLocation(saved), {
      countryCode: 'NG', countryName: 'Nigeria', stateCode: 'RI', stateName: 'Rivers',
      cityName: 'Port Harcourt', timezone: 'Africa/Lagos',
    });
    assert.equal(profileLocation({ ...saved, city_name: null }), null);
    assert.equal(profileLocation(null), null);
    assert.equal(draftFromProfile(saved).cityName, 'Port Harcourt');
    assert.deepEqual(draftFromProfile({ ...saved, country_code: null, city_name: null }), {
      ...emptyLocationDraft('Africa/Lagos'),
    }, 'a profile with no place opens on its existing timezone, not on a blank one');

    // --- The marketplace seam: it opens on the partner's city ---------------------------
    const ada = { ...saved };
    const ben = {
      ...saved, id: 'b', name: 'Ben', timezone: 'Europe/London',
      country_code: 'GB', country_name: 'United Kingdom', state_code: 'ENG', state_name: 'England',
      city_name: 'London', city_key: 'gb/eng/london',
    };

    const longDistance = resolveMarketCities(ada, ben);
    assert.equal(longDistance.ready, true);
    assert.equal(longDistance.defaultCity?.key, 'gb/eng/london', 'the gift is going to them, so their city is the default');
    assert.equal(longDistance.defaultCity?.belongsTo, 'partner');
    assert.deepEqual(longDistance.cities.map((city) => city.key), ['gb/eng/london', 'ng/ri/port-harcourt'],
      'their city first, then yours — the "other cities" switcher');
    assert.equal(longDistance.defaultCity?.name, 'London, England, United Kingdom');
    assert.equal(longDistance.defaultCity?.shortName, 'London, GB', 'and a short form for a switcher chip');
    assert.equal(longDistance.defaultCity?.timezone, 'Europe/London');
    assert.equal(longDistance.notice, null);

    // Back in the same country, still two cities: exactly the couple who came home from
    // abroad and kept using Nooki.
    const homeAgain = resolveMarketCities(
      { ...ada, country_code: 'ZA', country_name: 'South Africa', state_code: 'GP', state_name: 'Gauteng', city_name: 'Johannesburg', city_key: 'za/gp/johannesburg', timezone: 'Africa/Johannesburg' },
      { ...ben, country_code: 'ZA', country_name: 'South Africa', state_code: 'WC', state_name: 'Western Cape', city_name: 'Cape Town', city_key: 'za/wc/cape-town', timezone: 'Africa/Johannesburg' },
    );
    assert.equal(homeAgain.ready, true);
    assert.deepEqual(homeAgain.cities.map((city) => city.key), ['za/wc/cape-town', 'za/gp/johannesburg']);

    // The same city on both phones is one city, not two.
    const together = resolveMarketCities(ada, { ...ben, ...ada, id: 'b', name: 'Ben' });
    assert.deepEqual(together.cities.map((city) => city.key), ['ng/ri/port-harcourt']);

    // A partner who has not added theirs: not ready, and the sentence says whose it is.
    const waiting = resolveMarketCities(ada, { ...ben, country_code: null, country_name: null, state_code: null, state_name: null, city_name: null, city_key: null, location_updated_at: null });
    assert.equal(waiting.ready, false);
    assert.equal(waiting.defaultCity, null);
    assert.match(waiting.notice ?? '', /Ben has not added their city yet/);
    assert.deepEqual(waiting.cities.map((city) => city.key), ['ng/ri/port-harcourt'],
      'your own city is still on offer while you wait for theirs');
    assert.equal(marketCityFromProfile(null, 'partner'), null);
    // A row read from a project that has the columns but not the generated key still works.
    assert.equal(marketCityFromProfile({ ...ada, city_key: null }, 'you')?.key, 'ng/ri/port-harcourt');
  } finally {
    await server.close();
  }
});
