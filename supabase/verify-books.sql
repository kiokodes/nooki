-- Read-only books preflight; run after verify.sql and migrations 008 + 009.
BEGIN TRANSACTION READ ONLY;
DO $$
BEGIN
  IF to_regclass('public.shared_books') IS NULL
     OR to_regclass('public.reading_progress') IS NULL
     OR to_regclass('public.highlights') IS NULL THEN
    RAISE EXCEPTION 'Apply supabase/migrations/202610150008_shared_books.sql before deploying books.';
  END IF;

  -- The shelf is private: only the couple reads/writes it, never anon.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.shared_books'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.reading_progress'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.highlights'::regclass)
     OR has_table_privilege('anon', 'public.shared_books', 'SELECT')
     OR has_table_privilege('anon', 'public.reading_progress', 'SELECT')
     OR has_table_privilege('anon', 'public.highlights', 'SELECT') THEN
    RAISE EXCEPTION 'Books must stay couple-private: rerun migration 008.';
  END IF;

  -- One active book per couple: a unique partial index on couple_id WHERE status='reading'.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'shared_books'
      AND indexdef ILIKE '%UNIQUE%'
      AND indexdef LIKE '%couple_id%'
      AND indexdef ILIKE '%status%reading%'
  ) THEN
    RAISE EXCEPTION 'The one-active-book index is missing: rerun migration 008.';
  END IF;

  -- Two-book shelf limit: the BEFORE INSERT trigger from migration 009.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'shared_books_guard_limit'
      AND tgisinternal = false
  ) THEN
    RAISE EXCEPTION 'The two-book shelf limit trigger is missing: rerun migration 009.';
  END IF;

  -- The chat bridge: messages.highlight_id, and the definer-side couple check.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'highlight_id'
  ) THEN
    RAISE EXCEPTION 'messages.highlight_id is missing: rerun migration 008.';
  END IF;
  IF to_regprocedure('public.highlight_is_in_couple(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Missing the highlight couple check: rerun migration 008.';
  END IF;

  -- Storage, where the schema exists (a bare database gets the bucket at first deploy).
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'shared-books' AND public = false) THEN
      RAISE EXCEPTION 'The shared-books bucket must exist and stay private: rerun migration 008.';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects'
        AND policyname = 'Couple members can read their book files'
    ) THEN
      RAISE EXCEPTION 'The couple-scoped storage policies are missing: rerun migration 008.';
    END IF;
  END IF;
END $$;
SELECT 'PASS: shared books, progress, highlights, the two-book shelf limit and the private book bucket are configured. Test both devices before release.' AS result;
COMMIT;
