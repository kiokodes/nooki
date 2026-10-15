-- Snake duel: one ranked run each, highest score wins, and no pause.
--
-- The point of this migration is that the *database* decides a run's score. A snake run
-- is two things only — the food sequence the database dealt at the start, and the list of
-- direction changes the phone reports — and `snake_replay` walks those through the same
-- rules as `src/lib/snake.ts` to arrive at the same snake, the same score and the same
-- crash. A phone can therefore never hand in a score it did not play, and cannot replay a
-- better run later: the run reports are append-only, monotonic, and capped at one tick per
-- 160ms of real time.
--
-- Leaving is a loss. An in-app exit calls `snake_forfeit` and the partner takes the duel
-- there and then; a phone that goes quiet for more than 30 seconds (backgrounded, locked,
-- offline) is swept up the next time either partner reads the state and forfeits the same
-- way. Time never stands still: while nobody is steering, `snake_replay`/the phone keep
-- walking the snake forward in the direction it was last pointing, so a run that is left
-- alone dies at the wall.
--
-- Everything here is RPC-only, like the rest of Games: `game_matches` still has no table
-- grants, and the snapshot never publishes an unfinished partner's score (a blind duel).
BEGIN;

-- The duel lives on the same match row as the other games, so the Games tab badge, the
-- one-open-match-per-couple rule and the win scoreboard all keep working untouched.
ALTER TABLE public.game_matches DROP CONSTRAINT IF EXISTS game_matches_game_check;
ALTER TABLE public.game_matches ADD CONSTRAINT game_matches_game_check
  CHECK (game IN ('tic-tac-toe','rock-paper-scissors','snake'));
ALTER TABLE public.game_matches ADD COLUMN IF NOT EXISTS snake jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Mirror of src/lib/snake.ts: a 20×20 board, four cells long to start, 160ms a tick,
-- four minutes to a run, 30 seconds of silence before a run is lost.
CREATE OR REPLACE FUNCTION public.snake_max_ticks() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 1500 $$;

-- How many ticks a run may have reported after this much real time. Two ticks of slack
-- for the round trip; the run's own cap holds the ceiling.
CREATE OR REPLACE FUNCTION public.snake_budget(p_started timestamptz) RETURNS integer
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT least(greatest(floor(extract(epoch FROM (now() - p_started)) * 1000 / 160)::integer + 2, 0), public.snake_max_ticks())
$$;

-- Walk one side's run and return what it really scored. This is the authority: the score
-- a phone claims is never read, only this result is.
CREATE OR REPLACE FUNCTION public.snake_replay(p_foods jsonb, p_dirs jsonb, p_ticks integer, p_cap integer DEFAULT 1500)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  cols constant integer := 20;
  rows_ constant integer := 20;
  cap integer := least(coalesce(p_cap, public.snake_max_ticks()), public.snake_max_ticks());
  goal integer;
  body integer[];                 -- cell ids, head first
  food_ids integer[];
  food_at integer := 1;           -- which food is on the board
  planned text[];                 -- the direction change recorded for each tick
  dir text := 'right';
  head integer; nx integer; ny integer; dx integer; dy integer;
  entry integer; staying integer[]; eating boolean;
  ticks integer := 0; score integer := 0; ended text := NULL;
  change jsonb; change_tick integer; change_dir text;
