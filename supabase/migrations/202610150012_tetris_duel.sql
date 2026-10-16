-- Tetris duel: one ranked run each, five minutes a run, and no pause.
--
-- The point of this migration is that the *database* decides a run's score, exactly as it
-- does for the Snake duel. A Tetris run is two things only — the piece sequence the
-- database deals for the duel, and the list of taps the phone reports — and `tetris_replay`
-- walks those through the same rules as `src/lib/tetris.ts` to arrive at the same well, the
-- same score and the same top-out. A phone can therefore never hand in a score it did not
-- play, and cannot replay a better run later: the run reports are append-only, monotonic,
-- and capped at one tick per 50ms of real time.
--
-- The rules come from github.com/KPaccarizi/_Tetris_Game, a Pygame coding-challenge entry:
-- a 10×16 well, seven tetrominoes spawning at (5, 1), rotation about the piece's first
-- cell, and `{1:100, 2:300, 3:700, 4:1500}` for a clear. The reference's pygame loop is
-- rewritten here as a tick simulation so it can be replayed; three of its rough edges are
-- deliberately not carried over, and `src/lib/tetris.ts` says which.
--
-- Two ways to settle a duel, chosen when it is started and fixed for its lifetime:
--   · sprint   — the higher score after five minutes (or after topping out) wins.
--   · survival — whoever keeps stacking for longer wins; score only breaks an exact tie.
--
-- Leaving is a loss, and time never stands still, both exactly as in the Snake duel: an
-- in-app exit calls `tetris_forfeit`, a phone quiet for more than 30 seconds is swept up
-- the next time either partner reads the state, and ticks spent away are walked forward
-- with nobody steering, so a run left alone buries itself.
--
-- Everything here is RPC-only, like the rest of Games: `game_matches` still has no table
-- grants, and the snapshot never publishes an unfinished partner's score (a blind duel).
--
-- Run this after `202610150011_chess.sql`: it re-creates `games_state()`, and it carries
-- Chess along as it does — the snapshot keeps its `chess` key and the game check keeps
-- `chess` allowed. Applying it the other way round (before 011) would leave Chess unable
-- to start, so reorder the two if that is what your project needs.
BEGIN;

-- The duel lives on the same match row as the other games, so the Games tab badge, the
-- one-open-match-per-mode rule and the win scoreboard all keep working untouched.
ALTER TABLE public.game_matches DROP CONSTRAINT IF EXISTS game_matches_game_check;
ALTER TABLE public.game_matches ADD CONSTRAINT game_matches_game_check
  CHECK (game IN ('tic-tac-toe','rock-paper-scissors','snake','chess','tetris'));
ALTER TABLE public.game_matches ADD COLUMN IF NOT EXISTS tetris jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Which of the two ways this duel is settled. Null on every other game.
ALTER TABLE public.game_matches ADD COLUMN IF NOT EXISTS tetris_mode text;
ALTER TABLE public.game_matches DROP CONSTRAINT IF EXISTS game_matches_tetris_mode_check;
ALTER TABLE public.game_matches ADD CONSTRAINT game_matches_tetris_mode_check
  CHECK (tetris_mode IS NULL OR tetris_mode IN ('sprint','survival'));

-- One open practice match per couple per game is the rule the other three games keep. A
-- Tetris duel is fixed to the mode it was started in, so the rule becomes one open sprint
-- and one open survival: neither is the other's rematch, and opening one never closes it.
DROP INDEX IF EXISTS public.game_one_practice;
CREATE UNIQUE INDEX IF NOT EXISTS game_one_practice ON public.game_matches(couple_id, game)
  WHERE daily_date IS NULL AND NOT finished AND game <> 'tetris';
CREATE UNIQUE INDEX IF NOT EXISTS game_one_practice_tetris ON public.game_matches(couple_id, game, tetris_mode)
  WHERE daily_date IS NULL AND NOT finished AND game = 'tetris';

-- Mirror of src/lib/tetris.ts: a 10×16 well, 50ms a tick, five minutes to a run, thirty
-- seconds of silence before a run is lost, six hundred pieces dealt per duel.
CREATE OR REPLACE FUNCTION public.tetris_max_ticks() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 6000 $$;

