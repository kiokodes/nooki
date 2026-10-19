-- Word Wheel v2: each partner gets an independent timer, while practice runs stay
-- entirely local to the phone. The couple still shares one immutable puzzle.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.word_rounds') IS NULL
     OR to_regclass('public.word_round_results') IS NULL
     OR to_regprocedure('public.word_view(public.word_rounds,uuid)') IS NULL
     OR to_regprocedure('public.word_settle(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Apply supabase/migrations/202610190001_word_wheel.sql before 202610190003_word_wheel_async_practice.sql.';
  END IF;
END $$;

-- The shared round start remains as a v1/history field. New attempts use this
-- per-player timestamp, so one person's timer can never start the partner's clock.
ALTER TABLE public.word_round_results
  ADD COLUMN IF NOT EXISTS started_at timestamptz;

-- Keep already-running and completed v1 rounds replayable with their original
-- shared start. A waiting v1 lobby has not started either clock yet.
UPDATE public.word_round_results AS result
   SET started_at = rounds.start_at
  FROM public.word_rounds AS rounds
 WHERE result.round_id = rounds.id
   AND rounds.status IN ('running','finished')
   AND rounds.start_at IS NOT NULL
   AND result.started_at IS NULL;

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
      'started', mine.started_at IS NOT NULL,
      'started_at', mine.started_at,
      'submitted', mine.submitted_at IS NOT NULL,
      'words', to_jsonb(coalesce(mine.words_found, '{}'::text[])),
      'count', coalesce(cardinality(mine.words_found), 0),
      'finished_ms', mine.finished_ms
    ),
    -- The partner's score, words and exact time stay sealed until settlement. Their
    -- started flag is public so the UI can say whether the asynchronous attempt began.
    'partner', jsonb_build_object(
      'ready', theirs.ready_at IS NOT NULL,
      'ready_at', CASE WHEN reveal THEN theirs.ready_at END,
      'started', theirs.started_at IS NOT NULL,
      'started_at', CASE WHEN reveal THEN theirs.started_at END,
      'submitted', theirs.submitted_at IS NOT NULL,
      'words', CASE WHEN reveal THEN to_jsonb(coalesce(theirs.words_found, '{}'::text[])) ELSE '[]'::jsonb END,
      'count', CASE WHEN reveal THEN coalesce(cardinality(theirs.words_found), 0) ELSE 0 END,
      'finished_ms', CASE WHEN reveal THEN theirs.finished_ms END
    )
  );
END $$;

