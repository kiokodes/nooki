import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

process.env.TZ = 'UTC';

// The design preview's sample mailbox holds a correspondence chain of its own, so
// the reply banners, thread notes and answer counts can be walked without a second
// phone. This pins the samples to the shelves they belong on.
test('epistle preview: the sample mailbox renders its correspondence chain', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'FormData', 'localStorage']) {
    globalThis[key] = dom.window[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const root = createRoot(document.getElementById('root'));
  try {
    const { PreviewEpistles } = await server.ssrLoadModule('/src/preview/PreviewEpistles.tsx');
    await act(async () => {
      root.render(React.createElement(PreviewEpistles, { inboxNudge: 0 }));
    });
    assert(document.querySelector('[data-epistle-tab="received"]'), 'received tab renders');
    assert(document.querySelector('[data-epistle-section="unopened"]'), 'openable sample renders');
    assert.match(document.body.textContent, /In reply to/, 'the sample chain shows its links');
    await act(async () => {
      document.querySelector('[data-epistle-tab="sent"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    assert(document.querySelector('[data-epistle-section="sent-kept"]'), 'sent keepsakes render');
    assert.match(document.body.textContent, /2 replies in this correspondence/, 'the answered sample counts its answers');
    await act(async () => {
      document.querySelector('[data-epistle-tab="drafts"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    assert(document.querySelector('[data-epistle-tab-empty="drafts"]'), 'empty drafts shelf renders');
  } finally {
    await act(async () => root.unmount());
    await server.close();
  }
});
