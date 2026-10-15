-- Enforce a strict two-book shelf limit: a couple may keep at most two books on
-- their shelf at a time, regardless of status (reading, left, or finished). To
-- upload a third book, the couple must delete one first.
--
-- This keeps the reading habit disciplined — finish the books you start.
--
-- The one-reading-per-couple unique index from migration 0008 is kept: only one
-- book may be 'reading' at a time. This migration adds the total-count guard.
BEGIN;

-- A BEFORE INSERT trigger that refuses the row when the couple already has two
-- books on the shelf. The app-level check in createBook() catches this first
-- for a friendlier message; the trigger is the safety net that a bug cannot
-- bypass.
CREATE OR REPLACE FUNCTION public.guard_book_limit()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE
  book_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO book_count
  FROM public.shared_books
  WHERE couple_id = NEW.couple_id;

  IF book_count >= 2 THEN
    RAISE EXCEPTION 'Your shelf holds 2 books at a time. Delete one to make room.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shared_books_guard_limit ON public.shared_books;
CREATE TRIGGER shared_books_guard_limit
BEFORE INSERT ON public.shared_books
FOR EACH ROW EXECUTE FUNCTION public.guard_book_limit();

COMMIT;