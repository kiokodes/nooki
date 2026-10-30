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
  reply_to_id: null,
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
      letter({ id: 'mine-waiting', sender_id: 'alice', opens_at: '2026-10-25', created_at: '2026-10-17T12:00:00.000Z' }),
      letter({ id: 'keepsake-sent', sender_id: 'alice', title: 'The first one', opened_at: '2026-10-18T10:00:00.000Z', created_at: '2026-10-16T09:00:00.000Z' }),
      letter({ id: 'keepsake-received', opened_at: '2026-10-15T10:00:00.000Z', created_at: '2026-10-14T09:00:00.000Z' }),
      letter({ id: 'answer', title: 'Re: The first one', reply_to_id: 'keepsake-sent', opened_at: '2026-10-15T11:00:00.000Z', created_at: '2026-10-15T09:00:00.000Z' }),
      letter({ id: 'draft', sender_id: 'alice', sealed_at: null, created_at: '2026-10-19T20:00:00.000Z' }),
    ];
    let mailboxKey = 0;
    const renderMailbox = async (rows) => {
      mailboxKey += 1;
      await act(async () => {
        root.render(React.createElement(EpistleView, {
          key: `mailbox-${mailboxKey}`,
          letters: rows,
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
    };
    const clickTab = async (name) => {
      await act(async () => {
        document.querySelector(`[data-epistle-tab="${name}"]`).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
    };
    await renderMailbox(letters);

    // The mailbox opens on what arrived, with its waiting counted on the tab.
    assert.equal(document.querySelector('[data-epistle-tab="received"]')?.getAttribute('aria-selected'), 'true');
    assert.equal(document.querySelector('[data-epistle-tab="received"] .epistle-tab-count')?.textContent, '1');
    assert.equal(document.querySelector('[data-epistle-tab="sent"] .epistle-tab-count')?.textContent, '2');
    assert.equal(document.querySelector('[data-epistle-tab="drafts"] .epistle-tab-count')?.textContent, '1');

    assert(document.querySelector('[data-epistle-section="unopened"] [data-epistle-card="ready"]'), 'the openable letter waits at the top');
    assert.equal(document.querySelector('[data-epistle-card="ready"]')?.dataset.epistleState, 'sealed-unopened');
    assert.match(document.querySelector('[data-epistle-card="ready"]')?.getAttribute('aria-label') ?? '', /tap to break the seal/);
    assert.equal(document.querySelector('[data-epistle-card="ready"] .ep-envelope-from')?.textContent, 'From Bob');
    assert(document.querySelector('[data-epistle-section="waiting"] [data-epistle-card="waiting"]'), 'a scheduled letter stands visible but sealed');
    assert.equal(document.querySelector('[data-epistle-card="waiting"]').tagName, 'DIV', 'a sealed letter is looked at, not touched');
    assert.match(body(), /Sealed until their day/);
    assert.match(document.querySelector('[data-epistle-section="waiting"]')?.textContent ?? '', /Opens tomorrow/, 'the day is counted from the reader’s own calendar');
    assert(document.querySelector('[data-epistle-section="received-kept"] [data-epistle-card="keepsake-received"]'), 'received letters, once read, are kept');
    assert.match(
      document.querySelector('[data-epistle-card="answer"]')?.textContent ?? '',
      /In reply to “The first one”/,
      'an answer says which letter it answers',
    );

    // Sent: one's own letters, to the partner rather than from them.
    await clickTab('sent');
    assert(document.querySelector('[data-epistle-section="mine"] [data-epistle-card="mine"]'), 'my own standing letter is on its shelf');
    assert.equal(document.querySelector('[data-epistle-card="mine"]').tagName, 'BUTTON', 'my own letter may always be reread');
    assert.equal(document.querySelector('[data-epistle-card="mine"] .ep-envelope-from')?.textContent, 'To Bob');
    assert.match(document.querySelector('[data-epistle-card="mine"]')?.textContent ?? '', /Waiting for Bob to open/);
    assert.equal(document.querySelector('[data-epistle-card="mine"]')?.getAttribute('aria-label'), 'Your letter to Bob — read it again');
    assert.match(document.querySelector('[data-epistle-card="mine-waiting"]')?.textContent ?? '', /Opens in 5 days/, 'my own scheduled letter counts its day too');
    assert(document.querySelector('[data-epistle-section="mine"]')?.textContent.includes('Take back'), 'an unopened letter may still be taken back');
    assert(document.querySelector('[data-epistle-section="sent-kept"] [data-epistle-card="keepsake-sent"]'), 'sent letters, once opened, are kept');
    assert.match(
      document.querySelector('[data-epistle-card="keepsake-sent"]')?.textContent ?? '',
      /1 reply in this correspondence/,
      'an answered letter says it was answered',
    );

    // Drafts keep their own shelf.
    await clickTab('drafts');
    assert(document.querySelector('[data-epistle-section="drafts"] [data-epistle-card="draft"]'), 'drafts keep their own shelf');
    await clickTab('received');

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
    // The desk opens with the pen on the paper — but after that, writing the letter
    // must never drag the cursor out of its name.
    await act(async () => {
      titleInput.focus();
    });
    await act(async () => {
      setNativeValue(titleInput, 'Forty-one days');
    });
    await act(async () => {
      setNativeValue(bodyInput, 'My dearest Bob,\n\nIt has been forty-one days, and the distance is only geography.');
    });
    assert.equal(document.activeElement, titleInput, 'writing the letter never steals the name’s cursor');
    await waitFor(() => (document.querySelector('[data-epistle-words]')?.textContent ?? '').startsWith('14'), 'the word counter counts');
    await waitFor(() => sealedWith !== 'never', 'the desk autosaves the draft as it is written');
    assert.equal(document.activeElement, titleInput, 'not even the autosave steals the name’s cursor');
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

    // --- Answering a letter: the reading shows the chain, the reply continues it ----
    const chain = [
      letter({ id: 'first', sender_id: 'alice', title: 'The first one', opened_at: '2026-10-16T10:00:00.000Z', created_at: '2026-10-15T09:00:00.000Z' }),
      letter({ id: 'second', sender_id: 'bob', title: 'Re: The first one', reply_to_id: 'first', opened_at: '2026-10-17T10:00:00.000Z', created_at: '2026-10-16T09:00:00.000Z' }),
    ];
    await renderMailbox(chain);
    const clickCard = async (id) => {
      await act(async () => {
        document.querySelector(`[data-epistle-card="${id}"]`).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
    };
    await clickCard('second');
    const reading = () => document.querySelector('[data-epistle-reading]');
    await waitFor(() => reading(), 'the answer opens for reading');
    assert.match(
      document.querySelector('[data-epistle-in-reply-to]')?.textContent ?? '',
      /The first one/,
      'the reading names the answered letter',
    );
    assert(document.querySelector('[data-epistle-thread-letter="first"]'), 'the correspondence behind it stands ready to reread');
    assert.match(body(), /Letter 2 of 2/, 'the letter knows its place in the chain');

    // The answered letter reads back — and points forward to its answer.
    await act(async () => {
      document.querySelector('[data-epistle-in-reply-to]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => (document.querySelector('.epistle-letter-title')?.textContent ?? '') === 'The first one', 'the chain walks back');
    assert(document.querySelector('[data-epistle-latest-answer]'), 'an answered letter points at its answer');
    await act(async () => {
      document.querySelector('[data-epistle-latest-answer]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => (document.querySelector('.epistle-letter-title')?.textContent ?? '') === 'Re: The first one', 'and forward again');

    // Replying opens the desk already answering: the name prefixed once, the
    // answered letter quoted above the paper.
    await act(async () => {
      document.querySelector('[data-epistle-reply]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => desk(), 'the desk opens for the reply');
    assert.equal(document.querySelector('[data-epistle-title]').value, 'Re: The first one', 'a reply is named after its letter, prefixed once');
    assert.match(
      document.querySelector('[data-epistle-reply-banner]')?.textContent ?? '',
      /Replying to Bob/,
      'the desk says which letter is being answered',
    );
    await act(async () => {
      document.querySelector('.epistle-reply-banner-remove').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    assert(!document.querySelector('[data-epistle-reply-banner]'), 'a reply may still become a letter of its own');

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

test('epistle UI: a letter past the limit is refused and said so, never quietly cut', async () => {
  const dom = setupDom();
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const root = createRoot(document.getElementById('root'));
  try {
    const { EpistleView } = await server.ssrLoadModule('/src/components/epistle/EpistleView.tsx');
    const waitFor = async (predicate, message) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) return;
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      }
      assert.fail(message);
    };
    const saved = [];
    const errors = [];
    const noop = async () => letter();
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
        onCreateDraft: async (title, bodyText) => {
          saved.push(bodyText.length);
          return letter({ id: 'fresh', sender_id: 'alice', sealed_at: null, title, body: bodyText });
        },
        onSaveDraft: async (id, title, bodyText) => {
          saved.push(bodyText.length);
          return letter({ id, sender_id: 'alice', sealed_at: null, title, body: bodyText });
        },
        onSeal: noop,
        onRecall: noop,
        onOpen: noop,
        onDiscard: noop,
        onError: (message) => errors.push(message),
        onClearError: () => {},
      }));
    });
    await act(async () => {
      document.querySelector('[data-epistle-write]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    const bodyInput = document.querySelector('[data-epistle-body]');
    assert.equal(bodyInput.hasAttribute('maxLength'), false, 'the paper never clips what is pasted into it');

    const setNativeValue = (node, value) => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(node, value);
      node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    };
    // 20,001 characters, written the way the database counts them (code points).
    await act(async () => {
      setNativeValue(bodyInput, 'x'.repeat(20_001));
    });

    await waitFor(
      () => document.querySelector('[data-epistle-overflow]'),
      'the desk says the letter is past the limit',
    );
    assert.match(document.querySelector('[data-epistle-overflow]').textContent, /Nothing was cut/i);
    assert.equal(document.querySelector('[data-epistle-body]').value.length, 20_001, 'every word stays on the paper');
    assert.equal(document.querySelector('[data-epistle-seal-start]').disabled, true, 'an oversize letter cannot be sealed');
    assert.deepEqual(saved, [], 'nothing oversize is sent to the database');

    // Emoji are counted the database's way: 20,000 of them still fit and still save.
    await act(async () => {
      setNativeValue(bodyInput, '😀'.repeat(20_000));
    });
    assert.equal(document.querySelector('[data-epistle-overflow]'), null, 'a letter of emoji is not judged twice as long');
    assert.equal(document.querySelector('[data-epistle-seal-start]').disabled, false);
    await waitFor(() => saved.length > 0, 'the emoji letter saves');
    assert.deepEqual(errors, [], 'no error was ever raised at the writer');
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});

// A couple does not sign letters the way a form does. "love, Ana", "always, your Angel",
// a nickname only the two of them use — the last line is theirs to write, so the paper
// must not paste a name on after it.
test('epistle UI: the letter is never signed for the writer', async () => {
  const dom = setupDom();
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const root = createRoot(document.getElementById('root'));
  try {
    const { LetterPaper } = await server.ssrLoadModule('/src/components/epistle/LetterPaper.tsx');
    await act(async () => {
      root.render(React.createElement(LetterPaper, {
        letter: letter({ title: 'The long way home', body: 'My dearest Alice,\n\nThe distance is only geography.\n\nlove, your Angel' }),
        dateline: 'Lagos, Nigeria · 19 October 2026',
      }));
    });
    const paper = document.querySelector('[data-component="epistle-letter"]');
    assert.ok(paper, 'the paper renders');
    assert.equal(document.querySelector('.epistle-letter-sign'), null, 'no sign-off line is added');
    assert.equal(paper.textContent.includes('— Bob'), false, 'and certainly not the writer\'s account name');
    assert.match(paper.textContent, /love, your Angel/, 'the way they closed it is kept exactly as written');
    assert.match(paper.textContent, /The long way home/);
    assert.match(paper.textContent, /Sealed /, 'the sealed line under the words is still there');
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
