-- Word Wheel: one shared seven-letter wheel, a fixed hidden-word list, and a timed
-- sixty-second-to-five-minute race between the couple.
--
-- Puzzles are prepared ahead of time (scripts/build-word-puzzles.mjs) and uploaded by
-- supabase/seed/word_puzzles.sql. This migration owns the round, the ready handshake,
-- the server start time, word validation and the result comparison. The phone may run
-- its own countdown, but it never gets to declare a winner: the database only counts
-- words that are in the round's hidden list.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.game_matches') IS NULL
     OR to_regclass('public.couples') IS NULL
     OR to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'Apply the Games and pairing migrations before 202610190001_word_wheel.sql.';
  END IF;
  IF to_regprocedure('public.dash_view(jsonb,uuid,boolean,uuid,uuid,text,text)') IS NULL
     OR to_regprocedure('public.get_user_couple_id(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Apply 202610180009_dash_duel.sql before 202610190001_word_wheel.sql.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Puzzle bank
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.word_puzzles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  letters text NOT NULL CHECK (letters ~ '^[a-z]{7}$'),
  base_word text NOT NULL CHECK (base_word ~ '^[a-z]{7}$'),
  -- Union of every word used by the packs. Kept as a simple vocabulary record;
  -- the round only ever deals `packs`.
  words text[] NOT NULL DEFAULT '{}'::text[],
  -- {"easy":{"60":[...],"180":[...],"300":[...]},"medium":{...},"hard":{...}}
  -- Each list is the complete hidden-word set for that difficulty and duration.
  packs jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS word_puzzles_base_word_key ON public.word_puzzles(base_word);
ALTER TABLE public.word_puzzles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.word_puzzles FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Rounds
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.word_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id uuid NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
  puzzle_id uuid NOT NULL REFERENCES public.word_puzzles(id) ON DELETE RESTRICT,
  difficulty text NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
  duration_seconds integer NOT NULL CHECK (duration_seconds IN (60,180,300)),
  letters text NOT NULL CHECK (letters ~ '^[a-z]{7}$'),
  grand_word text NOT NULL CHECK (grand_word ~ '^[a-z]{7}$'),
  -- Exact hidden words for this round, chosen when the round is created. Both phones
  -- receive this same immutable list so they can give instant swipe feedback.
  words text[] NOT NULL CHECK (cardinality(words) BETWEEN 2 AND 24),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  player_x uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  player_o uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','running','finished','cancelled')),
  start_at timestamptz,
  finished_at timestamptz,
  winner_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT word_rounds_players_distinct CHECK (player_x <> player_o),
  CONSTRAINT word_rounds_started_has_time CHECK (status <> 'running' OR start_at IS NOT NULL)
);
-- One lobby or live round per couple. A finished round is history and never blocks a
-- rematch; the couple's old rounds remain as the last-duel record.
CREATE UNIQUE INDEX IF NOT EXISTS word_one_open_round
  ON public.word_rounds(couple_id) WHERE status IN ('waiting','running');
CREATE INDEX IF NOT EXISTS word_rounds_couple_created ON public.word_rounds(couple_id, created_at DESC);
ALTER TABLE public.word_rounds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.word_rounds FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.word_round_results (
  round_id uuid NOT NULL REFERENCES public.word_rounds(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  words_found text[] NOT NULL DEFAULT '{}'::text[],
  -- Elapsed milliseconds at the player's last found word (or the end of the clock).
  -- The earlier last-word time wins a tie on word count.
  finished_ms integer CHECK (finished_ms IS NULL OR finished_ms BETWEEN 0 AND 300000),
  ready_at timestamptz,
  submitted_at timestamptz,
  PRIMARY KEY (round_id, user_id)
);
ALTER TABLE public.word_round_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.word_round_results FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.word_layout(p_words text[]) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('length', length, 'count', n) ORDER BY length), '[]'::jsonb)
  FROM (
    SELECT length(word) AS length, count(*) AS n
    FROM unnest(coalesce(p_words, '{}'::text[])) AS word
    GROUP BY length(word)
  ) grouped
$$;

