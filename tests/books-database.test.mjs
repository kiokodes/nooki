import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

// The shelf's rules live in the database, so most of this file is about what the
// database refuses — including with the app out of the way.
test('shared books: two-book shelf limit, one active book, progress, highlights, the chat bridge and delete', async () => {
  const server = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
    },
  });
  let backend;
  try {
    const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
    backend = await installTestBackend(supabase);
    const auth = await server.ssrLoadModule('/src/lib/authService.ts');
    const chat = await server.ssrLoadModule('/src/lib/chatService.ts');
    const books = await server.ssrLoadModule('/src/lib/booksService.ts');

    // --- Pure helpers ---------------------------------------------------------------
    assert.equal(books.titleFromFileName('The-Hobbit.epub'), 'The Hobbit');
    assert.equal(books.titleFromFileName(''), 'Untitled book');
    assert.equal(books.bookStoragePath('c1', 'b1', 'pdf'), 'books/c1/b1.pdf');
    assert.deepEqual(
      books.validateBookFile({ name: 'Pride.and.Prejudice.epub', size: 1024 }),
      { fileType: 'epub', title: 'Pride and Prejudice' },
    );
    assert.equal(books.validateBookFile({ name: 'scan.pdf', size: 2_000_000 }).fileType, 'pdf');
    assert.throws(() => books.validateBookFile({ name: 'notes.txt', size: 10 }), /DRM-free/);
    assert.throws(() => books.validateBookFile({ name: 'x.epub', size: 0 }), /empty/);
    assert.throws(() => books.validateBookFile({ name: 'x.epub', size: books.BOOK_MAX_BYTES + 1 }), /40 MB/);
    // The two colours are one per person and both phones agree: the smaller id is rose.
    assert.equal(books.highlightColorFor('aaa', 'bbb'), 'rose');
    assert.equal(books.highlightColorFor('bbb', 'aaa'), 'sage');

    // --- Alice and Bob share a shelf; Carol is a third account ----------------------
    const alice = (await auth.signUpWithEmail('alice@example.com', 'password')).user;
    await auth.saveOnboardingProfile(alice.id, { name: 'Alice', location: null, timezone: 'Africa/Lagos' });
    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, { name: 'Bob', location: null, timezone: 'Pacific/Auckland' });
    const { couple } = await auth.createCouple(bob.id, '2020-02-14');
    await auth.signInWithEmail('alice@example.com', 'password');
    await auth.joinCoupleWithCode(alice.id, couple.invite_code);
    const carol = (await auth.signUpWithEmail('carol@example.com', 'password')).user;
    await auth.saveOnboardingProfile(carol.id, { name: 'Carol', location: null, timezone: 'UTC' });

    // --- Upload: the row first, the file second --------------------------------------
    await auth.signInWithEmail('alice@example.com', 'password');
    const bookId = books.newBookId();
    const book = await books.createBook(couple.id, alice.id, {
      id: bookId,
      title: '  The Hobbit  ',
      fileType: 'epub',
    });
    assert.equal(book.title, 'The Hobbit', 'the title is trimmed');
    assert.equal(book.status, 'reading');
    assert.equal(book.file_type, 'epub');
    assert.equal(book.file_path, `books/${couple.id}/${bookId}.epub`, 'the path is books/{couple_id}/{id}.ext');
    assert.equal(book.uploaded_by, alice.id);

    // One active book per couple — the count check passes (1 < 2) but the unique
    // index on status='reading' refuses the second reading row.
    await assert.rejects(
      books.createBook(couple.id, alice.id, { id: books.newBookId(), title: 'Dune', fileType: 'epub' }),
      /Pause or finish/,
    );
    await backend.resetRole();
    await assert.rejects(
      backend.query(
        "INSERT INTO public.shared_books (couple_id, title, file_path, file_type, status, uploaded_by) VALUES ($1, 'Dune', 'books/x/dune.epub', 'epub', 'reading', $2)",
        [couple.id, alice.id],
      ),
      /duplicate key|unique/i,
      'a second reading row cannot exist even straight into the table',
    );

    // --- Leave / finish / continue ---------------------------------------------------
    const left = await books.setBookStatus(couple.id, book.id, 'left');
    assert.equal(left.status, 'left');
    // The shelf allows two books: paused + a new one.
    const second = await books.createBook(couple.id, bob.id, {
      id: books.newBookId(),
      title: 'Dune',
      fileType: 'pdf',
    });
    assert.equal(second.status, 'reading');
    assert.equal(second.file_type, 'pdf');
    // Two-book shelf limit — enforced by the database trigger and the app.
    await assert.rejects(
      books.createBook(couple.id, alice.id, { id: books.newBookId(), title: 'Emma', fileType: 'epub' }),
      /2 books at a time/,
      'a third book cannot be added until one is deleted',
    );
    // ...but the paused book cannot come back while another is in play.
    await assert.rejects(books.setBookStatus(couple.id, book.id, 'reading'), /Pause or finish/);
    const finished = await books.setBookStatus(couple.id, second.id, 'finished');
    assert.equal(finished.status, 'finished');
    const resumed = await books.setBookStatus(couple.id, book.id, 'reading');
    assert.equal(resumed.status, 'reading');

    // Carol cannot see or touch this shelf.
    await auth.signInWithEmail('carol@example.com', 'password');
    assert.deepEqual(await books.fetchSharedBooks(couple.id), []);
    await assert.rejects(books.setBookStatus(couple.id, book.id, 'finished'), /not on your shelf/);

    // --- Reading progress: one row each, save and read both ways ---------------------
    await auth.signInWithEmail('alice@example.com', 'password');
    const place = await books.saveReadingProgress(book.id, alice.id, 'epubcfi(/6/4[chap01]!/4/2/1:0)', 42);
    assert.equal(place.percent, 42);
    assert.equal(place.user_id, alice.id);
    // Saving rounds and clamps to a whole percentage.
    const rounded = await books.saveReadingProgress(book.id, alice.id, 'epubcfi(/6/8[chap02]!/4/2/1:0)', 42.6);
    assert.equal(rounded.percent, 43);
    await assert.rejects(books.saveReadingProgress(book.id, alice.id, '  ', 10), /Nowhere/);
    await assert.rejects(books.saveReadingProgress(book.id, alice.id, 'x', -5), /between 0 and 100/);
    await assert.rejects(books.saveReadingProgress(book.id, alice.id, 'x', 250), /between 0 and 100/);
    // A phone cannot save a place for anyone but itself.
    await assert.rejects(books.saveReadingProgress(book.id, bob.id, 'page:3', 10), /message|permission|policy|row/i);

    await auth.signInWithEmail('bob@example.com', 'password');
    await books.saveReadingProgress(book.id, bob.id, 'epubcfi(/6/12[chap03]!/4/2/1:0)', 12);
    // "Jump to partner" reads the other row — both partners can see both places.
    const places = await books.fetchReadingProgress([book.id, second.id]);
    assert.equal(places.length, 2, 'one row per partner');
    assert.equal(places.find((item) => item.user_id === alice.id).percent, 43);
    assert.equal(places.find((item) => item.user_id === bob.id).percent, 12);

    await auth.signInWithEmail('carol@example.com', 'password');
    assert.deepEqual(await books.fetchReadingProgress([book.id]), [], 'no third account sees the bookmarks');

    // --- Highlights: shared in the book, coloured per person -------------------------
    await auth.signInWithEmail('alice@example.com', 'password');
    const highlight = await books.createHighlight({
      bookId: book.id,
      coupleId: couple.id,
      userId: alice.id,
      location: 'epubcfi(/6/4[chap01]!/4/2/1:0,/4/2/1:30)',
      quoteText: 'In a hole in the ground there lived a hobbit.',
      color: books.highlightColorFor(alice.id, bob.id),
    });
    assert.equal(highlight.user_id, alice.id);
    assert.equal(highlight.color, books.highlightColorFor(alice.id, bob.id),
      'the colour is the person, fixed the same on both phones');
    assert.ok(highlight.color === 'rose' || highlight.color === 'sage');
    assert.equal(highlight.book_id, book.id);
    await assert.rejects(
      books.createHighlight({
        bookId: book.id,
        coupleId: couple.id,
        userId: alice.id,
        location: 'x',
        quoteText: '   ',
        color: 'rose',
      }),
      /Select some text/,
    );

    await auth.signInWithEmail('bob@example.com', 'password');
    const bobSee = await books.fetchHighlights(couple.id);
    assert.equal(bobSee.length, 1, 'the partner sees the highlight too');
    assert.equal(bobSee[0].quote_text, 'In a hole in the ground there lived a hobbit.');
    await assert.rejects(
      books.createHighlight({
        bookId: book.id,
        coupleId: couple.id,
        userId: alice.id,
        location: 'x',
        quoteText: 'Impersonation',
        color: 'rose',
      }),
      /permission|policy|row/i,
      'nobody highlights as anyone but themselves',
    );

    await auth.signInWithEmail('carol@example.com', 'password');
    assert.deepEqual(await books.fetchHighlights(couple.id), [], 'no third account reads the margin notes');

    // --- Highlight to chat: the bubble quotes the passage, the link jumps back -------
    await auth.signInWithEmail('alice@example.com', 'password');
    const shared = await chat.sendMessage(
      couple.id, alice.id, highlight.quote_text, 'text', null, null, highlight.id,
    );
    assert.equal(shared.highlight_id, highlight.id);
    assert.equal(shared.content, 'In a hole in the ground there lived a hobbit.',
      'with no comment the message carries the quote itself');

    await backend.resetRole();
    await assert.rejects(
      backend.query(
        'UPDATE public.messages SET highlight_id = NULL WHERE id = $1',
        [shared.id],
      ),
      /frozen|cannot be edited/i,
      'the highlight link is frozen with the rest of the message',
    );
    await auth.signInWithEmail('alice@example.com', 'password');

    // The link can never point at another couple's highlight.
    await auth.signInWithEmail('carol@example.com', 'password');
    const carolBook = await books.createBook(couple.id, carol.id, {
      id: books.newBookId(), title: 'Nope', fileType: 'epub',
    }).catch(() => null);
    assert.equal(carolBook, null, 'Carol is not even in this couple');
    // Carol's own couple, book and highlight — a perfectly normal shelf of her own.
    const carolCouple = (await auth.createCouple(carol.id, '2021-01-01')).couple;
    const carolHighlight = await books.createHighlight({
      bookId: (await books.createBook(carolCouple.id, carol.id, { id: books.newBookId(), title: 'Hers', fileType: 'epub' })).id,
      coupleId: carolCouple.id,
      userId: carol.id,
      location: 'x',
      quoteText: 'Her own words',
      color: 'rose',
    });
    const carolMessage = await chat.sendMessage(
      carolCouple.id, carol.id, 'Her own words', 'text', null, null, carolHighlight.id,
    );
    assert.equal(carolMessage.highlight_id, carolHighlight.id, 'her own quote shares to her own chat');
    // ...but Alice quoting from Carol's shelf is refused from both sides.
    await auth.signInWithEmail('alice@example.com', 'password');
    await assert.rejects(
      chat.sendMessage(couple.id, alice.id, 'Sneaky', 'text', null, null, carolHighlight.id),
      undefined,
      'a message cannot quote a highlight its couple does not own',
    );

    // --- Delete: the file and row go; the quote in chat stays, without the jump ------
    await books.deleteBook(couple.id, book);
    const remaining = await books.fetchSharedBooks(couple.id);
    assert.deepEqual(remaining.map((item) => item.title), ['Dune'],
      'the deleted book leaves the shelf; the other book stays');
    assert.deepEqual(await books.fetchReadingProgress([book.id]), [], 'bookmarks go with the book');

    const orphan = (await books.fetchHighlights(couple.id)).find((item) => item.id === highlight.id);
    assert.ok(orphan, 'the highlight outlives the book');
    assert.equal(orphan.book_id, null, 'but its way back into the book is gone');

    const transcript = await chat.fetchMessages(couple.id);
    const quoteMessage = transcript.find((item) => item.id === shared.id);
    assert.equal(quoteMessage.content, 'In a hole in the ground there lived a hobbit.',
      'the quoted text stays in the chat');
    assert.equal(quoteMessage.highlight_id, highlight.id,
      'and the link still resolves to the quote — just with no book to jump to');

    // A fresh upload is allowed again once the shelf has room.
    const third = await books.createBook(couple.id, alice.id, {
      id: books.newBookId(), title: 'Emma', fileType: 'epub',
    });
    assert.equal(third.status, 'reading');

    // --- Safe to rerun, and the preflight passes on a healthy project ----------------
    const migration008 = await readFile(new URL('../supabase/migrations/202610150008_shared_books.sql', import.meta.url), 'utf8');
    const migration009 = await readFile(new URL('../supabase/migrations/202610150009_two_book_shelf_limit.sql', import.meta.url), 'utf8');
    await backend.exec(migration008);
    await backend.exec(migration009);
    await backend.exec(await readFile(new URL('../supabase/verify-books.sql', import.meta.url), 'utf8'));
    await backend.rollback();
    assert.deepEqual((await books.fetchSharedBooks(couple.id)).map((item) => item.title).sort(), ['Dune', 'Emma'],
      'rerunning the migration preserves the shelf');

    // A half-applied project fails the preflight loudly.
    await backend.exec('DROP INDEX IF EXISTS public.shared_books_one_reading');
    await assert.rejects(backend.exec(await readFile(new URL('../supabase/verify-books.sql', import.meta.url), 'utf8')));
    await backend.rollback();
    await backend.exec(migration008);
    await backend.exec(migration009);
    await backend.exec(await readFile(new URL('../supabase/verify-books.sql', import.meta.url), 'utf8'));
    await backend.rollback();
  } finally {
    await backend?.rollback();
    await backend?.close();
    await server.close();
  }
});
