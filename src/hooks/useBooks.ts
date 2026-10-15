import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createBook,
  createHighlight,
  deleteBook,
  fetchHighlights,
  fetchReadingProgress,
  fetchSharedBooks,
  forgetBookBytes,
  highlightColorFor,
  newBookId,
  saveReadingProgress,
  setBookStatus,
  subscribeToBooks,
  uploadBookFile,
  validateBookFile,
  type BookFileLike,
  type BooksChannel,
} from '../lib/booksService';
import type {
  BookStatus,
  Highlight,
  ReadingProgress,
  SharedBook,
} from '../types/database';

interface UseBooksOptions {
  /** The shared couple, or null while the account is still unpaired. */
  coupleId: string | null;
  /** The signed-in account (this phone). */
  userId: string | null;
  /** The other partner, for the shared highlight colours. */
  partnerId: string | null;
}

export interface HighlightInput {
  bookId: string;
  location: string;
  quoteText: string;
  rects?: unknown;
}

export interface BooksState {
  /** The couple's shelf, newest first. */
  books: SharedBook[];
  /** Every saved place, one row per partner per book. */
  progress: ReadingProgress[];
  /** Every margin note across every book (quotes that reached the chat live here). */
  highlights: Highlight[];
  loading: boolean;
  /** A shelf action (upload / leave / finish / delete) is in flight. */
  busy: boolean;
  error: string | null;
  /** Uploads the file and shelves the book as the one active read. */
  upload: (file: Blob & BookFileLike) => Promise<SharedBook | null>;
  /** Continue reading: 'left' (or 'finished') back to 'reading'. */
  continueReading: (bookId: string) => Promise<void>;
  /** Leave: pause the book. The file and highlights stay. */
  leave: (bookId: string) => Promise<void>;
  /** Finish: the book stays on the shelf until someone deletes it. */
  finish: (bookId: string) => Promise<void>;
  /** Delete: the row and the file go; quotes already in chat stay, minus the jump. */
  remove: (book: SharedBook) => Promise<void>;
  /** Adds the margin note and returns it (the caller shares it to chat). */
  addHighlight: (input: HighlightInput) => Promise<Highlight>;
  /** Debounced saves land here from the reader. */
  saveProgress: (bookId: string, location: string, percent: number) => Promise<ReadingProgress>;
  clearError: () => void;
}

interface LoadedBooks {
  coupleId: string;
  books: SharedBook[];
  progress: ReadingProgress[];
  highlights: Highlight[];
}

/**
 * The couple's shelf, owned by the app rather than by the Media tab: a book that
 * finishes, a partner's new highlight or a moved bookmark updates the card — and
 * the unread state of the reader — without anyone refreshing.
 */
