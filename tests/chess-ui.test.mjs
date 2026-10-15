import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('chess UI: library starts a refereed duel; the board plays one out', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent']) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const root = createRoot(document.getElementById('root'));
  try {
    const { GamesView } = await server.ssrLoadModule('/src/components/games/GamesView.tsx');
    const calls = [];
    const games = { data: { matches: [] }, error: null, busy: false, match: undefined, select: () => {}, start: () => {}, play: () => {}, refresh: () => {}, startChess: (mode) => calls.push(mode), playChess: () => {} };
    await act(async () => root.render(React.createElement(GamesView, { games, userId: 'a', partnerName: 'Bob' })));
    const button = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(text));
    const chessCard = [...document.querySelectorAll('article')].find((c) => c.textContent.includes('Chess'));
    assert.ok(chessCard, 'chess has a library card');
    assert.ok(chessCard.textContent.includes('first-to-7-captures'));
    // The library card picks the situational duel, then starts it through the database.
    await act(async () => [...chessCard.querySelectorAll('button')].find((b) => b.textContent.includes('Queen Hunt')).click());
    await act(async () => button('Play Chess with Bob →').click());
    assert.deepEqual(calls, ['queen-hunt'], 'starting chess goes through start_chess with the chosen mode');

    // The board itself (pass-and-play in the preview, the same component online).
    const { ChessDuel } = await server.ssrLoadModule('/src/components/games/ChessDuel.tsx');
    await act(async () => root.render(React.createElement(ChessDuel, { partnerName: 'Bob' })));
    assert.ok(document.querySelector('[data-chess="setup"]'), 'the duel picker opens');
    await act(async () => button('Queen Hunt').click());
    await act(async () => button('Start Queen Hunt').click());
    assert.equal(document.querySelectorAll('.chess-cell').length, 64, 'a full board renders');
    assert.ok(document.body.textContent.includes('White') && document.body.textContent.includes('to move'));

    const cell = (label) => [...document.querySelectorAll('.chess-cell')].find((b) => b.getAttribute('aria-label').startsWith(label));
    // 1. e4 d5 2. exd5 Qxd5 — queen recaptures, no hunt win yet.
    for (const [from, to] of [['e2', 'e4'], ['d7', 'd5'], ['e4', 'd5'], ['d8', 'd5']]) {
      await act(async () => cell(from).click());
      await act(async () => cell(to).click());
    }
    assert.ok(document.body.textContent.includes('1 captured'), 'captures are tallied for both sides');
    assert.ok(!document.body.textContent.includes('Queen Hunt —'), 'the hunt is not won by a pawn trade');
    // 3. Nc3 Nf6 4. Nxd5 — the knight takes the original queen and the banner lands.
    for (const [from, to] of [['b1', 'c3'], ['g8', 'f6'], ['c3', 'd5']]) {
      await act(async () => cell(from).click());
      await act(async () => cell(to).click());
    }
    assert.ok(document.body.textContent.includes('wins the Queen Hunt'), 'capturing the original queen ends the hunt');
    assert.ok([...document.querySelectorAll('.chess-cell')].every((b) => b.disabled), 'the board locks once the duel is decided');
  } finally { await act(async () => root.unmount()); await server.close(); dom.window.close(); }
});
