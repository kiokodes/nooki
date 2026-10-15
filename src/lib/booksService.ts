import { requireSupabase } from './supabaseClient';
import { describeDatabaseError } from './authService';
import type {
  BookFileType,
  BookStatus,
  Highlight,
  HighlightColor,
  ReadingProgress,
  SharedBook,
} from '../types/database';

/**
 * Storage and data for the Media tab's "Read together" shelf.
 *
 * Everything is couple-scoped and the database is what keeps it that way (see the
 * RLS policies in supabase/migrations/202610150008_shared_books.sql). The file
 * itself lives in the private `shared-books` bucket under
 * `books/{couple_id}/{book_id}.{epub|pdf}` — the folder name IS the couple id, which
 * is what the storage policies check — and is opened only through short-lived signed
 * URLs. There is deliberately no public link: a book is never shareable outside the
 * couple.
 *
 * The rules the app keeps even where a bug might not:
 *   - one book 'reading' per couple (a partial unique index refuses the second, and
 *     the error is mapped to "Leave or delete current book first.");
 *   - a deleted book takes its file and its shelf row with it, but a highlight that
 *     reached the chat survives (book_id goes NULL) so the quote stays readable and
 *     only the jump back into the book is disabled.
 */

/** The private bucket holding the couple's uploaded files. */
export const BOOKS_BUCKET = 'shared-books';

/** ~40 MB per file: big enough for a heavy PDF, small enough for weak mobile data. */
export const BOOK_MAX_BYTES = 40 * 1024 * 1024;

/** Signed URLs die quickly; the bytes are cached so a second open costs nothing. */
export const BOOK_URL_TTL_SECONDS = 60 * 60;

/** Shown whenever a file is refused — DRM-protected books won't open in any reader. */
export const BOOK_FILE_HELP = 'Please choose a DRM-free EPUB or PDF.';

/** The couple may only keep two books on the shelf at a time. */
export const MAX_BOOKS_ON_SHELF = 2;

export const SHELF_FULL_HELP = `Your shelf holds ${MAX_BOOKS_ON_SHELF} books at a time. Delete one to make room.`;

export function isBookFileType(value: string): value is BookFileType {
  return value === 'epub' || value === 'pdf';
}

/** Client-side book id, so the storage path is known before anything is uploaded. */
export function newBookId(): string {
  return crypto.randomUUID();
}

/**
 * The storage path is deterministic — books/{couple_id}/{book_id}.{ext} — so a row
 * can be created before the file is uploaded and the RLS folder check always reads
 * the owning couple straight off the object name.
 */
export function bookStoragePath(coupleId: string, bookId: string, fileType: BookFileType): string {
  return `books/${coupleId}/${bookId}.${fileType}`;
}

/** "The-Hobbit.epub" → "The Hobbit". Falls back to "Untitled book" for junk names. */
export function titleFromFileName(name: string): string {
  const base = (name || '').replace(/\.[^.]+$/, '').replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base || 'Untitled book';
}

export interface BookFileLike {
  name: string;
  size: number;
  type?: string;
}

/**
 * Checks a chosen file before any bytes move: right extension, right size. The
 * extension decides the format — mobile browsers often hand EPUBs over with an
 * empty or odd MIME type, and the extension is the honest signal.
 */
export function validateBookFile(file: BookFileLike): { fileType: BookFileType; title: string } {
  const extension = (file.name || '').toLowerCase().split('.').pop() ?? '';
  const fileType: BookFileType | null = extension === 'epub' ? 'epub' : extension === 'pdf' ? 'pdf' : null;
  if (!fileType) throw new Error(BOOK_FILE_HELP);
  if (!file.size || file.size <= 0) throw new Error('That file is empty.');
  if (file.size > BOOK_MAX_BYTES) {
    throw new Error('Books can be up to 40 MB. Try a smaller file.');
  }
  return { fileType, title: titleFromFileName(file.name) };
}

/**
 * Which of the two fixed colours a person's highlights take: the lexicographically
 * smaller account id is 'rose', the other 'sage'. Both phones compute the same
 * answer, so a passage always reads in the same colour for the same person.
 */
export function highlightColorFor(userId: string, partnerId: string): HighlightColor {
  return userId < partnerId ? 'rose' : 'sage';
}