BEGIN
  ticks := 0;
  goal := least(greatest(coalesce(p_ticks, 0), 0), cap);
  -- Four cells across the middle, heading right — the same start as the phone's.
  body := ARRAY[10 * cols + 10, 10 * cols + 9, 10 * cols + 8, 10 * cols + 7];
  SELECT coalesce(array_agg((value->>1)::integer * cols + (value->>0)::integer ORDER BY ord), ARRAY[]::integer[]) INTO food_ids
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(coalesce(p_foods,'[]'::jsonb)) = 'array' THEN p_foods ELSE '[]'::jsonb END) WITH ORDINALITY AS t(value, ord)
   WHERE jsonb_typeof(value) = 'array' AND jsonb_array_length(value) = 2
     AND (value->>0) ~ '^[0-9]{1,2}$' AND (value->>1) ~ '^[0-9]{1,2}$'
     AND (value->>0)::integer < cols AND (value->>1)::integer < rows_;
  planned := array_fill(''::text, ARRAY[goal]);
  IF jsonb_typeof(coalesce(p_dirs,'[]'::jsonb)) = 'array' THEN
    FOR change IN SELECT value FROM jsonb_array_elements(p_dirs) LOOP
      IF jsonb_typeof(change) = 'array' AND jsonb_array_length(change) = 2
         AND (change->>0) ~ '^[0-9]{1,4}$' AND (change->>1) IN ('up','down','left','right') THEN
        change_tick := (change->>0)::integer;
        change_dir := change->>1;
        -- The first change written for a tick is the one that happens; the phone can only
        -- send one per tick anyway.
        IF change_tick >= 0 AND change_tick < goal AND planned[change_tick + 1] = '' THEN
          planned[change_tick + 1] := change_dir;
        END IF;
      END IF;
    END LOOP;
  END IF;

  WHILE ticks < goal AND ended IS NULL LOOP
    -- Turning straight back into your own neck is not a move.
    IF planned[ticks + 1] IS NOT NULL AND planned[ticks + 1] <> '' AND planned[ticks + 1] <> dir
       AND NOT ((planned[ticks + 1] = 'up' AND dir = 'down') OR (planned[ticks + 1] = 'down' AND dir = 'up')
             OR (planned[ticks + 1] = 'left' AND dir = 'right') OR (planned[ticks + 1] = 'right' AND dir = 'left')) THEN
      dir := planned[ticks + 1];
    END IF;
    dx := CASE dir WHEN 'left' THEN -1 WHEN 'right' THEN 1 ELSE 0 END;
    dy := CASE dir WHEN 'up' THEN -1 WHEN 'down' THEN 1 ELSE 0 END;
    head := body[1];
    nx := (head % cols) + dx;
    ny := (head / cols) + dy;
    ticks := ticks + 1;
    IF nx < 0 OR nx >= cols OR ny < 0 OR ny >= rows_ THEN
      ended := 'wall';
    ELSE
      entry := ny * cols + nx;
      eating := food_at <= coalesce(array_length(food_ids, 1), 0) AND food_ids[food_at] = entry;
      -- The tail vacates its cell on the same tick unless the snake is growing.
      IF eating THEN staying := body; ELSE staying := body[1:greatest(coalesce(array_length(body, 1), 1) - 1, 0)]; END IF;
      IF entry = ANY(staying) THEN
        ended := 'self';
      ELSE
        IF eating THEN
          score := score + 1;
          food_at := food_at + 1;
          body := ARRAY[entry] || body;
        ELSE
          body := ARRAY[entry] || staying;
        END IF;
      END IF;
    END IF;
  END LOOP;
  IF ended IS NULL AND ticks >= cap THEN ended := 'cap'; END IF;
  RETURN jsonb_build_object('score', score, 'ticks', ticks, 'ended', ended);
END $$;

