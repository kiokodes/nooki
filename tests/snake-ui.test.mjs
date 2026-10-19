import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { openGameTab } from './helpers/gameLibrary.mjs';

/**
 * The Snake duel as the couple meets it: the card in the library, the gate that spells out
 * what entering means, the board itself, the question asked before a run is thrown away,
 * and the reveal once both runs are in. The board is driven by real time, so a couple of
 * the assertions here wait for the clock rather than for a click.
 */
test('snake UI: the gate, a playable board, the leave question, warm-ups and the reveal', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent']) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const root = createRoot(document.getElementById('root'));
  try {
    const { GamesView } = await server.ssrLoadModule('/src/components/games/GamesView.tsx');
    const { SnakeBoard } = await server.ssrLoadModule('/src/components/games/SnakeBoard.tsx');
    const calls = [];
    const foods = Array.from({ length: 40 }, (_, i) => ({ x: i % 20, y: 15 }));
    const duel = (snake, finished = false, winnerId = null) => ({
      id: 'duel-1', game: 'snake', player_x: 'a', player_o: 'b',
      board: Array(9).fill(''), turn_id: 'a', best_of: 3, round: 1, score_x: 0, score_o: 0,
      my_pick: null, partner_locked: false, finished, winner_id: winnerId, rounds: [], snake,
    });
    const games = (overrides = {}) => ({
      data: { today: '2026-10-15', wins: {}, matches: [] },
      error: null, busy: false, match: undefined, snakeLive: false, pendingCount: 0,
      select: (...args) => calls.push(['select', ...args]),
      start: (...args) => calls.push(['start', ...args]),
      startSnake: (...args) => calls.push(['startSnake', ...args]),
      beat: (...args) => calls.push(['beat', ...args]),
      finish: (...args) => calls.push(['finish', ...args]),
      forfeitSnake: (...args) => calls.push(['forfeitSnake', ...args]),
      play: (...args) => calls.push(['play', ...args]),
      refresh: () => {},
      ...overrides,
    });
    const render = (element) => act(async () => root.render(element));
    const button = (text) => [...document.querySelectorAll('button')].find((item) => item.textContent === text);
    const settle = async (ms) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
    const key = async (name) => { await act(async () => { window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name })); }); };
    const headCell = () => {
      const head = document.querySelector('.snake-head');
      assert.ok(head, 'the snake is on the board');
      return { x: Math.round(parseFloat(head.style.left) / 5), y: Math.round(parseFloat(head.style.top) / 5) };
    };

    // --- The library offers the duel, and a warm-up that never leaves the phone --------
    await render(React.createElement(GamesView, { games: games(), userId: 'a', partnerName: 'Bob' }));
    assert(document.body.textContent.includes('Snake Duel'), 'the game rail names the duel');
    await openGameTab(document, 'snake', act);
    assert(document.body.textContent.includes('One run each, highest score wins'), 'the rule is on the card');
    await act(async () => button('Duel Bob →').click());
    assert.deepEqual(calls.pop(), ['start', 'snake', 3]);
    await act(async () => button('Warm-up run (not counted)').click());
    assert(document.querySelector('.snake-board'), 'a warm-up board opens straight from the library');
    assert(document.body.textContent.includes('Not counted'), 'and says that it does not count');
    assert(document.body.textContent.includes('never reported, and it never scores'));
    await settle(200);
    assert.equal(calls.length, 0, 'a warm-up makes no calls at all');
    await act(async () => button('← End warm-up').click());
    assert.equal(document.querySelector('.snake-board'), null, 'ending it costs nothing');

    // --- The gate: what entering means, in plain words ---------------------------------
    calls.length = 0;
    await render(React.createElement(GamesView, { games: games({ match: duel({ mine: null, partner: { status: 'waiting', ended: null } }) }), userId: 'a', partnerName: 'Bob' }));
    const gate = document.querySelector('[data-snake-gate]');
    assert.ok(gate, 'an unplayed duel opens on its gate');
    for (const phrase of [
      'One run each. Highest score wins.',
      'there is no pause',
      'forfeit the duel to Bob',
      'Go quiet for 30 seconds',
      'One attempt each',
      "Bob hasn't played yet.",
    ]) assert(gate.textContent.includes(phrase), `the gate says "${phrase}"`);
    await act(async () => button('Start my run').click());
    assert.deepEqual(calls.pop(), ['startSnake', 'duel-1']);

    // --- A live run: the board plays, the keyboard steers, leaving is questioned --------
    calls.length = 0;
    const live = games({
      match: duel({
        mine: { status: 'running', score: 0, ticks: 0, dirs: [], foods: foods.map(({ x, y }) => [x, y]), started_at: '2026-10-15T10:00:00Z', last_seen: '2026-10-15T10:00:00Z', deadline: '2026-10-15T10:04:00Z', ended: null },
        partner: { status: 'waiting', ended: null },
      }),
      snakeLive: true,
    });
    await render(React.createElement(GamesView, { games: live, userId: 'a', partnerName: 'Bob' }));
    const start = headCell();
    assert.equal(start.x, 10);
    assert.equal(start.y, 10);
    assert(document.querySelector('.snake-food'), 'the dealt food is on the board');
    await settle(400);
    assert.ok(headCell().x > start.x, 'the snake moves on its own once the run is live');
    const beforeTurn = headCell();
    await key('ArrowUp');
    await settle(300);
    const turned = headCell();
    assert.ok(turned.x <= beforeTurn.x + 1, 'the turn took it straight up, not across');
    assert.ok(turned.y < beforeTurn.y, 'and it is climbing');
    // A reversal is not a move: the snake carries on in the same direction.
    const before = headCell();
    await key('ArrowDown');
    await settle(200);
    assert.ok(headCell().y <= before.y, 'turning back into its own neck is ignored');
    assert(document.body.textContent.includes('No pause, ever'));

    await act(async () => button('← Leave run (forfeits)').click());
    assert(document.querySelector('.snake-leave'), 'walking out asks first');
    assert(document.querySelector('.snake-board'), 'and the snake keeps moving behind the question');
    assert(document.body.textContent.includes('Bob wins this duel straight away'));
    await act(async () => { document.querySelector('.snake-leave').click(); });
    assert(document.querySelector('.snake-leave'), 'and a stray tap on the scrim keeps the run too');
    await act(async () => button('Keep playing').click());
    assert.equal(document.querySelector('.snake-leave'), null);
    assert.equal(calls.filter(([name]) => name === 'forfeitSnake').length, 0, 'keeping the run forfeits nothing');
    await act(async () => button('← Leave run (forfeits)').click());
    await act(async () => button('Leave and forfeit').click());
    assert.deepEqual(calls.find(([name]) => name === 'forfeitSnake'), ['forfeitSnake', 'duel-1']);

    // --- The run that is in, waiting on the partner: sealed, with no score on screen ---
    calls.length = 0;
    await render(React.createElement(GamesView, {
      games: games({ match: duel({ mine: { status: 'done', score: 12, ended: 'wall' }, partner: { status: 'done', score: 41, ended: 'self' } }) }),
      userId: 'a',
      partnerName: 'Bob',
    }));
    const waiting = document.querySelector('[data-snake-waiting="me"]');
    assert.ok(waiting);
    assert(waiting.textContent.includes('Your run is in: 12 food'));
    assert.equal(waiting.textContent.includes('41'), false, "the partner's score is nowhere on screen");
    await act(async () => button('Warm up while you wait').click());
    assert(document.querySelector('.snake-board'), 'and a warm-up is offered while waiting');

    // --- Finished: both scores, who won, and why ---------------------------------------
    await render(React.createElement(GamesView, {
      games: games({ match: duel({ mine: { status: 'done', score: 12, ended: 'wall' }, partner: { status: 'done', score: 41, ended: 'self' } }, true, 'b') }),
      userId: 'a',
      partnerName: 'Bob',
    }));
    const result = document.querySelector('[data-snake-result="finished"]');
    assert.ok(result);
    assert(result.textContent.includes('Bob won the duel'));
    assert.equal(document.querySelector('[data-snake-score-you]').textContent, '12');
    assert.equal(document.querySelector('[data-snake-score-partner]').textContent, '41');
    assert(result.textContent.includes('hit the wall'));
    await act(async () => button('Start a new duel').click());
    assert.deepEqual(calls.pop(), ['start', 'snake', 3]);

    // --- Winning your own way, and the forfeit reveal ----------------------------------
    await render(React.createElement(GamesView, {
      games: games({ match: duel({ mine: { status: 'done', score: 30, ended: 'cap' }, partner: { status: 'forfeit', score: 4, ended: 'forfeit' } }, true, 'a') }),
      userId: 'a',
      partnerName: 'Bob',
    }));
    assert(document.querySelector('[data-snake-result="finished"]').textContent.includes('You won the duel'));
    assert(document.body.textContent.includes('Bob left the run'));

    // --- The board stops the moment the server no longer counts the run -----------------
    await render(React.createElement(SnakeBoard, { foods, warmUp: false, live: false, onExit: () => {} }));
    const frozen = headCell();
    await settle(400);
    assert.deepEqual(headCell(), frozen, 'a settled run stops moving');

    // --- Progress reports carry only the turns the snake actually took ------------------
    calls.length = 0;
    await act(async () => { root.unmount(); });
    const root2 = createRoot(document.getElementById('root'));
    await act(async () => root2.render(React.createElement(SnakeBoard, {
      foods,
      warmUp: false,
      live: true,
      onBeat: (ticks, changes) => { calls.push(['beat', ticks, changes]); return Promise.resolve(); },
      onFinish: (ticks, changes) => { calls.push(['finish', ticks, changes]); return Promise.resolve(); },
      onExit: () => {},
    })));
    // Steer a little so the run survives past the first two-second report: the board
    // starts in the middle pointing at the right-hand wall.
    await key('ArrowUp');
    await settle(700);
    await key('ArrowLeft');
    await settle(1500);
    const beat = calls.find(([name]) => name === 'beat');
    assert.ok(beat, 'the board reports in while the run is live');
    assert.ok(beat[1] > 0, 'and the report carries how far it has got');
    assert.ok(beat[2].every((change) => change.tick < beat[1] && ['up', 'down', 'left', 'right'].includes(change.dir)), 'with a well-formed history');
    assert.ok(calls.filter(([name]) => name === 'beat').every(([, ticks]) => ticks > 0));
    await act(async () => root2.unmount());

    // --- A steer made while a report is on the wire is not lost -------------------------
    // The snake keeps moving while the report travels, and the queue it holds is the live
    // one. Count the queue after the round trip instead of before and every steer made in
    // those few hundred milliseconds is dropped — which leaves the server replaying a run
    // that was never played, and scoring it accordingly.
    calls.length = 0;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const root2b = createRoot(document.getElementById('root'));
    await act(async () => root2b.render(React.createElement(SnakeBoard, {
      foods,
      warmUp: false,
      live: true,
      onBeat: (ticks, changes) => { calls.push(['beat', ticks, changes]); return ticks > 0 ? held : Promise.resolve(); },
      onFinish: () => Promise.resolve(),
      onExit: () => {},
    })));
    // Steer a little so the run is still alive when the second report goes out: the board
    // starts in the middle pointing at the right-hand wall.
    await key('ArrowUp');
    await settle(700);
    await key('ArrowLeft');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1500)); });
    assert.equal(calls.length, 1, 'a report is on the wire');
    await key('ArrowDown');                        // ...and the player keeps playing under it
    await settle(200);
    await act(async () => { release(); });
    await settle(2200);
    const secondBeat = calls.filter(([name]) => name === 'beat')[1];
    assert.ok(secondBeat, 'the board reports in again');
    assert.ok(secondBeat[2].some((change) => change.dir === 'down'),
      'and the steer made mid-flight is in it, not quietly dropped');
    await act(async () => root2b.unmount());

    // --- A crash is a score even when the phone cannot reach the server ----------------
    // The leave question itself is owned by SnakeDuel and checked above; this is the one
    // case it does not cover, because the run is over rather than abandoned.
    calls.length = 0;
    let finishTries = 0;
    const root3 = createRoot(document.getElementById('root'));
    await act(async () => root3.render(React.createElement(SnakeBoard, {
      foods,
      warmUp: false,
      live: true,
      onBeat: () => Promise.resolve(),
      onFinish: (ticks, changes) => {
        finishTries += 1;
        calls.push(['finish', ticks, changes]);
        return finishTries < 2 ? Promise.reject(new Error('offline')) : Promise.resolve();
      },
      onExit: () => {},
    })));
    // Nothing steerable stands between the snake and the wall it is already heading for,
    // so the run ends on its own and the very first report is the one that fails.
    await settle(2600);
    assert.equal(finishTries, 1, 'the ending is reported once');
    assert.equal(calls[0][0], 'finish', 'as a finished run');
    assert.ok(calls[0][1] > 0, 'with the ticks it reached');
    assert.equal(document.body.textContent.includes('Saving your score'), true, 'the couple is told it is saving');
    await settle(2400);
    assert.equal(finishTries >= 2, true, 'and a failed report is retried');
    assert.equal(document.body.textContent.includes('Saving your score'), false, 'until the score is in');
    await act(async () => root3.unmount());
  } finally {
    await server.close();
    dom.window.close();
  }
});

