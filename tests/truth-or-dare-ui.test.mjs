import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Truth or Dare UI: Spicy stays locked for everyone while Flirty keeps its 18+ gate', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent']) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const root = createRoot(document.getElementById('root'));
  try {
    const { TruthOrDare } = await server.ssrLoadModule('/src/components/games/TruthOrDare.tsx');
    const calls = [];
    let game = {
      snapshot: {
        round: null,
        ages: {
          mine: { tier: 20, source: 'confirmation' },
          partner: { tier: 18, source: 'confirmation' },
        },
        active_counts: {
          random: { truth: 120, dare: 120 },
          flirty: { truth: 120, dare: 120 },
          spicy: { truth: 120, dare: 120 },
        },
      },
      loading: false,
      busy: false,
      error: null,
      refresh: async () => {},
      confirmAge: async (age) => calls.push(['confirmAge', age]),
      startRound: async (theme) => calls.push(['startRound', theme]),
      acceptRound: async (id) => calls.push(['acceptRound', id]),
      choosePrompt: async (id, type) => calls.push(['choosePrompt', id, type]),
      completePrompt: async (id, result) => calls.push(['completePrompt', id, result]),
      pauseRound: async (id) => calls.push(['pauseRound', id]),
      resumeRound: async (id) => calls.push(['resumeRound', id]),
      endRound: async (id) => calls.push(['endRound', id]),
    };
    const render = () => act(async () => root.render(React.createElement(TruthOrDare, {
      game, userId: 'a', partnerName: 'Sam', onExit: () => {},
    })));
    const button = (text) => [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === text);
    const themeButton = (label) => [...document.querySelectorAll('.tod-theme-option')]
      .find((item) => item.querySelector('strong')?.textContent === label);

    await render();
    const spicyOption = themeButton('Spicy');
    assert.equal(spicyOption.disabled, true, 'Spicy cannot be chosen, even by two 20+ partners');
    assert.match(spicyOption.textContent, /Locked/);
    assert.match(document.body.textContent, /marriage certificates/);
    await act(async () => spicyOption.click());
    assert.equal(themeButton('Random').getAttribute('aria-pressed'), 'true', 'the locked card does not change the selection');
    assert.equal(spicyOption.hasAttribute('aria-pressed'), false, 'a locked theme is never selected');
    assert.deepEqual(calls, [], 'tapping the locked card selects nothing');

    await act(async () => themeButton('Flirty').click());
    assert.equal(button('Start a round').disabled, false, 'both 18+ partners can unlock Flirty');
    await act(async () => button('Start a round').click());
    assert.deepEqual(calls.pop(), ['startRound', 'flirty']);

    game = {
      ...game,
      snapshot: {
        ...game.snapshot,
        ages: { mine: { tier: 0, source: 'missing' }, partner: { tier: 0, source: 'missing' } },
      },
    };
    await render();
    await act(async () => themeButton('Flirty').click());
    assert(document.querySelector('[role="dialog"]'), 'a missing DOB opens one-time age confirmation');
    assert.equal(button('I’m 20 or older'), undefined, 'there is no 20+ unlock path any more');
    await act(async () => button('I’m 18 or older').click());
    assert.deepEqual(calls.pop(), ['confirmAge', 18]);
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});

