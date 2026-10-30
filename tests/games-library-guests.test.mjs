import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// The Games tab has one rail and one panel; no game gets a card of its own above the
// carousel. Truth or Dare used to be that card, so these checks pin it inside the rail:
// its chip's panel is the way into the shared round. Raise a Child is the opposite case —
// it is not a chip but its own reserved card, and it sits above the ongoing matches,
// readable but not startable until its rules exist.
test('games tab: Truth or Dare is a chip in the rail and Raise a Child its own card above the matches', async () => {
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
    // One live match, so the Ongoing games card is on the tab to place the placeholder against.
    const liveMatch = {
      id: 'm1', game: 'rock-paper-scissors', player_x: 'a', player_o: 'b', turn_id: 'a',
      best_of: 3, round: 1, score_x: 0, score_o: 0, my_pick: null, partner_locked: false,
      finished: false, winner_id: null, rounds: [],
    };
    const games = {
      data: { matches: [liveMatch], wins: {} }, error: null, busy: false, match: undefined, pendingGame: null,
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

    // Nothing outside the carousel except the placeholder's own card.
    assert.equal(document.querySelector('.tod-launcher'), null, 'Truth or Dare is not a card of its own any more');
    const library = document.querySelector('.game-library');
    assert.deepEqual(
      [...document.querySelectorAll('.game-card')]
        .filter((card) => !library.contains(card) && !card.classList.contains('ongoing-games'))
        .map((card) => card.dataset.card),
      ['raise-a-child'],
      'the only card outside the carousel is the reserved seat for the next game',
    );
    assert.equal(chip('raise-a-child'), null, 'and it is not a chip in the rail');
    assert.ok(chip('truth-or-dare'), 'Truth or Dare is a chip in the rail');
    assert.equal(document.querySelectorAll('[role="tabpanel"]').length, 1, 'the tab still shows one panel at a time');

    // The placeholder sits above the ongoing matches, dashed and unstartable.
    const placeholder = document.querySelector('[data-card="raise-a-child"]');
    assert.ok(placeholder.querySelector('h2').textContent.includes('Raise a Child'));
    assert.ok(placeholder.textContent.includes('still being written'), 'it says the rules are still being written');
    assert.equal(placeholder.getAttribute('role'), null, 'it is a card, not a tab panel');
    const comingSoon = placeholder.querySelector('.game-actions button');
    assert.equal(comingSoon.textContent.trim(), 'Coming soon');
    assert.equal(comingSoon.disabled, true, 'there is no way to start a game that has no rules yet');
    assert.ok(
      placeholder.compareDocumentPosition(document.querySelector('[data-ongoing-games]')) & 4,
      'the placeholder sits above the ongoing games',
    );

    // Truth or Dare's panel is the way in to its shared round.
    await act(async () => chip('truth-or-dare').click());
    assert.equal(chip('truth-or-dare').getAttribute('aria-selected'), 'true');
    assert.equal(panel().dataset.game, 'truth-or-dare', 'choosing the chip brings its own panel in');
    assert.ok(panel().textContent.includes('Take turns with playful questions'), 'the panel says what the game is');
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

    // The placeholder card is still there, and still unstartable, while the rail is used.
    assert.equal(document.querySelector('[data-card="raise-a-child"] .game-actions button').disabled, true);
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
