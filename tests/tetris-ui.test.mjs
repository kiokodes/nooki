import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

/**
 * The Tetris duel as the couple meets it: the card in the library with its two ways of
 * settling, the gate that spells out what entering means, the board itself with the
 * controls a phone actually has, the question asked before a run is thrown away, and the
 * reveal once both runs are in. The board is driven by real time, so a couple of the
 * assertions here wait for the clock rather than for a click.
 */
test('tetris UI: the gate, a playable board, the leave question, warm-ups and the reveal', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent']) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const root = createRoot(document.getElementById('root'));
  try {
    const { GamesView } = await server.ssrLoadModule('/src/components/games/GamesView.tsx');
    const { TetrisBoard } = await server.ssrLoadModule('/src/components/games/TetrisBoard.tsx');
    const calls = [];
    const pieces = new Array(600).fill(0);          // every piece a bar, so a turn is obvious
    const duel = (tetris, finished = false, winnerId = null) => ({
      id: 'duel-1', game: 'tetris', daily_date: null, player_x: 'a', player_o: 'b',
      board: Array(9).fill(''), turn_id: 'a', best_of: 3, round: 1, score_x: 0, score_o: 0,
      my_pick: null, partner_locked: false, finished, winner_id: winnerId, rounds: [], tetris,
    });
    const games = (overrides = {}) => ({
      data: { today: '2026-10-15', wins: {}, matches: [] },
      error: null, busy: false, match: undefined, duelLive: null, pendingCount: 0,
      select: (...args) => calls.push(['select', ...args]),
      start: (...args) => calls.push(['start', ...args]),
      startTetris: (...args) => calls.push(['startTetris', ...args]),
      startTetrisDuel: (...args) => calls.push(['startTetrisDuel', ...args]),
      beatTetris: (...args) => calls.push(['beatTetris', ...args]),
      finishTetris: (...args) => calls.push(['finishTetris', ...args]),
      forfeitTetris: (...args) => calls.push(['forfeitTetris', ...args]),
      play: (...args) => calls.push(['play', ...args]),
      refresh: () => {},
      ...overrides,
    });
    const render = (element) => act(async () => root.render(element));
    const button = (text) => [...document.querySelectorAll('button')].find((item) => item.textContent === text);
    const settle = async (ms) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
    const key = async (name) => { await act(async () => { window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name })); }); };
    /** The four cells of the piece in play, as well columns and rows. */
    const pieceCells = () => [...document.querySelectorAll('.tetris-board .tetris-cell:not(.tetris-ghost)')]
      .map((cell) => ({ x: Math.round(parseFloat(cell.style.left) / 10), y: Math.round(parseFloat(cell.style.top) / (100 / 16)) }));
    const settledCells = () => document.querySelectorAll('.tetris-settled:not(.tetris-empty)').length;

    // --- The library offers the duel in both modes, and a warm-up that never leaves ----
    await render(React.createElement(GamesView, { games: games(), userId: 'a', partnerName: 'Bob' }));
    assert(document.body.textContent.includes('Tetris Duel'));
    assert(document.body.textContent.includes('Five minutes each, same pieces'), 'the rule is on the card');
    const tetrisCard = [...document.querySelectorAll('article')].find((card) => card.textContent.includes('Tetris Duel'));
    const picker = [...tetrisCard.querySelectorAll('button')].filter((item) => item.dataset.tetrisModeOption);
    assert.deepEqual(picker.map((item) => item.dataset.tetrisModeOption), ['sprint', 'survival'], 'both modes are offered');
    // Both duels invite you the same way, so the button has to be found inside the card.
    const cardButton = (text) => [...tetrisCard.querySelectorAll('button')].find((item) => item.textContent === text);
    await act(async () => cardButton('Duel Bob →').click());
    assert.deepEqual(calls.pop(), ['startTetrisDuel', 'sprint'], 'and the duel starts in the chosen mode');
    await act(async () => picker[1].click());
    await act(async () => cardButton('Duel Bob →').click());
    assert.deepEqual(calls.pop(), ['startTetrisDuel', 'survival']);
    await act(async () => [...tetrisCard.querySelectorAll('button')].at(-1).click());
    assert(document.querySelector('.tetris-board'), 'a warm-up board opens straight from the library');
    assert(document.body.textContent.includes('Not counted'), 'and says that it does not count');
    assert(document.body.textContent.includes('never reported, and it never scores'));
    await settle(200);
    assert.equal(calls.length, 0, 'a warm-up makes no calls at all');
    await act(async () => button('← End warm-up').click());
    assert.equal(document.querySelector('.tetris-board'), null, 'ending it costs nothing');

    // --- The gate: what entering means, in plain words ---------------------------------
    calls.length = 0;
    await render(React.createElement(GamesView, {
      games: games({ match: duel({ mode: 'sprint', mine: null, partner: { status: 'waiting', ended: null } }) }),
      userId: 'a',
      partnerName: 'Bob',
    }));
    const gate = document.querySelector('[data-tetris-gate]');
    assert.ok(gate, 'an unplayed duel opens on its gate');
    for (const phrase of [
      'Highest score in five minutes',
      'no pause',
      'You both play the same pieces',
      'forfeit the duel to Bob',
      'Go quiet for 30 seconds',
      "Bob hasn't played yet.",
    ]) assert(gate.textContent.includes(phrase), `the gate says "${phrase}"`);
    await act(async () => button('Start my 5 minutes').click());
    assert.deepEqual(calls.pop(), ['startTetris', 'duel-1']);

    // The survival gate reads differently, because what it asks of you is different.
    await render(React.createElement(GamesView, {
      games: games({ match: duel({ mode: 'survival', mine: null, partner: { status: 'waiting', ended: null } }) }),
      userId: 'a',
      partnerName: 'Bob',
    }));
    assert(document.querySelector('[data-tetris-gate]').textContent.includes('Last one stacking wins'));
    assert(document.body.textContent.includes('keeps stacking longer wins'));

    // --- A live run: the board plays, the pad steers, leaving is questioned -------------
    calls.length = 0;
    const live = games({
      match: duel({
        mode: 'sprint',
        mine: {
          status: 'running', score: 0, lines: 0, ticks: 0, inputs: [], pieces,
          started_at: '2026-10-15T10:00:00Z', last_seen: '2026-10-15T10:00:00Z',
          deadline: '2026-10-15T10:05:00Z', ended: null,
        },
        partner: { status: 'waiting', ended: null },
      }),
      duelLive: 'tetris',
    });
    await render(React.createElement(GamesView, { games: live, userId: 'a', partnerName: 'Bob' }));
    assert.equal(document.querySelectorAll('.tetris-settled').length, 160, 'the whole well is drawn');
    assert.equal(settledCells(), 0, 'and it starts empty');
    assert.equal(document.querySelectorAll('.tetris-ghost').length, 4, 'with a shadow under the piece');
    assert.ok(document.querySelector('.tetris-next-box').children.length === 4, 'and the next piece is shown');
    const opening = pieceCells();
    assert.equal(opening.length, 4, 'a piece is in play');
    assert.deepEqual([...new Set(opening.map((cell) => cell.y))], [1], 'the bar arrives flat, near the top');
    assert.equal(Math.min(...opening.map((cell) => cell.x)), 3);

    // Gravity alone: fifteen ticks to a row, and the clock is the only thing pushing it.
    await settle(900);
    assert.ok(Math.min(...pieceCells().map((cell) => cell.y)) > 1, 'the piece falls on its own');

    // The pad is the only control a phone has, and every one of it works.
    const across = Math.min(...pieceCells().map((cell) => cell.x));
    await act(async () => document.querySelector('[aria-label="Move left"]').click());
    await settle(60);
    assert.equal(Math.min(...pieceCells().map((cell) => cell.x)), across - 1, 'left is left');
    await key('ArrowRight');
    await settle(60);
    assert.equal(Math.min(...pieceCells().map((cell) => cell.x)), across, 'and the keyboard works too');

    // A turn stands the bar up: four columns wide becomes four rows tall.
    await act(async () => document.querySelector('[aria-label="Turn the piece"]').click());
    await settle(60);
    const turned = pieceCells();
    assert.equal(new Set(turned.map((cell) => cell.x)).size, 1, 'the bar is standing up');
    assert.equal(new Set(turned.map((cell) => cell.y)).size, 4);

    // Slam, and the piece is part of the well — the four cells behind it are redrawn.
    await act(async () => document.querySelector('[aria-label="Slam the piece down"]').click());
    await settle(60);
    assert.equal(settledCells(), 4, 'the slammed piece is in the well now');
    assert.equal(document.querySelector('[data-tetris-score]').textContent, '0');

    assert(document.body.textContent.includes('No pause, ever'));
    await act(async () => button('← Leave run (forfeits)').click());
    assert(document.querySelector('.snake-leave'), 'walking out asks first');
    assert(document.querySelector('.tetris-board'), 'and the clock keeps running behind the question');
    assert(document.body.textContent.includes('Bob wins this duel straight away'));
    await act(async () => button('Keep playing').click());
    assert.equal(document.querySelector('.snake-leave'), null);
    assert.equal(calls.filter(([name]) => name === 'forfeitTetris').length, 0, 'keeping the run forfeits nothing');
    await act(async () => button('← Leave run (forfeits)').click());
    await act(async () => button('Leave and forfeit').click());
    assert.deepEqual(calls.find(([name]) => name === 'forfeitTetris'), ['forfeitTetris', 'duel-1']);

    // --- The run that is in, waiting on the partner: sealed, with no score on screen ----
    calls.length = 0;
    await render(React.createElement(GamesView, {
      games: games({ match: duel({ mode: 'sprint', mine: { status: 'done', score: 900, lines: 6, ticks: 6000, ended: 'cap' }, partner: { status: 'done', score: 4100, lines: 40, ticks: 6000, ended: 'cap' } }) }),
      userId: 'a',
      partnerName: 'Bob',
    }));
    const waiting = document.querySelector('[data-tetris-waiting="me"]');
    assert.ok(waiting);
    assert(waiting.textContent.includes('Your run is in: 900 points'));
    assert(waiting.textContent.includes('6 lines'));
    assert.equal(waiting.textContent.includes('4100'), false, "the partner's score is nowhere on screen");
    await act(async () => button('Warm up while you wait').click());
    assert(document.querySelector('.tetris-board'), 'and a warm-up is offered while waiting');

    // --- Finished: both scores, who won, and why ---------------------------------------
    await render(React.createElement(GamesView, {
      games: games({ match: duel({ mode: 'sprint', mine: { status: 'done', score: 900, lines: 6, ticks: 6000, ended: 'cap' }, partner: { status: 'done', score: 4100, lines: 40, ticks: 6000, ended: 'top' } }, true, 'b') }),
      userId: 'a',
      partnerName: 'Bob',
    }));
    const result = document.querySelector('[data-tetris-result="finished"]');
    assert.ok(result);
    assert(result.textContent.includes('Bob won the duel'));
    assert.equal(document.querySelector('[data-tetris-score-you]').textContent, '900');
    assert.equal(document.querySelector('[data-tetris-score-partner]').textContent, '4100');
    assert(result.textContent.includes('the well filled up'), 'and it says how their run ended');
    await act(async () => button('Start a new duel').click());
    assert.deepEqual(calls.pop(), ['startTetrisDuel', 'sprint']);

    // --- Survival is settled on stacking time, and says so ------------------------------
    await render(React.createElement(GamesView, {
      games: games({ match: duel({ mode: 'survival', mine: { status: 'done', score: 900, lines: 6, ticks: 6000, ended: 'cap' }, partner: { status: 'done', score: 4100, lines: 40, ticks: 2400, ended: 'top' } }, true, 'a') }),
      userId: 'a',
      partnerName: 'Bob',
    }));
    const survived = document.querySelector('[data-tetris-result="finished"]');
    assert(survived.textContent.includes('You won the duel'), 'the longer run wins, not the bigger score');
    assert(survived.textContent.includes('Last one stacking wins'));
    assert(survived.textContent.includes('300s'), 'and the reveal shows how long each of you lasted');
    assert(survived.textContent.includes('120s'));

    // --- Winning your own way, and the forfeit reveal -----------------------------------
    await render(React.createElement(GamesView, {
      games: games({ match: duel({ mode: 'sprint', mine: { status: 'done', score: 300, lines: 3, ticks: 6000, ended: 'cap' }, partner: { status: 'forfeit', score: 40, lines: 0, ticks: 900, ended: 'forfeit' } }, true, 'a') }),
      userId: 'a',
      partnerName: 'Bob',
    }));
    assert(document.querySelector('[data-tetris-result="finished"]').textContent.includes('You won the duel'));
    assert(document.body.textContent.includes('Bob left the run'));

    // --- The board stops the moment the server no longer counts the run -----------------
    await render(React.createElement(TetrisBoard, { pieces, warmUp: false, live: false, onExit: () => {} }));
    const frozen = pieceCells();
    await settle(900);
    assert.deepEqual(pieceCells(), frozen, 'a settled run stops moving');

    // --- Progress reports carry only the taps the player actually made ------------------
    calls.length = 0;
    await act(async () => { root.unmount(); });
    const root2 = createRoot(document.getElementById('root'));
    await act(async () => root2.render(React.createElement(TetrisBoard, {
      pieces,
      warmUp: false,
      live: true,
      onBeat: (ticks, inputs) => { calls.push(['beat', ticks, inputs]); return Promise.resolve(); },
      onFinish: (ticks, inputs) => { calls.push(['finish', ticks, inputs]); return Promise.resolve(); },
      onExit: () => {},
    })));
    await act(async () => document.querySelector('[aria-label="Turn the piece"]').click());
    await settle(700);
    await act(async () => document.querySelector('[aria-label="Move left"]').click());
    await settle(1900);
    const beat = calls.find(([name]) => name === 'beat');
    assert.ok(beat, 'the board reports in while the run is live');
    assert.ok(beat[1] > 0, 'and the report carries how far it has got');
    assert.ok(beat[2].every((input) => input.tick < beat[1] && ['left', 'right', 'rotate', 'down', 'drop'].includes(input.action)),
      'with a well-formed history');
    assert.ok(beat[2].some((input) => input.action === 'rotate'), 'including the turn that was tapped');
    assert.ok(calls.filter(([name]) => name === 'beat').every(([, ticks]) => ticks > 0));
    await act(async () => root2.unmount());

    // --- A tap made while a report is on the wire is not lost ---------------------------
    // The board keeps playing while the report travels, and the queue it holds is the live
    // one. Count the queue after the round trip instead of before and every tap made in
    // those few hundred milliseconds is dropped — which leaves the server replaying a run
    // that was never played, and scoring it accordingly.
    calls.length = 0;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const root3 = createRoot(document.getElementById('root'));
    await act(async () => root3.render(React.createElement(TetrisBoard, {
      pieces,
      warmUp: false,
      live: true,
      onBeat: (ticks, inputs) => { calls.push(['beat', ticks, inputs]); return ticks > 0 ? held : Promise.resolve(); },
      onExit: () => {},
    })));
    await settle(2200);                            // the first report goes out and hangs
    assert.equal(calls.length, 1, 'a report is on the wire');
    await act(async () => document.querySelector('[aria-label="Turn the piece"]').click());
    await settle(200);                             // ...and the player keeps playing under it
    await act(async () => { release(); });
    await settle(2200);                            // the next report goes out
    const second = calls.filter(([name]) => name === 'beat')[1];
    assert.ok(second, 'the board reports in again');
    assert.ok(second[2].some((input) => input.action === 'rotate'),
      'and the tap made mid-flight is in it, not quietly dropped');
    await act(async () => root3.unmount());
  } finally {
    await server.close();
  }
});