-- How many ticks a run may have reported after this much real time. Six ticks of slack for
-- the round trip (300ms — a fiftieth of the run, and far less than the beat interval); the
-- run's own cap holds the ceiling.
CREATE OR REPLACE FUNCTION public.tetris_budget(p_started timestamptz) RETURNS integer
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT least(greatest(floor(extract(epoch FROM (now() - p_started)) * 1000 / 50)::integer + 6, 0), public.tetris_max_ticks())
$$;

-- Walk one side's run and return what it really scored. This is the authority: the score a
-- phone claims is never read, only this result is.
CREATE OR REPLACE FUNCTION public.tetris_replay(p_pieces jsonb, p_inputs jsonb, p_ticks integer, p_cap integer DEFAULT 6000)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  cols constant integer := 10;
  rows_ constant integer := 16;
  cap integer := least(coalesce(p_cap, public.tetris_max_ticks()), public.tetris_max_ticks());
  -- The seven tetrominoes as cell offsets from the spawn; the first cell is the pivot.
  shapes constant jsonb := '[[[-1,0],[-2,0],[0,0],[1,0]],[[0,-1],[-1,-1],[-1,0],[0,0]],[[-1,0],[-1,1],[0,0],[0,-1]],[[0,0],[-1,0],[0,1],[-1,-1]],[[0,0],[0,-1],[0,1],[-1,-1]],[[0,0],[0,-1],[0,1],[1,-1]],[[0,0],[0,-1],[0,1],[-1,0]]]'::jsonb;
  -- Ticks a piece waits before falling a row, by level. Level is one step per ten lines.
  gravity constant integer[] := ARRAY[15,13,11,10,9,8,7,6,5,4,3];
  scores constant integer[] := ARRAY[0,100,300,700,1500];
  spawn_x constant integer := 5;
  spawn_y constant integer := 1;
  max_level constant integer := 10;
  per_tick constant integer := 2;      -- taps acted on in one tick, and that may wait for it
  goal integer;
  pieces integer[];
  npiece integer := 0;
  in_tick integer[];
  in_act text[];
  ninput integer := 0;
  idx integer := 1;
  field integer[] := array_fill(0, ARRAY[160]);
  swept integer[];
  cx integer[] := ARRAY[0,0,0,0]; cy integer[] := ARRAY[0,0,0,0];
  tx integer[] := ARRAY[0,0,0,0]; ty integer[] := ARRAY[0,0,0,0];
  kind integer := 0; piece integer := 0; fall integer := 0;
  lines integer := 0; score integer := 0; ticks integer := 0;
  ended text := NULL;
  i integer; r integer; c integer; w integer; cleared integer; row_full boolean;
  act text; hit boolean; block boolean := false; queued integer; lvl integer;
  px integer; py integer; rx integer; ry integer;