/**
 * The development preview's Games tab: the same board, played out on the page, because the
 * real duel's score comes from the database. It should still be the real experience — gate,
 * rules, no pause, leaving is a forfeit — so that is what this drives.
 */
test('snake preview: the sample duel plays, and leaving it forfeits to the sample partner', async () => {
  // jsdom applies no stylesheets from a Vite module graph, so this one rule is checked in
  // the source: the preview renders the real board and leave question directly, and those
  // components are positioned entirely by games.css. Drop the import and the preview shows
  // a heap of absolutely-positioned squares instead of a snake.
  const previewSource = await readFile(new URL('../src/preview/PreviewSnake.tsx', import.meta.url), 'utf8');
  assert.match(previewSource, /import '\.\.\/components\/games\/games\.css'/, 'the preview loads the games stylesheet');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent']) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const root = createRoot(document.getElementById('root'));
  try {
    const { AppPreview } = await server.ssrLoadModule('/src/preview/AppPreview.tsx');
    await act(async () => root.render(React.createElement(AppPreview)));
    const settle = async (ms) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
    const waitFor = async (predicate, message) => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (await predicate()) return;
        await settle(10);
      }
      assert.fail(message);
    };
    const gamesTab = () => [...document.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === 'Games');
    const buttonText = (text) => [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === text);

    await waitFor(() => document.querySelector('[data-card="today"]'), 'the preview should open on Home');
    assert(gamesTab(), 'the preview nav offers Games');
    await act(async () => { gamesTab().click(); });
    // The tab head is the real thing: the eyebrow, the swipeable Ongoing games card and
    // the last duel's history row — the same components the app renders, so the preview
    // cannot drift from the Games tab it stands in for.
    assert.equal(document.querySelector('.games-eyebrow').textContent, 'A little lovers rivalry');
    const ongoing = document.querySelector('[data-ongoing-games]');
    assert.ok(ongoing, 'the preview shows the Ongoing games card');
    assert.equal(ongoing.querySelectorAll('[data-ongoing-slide]').length, 3, 'with the sample matches to swipe');
    assert(document.querySelector('[data-last-duel]'), 'and the last duel below, as history');
    // The Games tab shows one duel at a time, and it opens on Tetris: ask for Snake.
    await act(async () => { document.querySelector('[data-preview-game="snake"]').click(); });
    const gate = document.querySelector('[data-preview-snake="gate"]');
    assert(gate, 'the sample duel opens on its gate');
    assert(gate.textContent.includes('No pause, ever'), 'and says there is no pause');
    assert(gate.textContent.includes('forfeit the duel to Ana'), 'and who takes the duel if you leave');
    assert(document.body.textContent.includes('the real duel is scored by the database'), 'and that this one is a preview');

    await act(async () => buttonText('Start my run').click());
    assert(document.querySelector('.snake-board'), 'the board opens');
    await settle(300);
    assert(document.querySelector('.snake-head'), 'with a moving snake on it');

    await act(async () => buttonText('← Leave run (forfeits)').click());
    assert(document.querySelector('.snake-leave'), 'leaving asks first, even here');
    await act(async () => buttonText('Leave and forfeit').click());
    await waitFor(() => document.querySelector('[data-preview-snake="waiting"]'), 'the run is over and Ana is playing');
    await waitFor(() => document.querySelector('[data-preview-snake="result"]'), 'and the reveal lands');
    assert(document.body.textContent.includes('You left the run — Ana wins'), 'a forfeit is a loss');
  } finally {
    await act(() => root.unmount());
    await server.close();
    dom.window.close();
  }
});
