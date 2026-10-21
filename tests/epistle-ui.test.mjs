import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Letters wait for days, so pin the process timezone to keep "today" deterministic.
process.env.TZ = 'UTC';

/** One row of `epistles`, as the app reads it. */
const letter = (overrides = {}) => ({
  id: 'letter',
  couple_id: 'c1',
  sender_id: 'bob',
  title: null,
  body: 'My dearest Alice,\n\nThe distance is only geography.\n\nAll my love.',
  sealed_at: '2026-10-19T09:00:00.000Z',
  opens_at: null,
  opened_at: null,
  created_at: '2026-10-19T09:00:00.000Z',
  updated_at: '2026-10-19T09:00:00.000Z',
  ...overrides,
});

const setupDom = () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'FormData', 'localStorage']) {
    globalThis[key] = dom.window[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
};

test('epistle UI: the mailbox, the desk, the seal and the nook mailbox flag', async () => {
  const dom = setupDom();
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const root = createRoot(document.getElementById('root'));
  try {
    const { EpistleView } = await server.ssrLoadModule('/src/components/epistle/EpistleView.tsx');
    const { MailboxButton } = await server.ssrLoadModule('/src/components/home/MailboxButton.tsx');
    const { EnvelopeArt } = await server.ssrLoadModule('/src/components/epistle/EnvelopeArt.tsx');

    const body = () => document.body.textContent.replace(/\u2019/g, "'");
    const waitFor = async (predicate, message) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) return;
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      }
      assert.fail(message);
    };

    const noop = () => Promise.resolve(letter());

    // --- An empty mailbox invites the first letter, it does not apologise ------------
    await act(async () => {
      root.render(React.createElement(EpistleView, {
        letters: [],
        loading: false,
        error: null,
        userId: 'alice',
        myName: 'Alice',
        partnerName: 'Bob',
        myPlace: 'Lagos, Nigeria',
        todayKey: '2026-10-20',
        onClose: () => {},
        onCreateDraft: noop,
        onSaveDraft: noop,
        onSeal: noop,
        onRecall: noop,
        onOpen: noop,
        onDiscard: noop,
        onClearError: () => {},
      }));
    });
    assert(document.querySelector('[data-epistle-empty]'), 'an empty mailbox shows its welcome');
    assert(document.querySelector('[data-epistle-write]'), 'the way in is a written invitation');
    assert.match(body(), /Write the first one for Bob/);

    // --- Every envelope stands on the shelf its state earns --------------------------
    const letters = [
      letter({ id: 'ready', title: 'The long way home', created_at: '2026-10-19T09:00:00.000Z' }),
      letter({ id: 'waiting', opens_at: '2026-10-21', created_at: '2026-10-18T09:00:00.000Z' }),
      letter({ id: 'mine', sender_id: 'alice', created_at: '2026-10-17T09:00:00.000Z' }),
      letter({ id: 'keepsake', sender_id: 'alice', opened_at: '2026-10-18T10:00:00.000Z', created_at: '2026-10-16T09:00:00.000Z' }),
      letter({ id: 'draft', sender_id: 'alice', sealed_at: null, created_at: '2026-10-19T20:00:00.000Z' }),
    ];
    await act(async () => {
      root.render(React.createElement(EpistleView, {
        letters,
        loading: false,
        error: null,
        userId: 'alice',
        myName: 'Alice',
        partnerName: 'Bob',
        myPlace: null,
        todayKey: '2026-10-20',
        onClose: () => {},
        onCreateDraft: noop,
        onSaveDraft: noop,
        onSeal: noop,
        onRecall: noop,
        onOpen: noop,
        onDiscard: noop,
        onClearError: () => {},
      }));
    });
    assert(document.querySelector('[data-epistle-section="unopened"] [data-epistle-card="ready"]'), 'the openable letter waits at the top');
    assert.equal(document.querySelector('[data-epistle-card="ready"]')?.dataset.epistleState, 'sealed-unopened');
    assert.match(document.querySelector('[data-epistle-card="ready"]')?.getAttribute('aria-label') ?? '', /tap to break the seal/);
    assert(document.querySelector('[data-epistle-section="waiting"] [data-epistle-card="waiting"]'), 'a scheduled letter stands visible but sealed');
    assert.match(body(), /Sealed until their day/);
    assert.match(document.querySelector('[data-epistle-section="waiting"]')?.textContent ?? '', /Opens tomorrow/, 'the day is counted from the reader’s own calendar');
    assert(document.querySelector('[data-epistle-section="mine"] [data-epistle-card="mine"]'), 'my own standing letter is on its shelf');
    assert(document.querySelector('[data-epistle-section="mine"]')?.textContent.includes('Take back'), 'an unopened letter may still be taken back');
    assert(document.querySelector('[data-epistle-section="keepsakes"] [data-epistle-card="keepsake"]'), 'opened letters become keepsakes');
    assert(document.querySelector('[data-epistle-section="drafts"] [data-epistle-card="draft"]'), 'drafts keep their own shelf');

    // --- The writing desk: the paper, the dateline, the counter, the seal ------------
    let sealedWith = 'never';
    const actions = {
      onCreateDraft: async (title, bodyText) => {
        sealedWith = JSON.stringify({ title, bodyText });
        return letter({ id: 'fresh-draft', sender_id: 'alice', sealed_at: null, title, body: bodyText });
      },
      onSaveDraft: async (id, title, bodyText) => {
        sealedWith = JSON.stringify({ id, title, bodyText });
        return letter({ id, sender_id: 'alice', sealed_at: null, title, body: bodyText });
      },
      onSeal: async (id, opensAt) => letter({ id, sender_id: 'alice', opens_at: opensAt }),
    };
    await act(async () => {
      root.render(React.createElement(EpistleView, {
        letters: [],
        loading: false,
        error: null,
        userId: 'alice',
        myName: 'Alice',
        partnerName: 'Bob',
        myPlace: 'Lagos, Nigeria',
        todayKey: '2026-10-20',
        onClose: () => {},
        ...actions,
        onRecall: noop,
        onOpen: noop,
        onDiscard: noop,
        onClearError: () => {},
      }));
    });
    await act(async () => {
      document.querySelector('[data-epistle-write]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    const desk = () => document.querySelector('[data-epistle-desk]');
    await waitFor(() => desk(), 'the writing desk opens');
    assert(document.querySelector('[data-epistle-title]'), 'the letter has a name field');
    assert(document.querySelector('[data-epistle-body]'), 'the letter is written on its paper');
    assert.match(document.querySelector('.epistle-dateline')?.textContent ?? '', /Lagos, Nigeria/, 'the dateline carries the writer’s town');

    const titleInput = document.querySelector('[data-epistle-title]');
    const bodyInput = document.querySelector('[data-epistle-body]');
    // React watches the native value setters, so a plain assignment looks like no
    // change at all: set through the prototype, then announce it.
    const setNativeValue = (node, value) => {
      const proto = node.tagName === 'TEXTAREA'
        ? dom.window.HTMLTextAreaElement.prototype
        : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value);
      node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    };
    await act(async () => {
      setNativeValue(titleInput, 'Forty-one days');
    });
    await act(async () => {
      setNativeValue(bodyInput, 'My dearest Bob,\n\nIt has been forty-one days, and the distance is only geography.');
    });
    await waitFor(() => (document.querySelector('[data-epistle-words]')?.textContent ?? '').startsWith('14'), 'the word counter counts');
    await waitFor(() => sealedWith !== 'never', 'the desk autosaves the draft as it is written');
    assert.deepEqual(JSON.parse(sealedWith), {
      title: 'Forty-one days',
      bodyText: 'My dearest Bob,\n\nIt has been forty-one days, and the distance is only geography.',
    }, 'the draft is saved with its own words');

    // --- The sealing ceremony: read once more, choose the day, press the wax ---------
    await act(async () => {
      document.querySelector('[data-epistle-seal-start]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    const ceremony = () => document.querySelector('[data-epistle-sealing]');
    await waitFor(() => ceremony()?.dataset.sealingStep === 'review', 'sealing begins by reading it once more');
    assert(document.querySelector('[data-component="epistle-letter"]'), 'the preview is the same paper the reader will see');

    await act(async () => {
      document.querySelector('[data-epistle-seal-review]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => ceremony()?.dataset.sealingStep === 'when', 'then comes the choice of day');
    const nowChoice = document.querySelector('[data-epistle-timing="now"]');
    assert.equal(nowChoice?.dataset.chosen, 'true', 'the letter opens as soon as they like, by default');

    await act(async () => {
      document.querySelector('[data-epistle-timing="day"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    assert(document.querySelector('[data-epistle-date-field]'), 'choosing a day reveals the date');

    await act(async () => {
      document.querySelector('[data-epistle-seal-when]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => ceremony()?.dataset.sealingStep === 'press', 'and ends at the wax');
    assert(document.querySelector('[data-epistle-stamp]'), 'the wax waits to be pressed');

    // --- The nook's mailbox flag raises itself for a ready letter --------------------
    await act(async () => {
      root.render(React.createElement(MailboxButton, {
        count: 2,
        waitingCount: 1,
        partnerName: 'Bob',
        onOpen: () => {},
      }));
    });
    assert.equal(document.querySelector('[data-nooki-mailbox-count]')?.textContent, '2', 'the flag carries the number');
    assert.match(document.querySelector('[data-nooki-mailbox-hint]')?.textContent ?? '', /Bob wrote to you/);

    // The envelope drawing shows the same letter in every size.
    await act(async () => {
      root.render(React.createElement(EnvelopeArt, { senderName: 'Ana', sealed: true, wax: 'fresh' }));
    });
    assert.equal(document.querySelector('.ep-wax span')?.textContent, 'A', 'the wax carries the writer’s initial');
  } finally {
    await act(async () => root.unmount());
    await server.close();
  }
});