BEGIN
  SELECT coalesce(array_agg((value::text)::integer ORDER BY ord), ARRAY[]::integer[]) INTO pieces
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(coalesce(p_pieces,'[]'::jsonb)) = 'array' THEN p_pieces ELSE '[]'::jsonb END) WITH ORDINALITY AS t(value, ord)
   WHERE jsonb_typeof(value) = 'number' AND value::text ~ '^[0-6]$';
  npiece := coalesce(array_length(pieces, 1), 0);
  SELECT coalesce(array_agg((value->>0)::integer ORDER BY ord), ARRAY[]::integer[]),
         coalesce(array_agg((value->>1)::text ORDER BY ord), ARRAY[]::text[])
    INTO in_tick, in_act
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(coalesce(p_inputs,'[]'::jsonb)) = 'array' THEN p_inputs ELSE '[]'::jsonb END) WITH ORDINALITY AS t(value, ord)
   WHERE jsonb_typeof(value) = 'array' AND jsonb_array_length(value) = 2
     AND (value->>0) ~ '^[0-9]{1,4}$' AND (value->>1) IN ('left','right','rotate','down','drop');
  ninput := coalesce(array_length(in_tick, 1), 0);

  goal := least(greatest(coalesce(p_ticks, 0), 0), cap);
  -- Nothing dealt means nothing played: the run is over before it starts.
  IF npiece = 0 THEN
    RETURN jsonb_build_object('score', 0, 'lines', 0, 'ticks', goal, 'ended', 'cap');
  END IF;
  kind := pieces[1];
  FOR i IN 1..4 LOOP
    cx[i] := spawn_x + (shapes -> kind -> (i-1) ->> 0)::integer;
    cy[i] := spawn_y + (shapes -> kind -> (i-1) ->> 1)::integer;
  END LOOP;

  WHILE ticks < goal AND ended IS NULL LOOP
    block := false;
    -- The taps the phone reported for this tick, oldest first, up to what its own queue
    -- could have held.
    queued := 0;
    WHILE idx <= ninput AND in_tick[idx] <= ticks AND queued < per_tick LOOP
      act := in_act[idx];
      IF act = 'left' OR act = 'right' THEN
        FOR i IN 1..4 LOOP tx[i] := cx[i] + CASE WHEN act = 'left' THEN -1 ELSE 1 END; ty[i] := cy[i]; END LOOP;
        hit := false;
        FOR i IN 1..4 LOOP IF tx[i] < 0 OR tx[i] >= cols OR ty[i] < 0 OR ty[i] >= rows_ OR field[ty[i]*cols + tx[i] + 1] <> 0 THEN hit := true; END IF; END LOOP;
        IF NOT hit THEN FOR i IN 1..4 LOOP cx[i] := tx[i]; END LOOP; END IF;
      ELSIF act = 'down' THEN
        FOR i IN 1..4 LOOP tx[i] := cx[i]; ty[i] := cy[i] + 1; END LOOP;
        hit := false;
        FOR i IN 1..4 LOOP IF tx[i] < 0 OR tx[i] >= cols OR ty[i] < 0 OR ty[i] >= rows_ OR field[ty[i]*cols + tx[i] + 1] <> 0 THEN hit := true; END IF; END LOOP;
        IF NOT hit THEN FOR i IN 1..4 LOOP cy[i] := ty[i]; END LOOP; fall := 0; END IF;
      ELSIF act = 'rotate' THEN
        px := cx[1]; py := cy[1];
        FOR i IN 1..4 LOOP rx := cx[i] - px; ry := cy[i] - py; tx[i] := px - ry; ty[i] := py + rx; END LOOP;
        hit := false;
        FOR i IN 1..4 LOOP IF tx[i] < 0 OR tx[i] >= cols OR ty[i] < 0 OR ty[i] >= rows_ OR field[ty[i]*cols + tx[i] + 1] <> 0 THEN hit := true; END IF; END LOOP;
        IF NOT hit THEN FOR i IN 1..4 LOOP cx[i] := tx[i]; cy[i] := ty[i]; END LOOP; END IF;
      ELSE                                     -- drop: slide to the floor and come to rest
        LOOP
          FOR i IN 1..4 LOOP tx[i] := cx[i]; ty[i] := cy[i] + 1; END LOOP;
          hit := false;
          FOR i IN 1..4 LOOP IF tx[i] < 0 OR tx[i] >= cols OR ty[i] < 0 OR ty[i] >= rows_ OR field[ty[i]*cols + tx[i] + 1] <> 0 THEN hit := true; END IF; END LOOP;
          EXIT WHEN hit;
          FOR i IN 1..4 LOOP cy[i] := ty[i]; END LOOP;
        END LOOP;
        block := true;
      END IF;
      idx := idx + 1;
      queued := queued + 1;
      -- One piece comes to rest per tick, so a hard drop is this tick's last word.
      EXIT WHEN block;
    END LOOP;
    -- Taps the phone's queue had no room for are dropped here, exactly as they were there.
    WHILE idx <= ninput AND in_tick[idx] <= ticks LOOP idx := idx + 1; END LOOP;

    IF NOT block THEN
      lvl := least(lines / 10, max_level);
      fall := fall + 1;
      IF fall >= gravity[lvl + 1] THEN
        FOR i IN 1..4 LOOP tx[i] := cx[i]; ty[i] := cy[i] + 1; END LOOP;
        hit := false;
        FOR i IN 1..4 LOOP IF tx[i] < 0 OR tx[i] >= cols OR ty[i] < 0 OR ty[i] >= rows_ OR field[ty[i]*cols + tx[i] + 1] <> 0 THEN hit := true; END IF; END LOOP;
        IF hit THEN block := true; ELSE FOR i IN 1..4 LOOP cy[i] := ty[i]; END LOOP; fall := 0; END IF;
      END IF;
    END IF;

    -- The one place in the whole run where a piece comes to rest.
    IF block THEN
      FOR i IN 1..4 LOOP
        IF cx[i] >= 0 AND cx[i] < cols AND cy[i] >= 0 AND cy[i] < rows_ THEN
          field[cy[i]*cols + cx[i] + 1] := kind + 1;
        END IF;
      END LOOP;
      -- Collapse from the bottom up, keeping every row that is not row_full. Rows that scroll
      -- in at the top arrive empty: the reference leaves a stale copy behind instead.
      swept := array_fill(0, ARRAY[cols * rows_]);
      w := rows_ - 1;
      cleared := 0;
      FOR r IN REVERSE (rows_ - 1)..0 LOOP
        row_full := true;
        FOR c IN 0..(cols - 1) LOOP IF field[r*cols + c + 1] = 0 THEN row_full := false; END IF; END LOOP;
        IF row_full THEN
          cleared := cleared + 1;
        ELSE
          IF w >= 0 THEN
            FOR c IN 0..(cols - 1) LOOP swept[w*cols + c + 1] := field[r*cols + c + 1]; END LOOP;
          END IF;
          w := w - 1;
        END IF;
      END LOOP;
      field := swept;
      score := score + scores[cleared + 1];
      lines := lines + cleared;
      piece := piece + 1;
      kind := pieces[(piece % npiece) + 1];
      FOR i IN 1..4 LOOP
        cx[i] := spawn_x + (shapes -> kind -> (i-1) ->> 0)::integer;
        cy[i] := spawn_y + (shapes -> kind -> (i-1) ->> 1)::integer;
      END LOOP;
      hit := false;
      FOR i IN 1..4 LOOP IF cx[i] < 0 OR cx[i] >= cols OR cy[i] < 0 OR cy[i] >= rows_ OR field[cy[i]*cols + cx[i] + 1] <> 0 THEN hit := true; END IF; END LOOP;
      IF hit THEN ended := 'top'; END IF;
    END IF;

    ticks := ticks + 1;
    IF ended IS NULL AND ticks >= cap THEN ended := 'cap'; END IF;
  END LOOP;
  RETURN jsonb_build_object('score', score, 'lines', lines, 'ticks', ticks, 'ended', ended);
