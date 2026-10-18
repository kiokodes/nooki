-- A run report whose answer the wire dropped is retried — and a retry can overlap the
-- next progress report, so it may hand over taps the server has already logged. Both
-- referees used to refuse the whole report for that ("out of order"), which meant a
-- finished run could never be marked done: its retry went on being refused forever, the
-- duel never settled, and it sat in the couple's ongoing games after both partners had
-- played — until the 30-second grace window swept the run away as a forfeit.
--
-- The log is the run. A tap already in it is skipped on arrival (a resend changes
-- nothing); a tap at a tick already passed that is not in the log is still out of order
-- and still refused. Runs left in that stuck state recover on the next report or the
-- next sweep — both already settle a duel the moment both runs are in.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.game_matches') IS NULL THEN
    RAISE EXCEPTION 'Apply the Games migrations before 202610180003_duel_report_retries.sql.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.snake_commit(p_id uuid, p_ticks integer, p_dirs jsonb, p_final boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  m public.game_matches;
  state jsonb; entry jsonb; changes jsonb; result jsonb;
  last_tick integer := -1; change jsonb; change_tick integer; change_dir text;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  -- A phone that went quiet for longer than the grace has already lost its run: settle that
  -- before reading anything, so a report that arrives late cannot revive it.
  PERFORM public.snake_sweep(cid);
  SELECT * INTO m FROM public.game_matches WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.'; END IF;
  IF m.game <> 'snake' THEN RAISE EXCEPTION 'That is not a snake duel.'; END IF;
  state := coalesce(m.snake, '{}'::jsonb);
  entry := state -> uid::text;
  IF entry IS NULL THEN RAISE EXCEPTION 'Start your run first.'; END IF;
  -- Someone else (or the sweep) already settled this run; report it instead of arguing.
  IF entry->>'status' <> 'running' THEN RETURN entry; END IF;
  IF m.finished THEN RETURN entry || jsonb_build_object('match_finished', true); END IF;
  IF p_ticks IS NULL OR p_ticks < 0 OR p_dirs IS NULL OR jsonb_typeof(p_dirs) <> 'array' THEN
    RAISE EXCEPTION 'That run report cannot be read.';
  END IF;
  IF p_ticks < coalesce((entry->>'ticks')::integer, 0) THEN RAISE EXCEPTION 'That run report is older than the last one.'; END IF;
  IF p_ticks > public.snake_budget((entry->>'started_at')::timestamptz) THEN RAISE EXCEPTION 'That run is moving faster than real time.'; END IF;
  changes := coalesce(entry->'dirs', '[]'::jsonb);
  IF jsonb_array_length(changes) > 0 THEN last_tick := (changes->-1->>0)::integer; END IF;
  FOR change IN SELECT value FROM jsonb_array_elements(p_dirs) LOOP
    IF jsonb_typeof(change) <> 'array' OR jsonb_array_length(change) <> 2
       OR (change->>0) !~ '^[0-9]{1,4}$' OR (change->>1) NOT IN ('up','down','left','right') THEN
      RAISE EXCEPTION 'That run report cannot be read.';
    END IF;
    change_tick := (change->>0)::integer;
    change_dir := change->>1;
    -- A report whose answer the wire dropped comes again, and the retry can overlap the
    -- next report: a turn already in the log is skipped, not argued with — the log is the
    -- run, and a resend leaves it exactly as it was. (A phone retrying a finish used to
    -- be refused outright here for turns it had already handed over, and a refused finish
    -- is a duel that never settles: it sat in the couple's ongoing games until the grace
    -- window erased the run it could not read.)
    IF change_tick <= last_tick
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(changes) logged
                    WHERE (logged->>0)::integer = change_tick AND logged->>1 = change_dir) THEN
      CONTINUE;
    END IF;
    IF change_tick <= last_tick OR change_tick >= p_ticks THEN RAISE EXCEPTION 'That run report is out of order.'; END IF;
    changes := changes || jsonb_build_array(jsonb_build_array(change_tick, change_dir));
    last_tick := change_tick;
  END LOOP;
  entry := entry || jsonb_build_object('ticks', p_ticks, 'dirs', changes, 'last_seen', now());
  IF p_final OR p_ticks >= public.snake_max_ticks() THEN
    result := public.snake_replay(entry->'foods', changes, p_ticks);
    entry := entry || jsonb_build_object('status','done',
      'score',coalesce((result->>'score')::integer, 0),
      'ended',coalesce(result->>'ended','alive'),
      'ticks',coalesce((result->>'ticks')::integer, p_ticks),'finished_at',now());
  END IF;
  UPDATE public.game_matches SET snake = state || jsonb_build_object(uid::text, entry) WHERE id = m.id;
  IF p_final OR p_ticks >= public.snake_max_ticks() THEN PERFORM public.snake_settle(m.id); END IF;
  RETURN entry;
