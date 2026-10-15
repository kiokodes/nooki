-- Run this migration on existing Supabase projects before deploying the Media tab's
-- "Read together" books feature. It is additive and safe to rerun: nothing existing is
-- modified beyond the one new nullable column on `messages` (and the guard/policy that
-- must know about it).
--
-- The same statements live at the end of supabase/schema.sql for brand-new projects.
--
-- What this adds:
--   1. shared_books     — one uploaded file per row; only ONE row per couple may sit in
--                         status 'reading' (partial unique index, so a bug cannot break
--                         the rule either).
--   2. reading_progress — one row per partner per book: where each of them is, and how
--                         far through. This powers "Jump to partner".
--   3. highlights       — quoted passages with an EPUB CFI (or PDF page + rectangles).
--                         When a book is deleted the highlight SURVIVES with book_id set
--                         to NULL: the quote stays readable in chat, but the jump back
--                         into the book is disabled because the book is gone.
--   4. messages.highlight_id — the "highlight to chat" bridge. The bubble quotes the
--                         highlight and tapping it opens the reader at that spot.
--   5. A private storage bucket (shared-books) with couple-scoped policies and a
--                         ~40 MB per-file cap, so a book is never readable by anyone
--                         outside the couple and never shareable by link.
BEGIN;

-- ============================================================================
-- 1) shared_books: the couple's shelf. One book "reading" at a time.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.shared_books (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  -- Storage path, always books/{couple_id}/{id}.{epub|pdf} so the RLS folder check can
  -- read the owning couple straight off the object name.
  file_path TEXT NOT NULL,
  file_type TEXT NOT NULL,
  -- 'reading' is the one active book; 'left' is paused; 'finished' is done but kept.
  status TEXT NOT NULL DEFAULT 'reading',
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT shared_books_title_length CHECK (char_length(btrim(title)) BETWEEN 1 AND 300),
  CONSTRAINT shared_books_file_path_length CHECK (char_length(btrim(file_path)) BETWEEN 1 AND 500),
  CONSTRAINT shared_books_file_type_check CHECK (file_type IN ('epub', 'pdf')),
  CONSTRAINT shared_books_status_check CHECK (status IN ('reading', 'left', 'finished'))
);

-- The rule that cannot break even if the app has a bug: one active book per couple.
CREATE UNIQUE INDEX IF NOT EXISTS shared_books_one_reading
  ON public.shared_books(couple_id) WHERE status = 'reading';

CREATE INDEX IF NOT EXISTS idx_shared_books_couple
  ON public.shared_books(couple_id, created_at);

ALTER TABLE public.shared_books ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Couple members can read their books" ON public.shared_books;
CREATE POLICY "Couple members can read their books" ON public.shared_books
FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

DROP POLICY IF EXISTS "Couple members can shelve books" ON public.shared_books;
CREATE POLICY "Couple members can shelve books" ON public.shared_books
FOR INSERT TO authenticated
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid())
  AND uploaded_by = auth.uid()
);

-- Either partner may pause, finish or resume a book: the shelf belongs to the couple.
DROP POLICY IF EXISTS "Couple members can change book status" ON public.shared_books;
CREATE POLICY "Couple members can change book status" ON public.shared_books
FOR UPDATE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()))
WITH CHECK (couple_id = public.get_user_couple_id(auth.uid()));

-- Deleting the row is the "Delete" action (the file goes separately, from the app).
DROP POLICY IF EXISTS "Couple members can remove books" ON public.shared_books;
CREATE POLICY "Couple members can remove books" ON public.shared_books
FOR DELETE TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

-- Which book a row points at can never move: only the title and the status are editable.
CREATE OR REPLACE FUNCTION public.guard_book_immutable()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.couple_id <> OLD.couple_id
     OR NEW.file_path <> OLD.file_path
     OR NEW.file_type <> OLD.file_type
     OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'The book file itself is fixed. Only the title and the status can change.';
  END IF;
  NEW.updated_at := timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shared_books_guard_immutable ON public.shared_books;
CREATE TRIGGER shared_books_guard_immutable
BEFORE UPDATE ON public.shared_books
FOR EACH ROW EXECUTE FUNCTION public.guard_book_immutable();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.shared_books TO authenticated;
REVOKE ALL ON public.shared_books FROM anon;

-- ============================================================================
-- 2) reading_progress: where each partner is. Debounced saves from the reader;
--    the "Jump to partner" button reads the other row and lands there.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.reading_progress (
  book_id UUID NOT NULL REFERENCES public.shared_books(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- An EPUB CFI or a PDF page reference: opaque to the database, meaningful to the
  -- reader that wrote it.
  location TEXT NOT NULL,
  -- 0..100, kept as a whole number so the card can say "42%".
  percent INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (book_id, user_id),
  CONSTRAINT reading_progress_location_length CHECK (char_length(btrim(location)) BETWEEN 1 AND 1000),
  CONSTRAINT reading_progress_percent_check CHECK (percent BETWEEN 0 AND 100)
);

ALTER TABLE public.reading_progress ENABLE ROW LEVEL SECURITY;

-- Both partners read each other's row — that is the whole point of the feature.
DROP POLICY IF EXISTS "Couple members can read book progress" ON public.reading_progress;
CREATE POLICY "Couple members can read book progress" ON public.reading_progress
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.shared_books b
  WHERE b.id = book_id AND b.couple_id = public.get_user_couple_id(auth.uid())
));

