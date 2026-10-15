import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// The app stylesheet resets every margin to zero (`* { margin: 0 }`), so the games
// cards carry their own spacing rules. Without them the copy runs straight into
// the next element and the call-to-action button ends up sitting on the text.
// jsdom does not lay anything out, so this guards the rules and the markup that
// the spacing depends on.

const css = await readFile(new URL('../src/components/games/games.css', import.meta.url), 'utf8');

/** Pulls the declarations of a single rule out of the stylesheet. */
const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|[\\s}])${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  return match ? match[1] : '';
};

test('games layout: card copy is spaced away from the button below it', () => {
  // Every paragraph inside a card needs breathing room, otherwise it butts
  // straight up against the button that follows it.
  const cardParagraph = rule('.game-card > p');
  assert.match(cardParagraph, /margin[^;]*\b12px\b/, 'card paragraphs get a bottom margin');

  // The same for the error message, whose button is rendered as a sibling.
  assert.match(rule('.game-card > p:last-child'), /margin-bottom:\s*0/, 'the last paragraph in a card does not add a trailing margin');

  // Headings inside a match card (round numbers, the reveal) also need space.
  assert.match(rule('.game-card h3'), /margin[^;]*\b1\dpx\b/, 'card headings get their own spacing');

  // The board is a grid of square cells and is centred between the copy.
  assert.match(rule('.ttt-board'), /display:\s*grid/, 'the board is a grid');
  assert.match(rule('.ttt-board'), /max-width:\s*320px/, 'the board has a maximum width');
  assert.match(rule('.ttt-board button'), /aspect-ratio:\s*1/, 'board cells stay square');
});

test('games layout: the error message is a block so the retry button cannot sit on it', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent']) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const root = createRoot(document.getElementById('root'));
  try {
    const { GamesView } = await server.ssrLoadModule('/src/components/games/GamesView.tsx');
    const games = {
      data: { matches: [] },
      error: 'Games needs a database update.',
      busy: false,
      match: undefined,
      select: () => {}, start: () => {}, play: () => {}, refresh: () => {},
    };
    await act(async () => root.render(React.createElement(GamesView, { games, userId: 'a', partnerName: 'Bob' })));

    const alert = document.querySelector('[role="alert"].game-card');
    assert.ok(alert, 'the error card is rendered');
    const message = alert.querySelector('p');
    assert.ok(message, 'the error message is its own block');
    assert.equal(message.textContent, 'Games needs a database update.');
    const retry = alert.querySelector('button');
    assert.ok(retry, 'the retry button is rendered');
    assert.notEqual(retry, message, 'the retry button is not the message itself');
    assert.equal(retry.parentElement, alert, 'the retry button is a sibling of the message');
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