-- The round as one phone sees it. Words are deliberately included: this is a couples
-- game, the puzzle is shared, and instant local feedback matters more than hiding the
-- answer from DevTools. The database still validates every submitted word.
CREATE OR REPLACE FUNCTION public.word_view(p_round public.word_rounds, p_uid uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  partner uuid := CASE WHEN p_round.player_x = p_uid THEN p_round.player_o ELSE p_round.player_x END;
  mine public.word_round_results;
  theirs public.word_round_results;
  reveal boolean := p_round.status = 'finished';
BEGIN
  SELECT * INTO mine FROM public.word_round_results
   WHERE round_id = p_round.id AND user_id = p_uid;
  SELECT * INTO theirs FROM public.word_round_results
   WHERE round_id = p_round.id AND user_id = partner;
  RETURN jsonb_build_object(
    'letters', p_round.letters,
    'difficulty', p_round.difficulty,
    'duration_seconds', p_round.duration_seconds,
    'grand_word', p_round.grand_word,
    'words', to_jsonb(p_round.words),
    'layout', public.word_layout(p_round.words),
    'words_total', cardinality(p_round.words),
    'status', p_round.status,
    'start_at', p_round.start_at,
    'server_now', now(),
    'created_by', p_round.created_by,
    'winner_id', p_round.winner_id,
    'mine', jsonb_build_object(
      'ready', mine.ready_at IS NOT NULL,
      'ready_at', mine.ready_at,
      'submitted', mine.submitted_at IS NOT NULL,
      'words', to_jsonb(coalesce(mine.words_found, '{}'::text[])),
      'count', coalesce(cardinality(mine.words_found), 0),
      'finished_ms', mine.finished_ms
    ),
    -- The partner's words and time stay sealed until the round is settled. Before
    -- that the phone only learns whether they have readied or submitted.
    'partner', jsonb_build_object(
      'ready', theirs.ready_at IS NOT NULL,
      'ready_at', CASE WHEN reveal THEN theirs.ready_at END,
      'submitted', theirs.submitted_at IS NOT NULL,
      'words', CASE WHEN reveal THEN to_jsonb(coalesce(theirs.words_found, '{}'::text[])) ELSE '[]'::jsonb END,
      'count', CASE WHEN reveal THEN coalesce(cardinality(theirs.words_found), 0) ELSE 0 END,
      'finished_ms', CASE WHEN reveal THEN theirs.finished_ms END
    )
  );
END $$;

-- Compare two finished attempts: most words, then the earlier last-word time. Equal
-- counts and equal times are a draw.
CREATE OR REPLACE FUNCTION public.word_settle(p_id uuid) RETURNS public.word_rounds
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r public.word_rounds;
  a public.word_round_results;
  b public.word_round_results;
  a_count integer;
  b_count integer;
  victor uuid;
BEGIN
  SELECT * INTO r FROM public.word_rounds WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'running' THEN RETURN r; END IF;
  IF EXISTS (SELECT 1 FROM public.word_round_results WHERE round_id = p_id AND submitted_at IS NULL) THEN
    RETURN r;
  END IF;
  SELECT * INTO a FROM public.word_round_results WHERE round_id = p_id AND user_id = r.player_x;
  SELECT * INTO b FROM public.word_round_results WHERE round_id = p_id AND user_id = r.player_o;
  a_count := coalesce(cardinality(a.words_found), 0);
  b_count := coalesce(cardinality(b.words_found), 0);
  IF a_count > b_count THEN victor := r.player_x;
  ELSIF b_count > a_count THEN victor := r.player_o;
  ELSIF coalesce(a.finished_ms, r.duration_seconds * 1000) < coalesce(b.finished_ms, r.duration_seconds * 1000) THEN victor := r.player_x;
  ELSIF coalesce(b.finished_ms, r.duration_seconds * 1000) < coalesce(a.finished_ms, r.duration_seconds * 1000) THEN victor := r.player_o;
  ELSE victor := NULL;
  END IF;
  UPDATE public.word_rounds
     SET status = 'finished', winner_id = victor, finished_at = now()
   WHERE id = p_id
   RETURNING * INTO r;
  RETURN r;
END $$;

-- Housekeeping, called inside games_state so neither phone needs a timer of its own.
-- A lobby nobody accepted is dropped after half an hour. A live round whose deadline
-- passed plus a network grace window is settled with whatever each phone managed to
-- submit (a phone that never reported counts as zero words).
CREATE OR REPLACE FUNCTION public.word_sweep(p_couple uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.word_rounds;
BEGIN
  UPDATE public.word_rounds
     SET status = 'cancelled', finished_at = now()
   WHERE couple_id = p_couple AND status = 'waiting' AND created_at < now() - interval '30 minutes';
  FOR r IN
    SELECT * FROM public.word_rounds
     WHERE couple_id = p_couple AND status = 'running'
       AND start_at + make_interval(secs => duration_seconds) + interval '45 seconds' < now()
     FOR UPDATE
  LOOP
    INSERT INTO public.word_round_results (round_id, user_id, words_found, finished_ms, submitted_at)
    VALUES (r.id, r.player_x, '{}'::text[], r.duration_seconds * 1000, now()),
           (r.id, r.player_o, '{}'::text[], r.duration_seconds * 1000, now())
    ON CONFLICT (round_id, user_id) DO UPDATE
      SET submitted_at = coalesce(public.word_round_results.submitted_at, EXCLUDED.submitted_at),
          finished_ms = coalesce(public.word_round_results.finished_ms, EXCLUDED.finished_ms);
    PERFORM public.word_settle(r.id);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_word_round(p_difficulty text, p_seconds integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cid uuid := public.get_user_couple_id(auth.uid());
  partner uuid;
  mid uuid;
  lvl text := p_difficulty;
  sec text := p_seconds::text;
  puzzle public.word_puzzles;
  targets text[];
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  IF p_difficulty IS NULL OR p_difficulty NOT IN ('easy','medium','hard')
     OR p_seconds IS NULL OR p_seconds NOT IN (60,180,300) THEN
    RAISE EXCEPTION 'Choose Easy, Medium or Hard and a 1, 3 or 5 minute round.';
  END IF;
  PERFORM 1 FROM public.couples WHERE id = cid FOR UPDATE;
  SELECT id INTO partner FROM public.profiles WHERE couple_id = cid AND id <> auth.uid();
  IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;

  -- An open lobby or live round is the couple's round; reopening resumes it rather
  -- than silently replacing the puzzle underneath the other phone.
  SELECT id INTO mid FROM public.word_rounds
   WHERE couple_id = cid AND status IN ('waiting','running') LIMIT 1;
  IF mid IS NOT NULL THEN RETURN mid; END IF;

  SELECT * INTO puzzle FROM public.word_puzzles p
   WHERE p.packs ? lvl
     AND p.packs -> lvl ? sec
     AND jsonb_array_length(p.packs -> lvl -> sec) > 0
   ORDER BY
     (p.id IN (SELECT puzzle_id FROM public.word_rounds
                WHERE couple_id = cid AND created_at > now() - interval '60 days')) ASC,
     random()
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No Word Wheel puzzles are installed. Run supabase/seed/word_puzzles.sql.';
  END IF;

  targets := ARRAY(SELECT jsonb_array_elements_text(puzzle.packs -> lvl -> sec));
  INSERT INTO public.word_rounds
    (couple_id, puzzle_id, difficulty, duration_seconds, letters, grand_word, words, created_by, player_x, player_o)
  VALUES
    (cid, puzzle.id, p_difficulty, p_seconds, puzzle.letters, puzzle.base_word, targets, auth.uid(), auth.uid(), partner)
  RETURNING id INTO mid;

  INSERT INTO public.word_round_results (round_id, user_id)
  VALUES (mid, auth.uid()), (mid, partner);
  RETURN mid;
END $$;

-- One phone says it is ready. When both are ready the server sets one shared start
-- time a few seconds ahead; both countdowns then use that exact timestamp.
CREATE OR REPLACE FUNCTION public.word_ready(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cid uuid := public.get_user_couple_id(auth.uid());
  r public.word_rounds;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT * INTO r FROM public.word_rounds WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Word Wheel round not found.'; END IF;
  IF auth.uid() NOT IN (r.player_x, r.player_o) THEN RAISE EXCEPTION 'This is not your round.'; END IF;
  IF r.status = 'cancelled' THEN RAISE EXCEPTION 'This round was cancelled.'; END IF;
  IF r.status = 'finished' THEN RETURN public.word_view(r, auth.uid()); END IF;

  UPDATE public.word_round_results SET ready_at = coalesce(ready_at, now())
   WHERE round_id = r.id AND user_id = auth.uid();

  IF r.status = 'waiting' AND NOT EXISTS (
    SELECT 1 FROM public.word_round_results
     WHERE round_id = r.id AND user_id IN (r.player_x, r.player_o) AND ready_at IS NULL
  ) THEN
    UPDATE public.word_rounds
       SET status = 'running', start_at = now() + interval '8 seconds'
     WHERE id = r.id
     RETURNING * INTO r;
  END IF;
  RETURN public.word_view(r, auth.uid());
END $$;

-- A phone reports the words it found and the elapsed time of its last find. Only
-- words from this round's hidden list survive; duplicates are ignored. A retry after
-- the result is stored never changes the score.
CREATE OR REPLACE FUNCTION public.word_submit(p_id uuid, p_words text[], p_finished_ms integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cid uuid := public.get_user_couple_id(auth.uid());
  r public.word_rounds;
  mine public.word_round_results;
  clean text[];
  elapsed integer;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT * INTO r FROM public.word_rounds WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Word Wheel round not found.'; END IF;
  IF auth.uid() NOT IN (r.player_x, r.player_o) THEN RAISE EXCEPTION 'This is not your round.'; END IF;
  IF r.status = 'cancelled' THEN RAISE EXCEPTION 'This round was cancelled.'; END IF;
  IF r.status = 'finished' THEN RETURN public.word_view(r, auth.uid()); END IF;
  IF r.status = 'waiting' OR r.start_at IS NULL THEN RAISE EXCEPTION 'The round has not started yet.'; END IF;
  IF now() < r.start_at THEN RAISE EXCEPTION 'The round has not started yet.'; END IF;

  SELECT * INTO mine FROM public.word_round_results
   WHERE round_id = r.id AND user_id = auth.uid() FOR UPDATE;
  IF mine.submitted_at IS NOT NULL THEN RETURN public.word_view(r, auth.uid()); END IF;

  clean := ARRAY(
    SELECT DISTINCT lower(word)
      FROM unnest(coalesce(p_words, '{}'::text[])) AS word
     WHERE lower(word) = ANY(r.words)
       AND lower(word) ~ '^[a-z]{2,7}$'
  );

  elapsed := least(
    greatest(
      coalesce(p_finished_ms, floor(extract(epoch FROM (now() - r.start_at)) * 1000)::integer),
      0
    ),
    r.duration_seconds * 1000
  );

  UPDATE public.word_round_results
     SET words_found = clean, finished_ms = elapsed, submitted_at = now()
   WHERE round_id = r.id AND user_id = auth.uid();

  PERFORM public.word_settle(r.id);
  SELECT * INTO r FROM public.word_rounds WHERE id = r.id;
  RETURN public.word_view(r, auth.uid());
END $$;

-- Either partner can drop a lobby before it starts. A live round cannot be cancelled.
CREATE OR REPLACE FUNCTION public.word_cancel(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cid uuid := public.get_user_couple_id(auth.uid());
  r public.word_rounds;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT * INTO r FROM public.word_rounds WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Word Wheel round not found.'; END IF;
  IF auth.uid() NOT IN (r.player_x, r.player_o) THEN RAISE EXCEPTION 'This is not your round.'; END IF;
  IF r.status <> 'waiting' THEN RAISE EXCEPTION 'This round has already started.'; END IF;
  UPDATE public.word_rounds SET status = 'cancelled', finished_at = now()
   WHERE id = r.id RETURNING * INTO r;
  RETURN public.word_view(r, auth.uid());
END $$;

-- ---------------------------------------------------------------------------
-- Games snapshot: word rounds ride in the same list as the other games, so ongoing
-- cards, the Games badge, Last duel and rematches all keep working.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.games_state() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); result jsonb;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM public.snake_sweep(cid);
  PERFORM public.tetris_sweep(cid);
  PERFORM public.dash_sweep(cid);
  PERFORM public.word_sweep(cid);
  SELECT jsonb_build_object(
    'wins',(SELECT coalesce(jsonb_object_agg(winner_id,total),'{}'::jsonb) FROM (
      SELECT winner_id,sum(n) AS total FROM (
        SELECT winner_id,count(*) AS n FROM public.game_matches
         WHERE couple_id=cid AND finished AND winner_id IS NOT NULL GROUP BY winner_id
        UNION ALL
        SELECT winner_id,count(*) AS n FROM public.word_rounds
         WHERE couple_id=cid AND status='finished' AND winner_id IS NOT NULL GROUP BY winner_id
      ) unioned GROUP BY winner_id
    ) w),
    'matches',coalesce((SELECT jsonb_agg(safe ORDER BY created_at DESC) FROM (
      SELECT created_at,safe FROM (
        SELECT m.created_at,(to_jsonb(m)-'pick_x'-'pick_o'-'snake'-'chess'-'tetris'-'dash') || jsonb_build_object(
          'my_pick',CASE WHEN auth.uid()=player_x THEN pick_x ELSE pick_o END,
          'partner_locked',CASE WHEN auth.uid()=player_x THEN pick_o IS NOT NULL ELSE pick_x IS NOT NULL END,
          'snake',CASE WHEN m.game='snake' THEN public.snake_view(m.snake,auth.uid(),m.finished,m.player_x,m.player_o) END,
          'chess',CASE WHEN m.game='chess' THEN public.chess_view(m.chess) END,
          'tetris',CASE WHEN m.game='tetris' THEN public.tetris_view(m.tetris,auth.uid(),m.finished,m.player_x,m.player_o,m.tetris_mode) END,
          'dash',CASE WHEN m.game='dash-duel' THEN public.dash_view(m.dash,auth.uid(),m.finished,m.player_x,m.player_o,m.dash_mode,m.dash_level) END
        ) AS safe
        FROM public.game_matches m WHERE m.couple_id=cid AND (NOT m.finished OR m.id IN
          (SELECT id FROM public.game_matches WHERE couple_id=cid ORDER BY created_at DESC LIMIT 30))
        UNION ALL
        SELECT r.created_at,jsonb_build_object(
          'id',r.id,
          'couple_id',r.couple_id,
          'game','word-wheel',
          'player_x',r.player_x,
          'player_o',r.player_o,
          'turn_id',r.player_x,
          'best_of',1,
          'round',1,
          'score_x',coalesce((SELECT cardinality(words_found) FROM public.word_round_results
                               WHERE round_id=r.id AND user_id=r.player_x),0),
          'score_o',coalesce((SELECT cardinality(words_found) FROM public.word_round_results
                               WHERE round_id=r.id AND user_id=r.player_o),0),
          'my_pick',NULL,
          'partner_locked',false,
          'finished',(r.status='finished'),
          'winner_id',r.winner_id,
          'rounds','[]'::jsonb,
          'created_at',r.created_at,
          'word',public.word_view(r,auth.uid())
        ) AS safe
        FROM public.word_rounds r
        WHERE r.couple_id=cid AND r.status<>'cancelled'
          AND (r.status IN ('waiting','running') OR r.id IN
            (SELECT id FROM public.word_rounds WHERE couple_id=cid AND status<>'cancelled'
              ORDER BY created_at DESC LIMIT 30))
      ) combined
    ) recent),'[]'::jsonb)
  ) INTO result;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.word_layout(text[]),public.word_view(public.word_rounds,uuid),
  public.word_settle(uuid),public.word_sweep(uuid),public.start_word_round(text,integer),
  public.word_ready(uuid),public.word_submit(uuid,text[],integer),public.word_cancel(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.start_word_round(text,integer),public.word_ready(uuid),
  public.word_submit(uuid,text[],integer),public.word_cancel(uuid),
  public.games_state() TO authenticated;

COMMIT;