-- You may only ever write your own place in the book.
DROP POLICY IF EXISTS "Couples can save their own book progress" ON public.reading_progress;
CREATE POLICY "Couples can save their own book progress" ON public.reading_progress
FOR INSERT TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.shared_books b
    WHERE b.id = book_id AND b.couple_id = public.get_user_couple_id(auth.uid())
  )
);

DROP POLICY IF EXISTS "Couples can move their own bookmark" ON public.reading_progress;
CREATE POLICY "Couples can move their own bookmark" ON public.reading_progress
FOR UPDATE TO authenticated
USING (user_id = auth.uid())
WITH CHECK (
  user_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.shared_books b
    WHERE b.id = book_id AND b.couple_id = public.get_user_couple_id(auth.uid())
  )
);

-- The server's clock stamps the save, so "Jump to partner" always trusts the timestamp.
CREATE OR REPLACE FUNCTION public.set_reading_progress_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  NEW.updated_at := timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reading_progress_set_updated_at ON public.reading_progress;
CREATE TRIGGER reading_progress_set_updated_at
BEFORE INSERT OR UPDATE ON public.reading_progress
FOR EACH ROW EXECUTE FUNCTION public.set_reading_progress_updated_at();

GRANT SELECT, INSERT, UPDATE ON public.reading_progress TO authenticated;
REVOKE ALL ON public.reading_progress FROM anon;

-- ============================================================================
-- 3) highlights: the shared margin notes. Two colours, one per person.
--
-- book_id is ON DELETE SET NULL on purpose: deleting the book removes the file and
-- the shelf row, but a quote that reached the chat must stay readable there. The
-- orphaned highlight keeps its words and loses only its way back into the book.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.highlights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL only when the book this passage came from has been deleted.
  book_id UUID REFERENCES public.shared_books(id) ON DELETE SET NULL,
  couple_id UUID NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- EPUB: the CFI range of the selection. PDF: a page reference (the exact rectangles
  -- live in `rects` so the paint can be redrawn at any zoom).
  location TEXT NOT NULL,
  rects JSONB,
  quote_text TEXT NOT NULL,
  -- 'rose' or 'sage': one fixed colour per partner, chosen so both phones agree.
  color TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT highlights_location_length CHECK (char_length(btrim(location)) BETWEEN 1 AND 1000),
  CONSTRAINT highlights_quote_length CHECK (char_length(btrim(quote_text)) BETWEEN 1 AND 2000),
  CONSTRAINT highlights_color_check CHECK (color IN ('rose', 'sage'))
);

CREATE INDEX IF NOT EXISTS idx_highlights_book ON public.highlights(book_id) WHERE book_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_highlights_couple ON public.highlights(couple_id, created_at);

ALTER TABLE public.highlights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Couple members can read their highlights" ON public.highlights;
CREATE POLICY "Couple members can read their highlights" ON public.highlights
FOR SELECT TO authenticated
USING (couple_id = public.get_user_couple_id(auth.uid()));

DROP POLICY IF EXISTS "Couple members can highlight" ON public.highlights;
CREATE POLICY "Couple members can highlight" ON public.highlights
FOR INSERT TO authenticated
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid())
  AND user_id = auth.uid()
  AND (book_id IS NULL OR EXISTS (
    SELECT 1 FROM public.shared_books b
    WHERE b.id = book_id AND b.couple_id = public.get_user_couple_id(auth.uid())
  ))
);

-- Highlights are permanent margin notes: no update, no delete. They go away only with
-- the couple, the account, or (as orphans) when the book itself is deleted.

GRANT SELECT, INSERT ON public.highlights TO authenticated;
REVOKE ALL ON public.highlights FROM anon;

