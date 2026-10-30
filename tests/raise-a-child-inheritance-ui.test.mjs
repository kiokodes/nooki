import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// The traits the two of you chose during setup have to show up in the child, and they have
// to stay visibly separate from the ones the years add — nobody should be able to mistake
// a decision for who the child was born as, or the other way round.
test('the child shows what they came with, apart from what they are becoming', async () => {
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
      family: { id: 'family-1', status: 'active', since: new Date().toISOString() },
      configured: true,
      config: {
        moments_per_chapter: 3, moments_young: 2, timeout_hours: 24, chapters_per_day: 1, gifts_per_day: 1,
      },
      setup: {
        name: 'Mia',
        look: { skin: '#E8C4A0', hair: 'curls', outfit: '#F9A8D4' },
        catalog: [{ slug: 'patient', label: 'Patient', blurb: 'You wait well.' }],
        mine: ['patient', 'funny', 'warm'],
        partner_joined: true,
        partner_traits_ready: true,
        ready: true,
        content_ready: true,
        proposal: {
          mine: { name: 'Mia', look: { skin: '#E8C4A0', hair: 'curls', outfit: '#F9A8D4' } },
          partner: { name: 'Mia', look: { skin: '#E8C4A0', hair: 'curls', outfit: '#F9A8D4' } },
          name_same: true,
          look_same: true,
          agreed: true,
          locked: true,
        },
      },
      me: { user_id: 'me', bond: { band: 'close', line: 'Mia looks for you first when the door opens.' }, is_lead: true },
      child: {
        name: 'Mia',
        look: { skin: '#E8C4A0', hair: 'curls', outfit: '#F9A8D4' },
        age: 4,
        mood: 'safe',
        traits: [
          { slug: 'kind', label: 'Kind' },
          { slug: 'curious', label: 'Curious' },
        ],
        age_label: '4 years old',
      },
      today: { moments: [], gift: null, can_age_up: false, age_up_hint: null },
      album: { count: 2 },
      letter: null,
      inheritance: {
        inherited: [
          { slug: 'patient', label: 'Patient', from_me: true },
          { slug: 'warm', label: 'Warm', from_me: true },
          { slug: 'funny', label: 'Funny', from_me: false },
        ],
        more_like: 'me',
        line: 'Mia has more of your traits.',
      },
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
      adoptSetup: noop,
      vote: noop,
      decide: noop,
      toChat: async () => false,
      openGift: noop,
      ageUp: noop,
      loadAlbum: noop,
      reply: noop,
      startNewChild: noop,
    };

    await act(async () => {
      root.render(React.createElement(RaiseAChildModal, {
        state,
        userName: 'Ana',
        partnerName: 'Ravi',
        onClose: () => {},
      }));
    });

    const body = document.querySelector('.raise-child-sheet__body');
    assert.ok(body, 'the sheet is showing the family');

    // Who they came with: three traits, two of them yours.
    const born = [...body.querySelectorAll('.raise-child-inherited__chip')];
    assert.deepEqual(born.map((chip) => chip.textContent), ['Patient', 'Warm', 'Funny']);
    assert.deepEqual(born.map((chip) => chip.dataset.fromMe), ['true', 'true', 'false']);
    assert.ok(body.textContent.includes('What they came with'), 'and it says what that list is');

    // The soft resemblance sentence, with no score anywhere near it.
    assert.ok(body.textContent.includes('Mia has more of your traits.'));
    assert.equal(/\b\d+\s*(of\s*3|traits?)\b/.test(body.textContent), false, 'no counts are shown');

    // What the years added stays a separate list.
    assert.ok(body.textContent.includes('Becoming'), 'the earned traits have their own heading');
    assert.deepEqual(
      [...body.querySelectorAll('.raise-child-trait')].map((chip) => chip.textContent),
      ['Kind', 'Curious'],
      'the growing traits never mix into the born-with ones',
    );
    assert.equal(body.querySelectorAll('.raise-child-traits .raise-child-inherited__chip').length, 0);

    // The bond still reads as language, not a number.
    assert.ok(body.textContent.includes('Mia looks for you first when the door opens.'));
    assert.equal(body.querySelectorAll('progress, meter').length, 0);
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
