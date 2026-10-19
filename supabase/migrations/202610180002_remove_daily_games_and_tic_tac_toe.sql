-- Retire the daily Games challenge and Tic Tac Toe. Daily Decisions remain the one
-- daily Home activity; the Games tab contains only always-available rematches.
--
-- Existing daily-game and Tic Tac Toe rows are intentionally removed rather than kept as
-- inaccessible history. Their board/date columns and the old three-argument start RPC go
-- with them, so a client cannot accidentally revive either feature.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.game_matches') IS NULL THEN
    RAISE EXCEPTION 'Apply the Games migrations before 202610180002_remove_daily_games_and_tic_tac_toe.sql.';
  END IF;
END $$;

-- A daily match was meaningful only for the retired challenge. Its results, plus every
-- Tic Tac Toe board, leave with the feature so the shared win tally reflects current games.
-- The column is absent after the first run, so keep the cleanup rerunnable.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'game_matches' AND column_name = 'daily_date'
  ) THEN
    DELETE FROM public.game_matches WHERE game = 'tic-tac-toe' OR daily_date IS NOT NULL;
  ELSE
    DELETE FROM public.game_matches WHERE game = 'tic-tac-toe';
  END IF;
END $$;

-- The two indexes use daily_date as a predicate, so replace them before removing the
-- column. Dropping daily_date also removes its one-daily-match unique constraint.
DROP INDEX IF EXISTS public.game_one_practice;
DROP INDEX IF EXISTS public.game_one_practice_tetris;
ALTER TABLE public.game_matches DROP COLUMN IF EXISTS daily_date CASCADE;
ALTER TABLE public.game_matches DROP COLUMN IF EXISTS board;

ALTER TABLE public.game_matches DROP CONSTRAINT IF EXISTS game_matches_game_check;
ALTER TABLE public.game_matches ADD CONSTRAINT game_matches_game_check
  CHECK (game IN ('rock-paper-scissors', 'snake', 'chess', 'tetris'));

CREATE UNIQUE INDEX game_one_practice ON public.game_matches(couple_id, game)
  WHERE NOT finished AND game <> 'tetris';
CREATE UNIQUE INDEX game_one_practice_tetris ON public.game_matches(couple_id, game, tetris_mode)
  WHERE NOT finished AND game = 'tetris';

-- The former entry point accepted a daily flag. Replace it, instead of leaving an ignored
-- argument behind, so the database API makes the product decision enforceable.
DROP FUNCTION IF EXISTS public.start_game(text, boolean, integer);
CREATE OR REPLACE FUNCTION public.start_game(p_game text, p_best_of integer DEFAULT 3)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); partner uuid; mid uuid;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM 1 FROM public.couples WHERE id = cid FOR UPDATE;
  SELECT id INTO partner FROM public.profiles WHERE couple_id = cid AND id <> auth.uid();
  IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;
  IF p_game IS NULL OR p_game NOT IN ('rock-paper-scissors', 'snake')
     OR p_best_of IS NULL OR p_best_of NOT IN (3, 5) THEN
    RAISE EXCEPTION 'Invalid game settings.';
  END IF;
  SELECT id INTO mid FROM public.game_matches
   WHERE couple_id = cid AND game = p_game AND NOT finished;
  IF mid IS NOT NULL THEN RETURN mid; END IF;
  INSERT INTO public.game_matches(couple_id, game, player_x, player_o, turn_id, best_of)
  VALUES (cid, p_game, auth.uid(), partner, auth.uid(), p_best_of)
  RETURNING id INTO mid;
  RETURN mid;
END $$;

