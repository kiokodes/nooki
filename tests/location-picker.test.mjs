import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';
import { geoWorld } from './helpers/geoWorld.mjs';

// Where a person is gets asked twice: once at signup, and again whenever they move. Both
// ask through the same three fields, and both have to end with the same thing in the
// database — a whole place, and the timezone that place implies rather than a guess.
// The dataset is injected, so these run without the generated files or a network.

const profileRow = (overrides = {}) => ({
  id: 'user-a', couple_id: 'couple-1', name: 'Ada', timezone: 'Africa/Lagos',
  country_code: 'NG', country_name: 'Nigeria', state_code: 'RI', state_name: 'Rivers',
  city_name: 'Port Harcourt', city_key: 'ng/ri/port-harcourt',
  location_updated_at: '2026-10-01T00:00:00.000Z',
  last_seen_at: '2026-10-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

test('locations: signup collects a place, derives the clock, and degrades without the data', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://nooki.test/' });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'FormData', 'localStorage']) {
    globalThis[key] = dom.window[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
    },
  });
  const root = createRoot(document.getElementById('root'));
  const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
  const backend = await installTestBackend(supabase);
  const auth = await server.ssrLoadModule('/src/lib/authService.ts');
  const { OnboardingView } = await server.ssrLoadModule('/src/components/auth/OnboardingView.tsx');

  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  const setSelect = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set;
  const fill = async (input, value) => act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const choose = async (select, value) => act(async () => {
    setSelect.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const submit = async () => act(async () => {
    document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  const field = (name) => document.querySelector(`[data-location-${name}]`);
  // The offset half of the label moves with daylight saving, so only the zone is asserted.
  const zoneLabel = () => document.querySelector('[data-location-timezone-label]').textContent.split(' · ')[0];
  const zoneSource = () => document.querySelector('[data-location-timezone-source]').textContent;

  try {
    // --- Nigeria, Rivers, Port Harcourt: one zone in the country, so no question asked ---
    const ada = (await auth.signUpWithEmail('ada@example.com', 'password')).user;
    let completed = 0;
    await act(async () => root.render(React.createElement(OnboardingView, {
      userId: ada.id, onComplete: () => { completed += 1; }, geo: geoWorld(),
    })));
    assert.equal(document.querySelector('[data-location-fields]').dataset.locationMode, 'picker');
    assert.deepEqual(
      [...field('country').options].map((option) => option.value),
      ['', 'NG', 'SG', 'US'],
    );

    await fill(document.getElementById('first-name'), 'Ada');
    // No country yet: nothing is derived and the form says so rather than guessing.
    assert.equal(zoneSource(), 'Choose your country');
    await submit();
    assert.equal(completed, 0, 'a place is required before signup can go on');
    assert.match(document.querySelector('[role="alert"]').textContent, /choose your country/i);

    await choose(field('country'), 'NG');
    assert.equal(zoneLabel(), 'Africa/Lagos', 'the country alone settles the clock');
    assert.equal(zoneSource(), 'From your country');
    assert.equal(field('country').options[1].textContent, '🇳🇬  Nigeria');
    await choose(field('state'), 'RI');
    assert.deepEqual(
      [...document.querySelectorAll('datalist option')].map((option) => option.value),
      ['Port Harcourt', 'Buguma'],
      'the cities of the state that was chosen, and only those, in the order the file lists them',
    );
    await fill(field('city'), 'Port Harcourt');
    assert.equal(zoneSource(), 'From your state');
    await submit();
    assert.equal(completed, 1);
    const saved = await auth.fetchProfile(ada.id);
    assert.deepEqual({
      country_code: saved.country_code, country_name: saved.country_name,
      state_code: saved.state_code, state_name: saved.state_name,
      city_name: saved.city_name, timezone: saved.timezone,
    }, {
      country_code: 'NG', country_name: 'Nigeria', state_code: 'RI', state_name: 'Rivers',
      city_name: 'Port Harcourt', timezone: 'Africa/Lagos',
    });
    assert.equal(saved.city_key, 'ng/ri/port-harcourt', 'the database keys the place it was given');
    assert.ok(saved.location_updated_at, 'and stamps when it was told');

    // --- The United States: a country that cannot answer until the state does -----------
    const ben = (await auth.signUpWithEmail('ben@example.com', 'password')).user;
    await act(async () => root.render(React.createElement(OnboardingView, {
      key: 'ben', userId: ben.id, onComplete: () => {}, geo: geoWorld(),
    })));
    await choose(field('country'), 'US');
    assert.equal(zoneSource(), 'Choose your state to settle this', '29 zones is not an answer');
    await choose(field('state'), 'IN');
    assert.equal(zoneLabel(), 'America/Indianapolis');
    assert.equal(zoneSource(), 'From your state');
    await fill(field('city'), 'Gary');
    assert.equal(zoneLabel(), 'America/Chicago', 'the city corrects the state it sits on the edge of');
    assert.equal(zoneSource(), 'From your city');

    // A zone picked by hand stays put, and says that it was chosen.
    await choose(field('timezone'), 'America/New_York');
    assert.equal(document.querySelector('[data-location-fields]').dataset.locationZoneSource, 'override');
    assert.equal(zoneSource(), 'You chose this');
    await fill(field('city'), 'Gary ');
    assert.equal(field('timezone').value, 'America/New_York', 'typing in the same place keeps the hand-picked zone');
    // Moving state is a different place, so the derivation takes over again.
    await choose(field('state'), 'ID');
    assert.equal(field('timezone').value, 'America/Boise');

    // A country with no subdivisions in the data: the state is typed, the city is offered.
    await choose(field('country'), 'SG');
    assert.equal(field('state').tagName, 'INPUT', 'no states to pick from, so it is typed');
    await fill(field('state'), 'Central');
    await fill(field('city'), 'Singapore');
    assert.equal(field('timezone').value, 'Asia/Singapore');
    await fill(document.getElementById('first-name'), 'Ben');
    await submit();
    const singapore = await auth.fetchProfile(ben.id);
    assert.equal(singapore.state_code, null, 'a typed state has a name and no code');
    assert.equal(singapore.state_name, 'Central');
    assert.equal(singapore.city_key, 'sg/-/singapore');

    // --- One country's file missing: typed fields, but the country code is still known ---
    const chloe = (await auth.signUpWithEmail('chloe@example.com', 'password')).user;
    await act(async () => root.render(React.createElement(OnboardingView, {
      key: 'chloe', userId: chloe.id, onComplete: () => {},
      geo: geoWorld({ country: async () => { throw new Error('offline'); } }),
    })));
    await choose(field('country'), 'NG');
    assert.equal(document.querySelector('[data-location-fields]').dataset.locationMode, 'typed');
    assert.equal(field('state').tagName, 'INPUT');
    assert.match(document.body.textContent, /place list did not load/);
    await fill(field('state'), 'Rivers');
    await fill(field('city'), 'Port Harcourt');
    assert.equal(field('timezone').value, 'Africa/Lagos', 'the country index still knew the zone');
    await fill(document.getElementById('first-name'), 'Chloe');
    await submit();
    const typed = await auth.fetchProfile(chloe.id);
    assert.equal(typed.country_code, 'NG');
    assert.equal(typed.city_name, 'Port Harcourt');
    assert.equal(typed.city_key, 'ng/-/port-harcourt',
      'a typed state has no code, and the place still gets a key of its own');

    // --- No index at all: the timezone picker Nooki always had, and no half a place -----
    const milo = (await auth.signUpWithEmail('milo@example.com', 'password')).user;
    await act(async () => root.render(React.createElement(OnboardingView, {
      key: 'milo', userId: milo.id, onComplete: () => {},
      geo: geoWorld({ countries: async () => { throw new Error('offline'); } }),
    })));
    assert.equal(document.querySelector('[data-location-fields]').dataset.locationMode, 'timezone-only');
    assert.equal(field('country'), null, 'with no country there is nothing to key a place by');
    assert.ok([...field('timezone').options].length > 400, 'so the old picker comes back');
    await fill(document.getElementById('first-name'), 'Milo');
    await choose(field('timezone'), 'Europe/London');
    await submit();
    const fallback = await auth.fetchProfile(milo.id);
    assert.equal(fallback.timezone, 'Europe/London');
    assert.equal(fallback.country_code, null, 'signup saves a zone and no location, never half of one');
    assert.equal(fallback.city_key, null);
  } finally {
    await act(async () => root.unmount());
    await server.close();
    await supabase.auth.dispose();
    await backend.close();
    dom.window.close();
  }
});

test('locations: Couple Settings shows both places and updates only your own', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://nooki.test/' });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'FormData', 'localStorage']) {
    globalThis[key] = dom.window[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
    },
  });
  const root = createRoot(document.getElementById('root'));
  const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
  const backend = await installTestBackend(supabase);
  const auth = await server.ssrLoadModule('/src/lib/authService.ts');
  const { LocationSettingsCard } = await server.ssrLoadModule('/src/components/common/LocationSettingsCard.tsx');

  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  const setSelect = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set;
  const fill = async (input, value) => act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const choose = async (select, value) => act(async () => {
    setSelect.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const click = async (target) => act(async () => target.click());
  const field = (name) => document.querySelector(`[data-location-${name}]`);

  try {
    const ada = (await auth.signUpWithEmail('ada@example.com', 'password')).user;
    await auth.saveOnboardingProfile(ada.id, {
      name: 'Ada',
      location: {
        countryCode: 'NG', countryName: 'Nigeria', stateCode: 'RI', stateName: 'Rivers',
        cityName: 'Port Harcourt', timezone: 'Africa/Lagos',
      },
    });
    const partner = profileRow({
      id: 'user-b', name: 'Ben', timezone: 'Europe/London',
      country_code: 'GB', country_name: 'United Kingdom', state_code: 'ENG', state_name: 'England',
      city_name: 'London', city_key: 'gb/eng/london',
    });
    const mine = await auth.fetchProfile(ada.id);

    let savedWith = null;
    const render = (profile) => act(async () => root.render(React.createElement(LocationSettingsCard, {
      profile, partner, geo: geoWorld(), onSaved: (row) => { savedWith = row; },
    })));
    await render(mine);

    // Both places are on the card, and nothing else: the card says where, not why.
    assert.equal(field('yours').textContent, 'You: Port Harcourt, Rivers, Nigeria');
    assert.equal(field('partner').textContent, 'Ben: London, England, United Kingdom');
    assert.equal(field('market'), null, 'the card carries no marketplace commentary');
    assert.equal(document.querySelector('[data-location-form]'), null, 'the form is closed until it is asked for');

    // Ada moves back home to Lagos: one tap, three fields, and her partner's clock follows.
    await click(field('edit'));
    assert.equal(field('country').value, 'NG', 'the form opens on where she already is');
    assert.equal(field('state').value, 'RI', 'the state picker holds codes, and shows names');
    assert.equal(field('city').value, 'Port Harcourt');
    await choose(field('state'), 'LA');
    assert.equal(field('city').value, '', 'a different state means a different city list');
    await fill(field('city'), 'Lagos');
    await click(field('save'));

    assert.ok(savedWith, 'the saved row is handed back so the header can change at once');
    assert.equal(savedWith.city_name, 'Lagos');
    assert.equal(savedWith.city_key, 'ng/la/lagos');
    const inDatabase = await auth.fetchProfile(ada.id);
    // What the app does with that row: the card is re-rendered on the saved profile.
    await render(inDatabase);
    assert.equal(inDatabase.city_key, 'ng/la/lagos');
    assert.equal(inDatabase.state_code, 'LA');
    assert.equal(inDatabase.name, 'Ada', 'updating a place never rewrites the rest of the profile');
    assert.equal(field('yours').textContent, 'You: Lagos, Nigeria');
    assert.equal(document.querySelector('[role="status"]').textContent, 'Saved');

    // A partner who has not added theirs: the card says whose turn it is.
    await act(async () => root.render(React.createElement(LocationSettingsCard, {
      profile: inDatabase,
      partner: profileRow({ id: 'user-b', name: 'Ben', country_code: null, country_name: null, state_code: null, state_name: null, city_name: null, city_key: null, location_updated_at: null }),
      geo: geoWorld(),
      onSaved: () => {},
    })));
    assert.equal(field('partner').textContent, 'Ben: not added yet');
    assert.equal(field('market'), null, 'and no explanation of what is still missing');

    // Cancelling leaves what is saved alone.
    await act(async () => root.render(React.createElement(LocationSettingsCard, {
      profile: inDatabase, partner, geo: geoWorld(), onSaved: () => {},
    })));
    await click(field('edit'));
    await fill(field('city'), 'Abuja');
    await click(document.querySelector('[aria-label="Cancel editing your location"]'));
    assert.equal(document.querySelector('[data-location-form]'), null);
    assert.equal((await auth.fetchProfile(ada.id)).city_name, 'Lagos', 'a cancelled edit changed nothing');

    // A save the database refuses is reported in words, and the form stays open.
    await act(async () => root.render(React.createElement(LocationSettingsCard, {
      // A profile row that is not there any more: the save must say so in words.
      profile: { ...inDatabase, id: '00000000-0000-4000-8000-0000000000ff' },
      partner, geo: geoWorld(), onSaved: () => {},
    })));
    await click(field('edit'));
    await click(field('save'));
    assert.match(document.querySelector('[role="alert"]').textContent, /could not be saved/i);
    assert.ok(document.querySelector('[data-location-form]'), 'the form is still there to try again');
  } finally {
    await act(async () => root.unmount());
    await server.close();
    await supabase.auth.dispose();
    await backend.close();
    dom.window.close();
  }
});