END $$;

-- Decide the duel once it can be decided. Called with the match row already locked.
CREATE OR REPLACE FUNCTION public.tetris_settle(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m public.game_matches;
  x_entry jsonb; o_entry jsonb;
  x_score integer; o_score integer; x_ticks integer; o_ticks integer;
  winner uuid := NULL;
BEGIN
  SELECT * INTO m FROM public.game_matches WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR m.finished OR m.game <> 'tetris' THEN RETURN; END IF;
  x_entry := coalesce(m.tetris -> m.player_x::text, '{}'::jsonb);
  o_entry := coalesce(m.tetris -> m.player_o::text, '{}'::jsonb);
  IF x_entry->>'status' = 'forfeit' OR o_entry->>'status' = 'forfeit' THEN
    -- Leaving loses the duel there and then, whether or not the other partner has played.
    IF x_entry->>'status' = 'forfeit' AND o_entry->>'status' = 'forfeit' THEN winner := NULL;
    ELSIF x_entry->>'status' = 'forfeit' THEN winner := m.player_o;
    ELSE winner := m.player_x; END IF;
  ELSIF x_entry->>'status' = 'done' AND o_entry->>'status' = 'done' THEN
    x_score := coalesce((x_entry->>'score')::integer, 0);
    o_score := coalesce((o_entry->>'score')::integer, 0);
    IF m.tetris_mode = 'survival' THEN
      -- Whoever kept stacking longer. The score only separates two runs that lasted
      -- exactly as long, which in practice means both ran the clock out.
      x_ticks := coalesce((x_entry->>'ticks')::integer, 0);
      o_ticks := coalesce((o_entry->>'ticks')::integer, 0);
      IF x_ticks <> o_ticks THEN
        winner := CASE WHEN x_ticks > o_ticks THEN m.player_x ELSE m.player_o END;
      ELSIF x_score <> o_score THEN
        winner := CASE WHEN x_score > o_score THEN m.player_x ELSE m.player_o END;
      END IF;
    ELSE
      IF x_score > o_score THEN winner := m.player_x;
      ELSIF o_score > x_score THEN winner := m.player_o; END IF;
    END IF;
  ELSE
    RETURN;                                  -- still waiting on a run
  END IF;
  UPDATE public.game_matches SET finished = true, winner_id = winner WHERE id = m.id;
END $$;

-- Time never stands still, and the app has no server clock of its own: the sweep runs
-- whenever either phone reads its state. A run that has gone quiet for longer than the
-- grace is lost; a run that is still reporting in when its five minutes are up simply ends
-- where it stood.
CREATE OR REPLACE FUNCTION public.tetris_sweep(p_couple uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m public.game_matches;
  state jsonb; who text; entry jsonb; result jsonb;
BEGIN
  FOR m IN SELECT * FROM public.game_matches WHERE couple_id = p_couple AND game = 'tetris' AND NOT finished FOR UPDATE LOOP
    state := coalesce(m.tetris, '{}'::jsonb);
    FOR who IN SELECT jsonb_object_keys(state) LOOP
      entry := state -> who;
      CONTINUE WHEN jsonb_typeof(entry) <> 'object' OR entry->>'status' IS NULL;
      IF entry->>'status' = 'running' THEN
        IF (entry->>'last_seen')::timestamptz < now() - make_interval(secs => 30) THEN
          result := public.tetris_replay(entry->'pieces', entry->'inputs', coalesce((entry->>'ticks')::integer, 0));
          entry := entry || jsonb_build_object('status','forfeit','ended','forfeit',
            'score',coalesce((result->>'score')::integer, 0),'lines',coalesce((result->>'lines')::integer, 0),
            'finished_at',now());
        ELSIF (entry->>'deadline')::timestamptz <= now() THEN
          -- Five minutes are up: the run ends exactly where the last report left it.
          result := public.tetris_replay(entry->'pieces', entry->'inputs', coalesce((entry->>'ticks')::integer, 0));
          entry := entry || jsonb_build_object('status','done','ended','cap',
            'score',coalesce((result->>'score')::integer, 0),'lines',coalesce((result->>'lines')::integer, 0),
            'ticks',coalesce((result->>'ticks')::integer, 0),'finished_at',now());
        ELSE
          CONTINUE;
        END IF;
        state := jsonb_set(state, ARRAY[who], entry);
      END IF;
    END LOOP;
    IF state IS DISTINCT FROM coalesce(m.tetris, '{}'::jsonb) THEN
      UPDATE public.game_matches SET tetris = state WHERE id = m.id;
    END IF;
    PERFORM public.tetris_settle(m.id);
  END LOOP;
END $$;

-- Deal the pieces and start the clock. The sequence is dealt once per duel and both
-- partners play it, so the two runs are like for like. Calling this again while a run is
-- live hands the same run back, which is how a phone picks a run up after a reload; it
-- never deals a second chance at a run that has already been played.
CREATE OR REPLACE FUNCTION public.tetris_start(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  m public.game_matches;
  state jsonb; entry jsonb; other jsonb; pieces jsonb;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM public.tetris_sweep(cid);          -- a run that went quiet in the meantime is already lost
  SELECT * INTO m FROM public.game_matches WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.'; END IF;
  IF m.game <> 'tetris' THEN RAISE EXCEPTION 'That is not a Tetris duel.'; END IF;
  IF m.finished THEN RAISE EXCEPTION 'This duel is already over.'; END IF;
  state := coalesce(m.tetris, '{}'::jsonb);
  entry := state -> uid::text;
  IF entry IS NOT NULL AND entry->>'status' = 'running' THEN RETURN entry; END IF;
  IF entry IS NOT NULL THEN RAISE EXCEPTION 'You have already played your run in this duel.'; END IF;
  -- The partner's run carries the sequence if they have been dealt one already; otherwise
  -- this is the first run of the duel and it is dealt here.
  SELECT value INTO other FROM jsonb_each(state) WHERE value->>'status' IS NOT NULL LIMIT 1;
  pieces := CASE WHEN other IS NOT NULL THEN coalesce(other->'pieces', '[]'::jsonb) ELSE '[]'::jsonb END;
  IF coalesce(jsonb_array_length(pieces), 0) = 0 THEN
    SELECT coalesce(jsonb_agg(floor(random() * 7)::integer), '[]'::jsonb) INTO pieces FROM generate_series(1, 600);
  END IF;
  entry := jsonb_build_object('status','running','score',0,'lines',0,'ticks',0,'inputs','[]'::jsonb,'pieces',pieces,
    'started_at',now(),'last_seen',now(),'deadline',now() + make_interval(secs => 300));
  UPDATE public.game_matches SET tetris = state || jsonb_build_object(uid::text, entry) WHERE id = m.id;
  RETURN entry;
END $$;

-- A progress report: where the run is, and the taps made since the last one. The report is
-- append-only and cannot outrun real time, so a run cannot be rewound, accelerated or
-- handed in twice.
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

CREATE OR REPLACE FUNCTION public.tetris_beat(p_id uuid, p_ticks integer, p_inputs jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT public.tetris_commit(p_id, p_ticks, p_inputs, false) $$;
CREATE OR REPLACE FUNCTION public.tetris_finish(p_id uuid, p_ticks integer, p_inputs jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT public.tetris_commit(p_id, p_ticks, p_inputs, true) $$;

-- Walking out. The partner takes the duel immediately: waiting to be beaten is not part of
-- the deal. Safe to call twice, and safe to call after the duel ended some other way.
CREATE OR REPLACE FUNCTION public.tetris_forfeit(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  m public.game_matches;
  state jsonb; entry jsonb; result jsonb;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT * INTO m FROM public.game_matches WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.'; END IF;
  IF m.game <> 'tetris' THEN RAISE EXCEPTION 'That is not a Tetris duel.'; END IF;
  state := coalesce(m.tetris, '{}'::jsonb);
  entry := state -> uid::text;
  IF entry IS NULL THEN RETURN '{}'::jsonb; END IF;
  IF entry->>'status' <> 'running' THEN RETURN entry; END IF;
  IF m.finished THEN RETURN entry || jsonb_build_object('match_finished', true); END IF;
  -- Keep what the run had reached: the forfeit is the loss, not the score.
  result := public.tetris_replay(entry->'pieces', entry->'inputs', coalesce((entry->>'ticks')::integer, 0));
  entry := entry || jsonb_build_object('status','forfeit','ended','forfeit',
    'score',coalesce((result->>'score')::integer, 0),'lines',coalesce((result->>'lines')::integer, 0),
    'finished_at',now());
  UPDATE public.game_matches SET tetris = state || jsonb_build_object(uid::text, entry) WHERE id = m.id;
  PERFORM public.tetris_settle(m.id);
  RETURN entry;
END $$;

-- One side of a duel as this phone may see it. A blind duel: the partner's score is sealed
-- until the duel is over, and their live run shows only that they are playing.
CREATE OR REPLACE FUNCTION public.tetris_view(p_state jsonb, p_uid uuid, p_finished boolean, p_x uuid, p_o uuid, p_mode text)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  me jsonb; them jsonb;
BEGIN
  IF p_state IS NULL THEN RETURN NULL; END IF;
  me := p_state -> p_uid::text;
  them := p_state -> (CASE WHEN p_x = p_uid THEN p_o ELSE p_x END)::text;
  RETURN jsonb_build_object(
    'mode', p_mode,
    'mine', coalesce(me, 'null'::jsonb),
    'partner', CASE WHEN them IS NULL THEN jsonb_build_object('status','waiting') ELSE
      jsonb_build_object('status', them->>'status', 'ended', them->>'ended')
      || CASE WHEN them->>'status' = 'running' THEN jsonb_build_object('last_seen', them->>'last_seen') ELSE '{}'::jsonb END
      || CASE WHEN p_finished THEN jsonb_build_object('score', coalesce((them->>'score')::integer, 0),
                                                      'lines', coalesce((them->>'lines')::integer, 0),
                                                      'ticks', coalesce((them->>'ticks')::integer, 0)) ELSE '{}'::jsonb END
    END);
END $$;

REVOKE ALL ON FUNCTION public.tetris_max_ticks(), public.tetris_budget(timestamptz),
  public.tetris_replay(jsonb,jsonb,integer,integer),
  public.tetris_settle(uuid), public.tetris_sweep(uuid), public.tetris_start(uuid),
  public.tetris_commit(uuid,integer,jsonb,boolean),
  public.tetris_beat(uuid,integer,jsonb), public.tetris_finish(uuid,integer,jsonb), public.tetris_forfeit(uuid),
  public.tetris_view(jsonb,uuid,boolean,uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tetris_start(uuid), public.tetris_beat(uuid,integer,jsonb),
  public.tetris_finish(uuid,integer,jsonb), public.tetris_forfeit(uuid) TO authenticated;

-- Games now deal with four games, and the snapshot carries the duel: who has played, who
-- is playing right now, and — only once it is over — what each of them scored.
CREATE OR REPLACE FUNCTION public.games_state() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); result jsonb;
BEGIN IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
 -- Time keeps passing while nobody reads this: settle anything whose clock ran out first.
 PERFORM public.snake_sweep(cid);
 PERFORM public.tetris_sweep(cid);
 SELECT jsonb_build_object('today', (now() AT TIME ZONE 'UTC')::date,
 'wins', (SELECT coalesce(jsonb_object_agg(winner_id,n),'{}') FROM
   (SELECT winner_id,count(*) n FROM public.game_matches WHERE couple_id=cid AND finished AND winner_id IS NOT NULL GROUP BY winner_id) w),
 'matches',coalesce((SELECT jsonb_agg(safe ORDER BY created_at DESC) FROM (
 SELECT created_at, (to_jsonb(m)-'pick_x'-'pick_o'-'snake'-'chess'-'tetris') || jsonb_build_object(
 'my_pick',CASE WHEN auth.uid()=player_x THEN pick_x ELSE pick_o END,
 'partner_locked',CASE WHEN auth.uid()=player_x THEN pick_o IS NOT NULL ELSE pick_x IS NOT NULL END,
 'snake',CASE WHEN m.game='snake' THEN public.snake_view(m.snake, auth.uid(), m.finished, m.player_x, m.player_o) END,
 'chess',CASE WHEN m.game='chess' THEN public.chess_view(m.chess) END,
 'tetris',CASE WHEN m.game='tetris' THEN public.tetris_view(m.tetris, auth.uid(), m.finished, m.player_x, m.player_o, m.tetris_mode) END) safe
 FROM public.game_matches m WHERE couple_id=cid AND (NOT finished OR daily_date=(now() AT TIME ZONE 'UTC')::date OR id IN (SELECT id FROM public.game_matches WHERE couple_id=cid ORDER BY created_at DESC LIMIT 30))
 ) recent),'[]')) INTO result;
 RETURN result;
END $$;

-- Starting a Tetris duel gets its own RPC, the way Chess does, rather than a fourth
-- argument on `start_game`. Two reasons, and the second is the one that matters: a Tetris
-- duel is fixed to a mode in a way no other game is, and adding a fourth parameter would
-- leave *two* `start_game` functions on the project — so a three-argument call (every
-- other game, and any re-run of migration 007 or 011) would stop resolving with
-- "function start_game(...) is not unique". One function per way of starting a game.
CREATE OR REPLACE FUNCTION public.start_tetris(p_mode text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); partner uuid; mid uuid;
BEGIN
 IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
 IF p_mode IS NULL OR p_mode NOT IN ('sprint','survival') THEN RAISE EXCEPTION 'Invalid game settings.'; END IF;
 -- Serialize starts across both phones, so two taps cannot open two duels.
 PERFORM 1 FROM public.couples WHERE id=cid FOR UPDATE;
 SELECT id INTO partner FROM public.profiles WHERE couple_id=cid AND id<>auth.uid();
 IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;
 -- A duel is fixed to the mode it was started in, so a sprint and a survival can both be
 -- open at once without either of them being the other's rematch.
 SELECT id INTO mid FROM public.game_matches
  WHERE couple_id=cid AND game='tetris' AND daily_date IS NULL AND NOT finished AND tetris_mode=p_mode;
 IF mid IS NOT NULL THEN RETURN mid; END IF;
 INSERT INTO public.game_matches(couple_id,game,player_x,player_o,turn_id,best_of,tetris_mode)
 VALUES(cid,'tetris',auth.uid(),partner,auth.uid(),3,p_mode) RETURNING id INTO mid;
 RETURN mid;
END $$;

REVOKE ALL ON FUNCTION public.start_tetris(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_tetris(text) TO authenticated;

COMMIT;
