import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// The design preview's Games tab mirrors the app's carousel. Chess used to sit above
// the rail as a fixture of the page even though it is an ordinary game in the app, so
// this pins it where it belongs: one chip among the rest, with its board only arriving
// once the chip is chosen.
test('design preview: every game is a chip in the rail, Chess included', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent']) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
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
    const buttonText = (text) => [...document.querySelectorAll('button')].find((item) => item.textContent.includes(text));

    await waitFor(() => document.querySelector('[data-card="today"]'), 'the preview should open on Home');
    await act(async () => { [...document.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === 'Games').click(); });

    const rail = document.querySelector('.game-rail');
    assert.ok(rail, 'the preview shows the game rail');
    const chips = [...rail.querySelectorAll('[data-preview-game]')].map((chip) => chip.dataset.previewGame);
    assert.deepEqual(chips, ['snake', 'chess', 'tetris', 'word'], 'every duel is a chip, in the app order');
    const chessChip = rail.querySelector('[data-preview-game="chess"]');
    assert.ok(chessChip, 'Chess is one of them');
    assert.equal(chessChip.textContent.includes('Chess'), true);
    assert.equal(document.querySelectorAll('.chess-cell').length, 0, 'no board sits outside the carousel');

    await act(async () => chessChip.click());
    assert.equal(chessChip.getAttribute('aria-selected'), 'true', 'the Chess chip is the chosen one');
    assert.ok(document.querySelector('[data-chess="setup"]'), 'choosing it brings the duel picker in');
    await act(async () => buttonText('Queen Hunt').click());
    await act(async () => buttonText('Start Queen Hunt').click());
    assert.equal(document.querySelectorAll('.chess-cell').length, 64, 'and the board plays on this page');

    // Leaving Chess for another chip puts the board away again.
    await act(async () => document.querySelector('[data-preview-game="word"]').click());
    assert.equal(document.querySelectorAll('.chess-cell').length, 0, 'the chess board leaves with its chip');

    // The Word Wheel tab offers a local practice run and an async challenge. Neither
    // path relies on a shared ready handshake.
    const settings = document.querySelector('[data-preview-word-wheel="settings"]');
    assert.ok(settings, 'the Word Wheel tab opens on its settings');
    assert.equal(document.querySelector('.word-wheel'), null, 'no wheel before either action');
    assert.equal(document.querySelector('.word-timer'), null, 'and no clock running');
    assert.ok(settings.textContent.includes('Choose the difficulty'));
    assert.ok(settings.textContent.includes('How long is the round?'));
    assert.ok(buttonText('Practice solo →'));
    assert.ok(buttonText('Challenge Ana asynchronously →'));

    await act(async () => settings.querySelector('[data-preview-word-level="hard"]').click());
    await act(async () => settings.querySelector('[data-preview-word-duration="180"]').click());
    await act(async () => buttonText('Practice solo →').click());
    await waitFor(() => document.querySelector('.word-wheel'), 'practice starts locally from the settings');
    assert.ok(document.body.textContent.includes('Solo practice'));
    assert.ok(document.querySelector('.word-timer'), 'practice has its own countdown');
    await act(async () => buttonText('← All games').click());

    const settingsAgain = document.querySelector('[data-preview-word-wheel="settings"]');
    await act(async () => buttonText('Challenge Ana asynchronously →').click());
    assert.ok(document.querySelector('.word-wheel-card.word-lobby'), 'an async challenge opens a start lobby');
    assert.equal(document.querySelector('.word-timer'), null, 'the multiplayer clock has not started yet');
    await act(async () => buttonText('Start my 3 minutes →').click());
    await waitFor(() => document.querySelectorAll('.word-letter').length === 7, "starting this player's attempt opens the board");
    assert.ok(document.querySelector('.word-timer'), "this player's clock starts independently");
    assert.ok(document.body.textContent.includes('Ana: not started'), 'the sample partner may still be unstarted');
    assert.ok(settingsAgain, 'the settings page remains the stable entry point after leaving a run');
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