-- Decide the duel once it can be decided. Called with the match row already locked.
CREATE OR REPLACE FUNCTION public.snake_settle(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m public.game_matches;
  x_entry jsonb; o_entry jsonb;
  x_score integer; o_score integer;
  winner uuid := NULL;
BEGIN
  SELECT * INTO m FROM public.game_matches WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR m.finished OR m.game <> 'snake' THEN RETURN; END IF;
  x_entry := coalesce(m.snake -> m.player_x::text, '{}'::jsonb);
  o_entry := coalesce(m.snake -> m.player_o::text, '{}'::jsonb);
  IF x_entry->>'status' = 'forfeit' OR o_entry->>'status' = 'forfeit' THEN
    -- Leaving loses the duel there and then, whether or not the other partner has played.
    IF x_entry->>'status' = 'forfeit' AND o_entry->>'status' = 'forfeit' THEN winner := NULL;
    ELSIF x_entry->>'status' = 'forfeit' THEN winner := m.player_o;
    ELSE winner := m.player_x; END IF;
  ELSIF x_entry->>'status' = 'done' AND o_entry->>'status' = 'done' THEN
    x_score := coalesce((x_entry->>'score')::integer, 0);
    o_score := coalesce((o_entry->>'score')::integer, 0);
    IF x_score > o_score THEN winner := m.player_x;
    ELSIF o_score > x_score THEN winner := m.player_o; END IF;
  ELSE
    RETURN;                                  -- still waiting on a run
  END IF;
  UPDATE public.game_matches SET finished = true, winner_id = winner WHERE id = m.id;
END $$;

-- Time never stands still, and the app has no server clock of its own: the sweep runs
-- whenever either phone reads its state. A run that has gone quiet for longer than the
-- grace is lost; a run that is still reporting in when its four minutes are up simply
-- ends where it stood.
CREATE OR REPLACE FUNCTION public.snake_sweep(p_couple uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m public.game_matches;
  state jsonb; who text; entry jsonb; result jsonb;
BEGIN
  FOR m IN SELECT * FROM public.game_matches WHERE couple_id = p_couple AND game = 'snake' AND NOT finished FOR UPDATE LOOP
    state := coalesce(m.snake, '{}'::jsonb);
    FOR who IN SELECT jsonb_object_keys(state) LOOP
      entry := state -> who;
      IF entry->>'status' = 'running' THEN
        IF (entry->>'last_seen')::timestamptz < now() - make_interval(secs => 30) THEN
          result := public.snake_replay(entry->'foods', entry->'dirs', coalesce((entry->>'ticks')::integer, 0));
          entry := entry || jsonb_build_object('status','forfeit','ended','forfeit',
            'score',coalesce((result->>'score')::integer, 0),'finished_at',now());
        ELSIF (entry->>'deadline')::timestamptz <= now() THEN
          -- Four minutes are up: the run ends exactly where the last report left it.
          result := public.snake_replay(entry->'foods', entry->'dirs', coalesce((entry->>'ticks')::integer, 0));
          entry := entry || jsonb_build_object('status','done','ended','cap',
            'score',coalesce((result->>'score')::integer, 0),'finished_at',now());
        ELSE
          CONTINUE;
        END IF;
        state := jsonb_set(state, ARRAY[who], entry);
      END IF;
    END LOOP;
    IF state IS DISTINCT FROM coalesce(m.snake, '{}'::jsonb) THEN
      UPDATE public.game_matches SET snake = state WHERE id = m.id;
    END IF;
    PERFORM public.snake_settle(m.id);
  END LOOP;
END $$;

-- Deal the food and start the clock. Calling it again while a run is live hands the same
-- run back, which is how a phone picks a run up after a reload; it never deals a second
-- chance at a run that has already been played.
CREATE OR REPLACE FUNCTION public.snake_start(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  m public.game_matches;
  state jsonb; entry jsonb; foods jsonb;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM public.snake_sweep(cid);           -- a run that went quiet in the meantime is already lost
  SELECT * INTO m FROM public.game_matches WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.'; END IF;
  IF m.game <> 'snake' THEN RAISE EXCEPTION 'That is not a snake duel.'; END IF;
  IF m.finished THEN RAISE EXCEPTION 'This duel is already over.'; END IF;
  state := coalesce(m.snake, '{}'::jsonb);
  entry := state -> uid::text;
  IF entry IS NOT NULL AND entry->>'status' = 'running' THEN RETURN entry; END IF;
  IF entry IS NOT NULL THEN RAISE EXCEPTION 'You have already played your run in this duel.'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_array(floor(random() * 20)::integer, floor(random() * 20)::integer)), '[]'::jsonb)
    INTO foods FROM generate_series(1, 200);
  entry := jsonb_build_object('status','running','score',0,'ticks',0,'dirs','[]'::jsonb,'foods',foods,
    'started_at',now(),'last_seen',now(),'deadline',now() + make_interval(secs => 240));
  UPDATE public.game_matches SET snake = state || jsonb_build_object(uid::text, entry) WHERE id = m.id;
  RETURN entry;
END $$;

-- A progress report: where the run is, and the direction changes made since the last one.
-- The report is append-only and cannot outrun real time, so a run cannot be rewound,
-- accelerated or handed in twice.
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

CREATE OR REPLACE FUNCTION public.snake_beat(p_id uuid, p_ticks integer, p_dirs jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT public.snake_commit(p_id, p_ticks, p_dirs, false) $$;
CREATE OR REPLACE FUNCTION public.snake_finish(p_id uuid, p_ticks integer, p_dirs jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT public.snake_commit(p_id, p_ticks, p_dirs, true) $$;

-- Walking out. The partner takes the duel immediately: waiting to be beaten is not part of
-- the deal. Safe to call twice, and safe to call after the duel ended some other way.
CREATE OR REPLACE FUNCTION public.snake_forfeit(p_id uuid) RETURNS jsonb
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
  IF m.game <> 'snake' THEN RAISE EXCEPTION 'That is not a snake duel.'; END IF;
  state := coalesce(m.snake, '{}'::jsonb);
  entry := state -> uid::text;
  IF entry IS NULL THEN RETURN '{}'::jsonb; END IF;
  IF entry->>'status' <> 'running' THEN RETURN entry; END IF;
  IF m.finished THEN RETURN entry || jsonb_build_object('match_finished', true); END IF;
  -- Keep what the run had reached: the forfeit is the loss, not the score.
  result := public.snake_replay(entry->'foods', entry->'dirs', coalesce((entry->>'ticks')::integer, 0));
  entry := entry || jsonb_build_object('status','forfeit','ended','forfeit',
    'score',coalesce((result->>'score')::integer, 0),'finished_at',now());
  UPDATE public.game_matches SET snake = state || jsonb_build_object(uid::text, entry) WHERE id = m.id;
  PERFORM public.snake_settle(m.id);
  RETURN entry;
END $$;

-- One side of a duel as this phone may see it. A blind duel: the partner's score is sealed
-- until the duel is over, and their live run shows only that they are playing.
CREATE OR REPLACE FUNCTION public.snake_view(p_state jsonb, p_uid uuid, p_finished boolean, p_x uuid, p_o uuid)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  me jsonb; them jsonb;
BEGIN
  IF p_state IS NULL THEN RETURN NULL; END IF;
  me := p_state -> p_uid::text;
  them := p_state -> (CASE WHEN p_x = p_uid THEN p_o ELSE p_x END)::text;
  RETURN jsonb_build_object(
    'mine', coalesce(me, 'null'::jsonb),
    'partner', CASE WHEN them IS NULL THEN jsonb_build_object('status','waiting') ELSE
      jsonb_build_object('status', them->>'status', 'ended', them->>'ended')
      || CASE WHEN them->>'status' = 'running' THEN jsonb_build_object('last_seen', them->>'last_seen') ELSE '{}'::jsonb END
      || CASE WHEN p_finished THEN jsonb_build_object('score', coalesce((them->>'score')::integer, 0)) ELSE '{}'::jsonb END
    END);
END $$;

REVOKE ALL ON FUNCTION public.snake_max_ticks(), public.snake_budget(timestamptz), public.snake_replay(jsonb,jsonb,integer,integer),
  public.snake_settle(uuid), public.snake_sweep(uuid), public.snake_start(uuid), public.snake_commit(uuid,integer,jsonb,boolean),
  public.snake_beat(uuid,integer,jsonb), public.snake_finish(uuid,integer,jsonb), public.snake_forfeit(uuid),
  public.snake_view(jsonb,uuid,boolean,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.snake_start(uuid), public.snake_beat(uuid,integer,jsonb), public.snake_finish(uuid,integer,jsonb),
  public.snake_forfeit(uuid) TO authenticated;

-- Games now deal with three games, and the snapshot carries the duel: who has played, who
-- is playing right now, and — only once it is over — what each of them scored.
CREATE OR REPLACE FUNCTION public.games_state() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); result jsonb;
BEGIN
 IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
 -- Time keeps passing while nobody reads this: settle anything whose clock ran out first.
 PERFORM public.snake_sweep(cid);
 SELECT jsonb_build_object('today', (now() AT TIME ZONE 'UTC')::date,
 'wins', (SELECT coalesce(jsonb_object_agg(winner_id,n),'{}') FROM
   (SELECT winner_id,count(*) n FROM public.game_matches WHERE couple_id=cid AND finished AND winner_id IS NOT NULL GROUP BY winner_id) w),
 'matches',coalesce((SELECT jsonb_agg(safe ORDER BY created_at DESC) FROM (
 SELECT created_at, (to_jsonb(m)-'pick_x'-'pick_o'-'snake') || jsonb_build_object(
 'my_pick',CASE WHEN auth.uid()=player_x THEN pick_x ELSE pick_o END,
 'partner_locked',CASE WHEN auth.uid()=player_x THEN pick_o IS NOT NULL ELSE pick_x IS NOT NULL END,
 'snake',CASE WHEN m.game='snake' THEN public.snake_view(m.snake, auth.uid(), m.finished, m.player_x, m.player_o) END) safe
 FROM public.game_matches m WHERE couple_id=cid AND (NOT finished OR daily_date=(now() AT TIME ZONE 'UTC')::date OR id IN (SELECT id FROM public.game_matches WHERE couple_id=cid ORDER BY created_at DESC LIMIT 30))
 ) recent),'[]')) INTO result;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.start_game(p_game text, p_daily boolean DEFAULT false, p_best_of integer DEFAULT 3)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); partner uuid; mid uuid; chosen text;
BEGIN
 IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
 -- Serialize starts across both phones, including daily random selection.
 PERFORM 1 FROM public.couples WHERE id=cid FOR UPDATE;
 SELECT id INTO partner FROM public.profiles WHERE couple_id=cid AND id<>auth.uid();
 IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;
 IF p_daily IS NULL OR p_game IS NULL OR p_game NOT IN ('tic-tac-toe','rock-paper-scissors','snake') OR p_best_of IS NULL OR p_best_of NOT IN (3,5) THEN RAISE EXCEPTION 'Invalid game settings.'; END IF;
 IF p_daily THEN
   SELECT id INTO mid FROM public.game_matches WHERE couple_id=cid AND daily_date=(now() AT TIME ZONE 'UTC')::date;
 ELSE
   SELECT id INTO mid FROM public.game_matches WHERE couple_id=cid AND game=p_game AND daily_date IS NULL AND NOT finished;
 END IF;
 IF mid IS NOT NULL THEN RETURN mid; END IF;
 -- Snake is never the daily challenge: a duel waits for both partners to play whenever
 -- suits them, which is not a thing a single UTC day should be asked to hold.
 chosen := CASE WHEN p_daily THEN (ARRAY['tic-tac-toe','rock-paper-scissors'])[1+floor(random()*2)::integer] ELSE p_game END;
 INSERT INTO public.game_matches(couple_id,game,daily_date,player_x,player_o,turn_id,best_of)
 VALUES(cid,chosen,CASE WHEN p_daily THEN (now() AT TIME ZONE 'UTC')::date END,auth.uid(),partner,auth.uid(),CASE WHEN p_daily THEN 3 ELSE p_best_of END) RETURNING id INTO mid;
 RETURN mid;
END $$;

COMMIT;