test('Truth or Dare UI: the turn owner chooses and can always skip, and round controls stay available', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent']) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const root = createRoot(document.getElementById('root'));
  try {
    const { TruthOrDare } = await server.ssrLoadModule('/src/components/games/TruthOrDare.tsx');
    const calls = [];
    const round = {
      id: 'r1', couple_id: 'c1', theme: 'random', created_by: 'a', player_one: 'a', player_two: 'b',
      turn_id: 'a', status: 'active', accepted_by: ['a', 'b'], current_prompt: null, completed_count: 0,
      created_at: '', updated_at: '',
    };
    const baseGame = {
      snapshot: {
        round,
        ages: { mine: { tier: 0, source: 'missing' }, partner: { tier: 0, source: 'missing' } },
        active_counts: { random: { truth: 2, dare: 2 }, flirty: { truth: 0, dare: 0 }, spicy: { truth: 0, dare: 0 } },
      },
      loading: false, busy: false, error: null,
      refresh: async () => {}, confirmAge: async () => {}, startRound: async () => {},
      acceptRound: async (id) => calls.push(['acceptRound', id]),
      choosePrompt: async (id, type) => calls.push(['choosePrompt', id, type]),
      completePrompt: async (id, result) => calls.push(['completePrompt', id, result]),
      pauseRound: async (id) => calls.push(['pauseRound', id]),
      resumeRound: async (id) => calls.push(['resumeRound', id]),
      endRound: async (id) => calls.push(['endRound', id]),
    };
    let game = baseGame;
    const render = () => act(async () => root.render(React.createElement(TruthOrDare, {
      game, userId: 'a', partnerName: 'Sam', onExit: () => {},
    })));
    const button = (text) => [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === text);

    await render();
    assert(button('Pause / end'), 'round control is visible during the turn');
    await act(async () => button('Truth').click());
    assert.deepEqual(calls.pop(), ['choosePrompt', 'r1', 'truth']);

    game = { ...baseGame, snapshot: { ...baseGame.snapshot, round: {
      ...round,
      current_prompt: { id: 'p1', type: 'truth', theme: 'random', intensity: 1, text: 'What helps you feel safe enough to be honest?', tags: ['trust'], mode: 'text' },
    } } };
    await render();
    assert.match(document.body.textContent, /What helps you feel safe enough to be honest/);
    assert(button('Skip'), 'Skip is available to the player whose turn it is');
    await act(async () => button('Skip').click());
    assert.deepEqual(calls.pop(), ['completePrompt', 'r1', 'skip']);
    assert.equal(document.body.textContent.toLowerCase().includes('shame'), false);

    game = { ...game, snapshot: { ...game.snapshot, round: { ...game.snapshot.round, turn_id: 'b' } } };
    await render();
    assert.equal(button('Skip'), undefined, 'the other phone waits for its partner to complete the prompt');
    assert(button('Pause / end'));
    await act(async () => button('Pause / end').click());
    assert(button('Pause round'));
    assert(button('End round'));
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});

test('Truth or Dare UI: a Spicy round left over from before the lock is closed, never played', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent']) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const root = createRoot(document.getElementById('root'));
  try {
    const { TruthOrDare } = await server.ssrLoadModule('/src/components/games/TruthOrDare.tsx');
    const calls = [];
    const round = {
      id: 'spicy-round', couple_id: 'c1', theme: 'spicy', created_by: 'a', player_one: 'a', player_two: 'b',
      turn_id: 'a', status: 'active', accepted_by: ['a', 'b'], current_prompt: null, completed_count: 0,
      created_at: '', updated_at: '',
    };
    const game = {
      snapshot: {
        round,
        ages: { mine: { tier: 20, source: 'date_of_birth' }, partner: { tier: 20, source: 'confirmation' } },
        active_counts: { random: { truth: 2, dare: 2 }, flirty: { truth: 2, dare: 2 }, spicy: { truth: 0, dare: 0 } },
      },
      loading: false, busy: false, error: null,
      refresh: async () => {}, confirmAge: async () => {}, startRound: async () => {},
      acceptRound: async () => {}, choosePrompt: async () => {}, completePrompt: async () => {},
      pauseRound: async () => {}, resumeRound: async () => {},
      endRound: async (id) => calls.push(['endRound', id]),
    };
    await act(async () => root.render(React.createElement(TruthOrDare, {
      game, userId: 'a', partnerName: 'Sam', onExit: () => {},
    })));
    const button = (text) => [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === text);

    assert.match(document.body.textContent, /This round is closed/);
    assert.match(document.body.textContent, /marriage verification/i);
    assert.equal(button('Truth'), undefined, 'the turn owner cannot deal a Spicy prompt');
    assert.equal(button('Start a round'), undefined);
    await act(async () => button('End round').click());
    assert.deepEqual(calls, [['endRound', 'spicy-round']], 'the only way out is to end the round');
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
