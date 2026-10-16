-- Restore 'chess' in the game_matches game check on projects where it went missing.
--
-- Why this exists: the check constraint is replaced wholesale by each Games migration,
-- so its contents are whatever the *last* migration to touch it said. A project that
-- applied migration 011 (Chess) and later reran migration 010 (Snake) — as older
-- verify-games output and troubleshooting steps could lead it to — ends up with the
-- Chess functions, column and UI all present but a constraint that only allows
-- 'tic-tac-toe', 'rock-paper-scissors' and 'snake'. Starting a chess match then fails
-- at the INSERT in start_chess with:
--
--   new row for relation "game_matches" violates check constraint
--   "game_matches_game_check"
--
-- This file changes that one constraint only: no functions, tables or rows are
-- touched, existing matches (of any game) are preserved, and it is safe to run
-- more than once. It refuses to run on a project where Chess itself was never
-- installed, because widening the check without the referee would be worse.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.game_matches') IS NULL THEN
    RAISE EXCEPTION 'Apply supabase/migrations/202610150007_games.sql before repairing the game check.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'game_matches' AND column_name = 'chess'
  ) OR to_regprocedure('public.start_chess(text)') IS NULL THEN
    RAISE EXCEPTION 'Chess is not installed on this project: apply supabase/migrations/202610150011_chess.sql instead of this repair.';
  END IF;
END $$;

ALTER TABLE public.game_matches DROP CONSTRAINT IF EXISTS game_matches_game_check;
ALTER TABLE public.game_matches ADD CONSTRAINT game_matches_game_check
  CHECK (game IN ('tic-tac-toe', 'rock-paper-scissors', 'snake', 'chess'));

COMMIT;
