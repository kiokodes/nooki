import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Two parents, two suggestions, and one child who only exists once they agree. The screen
// has to show both ideas and offer a deliberate way across — never a quiet overwrite.
test('the setup screen shows both parents’ suggestions and only moves when asked', async () => {
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

    const MY_LOOK = { skin: 'warm-3', hair: 'curl-2', outfit: '#c98b6b' };
    const THEIR_LOOK = { skin: 'deep-4', hair: 'braid-1', outfit: '#7a9a8b' };
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
        mine: ['patient', 'funny', 'warm'],
        partner_joined: true,
        partner_traits_ready: true,
        ready: false,
        content_ready: true,
        proposal: {
          mine: { name: 'Mia', look: MY_LOOK },
          partner: { name: 'Noor', look: THEIR_LOOK },
          name_same: false,
          look_same: false,
          agreed: false,
          locked: false,
        },
      },
      me: { bond: { band: null, line: null }, is_lead: false },
      child: null,
      today: { moments: [], gift: null, can_age_up: false, age_up_hint: null },
      album: { count: 0 },
      letter: null,
    };

    const calls = [];
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
      saveSetup: async (input) => { calls.push(['save', input.name]); },
      adoptSetup: async (part) => { calls.push(['adopt', part]); },
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

    const text = () => document.body.textContent;
    const byAction = (action) => document.querySelector(`[data-action="${action}"]`);

    // Both suggestions are on screen, labelled by who made them.
    assert.ok(text().includes('Mia'), 'my suggestion is shown');
    assert.ok(text().includes('Noor'), 'and so is theirs');
    assert.ok(text().includes('Ravi'), 'the suggestion is attributed to the partner');
    assert.ok(byAction('use-partner-name'), 'moving to their name is offered');
    assert.ok(byAction('use-partner-look'), 'and so is moving to their face');
    assert.equal(text().includes('You both landed on'), false, 'nothing is settled while they differ');

    // The name field still holds my own suggestion, not theirs.
    assert.equal(document.querySelector('.raise-child-input').value, 'Mia');

    // Choosing is a click, never a side effect of seeing their idea.
    assert.deepEqual(calls, []);
    await act(async () => { byAction('use-partner-name').click(); });
    assert.deepEqual(calls, [['adopt', 'name']]);

    await act(async () => { byAction('use-partner-look').click(); });
    assert.deepEqual(calls, [['adopt', 'name'], ['adopt', 'look']]);

    // Saving sends my name as a suggestion, with the traits that are already chosen.
    const save = [...document.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === 'Save my suggestion');
    assert.ok(save, 'the button says what it does');
    await act(async () => { save.click(); });
    assert.deepEqual(calls.at(-1), ['save', 'Mia']);
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