-- The first player may start immediately. An unstarted partner is allowed a week
-- to play; each started attempt gets its own duration plus a short network grace.
CREATE OR REPLACE FUNCTION public.word_sweep(p_couple uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.word_rounds;
BEGIN
  UPDATE public.word_rounds
     SET status = 'cancelled', finished_at = now()
   WHERE couple_id = p_couple AND status = 'waiting'
     AND created_at < now() - interval '7 days';

  FOR r IN
    SELECT * FROM public.word_rounds
     WHERE couple_id = p_couple AND status = 'running'
     FOR UPDATE
  LOOP
    -- A started run that never reports by its own deadline + grace is zero-filled.
    UPDATE public.word_round_results
       SET words_found = '{}'::text[],
           finished_ms = r.duration_seconds * 1000,
           submitted_at = now()
     WHERE round_id = r.id
       AND submitted_at IS NULL
       AND started_at IS NOT NULL
       AND started_at + make_interval(secs => r.duration_seconds) + interval '45 seconds' < now();

    -- If the other person never starts, close the challenge after seven days rather
    -- than allowing a dormant round to block new ones forever.
    IF r.created_at < now() - interval '7 days' THEN
      UPDATE public.word_round_results
         SET words_found = '{}'::text[],
             finished_ms = r.duration_seconds * 1000,
             submitted_at = now()
       WHERE round_id = r.id
         AND submitted_at IS NULL
         AND started_at IS NULL;
    END IF;

    PERFORM public.word_settle(r.id);
  END LOOP;
END $$;

-- The library button creates or resumes the couple's one shared puzzle. Sweep stale
-- rounds first so a new challenge can be created as soon as the old one expires.
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
  PERFORM public.word_sweep(cid);
  SELECT id INTO partner FROM public.profiles WHERE couple_id = cid AND id <> auth.uid();
  IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;

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

-- Start only the caller's clock. The couple's round becomes running on the first
-- start, but the partner can wait and begin their own full-duration attempt later.
CREATE OR REPLACE FUNCTION public.word_start(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cid uuid := public.get_user_couple_id(auth.uid());
  r public.word_rounds;
  mine public.word_round_results;
  started timestamptz;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM public.word_sweep(cid);
  SELECT * INTO r FROM public.word_rounds WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Word Wheel round not found.'; END IF;
  IF auth.uid() NOT IN (r.player_x, r.player_o) THEN RAISE EXCEPTION 'This is not your round.'; END IF;
  IF r.status = 'cancelled' THEN RAISE EXCEPTION 'This round was cancelled.'; END IF;
  IF r.status = 'finished' THEN RETURN public.word_view(r, auth.uid()); END IF;

  SELECT * INTO mine FROM public.word_round_results
   WHERE round_id = r.id AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Your Word Wheel attempt was not found.'; END IF;
  IF mine.submitted_at IS NOT NULL THEN RETURN public.word_view(r, auth.uid()); END IF;

  IF mine.started_at IS NULL THEN
    started := now();
    UPDATE public.word_round_results
       SET started_at = started,
           ready_at = coalesce(ready_at, started)
     WHERE round_id = r.id AND user_id = auth.uid();
    UPDATE public.word_rounds
       SET status = 'running', start_at = coalesce(start_at, started)
     WHERE id = r.id
     RETURNING * INTO r;
  END IF;
  RETURN public.word_view(r, auth.uid());
END $$;

-- Keep the old RPC name callable for already-shipped clients. Its tap now starts that
-- player's own attempt instead of waiting for a two-phone ready handshake.
CREATE OR REPLACE FUNCTION public.word_ready(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN public.word_start(p_id);
END $$;

-- Validate and save only the caller's attempt, using their own start time and clock.
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
  PERFORM public.word_sweep(cid);
  SELECT * INTO r FROM public.word_rounds WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Word Wheel round not found.'; END IF;
  IF auth.uid() NOT IN (r.player_x, r.player_o) THEN RAISE EXCEPTION 'This is not your round.'; END IF;
  IF r.status = 'cancelled' THEN RAISE EXCEPTION 'This round was cancelled.'; END IF;
  IF r.status = 'finished' THEN RETURN public.word_view(r, auth.uid()); END IF;

  SELECT * INTO mine FROM public.word_round_results
   WHERE round_id = r.id AND user_id = auth.uid() FOR UPDATE;
  IF mine.submitted_at IS NOT NULL THEN RETURN public.word_view(r, auth.uid()); END IF;
  IF mine.started_at IS NULL THEN RAISE EXCEPTION 'Start your own Word Wheel clock first.'; END IF;
  IF now() < mine.started_at THEN RAISE EXCEPTION 'Your clock has not started yet.'; END IF;

  clean := ARRAY(
    SELECT DISTINCT lower(word)
      FROM unnest(coalesce(p_words, '{}'::text[])) AS word
     WHERE lower(word) = ANY(r.words)
       AND lower(word) ~ '^[a-z]{2,7}$'
  );

  elapsed := least(
    greatest(
      coalesce(p_finished_ms, floor(extract(epoch FROM (now() - mine.started_at)) * 1000)::integer),
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

REVOKE ALL ON FUNCTION public.word_layout(text[]),public.word_view(public.word_rounds,uuid),
  public.word_settle(uuid),public.word_sweep(uuid),public.start_word_round(text,integer),
  public.word_start(uuid),public.word_ready(uuid),public.word_submit(uuid,text[],integer),
  public.word_cancel(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.start_word_round(text,integer),public.word_start(uuid),
  public.word_ready(uuid),public.word_submit(uuid,text[],integer),public.word_cancel(uuid),
  public.games_state() TO authenticated;

COMMIT;