END $$;

CREATE OR REPLACE FUNCTION public.tetris_commit(p_id uuid, p_ticks integer, p_inputs jsonb, p_final boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  m public.game_matches;
  state jsonb; entry jsonb; inputs jsonb; incoming jsonb; result jsonb;
  last_tick integer := -1; change jsonb; change_tick integer; change_act text;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  -- A phone that went quiet for longer than the grace has already lost its run: settle that
  -- before reading anything, so a report that arrives late cannot revive it.
  PERFORM public.tetris_sweep(cid);
  SELECT * INTO m FROM public.game_matches WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.'; END IF;
  IF m.game <> 'tetris' THEN RAISE EXCEPTION 'That is not a Tetris duel.'; END IF;
  state := coalesce(m.tetris, '{}'::jsonb);
  entry := state -> uid::text;
  IF entry IS NULL THEN RAISE EXCEPTION 'Start your run first.'; END IF;
  -- Someone else (or the sweep) already settled this run; report it instead of arguing.
  IF entry->>'status' <> 'running' THEN RETURN entry; END IF;
  IF m.finished THEN RETURN entry || jsonb_build_object('match_finished', true); END IF;
  IF p_ticks IS NULL OR p_ticks < 0 OR p_inputs IS NULL OR jsonb_typeof(p_inputs) <> 'array' THEN
    RAISE EXCEPTION 'That run report cannot be read.';
  END IF;
  IF p_ticks < coalesce((entry->>'ticks')::integer, 0) THEN RAISE EXCEPTION 'That run report is older than the last one.'; END IF;
  IF p_ticks > public.tetris_budget((entry->>'started_at')::timestamptz) THEN RAISE EXCEPTION 'That run is moving faster than real time.'; END IF;
  inputs := coalesce(entry->'inputs', '[]'::jsonb);
  IF jsonb_array_length(inputs) > 0 THEN last_tick := (inputs->-1->>0)::integer; END IF;
  incoming := '[]'::jsonb;
  FOR change IN SELECT value FROM jsonb_array_elements(p_inputs) LOOP
    IF jsonb_typeof(change) <> 'array' OR jsonb_array_length(change) <> 2
       OR (change->>0) !~ '^[0-9]{1,4}$' OR (change->>1) NOT IN ('left','right','rotate','down','drop') THEN
      RAISE EXCEPTION 'That run report cannot be read.';
    END IF;
    change_tick := (change->>0)::integer;
    change_act := change->>1;
    -- A report whose answer the wire dropped comes again, and the retry can overlap the
    -- next report: a tap already in the log is skipped, not argued with — the log is the
    -- run, and a resend leaves it exactly as it was. (A phone retrying a finish used to
    -- be refused outright here for taps it had already handed over, and a refused finish
    -- is a duel that never settles: it sat in the couple's ongoing games until the grace
    -- window erased the run it could not read.)
    IF change_tick <= last_tick
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(inputs) logged
                    WHERE (logged->>0)::integer = change_tick AND logged->>1 = change_act) THEN
      CONTINUE;
    END IF;
    -- Taps arrive in the order they were made, never before the last one already on file,
    -- and never for a tick the run has not reached yet.
    IF change_tick < last_tick OR change_tick >= p_ticks THEN RAISE EXCEPTION 'That run report is out of order.'; END IF;
    incoming := incoming || jsonb_build_array(jsonb_build_array(change_tick, change_act));
    last_tick := change_tick;
  END LOOP;
  inputs := inputs || incoming;
  entry := entry || jsonb_build_object('ticks', p_ticks, 'inputs', inputs, 'last_seen', now());
  IF p_final OR p_ticks >= public.tetris_max_ticks() THEN
    result := public.tetris_replay(entry->'pieces', inputs, p_ticks);
    entry := entry || jsonb_build_object('status','done',
      'score',coalesce((result->>'score')::integer, 0),
      'lines',coalesce((result->>'lines')::integer, 0),
      'ended',coalesce(result->>'ended','alive'),
      'ticks',coalesce((result->>'ticks')::integer, p_ticks),'finished_at',now());
  END IF;
  UPDATE public.game_matches SET tetris = state || jsonb_build_object(uid::text, entry) WHERE id = m.id;
  IF p_final OR p_ticks >= public.tetris_max_ticks() THEN PERFORM public.tetris_settle(m.id); END IF;
  RETURN entry;
END $$;

-- Replacing a function leaves its privileges as they were: 013 already revoked these
-- two from every phone and granted only the wrappers (snake_beat/finish, tetris_beat/
-- finish), and CREATE OR REPLACE keeps that in place. Nothing else changes.

COMMIT;
