import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Sudoku collaboration cannot start without the partner in the collaboration room', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent']) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const root = createRoot(document.getElementById('root'));

  try {
    const { Sudoku } = await server.ssrLoadModule('/src/components/games/Sudoku.tsx');
    await act(async () => root.render(React.createElement(Sudoku, {
      coupleId: 'couple', userId: 'me', partnerId: 'partner', partnerName: 'Ana', partnerOnline: true,
    })));

    const byText = text => [...document.querySelectorAll('button')].find(button => button.textContent === text);
    await act(async () => byText('collaboration').click());
    const start = byText('Waiting for both players…');
    assert.ok(start?.disabled, 'collaboration cannot start until both players are present in the room');
    assert.match(document.body.textContent, /Waiting for Ana to open Sudoku and select Collaboration/);

    // The two-player rule does not interfere with local Sudoku practice.
    await act(async () => byText('solo').click());
    await act(async () => byText('Start puzzle').click());
    assert.equal(document.querySelectorAll('[data-sudoku-cell]').length, 81);
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
