import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

/**
 * The Games tab head: the eyebrow, and the "Ongoing games" card that holds every live
 * match at one card's height — swiped through, not scrolled past.
 *
 * The rule the card exists to enforce: only games that can still be played are ongoing.
 * A finished duel is history and is not listed at all, and a duel whose two runs are in
 * is waiting on the referee — it must never sit in the ongoing games claiming "Resume",
 * which is exactly where the Tetris glitch left finished duels standing.
 */
test('games tab: ongoing games swipe, and nothing finished or settled stands among them', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent']) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const root = createRoot(document.getElementById('root'));
  try {
    const { GamesView } = await server.ssrLoadModule('/src/components/games/GamesView.tsx');
    const calls = [];
    const games = (matches) => ({
      data: { matches, wins: {} },
      error: null, busy: false, match: undefined, duelLive: null, pendingCount: 0,
      select: (id) => calls.push(['select', id]),
      start: () => {}, startChess: () => {}, startTetrisDuel: () => {}, play: () => {}, playChess: () => {},
      refresh: () => {},
    });
    const render = (matches) => act(async () => root.render(React.createElement(GamesView, {
      games: games(matches), userId: 'a', partnerName: 'Bob',
    })));
    const tetris = (id, { finished = false, winner = null, mine, partner, mode = 'sprint' } = {}) => ({
      id, game: 'tetris', player_x: 'a', player_o: 'b',
      turn_id: 'a', best_of: 3, round: 1, score_x: 0, score_o: 0, rounds: [],
      my_pick: null, partner_locked: false, finished, winner_id: winner,
      tetris: { mode, mine: mine ?? null, partner: partner ?? { status: 'waiting', ended: null } },
    });
    const rps = (id, { finished = false } = {}) => ({
      id, game: 'rock-paper-scissors', player_x: 'a', player_o: 'b',
      turn_id: 'a', best_of: 3, round: 1, score_x: 0, score_o: 0, rounds: [],
      my_pick: null, partner_locked: false, finished, winner_id: null,
    });
    const doneRun = { status: 'done', score: 900, lines: 6, ticks: 4000, ended: 'cap' };

    // --- The copy the tab opens with ---------------------------------------------------
    await render([]);
    assert.equal(document.querySelector('.games-eyebrow').textContent, 'A little lovers rivalry');
    assert.equal(document.querySelector('[data-ongoing-games]'), null, 'no ongoing card when nothing is open');

    // --- Open matches live in the card; finished ones do not ---------------------------
    await render([
      tetris('open-1', { mine: doneRun, partner: { status: 'waiting', ended: null } }),
      tetris('done-1', { finished: true, winner: 'b', mine: doneRun, partner: { status: 'done', score: 4100, lines: 40, ticks: 6000, ended: 'cap' } }),
    ]);
    let card = document.querySelector('[data-ongoing-games]');
    assert.ok(card, 'the ongoing card renders when a match is open');
    const slides = [...card.querySelectorAll('[data-ongoing-slide]')];
    assert.deepEqual(slides.map((slide) => slide.dataset.ongoingSlide), ['open-1'], 'only the open match is ongoing');
    assert(slides[0].textContent.includes('Tetris Duel'));
    assert(slides[0].textContent.includes('Waiting for Bob'), 'a slide not waiting on you names the partner');
    assert.equal(slides[0].dataset.waitingOn, 'partner');
    assert.equal(slides[0].querySelector('[data-ongoing-bell]'), null, 'a partner\'s move wears no bell');

    // --- The glitch's shape: both runs in, the row not settled yet — not "ongoing" -----
    await render([
      tetris('both-in', {
        mine: doneRun,
        partner: { status: 'done', ended: 'cap' },
      }),
    ]);
    assert.equal(
      document.querySelector('[data-ongoing-games]'),
      null,
      'a duel whose two runs are in is not ongoing, even before the row settles',
    );

    // --- Many open games: one card's height, swiped with dots --------------------------
    await render([
      // I have played my run; this one is waiting on Bob.
      tetris('open-1', { mine: doneRun, partner: { status: 'waiting', ended: null } }),
      rps('open-2'),
      tetris('open-3', { mine: null, mode: 'survival' }),
    ]);
    card = document.querySelector('[data-ongoing-games]');
    const track = document.querySelector('[data-ongoing-track]');
    assert.ok(track, 'the matches sit in one swipe track');
    assert.equal(track.querySelectorAll('[data-ongoing-slide]').length, 3);
    const dots = document.querySelectorAll('[data-ongoing-dots] .ongoing-dot');
    assert.equal(dots.length, 3, 'one dot per open match');
    assert.equal(dots[0].getAttribute('aria-current'), 'true', 'the first dot marks the first match');
    // "Your turn" is what a match waiting on this phone says on its slide.
    const waiting = [...track.querySelectorAll('[data-ongoing-slide]')].find((slide) => slide.dataset.ongoingSlide === 'open-2');
    assert(waiting.textContent.includes('Your move'), 'a match waiting on your move says so');
    assert.equal(waiting.dataset.waitingOn, 'me');
    assert.ok(waiting.querySelector('[data-ongoing-bell]'), 'and wears the bell that flags it');
    assert.equal(card.querySelector('[data-ongoing-count]').textContent, '3 open', 'the card counts the open games');
    const quiet = [...track.querySelectorAll('[data-ongoing-slide]')].filter((slide) => slide.dataset.waitingOn === 'partner');
    assert.equal(quiet.length, 1, 'only the match waiting on Bob wears no bell');
    assert.ok(quiet[0].textContent.includes('Waiting for Bob'));

    // Tapping a slide opens that match.
    await act(async () => track.querySelector('[data-ongoing-slide="open-3"]').click());
    assert.deepEqual(calls.pop(), ['select', 'open-3']);

    // --- A finished duel is history: it is not listed on this tab at all ---------------
    await render([
      tetris('open-1', { mine: null }),
      tetris('done-1', {
        finished: true, winner: 'a', mine: doneRun,
        partner: { status: 'done', score: 400, lines: 2, ticks: 900, ended: 'top' },
      }),
    ]);
    assert.deepEqual(
      [...document.querySelectorAll('[data-ongoing-slide]')].map((slide) => slide.dataset.ongoingSlide),
      ['open-1'],
      'only the live match is listed',
    );
    assert.equal(document.querySelector('[data-last-duel]'), null, 'there is no last-duel row to find');
    const sections = [...document.querySelectorAll('.games-view > *')]
      .filter((node) => node.matches('[data-ongoing-games], .game-library'));
    assert.equal(sections.length, 2, 'the tab holds the ongoing card and the catalogue, nothing else');
    assert.equal(document.querySelector('[data-ongoing-count]').textContent, '1 open', 'even a single open game is counted');

    // A settled duel between the couple is gone from the tab entirely.
    await render([tetris('done-1', { finished: true, winner: 'a', mine: doneRun, partner: { status: 'done', score: 400, lines: 2, ticks: 900, ended: 'top' } })]);
    assert.equal(document.querySelector('[data-ongoing-games]'), null, 'nothing open means no ongoing card');
    assert.equal(document.querySelector('[data-last-duel]'), null);
    assert.ok(document.querySelector('.game-library'), 'the catalogue is still there');
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