-- ============================================================================
-- 4) messages.highlight_id: "highlight to chat", and the way back ("chat to book").
--
-- The message carries the quote and the optional comment; the link points at the
-- highlight so the bubble can jump back to the passage. When the book dies the
-- highlight survives (book_id NULL), so the quote stays on the bubble and only the
-- jump is disabled.
-- ============================================================================

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS highlight_id UUID REFERENCES public.highlights(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.messages.highlight_id IS
  'The book highlight this message shares (set by "highlight to chat"). NULL for ordinary messages.';

-- The link is frozen with the rest of the message: only the read receipt and the
-- author's edit can change anything on a stored row.
CREATE OR REPLACE FUNCTION public.guard_message_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.couple_id <> OLD.couple_id
     OR NEW.sender_id IS DISTINCT FROM OLD.sender_id
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.reply_to_id IS DISTINCT FROM OLD.reply_to_id
     OR NEW.highlight_id IS DISTINCT FROM OLD.highlight_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Most of a message is frozen: only its author can edit the words, and only the recipient can stamp the receipt.';
  END IF;

  IF NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    IF OLD.sender_id IS NOT DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'You cannot mark your own message as read.';
    END IF;
    IF OLD.read_at IS NOT NULL OR NEW.read_at IS NULL THEN
      RAISE EXCEPTION 'A read receipt cannot be taken back.';
    END IF;
  END IF;

  IF NEW.content IS DISTINCT FROM OLD.content THEN
    IF OLD.sender_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'You can only edit your own messages.';
    END IF;
    -- The server stamps the edit: a phone's clock never writes edited_at.
    NEW.edited_at := timezone('utc'::text, now());
  ELSIF NEW.edited_at IS DISTINCT FROM OLD.edited_at THEN
    -- Silently keeping an edited_at the client sent would let it look forged.
    RAISE EXCEPTION 'The edit stamp only moves when the words do.';
  END IF;

  RETURN NEW;
END;
$$;

-- A highlight link may only point at a highlight inside this couple's own shelf —
-- quoting another couple's margin notes in your chat is refused row by row. The lookup
-- goes through a definer-side function by design, exactly like message_is_in_couple:
-- a policy that selects from highlights recursively would apply highlights' own read
-- policy inside itself.
CREATE OR REPLACE FUNCTION public.highlight_is_in_couple(p_highlight_id UUID, p_couple_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_highlight_id IS NOT NULL
     AND p_couple_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.highlights h
       WHERE h.id = p_highlight_id AND h.couple_id = p_couple_id
     );
$$;

DROP POLICY IF EXISTS "Couple members can send messages" ON public.messages;
CREATE POLICY "Couple members can send messages" ON public.messages
FOR INSERT TO authenticated
WITH CHECK (
  couple_id = public.get_user_couple_id(auth.uid())
  AND (sender_id = auth.uid() OR (sender_id IS NULL AND type = 'system'))
  AND (session_id IS NULL OR public.get_session_couple_id(session_id) = couple_id)
  AND (reply_to_id IS NULL OR public.message_is_in_couple(reply_to_id, couple_id))
  AND (highlight_id IS NULL OR public.highlight_is_in_couple(highlight_id, couple_id))
);

-- ============================================================================
-- 5) Live updates: new highlights and moved bookmarks arrive without a refresh.
-- ============================================================================

ALTER TABLE public.shared_books REPLICA IDENTITY FULL;
ALTER TABLE public.reading_progress REPLICA IDENTITY FULL;
ALTER TABLE public.highlights REPLICA IDENTITY FULL;

DO $realtime$
DECLARE t TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['shared_books', 'reading_progress', 'highlights'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END
$realtime$;

-- ============================================================================
-- 6) Storage: a private bucket for the files themselves.
--
-- The path is always books/{couple_id}/{book_id}.{ext}, and the policies below read
-- the couple straight off that folder name: only the two partners can upload, read
-- (via signed URLs) or delete their own book's file. The bucket is never public and
-- nothing here creates a shareable link.
--
-- The storage schema is absent on a bare database (and in the test backend), so every
-- statement is guarded and a rerun is always safe.
-- ============================================================================

DO $books_storage$
DECLARE
  has_size_limit BOOLEAN;
  has_mime_types BOOLEAN;
BEGIN
  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO storage.buckets (id, name, public)
  VALUES ('shared-books', 'shared-books', false)
  ON CONFLICT (id) DO UPDATE SET public = false;

  -- ~40 MB per file: big enough for a heavy PDF, small enough for weak mobile data.
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'file_size_limit'
  ) INTO has_size_limit;
  IF has_size_limit THEN
    EXECUTE 'UPDATE storage.buckets SET file_size_limit = 41943040 WHERE id = ''shared-books''';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'allowed_mime_types'
  ) INTO has_mime_types;
  IF has_mime_types THEN
    EXECUTE $sql$UPDATE storage.buckets
      SET allowed_mime_types = ARRAY['application/epub+zip', 'application/pdf']
      WHERE id = 'shared-books'$sql$;
  END IF;

  -- Read (for signed URLs), upload and delete are all scoped to the couple's own
  -- folder: books/{couple_id}/... — the folder name IS the couple id.
  EXECUTE 'DROP POLICY IF EXISTS "Couple members can read their book files" ON storage.objects';
  EXECUTE $sql$CREATE POLICY "Couple members can read their book files" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'shared-books'
    AND (storage.foldername(name))[1] = 'books'
    AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text
  )$sql$;

  EXECUTE 'DROP POLICY IF EXISTS "Couple members can upload their book files" ON storage.objects';
  EXECUTE $sql$CREATE POLICY "Couple members can upload their book files" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'shared-books'
    AND (storage.foldername(name))[1] = 'books'
    AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text
  )$sql$;

  EXECUTE 'DROP POLICY IF EXISTS "Couple members can delete their book files" ON storage.objects';
  EXECUTE $sql$CREATE POLICY "Couple members can delete their book files" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'shared-books'
    AND (storage.foldername(name))[1] = 'books'
    AND (storage.foldername(name))[2] = public.get_user_couple_id(auth.uid())::text
  )$sql$;
END
$books_storage$;

COMMIT;
