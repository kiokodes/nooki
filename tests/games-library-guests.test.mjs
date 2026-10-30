import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// The Games tab has one rail and one panel; nothing sits outside the carousel. Truth or
// Dare used to be its own card above the rail (a section of the page that was neither a
// game chip nor an ongoing match), and Raise a Child is a placeholder for the next game.
// These checks pin both of them inside the rail, and pin the placeholder honest: it can
// be read, but it cannot be started.
test('games library: Truth or Dare and Raise a Child are chips in the rail, never cards above it', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'PointerEvent', 'KeyboardEvent']) {
    if (dom.window[key]) globalThis[key] = dom.window[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const { GamesView } = await server.ssrLoadModule('/src/components/games/GamesView.tsx');
    const games = {
      data: { matches: [], wins: {} }, error: null, busy: false, match: undefined, pendingGame: null,
      select: () => {}, start: () => {}, play: () => {}, refresh: () => {},
    };
    const truthOrDare = {
      snapshot: {
        round: null,
        ages: { mine: { tier: 20, source: 'confirmation' }, partner: { tier: 18, source: 'confirmation' } },
        active_counts: {
          random: { truth: 20, dare: 20 },
          flirty: { truth: 20, dare: 20 },
          spicy: { truth: 0, dare: 0 },
        },
      },
      loading: false, busy: false, error: null,
      refresh: async () => {}, confirmAge: async () => {}, startRound: async () => {},
      acceptRound: async () => {}, choosePrompt: async () => {}, completePrompt: async () => {},
      pauseRound: async () => {}, resumeRound: async () => {}, endRound: async () => {},
    };
    const render = (state) => act(async () => root.render(
      React.createElement(GamesView, { games, userId: 'a', partnerName: 'Bob', truthOrDare: state }),
    ));
    const chip = (id) => document.querySelector(`[data-game-tab="${id}"]`);
    const panel = () => document.querySelector('[role="tabpanel"]');
    const button = (text) => [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === text);

    await render(truthOrDare);

    // Nothing outside the carousel: the tab is the swipeable card, the library is the rail.
    assert.equal(document.querySelector('.tod-launcher'), null, 'Truth or Dare is not a card of its own any more');
    const rail = document.querySelector('[data-game-rail]');
    assert.ok(chip('truth-or-dare'), 'Truth or Dare has a chip in the rail');
    assert.ok(chip('raise-a-child'), 'and Raise a Child has the next one');
    assert.equal(document.querySelectorAll('[role="tabpanel"]').length, 1, 'the tab still shows one panel at a time');
    const library = document.querySelector('.game-library');
    assert.deepEqual(
      [...document.querySelectorAll('.game-card')].filter((card) => !library.contains(card)),
      [],
      'every card on the tab lives inside the carousel, none sits above it',
    );

    // Truth or Dare's panel is the way in to its shared round.
    assert.equal(panel().querySelector('h2')?.textContent.includes('Raise a Child'), false);
    await act(async () => chip('truth-or-dare').click());
    assert.equal(chip('truth-or-dare').getAttribute('aria-selected'), 'true');
    assert.equal(panel().dataset.game, 'truth-or-dare', 'choosing the chip brings its own panel in');
    assert.ok(panel().textContent.includes('Take turns with playful questions'), 'the panel says what the game is');
    assert.equal(panel().querySelector('.game-rail-badge'), null);
    const open = button('Choose a theme →');
    assert.ok(open, 'with the call to action on it');
    assert.equal(open.disabled, false);

    await act(async () => open.click());
    assert.ok(document.querySelector('.tod-view'), 'the shared round opens from its chip');
    assert.equal(document.querySelector('[data-game-rail]'), null, 'and takes the tab over while it is played');
    assert.equal(document.querySelector('.games-view h1').textContent, 'Truth or Dare');
    await act(async () => button('← All games').click());
    assert.ok(chip('truth-or-dare'), 'leaving it comes back to the same rail');
    assert.equal(chip('truth-or-dare').getAttribute('aria-selected'), 'true', 'with the same chip still chosen');

    // An open round is named on the chip's panel, and the button resumes it.
    const round = {
      id: 'r1', couple_id: 'c1', theme: 'random', created_by: 'a', player_one: 'a', player_two: 'b',
      turn_id: 'a', status: 'active', accepted_by: ['a', 'b'], current_prompt: null, completed_count: 0,
      created_at: '', updated_at: '',
    };
    await render({ ...truthOrDare, snapshot: { ...truthOrDare.snapshot, round } });
    assert.equal(panel().querySelector('.tod-panel-status')?.textContent, 'Round in progress');
    assert.ok(button('Resume round →'), 'the round in progress is resumed from the panel');

    // Raise a Child is a reserved seat: readable, clearly unfinished, not playable.
    await act(async () => chip('raise-a-child').click());
    assert.equal(chip('raise-a-child').getAttribute('aria-selected'), 'true');
    assert.equal(panel().dataset.game, 'raise-a-child');
    assert.ok(panel().querySelector('h2').textContent.includes('Raise a Child'));
    assert.ok(panel().textContent.includes('placeholder'), 'the panel says it is a placeholder');
    assert.equal(chip('raise-a-child').querySelector('.game-rail-badge')?.textContent, 'Soon', 'the chip marks it as not ready');
    const comingSoon = panel().querySelector('.game-actions button');
    assert.equal(comingSoon.textContent.trim(), 'Coming soon');
    assert.equal(comingSoon.disabled, true, 'there is no way to start a game that has no rules yet');
    assert.equal(panel().querySelectorAll('.game-actions button').length, 1, 'and nothing else to tap');
    const sameRail = document.querySelector('[data-game-rail]');
    assert.equal(sameRail.getAttribute('role'), 'tablist', 'both guests ride the same rail');
    assert.ok(sameRail.contains(chip('raise-a-child')), 'the placeholder is a chip like any other');
    assert.ok(sameRail.contains(chip('truth-or-dare')));
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
