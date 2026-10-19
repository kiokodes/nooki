import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// The Games tab shows the game titles in a rail and only the chosen game's settings
// under it. These checks cover the rail itself: one panel at a time, the chip that
// mirrors the panel, arrow-key movement, and the swipe that walks the carousel — the
// part of the library that no pointer-free test could catch.
test('games library: the rail shows one game at a time and swipes between them', async () => {
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
    const { GAMES } = await server.ssrLoadModule('/src/lib/gamesService.ts');
    const games = {
      data: { matches: [], wins: {} }, error: null, busy: false, match: undefined, pendingGame: null,
      select: () => {}, start: () => {}, play: () => {}, refresh: () => {},
    };
    await act(async () => root.render(React.createElement(GamesView, { games, userId: 'a', partnerName: 'Bob' })));

    const rail = document.querySelector('[data-game-rail]');
    const track = document.querySelector('[data-game-panel-track]');
    assert.ok(rail, 'the games sit in a rail');
    assert.ok(track, 'one panel shows under it');
    assert.equal(rail.getAttribute('role'), 'tablist');
    const tabs = [...rail.querySelectorAll('[role="tab"]')];
    assert.deepEqual(tabs.map(tab => tab.dataset.gameTab), GAMES.map(game => game.id), 'every game has a chip');
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true', 'the first game is chosen by default');
    assert.deepEqual(
      tabs.filter(tab => tab.getAttribute('aria-selected') === 'true').map(tab => tab.dataset.gameTab),
      ['rock-paper-scissors'],
      'only one chip reads as chosen',
    );

    const panels = () => [...document.querySelectorAll('[role="tabpanel"]')];
    assert.equal(panels().length, 1, 'the library never stacks every game at once');
    assert.equal(panels()[0].dataset.game, 'rock-paper-scissors');
    assert.ok(panels()[0].textContent.includes('Pick in secret'), 'the chosen game brings its own settings');
    assert.equal(document.body.textContent.includes('Five minutes each, same pieces'), false, 'other games stay off the page');

    // A chip brings its game's settings and start button in.
    const wordTab = tabs.find(tab => tab.dataset.gameTab === 'word-wheel');
    await act(async () => wordTab.click());
    assert.equal(panels()[0].dataset.game, 'word-wheel');
    assert.equal(wordTab.getAttribute('aria-selected'), 'true');
    assert.ok(panels()[0].textContent.includes('Practice solo anytime'), 'the word wheel panel describes local practice');
    assert.ok([...panels()[0].querySelectorAll('button')].some(item => item.textContent.includes('Challenge Bob asynchronously')), 'with its async challenge button');
    assert.ok([...panels()[0].querySelectorAll('button')].some(item => item.textContent.includes('Practice solo')), 'and a separate practice button');

    // Arrow keys walk the rail like a tab list, and the panel follows.
    await act(async () => rail.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    assert.equal(panels()[0].dataset.game, 'dash-duel', 'ArrowLeft moves one game back');
    assert.equal(document.activeElement?.dataset.gameTab, 'dash-duel', 'focus follows the arrow key');
    await act(async () => rail.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
    assert.equal(panels()[0].dataset.game, 'rock-paper-scissors', 'Home returns to the first game');
    await act(async () => rail.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    assert.equal(panels()[0].dataset.game, 'word-wheel', 'End jumps to the last game');

    // A thumb swipe across the panel is the other way through the carousel.
    const swipe = async (from, to) => {
      await act(async () => {
        track.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: from, clientY: 200 }));
        track.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: (from + to) / 2, clientY: 204 }));
        track.dispatchEvent(new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: to, clientY: 206 }));
        track.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, clientX: to, clientY: 206 }));
      });
    };
    await act(async () => tabs[0].click());
    assert.equal(panels()[0].dataset.game, 'rock-paper-scissors');
    await swipe(320, 140);
    assert.equal(panels()[0].dataset.game, 'snake', 'swiping left walks forward');
    assert.equal(track.style.transform, '', 'the panel settles back into place');
    await swipe(120, 320);
    assert.equal(panels()[0].dataset.game, 'rock-paper-scissors', 'swiping right walks back');
    // A wobble is a tap on whatever is under the thumb, not a change of game.
    await swipe(300, 285);
    assert.equal(panels()[0].dataset.game, 'rock-paper-scissors', 'a small drag leaves the choice alone');
    // Swiping back from the first game stops there rather than wrapping around.
    await swipe(120, 320);
    assert.equal(panels()[0].dataset.game, 'rock-paper-scissors', 'the first game is the start of the rail');

    assert.ok(document.querySelector('.game-library-hint'), 'the swipe route is named on screen');
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