function toSharedBook(row: Record<string, unknown>): SharedBook {
  return {
    id: String(row.id),
    couple_id: String(row.couple_id),
    title: String(row.title ?? ''),
    file_path: String(row.file_path ?? ''),
    file_type: (row.file_type as BookFileType) ?? 'epub',
    status: (row.status as BookStatus) ?? 'reading',
    uploaded_by: row.uploaded_by == null ? null : String(row.uploaded_by),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function toReadingProgress(row: Record<string, unknown>): ReadingProgress {
  return {
    book_id: String(row.book_id),
    user_id: String(row.user_id),
    location: String(row.location ?? ''),
    percent: Number(row.percent ?? 0),
    updated_at: String(row.updated_at),
  };
}

function toHighlight(row: Record<string, unknown>): Highlight {
  return {
    id: String(row.id),
    book_id: row.book_id == null ? null : String(row.book_id),
    couple_id: String(row.couple_id),
    user_id: String(row.user_id),
    location: String(row.location ?? ''),
    rects: (row.rects as unknown) ?? null,
    quote_text: String(row.quote_text ?? ''),
    color: (row.color as HighlightColor) ?? 'rose',
    created_at: String(row.created_at),
  };
}

/**
 * The database has two guards:
 *   - A unique index that allows only one book in status 'reading' per couple.
 *   - A trigger that limits the total shelf to two books.
 * The app-level count check in createBook() catches the shelf-full case for a
 * friendlier message; this handler covers the one-reading-per-couple index.
 */
function rethrowBookConflict(error: { message: string; code?: string }): never {
  if (error.code === '23505') throw new Error('Pause or finish the book you are reading first.');
  throw new Error(describeDatabaseError(error));
}

/**
 * Creates the shelf row first — before a single byte uploads — so a couple that
 * already has two books is told to delete one without having wasted a 40 MB upload.
 * The caller uploads the file next and removes the row again if that upload fails.
 */
export async function createBook(
  coupleId: string,
  userId: string,
  options: { id: string; title: string; fileType: BookFileType },
): Promise<SharedBook> {
  const title = options.title.trim();
  if (!title) throw new Error('Please give the book a title.');

  // The shelf holds a strict two-book maximum. Check before inserting so the user
  // gets a clear message instead of a database constraint violation.
  const { data: shelfBooks, error: countError } = await requireSupabase().from('shared_books')
    .select('id')
    .eq('couple_id', coupleId);
  if (countError) throw new Error(describeDatabaseError(countError));
  if ((shelfBooks?.length ?? 0) >= MAX_BOOKS_ON_SHELF) {
    throw new Error(SHELF_FULL_HELP);
  }

  const { data, error } = await requireSupabase().from('shared_books')
    .insert({
      id: options.id,
      couple_id: coupleId,
      title: title.slice(0, 300),
      file_path: bookStoragePath(coupleId, options.id, options.fileType),
      file_type: options.fileType,
      status: 'reading',
      uploaded_by: userId,
    })
    .select('*')
    .single();
  if (error) rethrowBookConflict(error);
  if (!data) throw new Error('The book could not be added. Please try again.');
  return toSharedBook(data as Record<string, unknown>);
}

/** The couple's shelf, newest first. */
export async function fetchSharedBooks(coupleId: string): Promise<SharedBook[]> {
  const { data, error } = await requireSupabase().from('shared_books')
    .select('*')
    .eq('couple_id', coupleId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(describeDatabaseError(error));
  return (data ?? []).map(toSharedBook);
}

/** Every saved place in every book — one row per partner per book. */
export async function fetchReadingProgress(bookIds: string[]): Promise<ReadingProgress[]> {
  if (!bookIds.length) return [];
  const { data, error } = await requireSupabase().from('reading_progress')
    .select('*')
    .in('book_id', bookIds);
  if (error) throw new Error(describeDatabaseError(error));
  return (data ?? []).map(toReadingProgress);
}

/** The couple's margin notes across every book, oldest first. */
export async function fetchHighlights(coupleId: string): Promise<Highlight[]> {
  const { data, error } = await requireSupabase().from('highlights')
    .select('*')
    .eq('couple_id', coupleId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(describeDatabaseError(error));
  return (data ?? []).map(toHighlight);
}

/**
 * Saves this phone's place in the book. Called on a debounce from the reader — not
 * on every page turn — so a flaky connection never feels like page-turn lag. The
 * database stamps `updated_at`, which "Jump to partner" then trusts.
 */
export async function saveReadingProgress(
  bookId: string,
  userId: string,
  location: string,
  percent: number,
): Promise<ReadingProgress> {
  const cleanLocation = (location || '').trim();
  if (!cleanLocation) throw new Error('Nowhere to save in this book yet.');
  const rounded = Math.round(percent);
  if (!Number.isFinite(rounded) || rounded < 0 || rounded > 100) {
    throw new Error('Progress must be between 0 and 100.');
  }
  const { data, error } = await requireSupabase().from('reading_progress')
    .upsert(
      { book_id: bookId, user_id: userId, location: cleanLocation.slice(0, 1000), percent: rounded },
      { onConflict: 'book_id,user_id' },
    )
    .select('*')
    .single();
  if (error) throw new Error(describeDatabaseError(error));
  if (!data) throw new Error('Your place in the book could not be saved.');
  return toReadingProgress(data as Record<string, unknown>);
}

/**
 * Adds the margin note. The chat message that shares it is sent separately (with
 * `highlight_id` pointing here), so a highlight and its comment land as one story.
 */
export async function createHighlight(input: {
  bookId: string;
  coupleId: string;
  userId: string;
  location: string;
  quoteText: string;
  color: HighlightColor;
  rects?: unknown;
}): Promise<Highlight> {
  const quote = input.quoteText.trim();
  if (!quote) throw new Error('Select some text to highlight first.');
  if (quote.length > 2000) throw new Error('Highlights can be up to 2000 characters.');
  const location = input.location.trim();
  if (!location) throw new Error('This highlight has no place in the book.');
  const { data, error } = await requireSupabase().from('highlights')
    .insert({
      book_id: input.bookId,
      couple_id: input.coupleId,
      user_id: input.userId,
      location: location.slice(0, 1000),
      rects: input.rects ?? null,
      quote_text: quote,
      color: input.color,
    })
    .select('*')
    .single();
  if (error) throw new Error(describeDatabaseError(error));
  if (!data) throw new Error('The highlight could not be saved.');
  return toHighlight(data as Record<string, unknown>);
}

/**
 * Leave ('left'), finish ('finished') or Continue reading ('reading'). Resuming is
 * refused while another book is in play — the same one-active-book rule as upload.
 */
export async function setBookStatus(
  coupleId: string,
  bookId: string,
  status: BookStatus,
): Promise<SharedBook> {
  const { data, error } = await requireSupabase().from('shared_books')
    .update({ status })
    .eq('id', bookId)
    .eq('couple_id', coupleId)
    .select('*');
  if (error) rethrowBookConflict(error);
  if (!data || data.length === 0) throw new Error('That book is not on your shelf.');
  return toSharedBook(data[0] as Record<string, unknown>);
}

/**
 * Delete: the shelf row goes first (the database then orphans the highlights —
 * their quotes stay readable in chat with the jump disabled), and the file is
 * removed after. A file that refuses to go is not worth failing the delete over;
 * the row is already gone and the bucket policy stops it being read anyway.
 */
export async function deleteBook(coupleId: string, book: Pick<SharedBook, 'id' | 'file_path'>): Promise<void> {
  const { error } = await requireSupabase().from('shared_books')
    .delete()
    .eq('id', book.id)
    .eq('couple_id', coupleId);
  if (error) throw new Error(describeDatabaseError(error));
  await removeBookFile(book.file_path);
}

/* -------------------------------------------------------------------------
   Storage: private bucket, signed URLs, and a local cache so a second open
   never redownloads the whole book on weak data.
   ---------------------------------------------------------------------- */

function storageApi() {
  const client = requireSupabase() as unknown as {
    storage?: { from: (bucket: string) => unknown };
  };
  return client.storage ?? null;
}

/** Uploads the bytes. Returns nothing on success and throws a readable error on failure. */
export async function uploadBookFile(
  filePath: string,
  file: Blob,
  fileType: BookFileType,
): Promise<void> {
  const storage = storageApi();
  if (!storage) throw new Error('Book storage is unavailable right now.');
  const bucket = storage.from(BOOKS_BUCKET) as {
    upload: (
      path: string,
      body: Blob,
      options?: { contentType?: string; upsert?: boolean },
    ) => Promise<{ error: { message: string } | null }>;
  };
  const { error } = await bucket.upload(filePath, file, {
    contentType: fileType === 'epub' ? 'application/epub+zip' : 'application/pdf',
    upsert: true,
  });
  if (error) throw new Error(describeDatabaseError(error));
}

/** Best-effort: the row is already gone, so a stray file must not fail the delete. */
export async function removeBookFile(filePath: string): Promise<void> {
  const storage = storageApi();
  if (!storage || !filePath) return;
  try {
    const bucket = storage.from(BOOKS_BUCKET) as {
      remove: (paths: string[]) => Promise<{ error: { message: string } | null }>;
    };
    await bucket.remove([filePath]);
  } catch {
    // The file is unreadable to everyone from now on whatever happens here.
  }
}

/** A one-hour signed URL — the only way a file ever leaves the private bucket. */
export async function fetchSignedBookUrl(filePath: string): Promise<string> {
  const storage = storageApi();
  if (!storage) throw new Error('Book storage is unavailable right now.');
  const bucket = storage.from(BOOKS_BUCKET) as {
    createSignedUrl: (path: string, ttl: number) => Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
  };
  const { data, error } = await bucket.createSignedUrl(filePath, BOOK_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    throw new Error(error ? describeDatabaseError(error) : 'The book file could not be opened.');
  }
  return data.signedUrl;
}

/** In-memory fallback where the Cache API is missing (and for tests). */
const bookBytesCache = new Map<string, ArrayBuffer>();

function cacheKey(filePath: string): string {
  return `nooki-book:${filePath}`;
}

/**
 * Downloads the file once and caches it — the Cache API when the browser has it,
 * memory otherwise. Both partners need the whole file on their own device before a
 * page can open, so the second open must cost nothing on weak data.
 */
export async function fetchBookBytes(filePath: string): Promise<ArrayBuffer> {
  const key = cacheKey(filePath);
  const memory = bookBytesCache.get(key);
  if (memory) return memory;

  try {
    if (typeof caches !== 'undefined') {
      const cache = await caches.open('nooki-books');
      const hit = await cache.match(key);
      if (hit) {
        const bytes = await hit.arrayBuffer();
        bookBytesCache.set(key, bytes);
        return bytes;
      }
    }
  } catch {
    // A missing or blocked cache just means one download per session.
  }

  const url = await fetchSignedBookUrl(filePath);
  const response = await fetch(url);
  if (!response.ok) throw new Error('The book file could not be downloaded. Please try again.');
  const bytes = await response.arrayBuffer();

  try {
    if (typeof caches !== 'undefined') {
      const cache = await caches.open('nooki-books');
      await cache.put(key, new Response(bytes.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } }));
    }
  } catch {
    // Memory caching below still keeps this session fast.
  }
  bookBytesCache.set(key, bytes);
  return bytes;
}

/** Seeds the in-memory cache from a copy already in hand (no refetch on reopen). */
export function rememberBookBytes(filePath: string, bytes: ArrayBuffer): void {
  bookBytesCache.set(cacheKey(filePath), bytes);
}

/** Drops cached bytes for a deleted book so the phone stops holding a dead file. */
export function forgetBookBytes(filePath: string): void {
  bookBytesCache.delete(cacheKey(filePath));
  try {
    if (typeof caches !== 'undefined') {
      void caches.open('nooki-books').then((cache) => cache.delete(cacheKey(filePath))).catch(() => {});
    }
  } catch {
    // Nothing to clean up where there is no Cache API.
  }
}

/* -------------------------------------------------------------------------
   Realtime: the shelf, the bookmarks and the margin notes arrive live, so
   one partner's upload / leave / finish / highlight shows up on the other
   phone without a refresh. Row-level security scopes delivery exactly as it
   scopes reads: a third account is never sent any of it.
   ---------------------------------------------------------------------- */

export interface BooksSubscriptionHandlers {
  /** A book was added or changed; `deletedId` is set when the row went away. */
  onBookChanged: (book: SharedBook | null, deletedId: string | null) => void;
  onProgressChanged: (progress: ReadingProgress) => void;
  onHighlightAdded: (highlight: Highlight) => void;
  onStatus?: (status: string) => void;
}

export interface BooksChannel {
  close: () => void;
}

export function booksTopic(coupleId: string): string {
  return `nooki-books-${coupleId}`;
}

export function subscribeToBooks(
  coupleId: string,
  handlers: BooksSubscriptionHandlers,
): BooksChannel {
  const client = requireSupabase();
  const channel = client.channel(booksTopic(coupleId), {
    config: { broadcast: { self: false } },
  });

  channel
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'shared_books', filter: `couple_id=eq.${coupleId}` },
      (payload: { eventType: string; new: Record<string, unknown> | null; old: Record<string, unknown> | null }) => {
        if (payload.eventType === 'DELETE') {
          handlers.onBookChanged(null, String(payload.old?.id ?? ''));
        } else if (payload.new) {
          handlers.onBookChanged(toSharedBook(payload.new), null);
        }
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'reading_progress' },
      (payload: { new: Record<string, unknown> | null }) => {
        if (payload.new) handlers.onProgressChanged(toReadingProgress(payload.new));
      },
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'highlights', filter: `couple_id=eq.${coupleId}` },
      (payload: { new: Record<string, unknown> | null }) => {
        if (payload.new) handlers.onHighlightAdded(toHighlight(payload.new));
      },
    )
    .subscribe((status: string) => handlers.onStatus?.(status));

  return {
    close: () => {
      const removed = client.removeChannel(channel);
      if (removed && typeof removed.catch === 'function') removed.catch(() => {});
    },
  };
}
