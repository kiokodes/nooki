import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';
import { geoWorld } from './helpers/geoWorld.mjs';

// DOM interaction checks without a browser download or a live backend.
test('auth, place selection, and navigating pending pairing', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
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
  let backend;
  let unconfiguredServer;
  const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
  const root = createRoot(document.getElementById('root'));
  const button = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(text));
  const click = async (target) => act(async () => target.click());
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  const fill = async (input, value) => act(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const submit = async () => act(async () => {
    document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  try {
    const { clearLegacyLocalData } = await server.ssrLoadModule('/src/lib/clearLegacyLocalData.ts');
    const legacyKeys = ['nooki_mock_users', 'nooki_mock_profiles', 'nooki_mock_couples', 'nooki_current_user_id'];
    legacyKeys.forEach((key) => localStorage.setItem(key, 'obsolete'));
    localStorage.setItem('sb-existing-auth-token', 'keep-session');
    clearLegacyLocalData();
    legacyKeys.forEach((key) => assert.equal(localStorage.getItem(key), null));
    assert.equal(localStorage.getItem('sb-existing-auth-token'), 'keep-session');
    backend = await installTestBackend(supabase);
    const { AuthView } = await server.ssrLoadModule('/src/components/auth/AuthView.tsx');
    let submitted = false;
    await act(() => root.render(React.createElement(AuthView, { onSuccess: () => { submitted = true; } })));
    const password = document.getElementById('password');
    assert.equal(password.type, 'password');
    await fill(password, 'test-password');
    await click(document.querySelector('[aria-label="Show password"]'));
    assert.equal(password.type, 'text');
    assert.equal(password.value, 'test-password');
    assert.equal(submitted, false);
    await click(document.querySelector('[aria-label="Hide password"]'));
    assert.equal(password.type, 'password');
    await click(document.querySelector('[aria-label="Show password"]'));
    await click(button('Sign In'));
    assert.equal(password.type, 'password');
    assert.equal(password.autocomplete, 'current-password');
    await click(document.querySelector('[aria-label="Show password"]'));
    assert.equal(password.type, 'text');

    // The full timezone list is still there for the case where no place can be keyed (and
    // for the override picker), even though signup no longer opens with it.
    const { getTimezones } = await server.ssrLoadModule('/src/lib/timezones.ts');
    const zones = getTimezones('US/Eastern');
    assert(zones.includes('UTC') && zones.includes('US/Eastern') && zones.includes('Africa/Lagos'));
    assert(zones.length > 400);
    assert.equal(new Set(zones).size, zones.length);
    assert.deepEqual(zones, [...zones].sort());
    const originalSupportedValues = Intl.supportedValuesOf;
    Intl.supportedValuesOf = undefined;
    try { assert(getTimezones('UTC').length > 400); } finally { Intl.supportedValuesOf = originalSupportedValues; }

    const auth = await server.ssrLoadModule('/src/lib/authService.ts');
    const alice = (await auth.signUpWithEmail('alice@example.com', 'password')).user;
    const { OnboardingView } = await server.ssrLoadModule('/src/components/auth/OnboardingView.tsx');
    let completed = false;
    await act(async () => root.render(React.createElement(OnboardingView, {
      userId: alice.id, onComplete: () => { completed = true; }, geo: geoWorld(),
    })));
    // Signup asks where she is, and the timezone follows from it (see location-picker.test.mjs).
    const setSelectValue = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set;
    await fill(document.getElementById('first-name'), 'Alice');
    await act(async () => {
      const country = document.querySelector('[data-location-country]');
      setSelectValue.call(country, 'NG');
      country.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => {
      const state = document.querySelector('[data-location-state]');
      setSelectValue.call(state, 'RI');
      state.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await fill(document.querySelector('[data-location-city]'), 'Port Harcourt');
    assert.equal(document.querySelector('[data-location-timezone]').value, 'Africa/Lagos');
    await submit();
    assert.equal(completed, true);
    const aliceProfile = await auth.fetchProfile(alice.id);
    assert.equal(aliceProfile.timezone, 'Africa/Lagos');
    assert.equal(aliceProfile.city_key, 'ng/ri/port-harcourt');

    const { PairingView } = await server.ssrLoadModule('/src/components/auth/PairingView.tsx');
    let currentCouple = null;
    const renderPairing = () => root.render(React.createElement(PairingView, {
      userId: alice.id, userName: 'Alice', couple: currentCouple,
      onPairSuccess: async () => {
        const profile = await auth.fetchProfile(alice.id);
        currentCouple = profile.couple_id ? (await auth.fetchCouple(profile.couple_id)).couple : null;
        renderPairing();
      },
    }));
    await act(renderPairing);
    await click(button('Create'));
    await click(button('Back to options'));
    await click(button("Enter Partner's Code"));
    await click(button('Back to options'));
    await click(button('Create'));
    await fill(document.querySelector('input[type="date"]'), '2020-02-14');
    await submit();
    assert(currentCouple);
    const cancelledCode = currentCouple.invite_code;
    assert(document.body.textContent.includes('Waiting for Your Partner'));
    assert(!document.body.textContent.includes('Anniversary locked'));
    await fill(document.getElementById('pending-anniversary'), '2021-03-15');
    await submit();
    assert.equal(currentCouple.anniversary_date, '2021-03-15');
    dom.window.confirm = () => false;
    await click(button('Back to pairing options'));
    assert(currentCouple, 'declining cancellation retains the invite');
    dom.window.confirm = () => true;
    await click(button('Back to pairing options'));
    assert.equal(currentCouple, null);
    assert(button('Create') && button("Enter Partner's Code"));

    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, { name: 'Bob', location: null, timezone: 'Europe/London' });
    await assert.rejects(auth.joinCoupleWithCode(bob.id, cancelledCode), /Invalid or cancelled code/);
    const bobCouple = (await auth.createCouple(bob.id, '2022-04-01')).couple;
    await auth.signInWithEmail('alice@example.com', 'password');
    await click(button("Enter Partner's Code"));
    await fill(document.getElementById('invite-code'), ` ${bobCouple.invite_code.toLowerCase()} `);
    await submit();
    assert.equal(currentCouple.id, bobCouple.id);
    assert.equal((await auth.joinCoupleWithCode(alice.id, bobCouple.invite_code)).couple.id, bobCouple.id);
    await assert.rejects(auth.updatePendingAnniversary('2023-01-01'), /anniversary is locked/);
    await assert.rejects(auth.leavePendingCouple(), /partner has already joined/);
    const createdAt = (await auth.fetchProfile(alice.id)).created_at;
    await auth.saveOnboardingProfile(alice.id, { name: 'Alice Updated', location: null, timezone: 'Africa/Lagos' });
    const updated = await auth.fetchProfile(alice.id);
    assert.equal(updated.couple_id, bobCouple.id);
    assert.equal(updated.created_at, createdAt);
    const originalFrom = supabase.from;
    supabase.from = () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'Database unavailable' } }) }) }) });
    await assert.rejects(auth.fetchProfile(alice.id), /Database unavailable/);
    supabase.from = originalFrom;
    const third = (await auth.signUpWithEmail('third@example.com', 'password')).user;
    await auth.saveOnboardingProfile(third.id, { name: 'Third', location: null, timezone: 'UTC' });
    await assert.rejects(auth.joinCoupleWithCode(third.id, bobCouple.invite_code), /2 partners/);

    // Simulate Supabase's confirmation-required signup without a network request.
    supabase.auth.signUp = async () => ({ data: { user: { id: 'confirmed-later', email: 'new@example.com' }, session: null }, error: null });
    const { AuthView: ConfirmAuthView } = await server.ssrLoadModule('/src/components/auth/AuthView.tsx');
    let authenticated = false;
    await act(() => root.render(React.createElement(ConfirmAuthView, { key: 'confirm', onSuccess: () => { authenticated = true; } })));
    await fill(document.querySelector('input[type="email"]'), 'new@example.com');
    await fill(document.getElementById('password'), 'test-password');
    await submit();
    assert.equal(authenticated, false, 'signup without a session must not advance to pairing');
    assert(document.querySelector('[role="status"]').textContent.includes('confirm your account'));
    assert(button('Sign In'));

    unconfiguredServer = await createServer({
      server: { middlewareMode: true, hmr: false, ws: false },
      define: {
        'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(''),
        'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(''),
      },
    });
    const { default: UnconfiguredApp } = await unconfiguredServer.ssrLoadModule('/src/App.tsx');
    await act(async () => root.render(React.createElement(UnconfiguredApp)));
    assert(document.body.textContent.includes('Unable to connect to Nooki'));
    assert(document.body.textContent.includes('VITE_SUPABASE_URL'));
    assert.equal(document.querySelector('input'), null, 'unconfigured app never offers local signup');


  } finally {
    await act(() => root.unmount());
    await server.close();
    await unconfiguredServer?.close();
    await supabase.auth.dispose();
    await backend?.close();
    dom.window.close();
  }
});