-- Rock Paper Scissors is the one game that still uses the generic move endpoint. Chess,
-- Snake and Tetris each keep their dedicated authoritative referee.
CREATE OR REPLACE FUNCTION public.play_game(p_id uuid, p_round integer, p_move text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m public.game_matches; victor uuid;
BEGIN
  SELECT * INTO m FROM public.game_matches
   WHERE id = p_id AND couple_id = public.get_user_couple_id(auth.uid()) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.'; END IF;
  IF m.finished THEN RAISE EXCEPTION 'This match is finished.'; END IF;
  IF m.game <> 'rock-paper-scissors' THEN RAISE EXCEPTION 'That game uses a dedicated referee.'; END IF;
  IF p_round IS DISTINCT FROM m.round THEN RAISE EXCEPTION 'The game changed. Try again.'; END IF;
  IF p_move IS NULL OR p_move NOT IN ('rock', 'paper', 'scissors') THEN
    RAISE EXCEPTION 'Choose rock, paper or scissors.';
  END IF;
  IF auth.uid() = m.player_x THEN
    IF m.pick_x IS NOT NULL THEN RAISE EXCEPTION 'Your pick is already locked.'; END IF;
    m.pick_x := p_move;
  ELSE
    IF m.pick_o IS NOT NULL THEN RAISE EXCEPTION 'Your pick is already locked.'; END IF;
    m.pick_o := p_move;
  END IF;
  IF m.pick_x IS NOT NULL AND m.pick_o IS NOT NULL THEN
    IF m.pick_x <> m.pick_o THEN
      IF (m.pick_x = 'rock' AND m.pick_o = 'scissors')
         OR (m.pick_x = 'paper' AND m.pick_o = 'rock')
         OR (m.pick_x = 'scissors' AND m.pick_o = 'paper') THEN
        m.score_x := m.score_x + 1; victor := m.player_x;
      ELSE
        m.score_o := m.score_o + 1; victor := m.player_o;
      END IF;
    END IF;
    m.rounds := m.rounds || jsonb_build_array(jsonb_build_object(
      'round', m.round, 'x', m.pick_x, 'o', m.pick_o, 'winner', victor));
    IF greatest(m.score_x, m.score_o) > m.best_of / 2 THEN
      m.finished := true; m.winner_id := victor;
    END IF;
    m.pick_x := NULL; m.pick_o := NULL; m.round := m.round + 1;
  END IF;
  UPDATE public.game_matches SET
    turn_id = m.turn_id, round = m.round, pick_x = m.pick_x, pick_o = m.pick_o,
    score_x = m.score_x, score_o = m.score_o, rounds = m.rounds,
    finished = m.finished, winner_id = m.winner_id
  WHERE id = m.id;
END $$;

-- Keep the library snapshot free of retired fields and records. Finished games remain
-- available through the recent-history window; open matches are always available.
CREATE OR REPLACE FUNCTION public.games_state() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); result jsonb;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM public.snake_sweep(cid);
  PERFORM public.tetris_sweep(cid);
  SELECT jsonb_build_object(
    'wins', (SELECT coalesce(jsonb_object_agg(winner_id, n), '{}'::jsonb) FROM
      (SELECT winner_id, count(*) n FROM public.game_matches
       WHERE couple_id = cid AND finished AND winner_id IS NOT NULL GROUP BY winner_id) w),
    'matches', coalesce((SELECT jsonb_agg(safe ORDER BY created_at DESC) FROM (
      SELECT created_at,
        (to_jsonb(m) - 'pick_x' - 'pick_o' - 'snake' - 'chess' - 'tetris') || jsonb_build_object(
          'my_pick', CASE WHEN auth.uid() = player_x THEN pick_x ELSE pick_o END,
          'partner_locked', CASE WHEN auth.uid() = player_x THEN pick_o IS NOT NULL ELSE pick_x IS NOT NULL END,
          'snake', CASE WHEN m.game = 'snake' THEN public.snake_view(m.snake, auth.uid(), m.finished, m.player_x, m.player_o) END,
          'chess', CASE WHEN m.game = 'chess' THEN public.chess_view(m.chess) END,
          'tetris', CASE WHEN m.game = 'tetris' THEN public.tetris_view(m.tetris, auth.uid(), m.finished, m.player_x, m.player_o, m.tetris_mode) END
        ) safe
      FROM public.game_matches m
      WHERE couple_id = cid AND (NOT finished OR id IN (
        SELECT id FROM public.game_matches WHERE couple_id = cid ORDER BY created_at DESC LIMIT 30
      ))
    ) recent), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END $$;

-- Chess and Tetris are dedicated starts, but both previously filtered on daily_date.
CREATE OR REPLACE FUNCTION public.start_chess(p_mode text DEFAULT 'classic') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); partner uuid; mid uuid;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('classic', 'capture-race', 'queen-hunt') THEN
    RAISE EXCEPTION 'Choose a chess duel: classic, capture-race or queen-hunt.';
  END IF;
  PERFORM 1 FROM public.couples WHERE id = cid FOR UPDATE;
  SELECT id INTO partner FROM public.profiles WHERE couple_id = cid AND id <> auth.uid();
  IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;
  SELECT id INTO mid FROM public.game_matches
   WHERE couple_id = cid AND game = 'chess' AND NOT finished;
  IF mid IS NOT NULL THEN RETURN mid; END IF;
  INSERT INTO public.game_matches(couple_id, game, player_x, player_o, turn_id, best_of, chess)
  VALUES (cid, 'chess', auth.uid(), partner, auth.uid(), 3, public.chess_state_json(p_mode))
  RETURNING id INTO mid;
  RETURN mid;
END $$;

CREATE OR REPLACE FUNCTION public.start_tetris(p_mode text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); partner uuid; mid uuid;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('sprint', 'survival') THEN RAISE EXCEPTION 'Invalid game settings.'; END IF;
  PERFORM 1 FROM public.couples WHERE id = cid FOR UPDATE;
  SELECT id INTO partner FROM public.profiles WHERE couple_id = cid AND id <> auth.uid();
  IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;
  SELECT id INTO mid FROM public.game_matches
   WHERE couple_id = cid AND game = 'tetris' AND NOT finished AND tetris_mode = p_mode;
  IF mid IS NOT NULL THEN RETURN mid; END IF;
  INSERT INTO public.game_matches(couple_id, game, player_x, player_o, turn_id, best_of, tetris_mode)
  VALUES (cid, 'tetris', auth.uid(), partner, auth.uid(), 3, p_mode)
  RETURNING id INTO mid;
  RETURN mid;
END $$;

REVOKE ALL ON FUNCTION public.start_game(text, integer), public.play_game(uuid, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_game(text, integer), public.play_game(uuid, integer, text)
  TO authenticated;

COMMIT;
