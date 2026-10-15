import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// The Media tab's shelf card states, and the chat's quote card for shared highlights.
// Both are presentational: the database rules are covered in books-database.test.mjs.
test('media tab: read-together card, both progress bars, and the one-active-book notice', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'File', 'FileReader']) {
    globalThis[key] = dom.window[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const root = createRoot(document.getElementById('root'));
  try {
    const { MediaView } = await server.ssrLoadModule('/src/components/media/MediaView.tsx');

    const calls = [];
    const makeState = (overrides = {}) => ({
      books: [],
      progress: [],
      highlights: [],
      loading: false,
      busy: false,
      error: null,
      upload: async (file) => { calls.push(['upload', file?.name]); return null; },
      continueReading: async (id) => calls.push(['continue', id]),
      leave: async (id) => calls.push(['leave', id]),
      finish: async (id) => calls.push(['finish', id]),
      remove: async (book) => calls.push(['delete', book.id]),
      addHighlight: async () => { throw new Error('unused'); },
      saveProgress: async () => { throw new Error('unused'); },
      clearError: () => calls.push(['clearError']),
      ...overrides,
    });

    const openReader = (id) => calls.push(['openReader', id]);
    const render = (state) => act(async () => root.render(React.createElement(MediaView, {
      state,
      userId: 'me',
      userName: 'Alice',
      partnerName: 'Ana',
      onOpenReader: openReader,
    })));
    const button = (text) => [...document.querySelectorAll('button')].find((item) => item.textContent.includes(text));
    const body = () => document.body.textContent.replace(/\u2019/g, "'");

    // --- No book: "Read together" with the upload button -----------------------------
    await render(makeState());
    assert(body().includes('Read together'));
    assert(body().includes('DRM-free EPUB or PDF only'));
    assert(body().includes('40 MB'));
    assert(button('Upload book'));
    assert(document.querySelector('[data-upload-input]'), 'the file picker is wired');

    // --- One book in play: title, both progress bars, Continue reading ---------------
    const reading = {
      id: 'b1', couple_id: 'c1', title: 'The Hobbit', file_path: 'books/c1/b1.epub',
      file_type: 'epub', status: 'reading', uploaded_by: 'me', created_at: '', updated_at: '',
    };
    const paused = { ...reading, id: 'b2', title: 'Dune', status: 'left' };
    const finished = { ...reading, id: 'b3', title: 'Emma', status: 'finished' };
    await render(makeState({
      books: [reading, paused, finished],
      progress: [
        { book_id: 'b1', user_id: 'me', location: 'x', percent: 42, updated_at: '' },
        { book_id: 'b1', user_id: 'you', location: 'y', percent: 37, updated_at: '' },
      ],
    }));
    assert(body().includes('Currently reading together'));
    assert(body().includes('The Hobbit'));
    const bars = [...document.querySelectorAll('[role="progressbar"]')].map((bar) => bar.getAttribute('aria-label'));
    assert(bars.includes('Alice is at 42 percent'), 'the reader’s own place is on the card');
    assert(bars.includes('Ana is at 37 percent'), "and the partner's place too");
    assert(body().includes('Paused'));
    assert(body().includes('Finished'));
    await act(async () => button('Continue reading').click());
    assert.deepEqual(calls.pop(), ['openReader', 'b1'], 'Continue reading opens the reader');

    // --- Upload new while a book is in play: the friendly refusal --------------------
    const uploadNew = document.querySelector('[data-upload-new]');
    assert(uploadNew, 'the paused card offers Upload new');
    await act(async () => uploadNew.click());
    assert(body().includes('Leave or delete current book first.'));
    assert.equal(calls.some(([name]) => name === 'upload'), false, 'no file was even picked');

    // --- Delete asks first, then removes --------------------------------------------
    let confirmations = [];
    dom.window.confirm = (message) => { confirmations.push(message); return true; };
    await act(async () => document.querySelector('[data-delete-book="b2"]').click());
    assert.equal(confirmations.length, 1);
    assert(confirmations[0].includes('Dune'));
    assert.deepEqual(calls.pop(), ['delete', 'b2']);

    // --- An upload failure surfaces on the card --------------------------------------
    await render(makeState({
      books: [reading],
      error: 'Books can be up to 40 MB. Try a smaller file.',
    }));
    assert(body().includes('Books can be up to 40 MB'));
  } finally {
    await act(() => root.unmount());
    await server.close();
    dom.window.close();
  }
});

test('chat tab: a shared highlight quotes the passage and jumps back into the book', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'FormData', 'localStorage']) {
    globalThis[key] = dom.window[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const root = createRoot(document.getElementById('root'));
  try {
    const { ChatView } = await server.ssrLoadModule('/src/components/chat/ChatView.tsx');
    const opened = [];
    const base = {
      couple_id: 'c1',
      type: 'text',
      session_id: null,
      reply_to_id: null,
      created_at: new Date().toISOString(),
      read_at: null,
      edited_at: null,
      delivery: 'read',
    };
    const quote = 'In a hole in the ground there lived a hobbit.';
    const messages = [
      // With no comment the message content IS the quote: the card shows it once.
      { ...base, id: 'm1', sender_id: 'me', content: quote, highlight_id: 'h1' },
      // With a comment, the card quotes and the body carries the words.
      { ...base, id: 'm2', sender_id: 'you', content: 'This line!', highlight_id: 'h2' },
      // The book was deleted: the quote stays, the jump does not.
      { ...base, id: 'm3', sender_id: 'me', content: quote, highlight_id: 'h3' },
    ];
    const highlightById = {
      h1: { quote_text: quote, book_id: 'b1', book_title: 'The Hobbit' },
      h2: { quote_text: 'It is a dangerous business…', book_id: 'b1', book_title: 'The Hobbit' },
      h3: { quote_text: quote, book_id: null, book_title: null },
    };

    await act(async () => root.render(React.createElement(ChatView, {
      messages,
      currentUserId: 'me',
      partnerName: 'Ana',
      partnerOnline: true,
      partnerLastSeenAt: null,
      partnerTyping: false,
      loading: false,
      error: null,
      onSend: async () => {},
      onTyping: () => {},
      onStopTyping: () => {},
      onRetry: () => {},
      onDismissError: () => {},
      highlightById,
      onOpenHighlight: (id) => opened.push(id),
    })));

    const live = document.querySelector('[data-highlight-link="h1"]');
    assert(live, 'the quote card is tappable while the book exists');
    assert(live.textContent.includes('from The Hobbit'));
    assert(live.textContent.includes(quote));
    await act(async () => live.click());
    assert.deepEqual(opened, ['h1'], 'tapping the quote opens the book at the passage');

    const commented = document.querySelector('[data-highlight-link="h2"]');
    assert(commented.textContent.includes('It is a dangerous business'));
    assert(document.body.textContent.includes('This line!'), 'the comment rides below the quote');

    const dead = document.querySelector('[data-highlight-link-dead="h3"]');
    assert(dead, 'a deleted book keeps the quote but loses the jump');
    assert.equal(document.querySelector('[data-highlight-link="h3"]'), null);
    assert(dead.textContent.includes('Book deleted'));
    assert(dead.textContent.includes(quote));
    // With no comment, the quote is not repeated as body text under the card.
    assert.equal(document.body.textContent.split(quote).length - 1, 2,
      'the quote appears once in each surviving card, never doubled in a body');
  } finally {
    await act(() => root.unmount());
    await server.close();
    dom.window.close();
  }
});
