import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// The app re-renders all the time while a sheet is open — presence, the chat, a realtime
// nudge from the partner — and every render hands the sheet a fresh onClose. Opening the
// sheet must not depend on that: an effect keyed on onClose re-runs, pulls focus off the
// name field, and on a phone that shuts the keyboard mid-word.
test('typing the child’s name keeps the keyboard: re-renders never steal focus', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent']) {
    globalThis[key] = dom.window[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const { RaiseAChildModal } = await server.ssrLoadModule('/src/components/raisechild/RaiseAChildModal.tsx');

    const snapshot = {
      family: { id: 'family-1', status: 'setup', since: new Date().toISOString() },
      configured: true,
      config: {
        moments_per_chapter: 3, moments_young: 2, timeout_hours: 24, chapters_per_day: 1, gifts_per_day: 1,
      },
      setup: {
        name: null,
        look: {},
        catalog: [
          { slug: 'patient', label: 'Patient', blurb: 'You wait well.' },
          { slug: 'funny', label: 'Funny', blurb: 'You find the joke.' },
          { slug: 'warm', label: 'Warm', blurb: 'You make it easy.' },
        ],
        mine: [],
        partner_joined: true,
        partner_traits_ready: false,
        ready: false,
        content_ready: true,
      },
      me: { bond: { band: null, line: null }, is_lead: false },
      child: null,
      today: { moments: [], gift: null, can_age_up: false, age_up_hint: null },
      album: { count: 0 },
      letter: null,
    };
    const noop = async () => {};
    const state = {
      snapshot,
      loading: false,
      busy: false,
      error: null,
      album: [],
      albumLoading: false,
      clearError: () => {},
      refresh: noop,
      saveSetup: noop,
      vote: noop,
      decide: noop,
      toChat: async () => false,
      openGift: noop,
      ageUp: noop,
      loadAlbum: noop,
      reply: noop,
      startNewChild: noop,
    };

    // Every render builds a brand-new onClose, exactly as App's inline arrow does.
    const render = async () => {
      await act(async () => {
        root.render(React.createElement(RaiseAChildModal, {
          state,
          userName: 'Ana',
          partnerName: 'Ravi',
          onClose: () => {},
        }));
      });
    };

    await render();
    const field = () => document.querySelector('.raise-child-input');
    assert.ok(field(), 'the setup screen has a name field');
    const closeButton = document.querySelector('[aria-label="Close"]');
    assert.ok(closeButton, 'and a close button');
    assert.equal(document.activeElement, closeButton, 'opening the sheet still puts focus on Close');

    await act(async () => { field().focus(); });
    assert.equal(document.activeElement, field(), 'the field takes focus when tapped');

    // Ten parent renders happen while the keyboard is up.
    for (let tick = 0; tick < 10; tick += 1) await render();
    assert.equal(document.activeElement, field(), 'a re-render must not move focus off the name field');

    // And the letters land one at a time, with a render in between each one.
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    let typed = '';
    for (const letter of 'Mia') {
      typed += letter;
      await act(async () => {
        setter.call(field(), typed);
        field().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
      await render();
      assert.equal(document.activeElement, field(), `focus stays while typing “${typed}”`);
      assert.equal(field().value, typed, `the field keeps “${typed}”`);
    }

    // The rest of the sheet is untouched: three traits are still waiting to be chosen.
    assert.equal(document.body.textContent.includes('0 of 3 chosen.'), true);
    assert.equal(document.body.textContent.includes('A family, together'), true);
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
