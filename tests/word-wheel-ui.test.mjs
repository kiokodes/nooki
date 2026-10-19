import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { openGameTab } from './helpers/gameLibrary.mjs';

test('Word Wheel UI: local practice, independent start lobby, board and multiplayer result', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'PointerEvent', 'KeyboardEvent']) {
    if (dom.window[key]) globalThis[key] = dom.window[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const originalFetch = globalThis.fetch;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const { GamesView } = await server.ssrLoadModule('/src/components/games/GamesView.tsx');
    const { WordWheel } = await server.ssrLoadModule('/src/components/games/WordWheel.tsx');
    const { needsMyMove } = await server.ssrLoadModule('/src/hooks/useGames.ts');
    const calls = [];
    const games = {
      data: { matches: [], wins: {} }, error: null, busy: false, match: undefined,
      select: (id) => calls.push(['select', id]),
      start: (...args) => calls.push(['start', ...args]),
      startWordRound: (...args) => calls.push(['startWordRound', ...args]),
      startWordAttempt: (...args) => calls.push(['startWordAttempt', ...args]),
      readyWord: (...args) => calls.push(['readyWord', ...args]),
      cancelWord: (...args) => calls.push(['cancelWord', ...args]),
      submitWord: (...args) => { calls.push(['submitWord', ...args]); return Promise.resolve(); },
      refresh: () => {},
    };
    const button = (name) => [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === name);
    const render = (node) => act(async () => root.render(node));
    const waitFor = async (predicate, message) => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (predicate()) return;
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      }
      assert.fail(message);
    };

    await render(React.createElement(GamesView, { games, userId: 'a', partnerName: 'Bob' }));
    assert(document.querySelector('[data-game-tab="word-wheel"]'), 'Word Wheel is in the games rail');
    await openGameTab(document, 'word-wheel', act);
    const card = document.querySelector('[data-game="word-wheel"]');
    assert(card, 'Word Wheel is in the games library');
    await act(async () => [...card.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Hard').click());
    await act(async () => [...card.querySelectorAll('button')].find((item) => item.textContent.trim() === '3 minutes').click());
    await act(async () => button('Challenge Bob asynchronously →').click());
    assert.deepEqual(calls.pop(), ['startWordRound', 'hard', 180], 'the challenge sends its selected settings');
    assert(button('Practice solo · not counted'), 'solo practice is offered separately from the challenge');

    // The local puzzle bank is bundled as a static asset. Stub its fetch to prove the
    // practice path works without invoking any multiplayer service method.
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => [{
        letters: 'ceiprtu',
        base_word: 'picture',
        packs: { hard: { '180': ['picture', 'cut', 'it'] } },
      }],
    });
    await act(async () => button('Practice solo · not counted').click());
    await waitFor(() => document.querySelector('.word-wheel') && document.querySelector('.word-timer'), 'local practice should open a live board');
    assert(document.body.textContent.includes('Solo practice'));
    assert(document.body.textContent.includes('Not counted'));
    assert.equal(calls.some(([name]) => ['startWordRound', 'startWordAttempt', 'submitWord'].includes(name)), false,
      'practice does not create or submit a multiplayer match');

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const findWord = async (word) => {
      const input = document.querySelector('#word-type-input');
      await act(async () => {
        setValue.call(input, word);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => button('Check').click());
    };
    await findWord('picture');
    await findWord('cut');
    await findWord('it');
    await waitFor(() => document.querySelector('.word-practice-result'), 'practice should finish locally');
    assert(document.body.textContent.includes('Practice is just for you'));
    assert.equal(calls.some(([name]) => name === 'submitWord'), false, 'practice results are not sent to Supabase');
    await act(async () => button('← All games').click());
    calls.length = 0;

    const words = ['picture', 'cut', 'it', 'up', 'tie', 'true'];
    const emptySide = () => ({
      started: false, started_at: null, ready: false, ready_at: null,
      submitted: false, words: [], count: 0, finished_ms: null,
    });
    const base = {
      id: 'word-1', game: 'word-wheel', player_x: 'a', player_o: 'b', turn_id: 'a', best_of: 1,
      round: 1, score_x: 0, score_o: 0, my_pick: null, partner_locked: false, finished: false,
      winner_id: null, rounds: [],
      word: {
        letters: 'ceiprtu', difficulty: 'easy', duration_seconds: 60, grand_word: 'picture',
        words, layout: [{ length: 7, count: 1 }, { length: 2, count: 2 }, { length: 3, count: 2 }, { length: 5, count: 1 }],
        words_total: words.length, status: 'waiting', start_at: null,
        server_now: new Date().toISOString(), created_by: 'a', winner_id: null,
        mine: emptySide(), partner: emptySide(),
      },
    };
    assert.equal(needsMyMove(base, 'a'), true, 'an unstarted multiplayer attempt is this player\'s move');
    const sweptAttempt = {
      ...base,
      word: { ...base.word, status: 'running', mine: { ...base.word.mine, submitted: true } },
    };
    assert.equal(needsMyMove(sweptAttempt, 'a'), false, 'a zero-filled never-started attempt is no longer actionable');

    const renderWheel = (word) => render(React.createElement(WordWheel, {
      match: { ...base, word }, userId: 'a', partnerName: 'Bob', games,
      onExit: () => calls.push(['exit']),
    }));

    await renderWheel(base.word);
    assert(document.body.textContent.includes('Not started yet'));
    assert(document.body.textContent.includes('6 words'));
    assert(document.body.textContent.includes('Your 1 minute clock starts when you tap below'));
    assert(!document.body.textContent.includes('both ready'), 'there is no shared-ready gate');
    const startButton = document.querySelector('[data-word-start-button]');
    assert(startButton, 'the lobby starts this phone only');
    await act(async () => startButton.click());
    assert.deepEqual(calls.pop(), ['startWordAttempt', 'word-1']);

    const myStartedAt = new Date(Date.now() - 10_000).toISOString();
    const running = {
      ...base.word,
      status: 'running', start_at: myStartedAt,
      mine: { ...base.word.mine, started: true, started_at: myStartedAt },
    };
    await renderWheel(running);
    assert.equal(document.querySelectorAll('.word-letter').length, 7, 'seven letters on the wheel');
    assert(document.querySelector('.word-group.is-grand'), 'the grand prize has its own blank row');
    assert.equal(document.querySelectorAll('.word-slot').length, 6, 'every hidden word has a blank');
    assert(/Time left0:5[01]/.test(document.body.textContent), 'the clock uses this player\'s personal start');
    assert(document.body.textContent.includes('Bob: not started'), 'the partner can still be unstarted');

    const partnerStarted = {
      ...running,
      partner: { ...base.word.partner, started: true, started_at: new Date().toISOString() },
    };
    await renderWheel(partnerStarted);
    assert(/Time left0:5[01]/.test(document.body.textContent), 'the partner\'s later start does not reset this clock');
    assert(document.body.textContent.includes('Bob: playing'));

    const input = document.querySelector('#word-type-input');
    assert(input, 'a keyboard entry route exists alongside the swipe');
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
      partner: { ...partnerStarted.partner, submitted: true, words: ['it'], count: 1, finished_ms: 40_000 },
    };
    await renderWheel(finished);
    assert(document.body.textContent.includes('You won!'));
    assert(document.body.textContent.includes('2/6'));
    assert(document.body.textContent.includes('1/6'));
    assert(document.body.textContent.includes('PICTURE') && document.body.textContent.includes('CUT'));
    assert(document.body.textContent.includes('0:38'));
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
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
