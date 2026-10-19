import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { openGameTab } from './helpers/gameLibrary.mjs';

test('Word Wheel UI: library settings, lobby handshake, blank-filling board and result reveal', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'PointerEvent', 'KeyboardEvent']) {
    if (dom.window[key]) globalThis[key] = dom.window[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const { GamesView } = await server.ssrLoadModule('/src/components/games/GamesView.tsx');
    const { WordWheel } = await server.ssrLoadModule('/src/components/games/WordWheel.tsx');
    const calls = [];
    const games = {
      data: { matches: [], wins: {} }, error: null, busy: false, match: undefined,
      select: (id) => calls.push(['select', id]),
      start: (...args) => calls.push(['start', ...args]),
      startWordRound: (...args) => calls.push(['startWordRound', ...args]),
      readyWord: (...args) => calls.push(['readyWord', ...args]),
      submitWord: (...args) => { calls.push(['submitWord', ...args]); return Promise.resolve(); },
      refresh: () => {},
    };
    const button = (name) => [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === name);
    const render = (node) => act(async () => root.render(node));

    await render(React.createElement(GamesView, { games, userId: 'a', partnerName: 'Bob' }));
    assert(document.querySelector('[data-game-tab="word-wheel"]'), 'Word Wheel is in the games rail');
    await openGameTab(document, 'word-wheel', act);
    const card = document.querySelector('[data-game="word-wheel"]');
    assert(card, 'Word Wheel is in the games library');
    await act(async () => [...card.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Hard').click());
    await act(async () => [...card.querySelectorAll('button')].find((item) => item.textContent.trim() === '3 minutes').click());
    await act(async () => [...card.querySelectorAll('button')].at(-1).click());
    assert.deepEqual(calls.pop(), ['startWordRound', 'hard', 180], 'the card sends the chosen difficulty and clock');
    calls.length = 0;

    const words = ['picture', 'cut', 'it', 'up', 'tie', 'true'];
    const base = {
      id: 'word-1', game: 'word-wheel', player_x: 'a', player_o: 'b', turn_id: 'a', best_of: 1,
      round: 1, score_x: 0, score_o: 0, my_pick: null, partner_locked: false, finished: false,
      winner_id: null, rounds: [],
      word: {
        letters: 'ceiprtu', difficulty: 'easy', duration_seconds: 60, grand_word: 'picture',
        words, layout: [{ length: 7, count: 1 }, { length: 2, count: 2 }, { length: 3, count: 2 }, { length: 5, count: 1 }],
        words_total: words.length, status: 'waiting', start_at: null,
        server_now: new Date().toISOString(), created_by: 'a', winner_id: null,
        mine: { ready: false, ready_at: null, submitted: false, words: [], count: 0, finished_ms: null },
        partner: { ready: false, ready_at: null, submitted: false, words: [], count: 0, finished_ms: null },
      },
    };
    const renderWheel = (word) => render(React.createElement(WordWheel, {
      match: { ...base, word }, userId: 'a', partnerName: 'Bob', games,
      onExit: () => calls.push(['exit']),
    }));

    await renderWheel(base.word);
    assert(document.body.textContent.includes('Not ready yet'));
    assert(document.body.textContent.includes('6 words'));
    const readyButton = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('I’m ready'));
    assert(readyButton, 'the lobby asks each phone to ready up');
    await act(async () => readyButton.click());
    assert.deepEqual(calls.pop(), ['readyWord', 'word-1']);

    const running = {
      ...base.word,
      status: 'running', finished: false,
      start_at: new Date(Date.now() - 10_000).toISOString(),
      mine: { ...base.word.mine, ready: true, ready_at: new Date().toISOString() },
      partner: { ...base.word.partner, ready: true, ready_at: new Date().toISOString() },
    };
    await renderWheel(running);
    assert(document.querySelectorAll('.word-letter').length === 7, 'seven letters on the wheel');
    assert(document.querySelector('.word-group.is-grand'), 'the grand prize has its own blank row');
    assert(document.querySelectorAll('.word-slot').length === 6, 'every hidden word has a blank');
    assert(/Time left0:5[01]/.test(document.body.textContent), 'the clock uses the server start');

    const input = document.querySelector('#word-type-input');
    assert(input, 'a keyboard entry route exists alongside the swipe');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    await act(async () => {
      setValue.call(input, 'cut');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Check').click());
    const foundSlots = [...document.querySelectorAll('.word-slot.is-found')];
    assert.equal(foundSlots.length, 1, 'a correct word fills its blank');
    assert.equal(foundSlots[0].textContent.toUpperCase(), 'CUT');
    assert(document.querySelector('.word-message.is-correct'));

    await act(async () => button('⇄ Shuffle').click());
    await act(async () => button('💡 Hint · 2').click());
    assert(button('💡 Hint · 1'), 'a hint is spent once');

    await act(async () => {
      setValue.call(document.querySelector('#word-type-input'), 'zzzz');
      document.querySelector('#word-type-input').dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Check').click());
    assert(document.querySelector('.word-message.is-wrong'), 'a word that is not hidden is refused');
    assert.equal(document.querySelectorAll('.word-slot.is-found').length, 1, 'a wrong word fills nothing');

    const finished = {
      ...running, status: 'finished', winner_id: 'a',
      mine: { ...running.mine, submitted: true, words: ['picture', 'cut'], count: 2, finished_ms: 38_000 },
      partner: { ...running.partner, submitted: true, words: ['it'], count: 1, finished_ms: 40_000 },
    };
    await renderWheel(finished);
    assert(document.body.textContent.includes('You won!'));
    assert(document.body.textContent.includes('2/6'));
    assert(document.body.textContent.includes('1/6'));
    assert(document.body.textContent.includes('PICTURE') && document.body.textContent.includes('CUT'));
    bodyTextIncludes('0:38');
    await act(async () => button('Play again →').click());
    assert.deepEqual(calls.pop(), ['startWordRound', 'easy', 60]);

    calls.length = 0;
    const draw = {
      ...finished, winner_id: null,
      mine: { ...finished.mine, count: 2, finished_ms: 30_000 },
      partner: { ...finished.partner, count: 2, finished_ms: 30_000 },
    };
    await renderWheel(draw);
    assert(document.body.textContent.includes('A draw!'));
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }

  function bodyTextIncludes(text) {
    assert(document.body.textContent.includes(text), `expected the result to show ${text}`);
  }
});