export function useBooks({ coupleId, userId, partnerId }: UseBooksOptions): BooksState {
  const [loaded, setLoaded] = useState<LoadedBooks | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const channelRef = useRef<BooksChannel | null>(null);

  const stored = useMemo<LoadedBooks>(
    () => (loaded && loaded.coupleId === coupleId
      ? loaded
      : { coupleId: coupleId ?? '', books: [], progress: [], highlights: [] }),
    [coupleId, loaded],
  );

  const apply = useCallback((forCoupleId: string, update: (current: LoadedBooks) => LoadedBooks) => {
    setLoaded((current) => update(current && current.coupleId === forCoupleId
      ? current
      : { coupleId: forCoupleId, books: [], progress: [], highlights: [] }));
  }, []);

  // --- Live shelf: uploads, status changes, bookmarks and new highlights ---------
  useEffect(() => {
    if (!coupleId) return;
    let channel: BooksChannel;
    try {
      channel = subscribeToBooks(coupleId, {
        onBookChanged: (book, deletedId) => apply(coupleId, (current) => ({
          ...current,
          books: deletedId
            ? current.books.filter((item) => item.id !== deletedId)
            : [book as SharedBook, ...current.books.filter((item) => item.id !== (book as SharedBook).id)],
        })),
        onProgressChanged: (progress) => apply(coupleId, (current) => ({
          ...current,
          progress: [progress, ...current.progress.filter((item) => !(
            item.book_id === progress.book_id && item.user_id === progress.user_id
          ))],
        })),
        onHighlightAdded: (highlight) => apply(coupleId, (current) => (
          current.highlights.some((item) => item.id === highlight.id)
            ? current
            : { ...current, highlights: [...current.highlights, highlight] }
        )),
      });
    } catch {
      // Live updates are a nicety: the shelf still works from a plain load.
      return;
    }
    channelRef.current = channel;
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [apply, coupleId]);

  // --- Initial load ---------------------------------------------------------------
  useEffect(() => {
    if (!coupleId) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const books = await fetchSharedBooks(coupleId);
        const [progress, highlights] = await Promise.all([
          fetchReadingProgress(books.map((book) => book.id)),
          fetchHighlights(coupleId),
        ]);
        if (cancelled) return;
        setLoaded({ coupleId, books, progress, highlights });
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Your books could not be loaded.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [coupleId]);

  const upload = useCallback(async (file: Blob & BookFileLike): Promise<SharedBook | null> => {
    if (!coupleId || !userId) return null;
    setBusy(true);
    try {
      // Validated and shelved BEFORE any bytes move: a couple that already has an
      // active book hears "Leave or delete current book first." without waiting for
      // a 40 MB upload to finish.
      const { fileType, title } = validateBookFile(file);
      const book = await createBook(coupleId, userId, { id: newBookId(), title, fileType });
      try {
        await uploadBookFile(book.file_path, file, fileType);
      } catch (uploadError) {
        // No file, no book: take the row back down and say what happened.
        await deleteBook(coupleId, book).catch(() => {});
        throw uploadError;
      }
      apply(coupleId, (current) => ({
        ...current,
        books: [book, ...current.books.filter((item) => item.id !== book.id)],
      }));
      setError(null);
      return book;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The book could not be uploaded.');
      return null;
    } finally {
      setBusy(false);
    }
  }, [apply, coupleId, userId]);

  const changeStatus = useCallback(async (bookId: string, status: BookStatus) => {
    if (!coupleId) return;
    setBusy(true);
    try {
      const book = await setBookStatus(coupleId, bookId, status);
      apply(coupleId, (current) => ({
        ...current,
        books: current.books.map((item) => (item.id === book.id ? book : item)),
      }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That book could not be changed.');
    } finally {
      setBusy(false);
    }
  }, [apply, coupleId]);

  const remove = useCallback(async (book: SharedBook) => {
    if (!coupleId) return;
    setBusy(true);
    try {
      await deleteBook(coupleId, book);
      forgetBookBytes(book.file_path);
      apply(coupleId, (current) => ({
        ...current,
        books: current.books.filter((item) => item.id !== book.id),
        progress: current.progress.filter((item) => item.book_id !== book.id),
      }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That book could not be deleted.');
    } finally {
      setBusy(false);
    }
  }, [apply, coupleId]);

  const addHighlight = useCallback(async (input: HighlightInput): Promise<Highlight> => {
    if (!coupleId || !userId || !partnerId) throw new Error('Please pair with your partner first.');
    const highlight = await createHighlight({
      bookId: input.bookId,
      coupleId,
      userId,
      location: input.location,
      quoteText: input.quoteText,
      rects: input.rects,
      color: highlightColorFor(userId, partnerId),
    });
    apply(coupleId, (current) => (
      current.highlights.some((item) => item.id === highlight.id)
        ? current
        : { ...current, highlights: [...current.highlights, highlight] }
    ));
    return highlight;
  }, [apply, coupleId, partnerId, userId]);

  const saveProgress = useCallback((bookId: string, location: string, percent: number) => {
    if (!coupleId || !userId) return Promise.reject(new Error('Please pair with your partner first.'));
    return saveReadingProgress(bookId, userId, location, percent).then((progress) => {
      apply(coupleId, (current) => ({
        ...current,
        progress: [progress, ...current.progress.filter((item) => !(
          item.book_id === progress.book_id && item.user_id === progress.user_id
        ))],
      }));
      return progress;
    });
  }, [apply, coupleId, userId]);

  return {
    books: stored.books,
    progress: stored.progress,
    highlights: stored.highlights,
    loading,
    busy,
    error,
    upload,
    continueReading: (bookId) => changeStatus(bookId, 'reading'),
    leave: (bookId) => changeStatus(bookId, 'left'),
    finish: (bookId) => changeStatus(bookId, 'finished'),
    remove,
    addHighlight,
    saveProgress,
    clearError: () => setError(null),
  };
}
