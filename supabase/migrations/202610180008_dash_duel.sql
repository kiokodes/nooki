-- Dash Duel: same-course runs for a couple, with an asynchronous challenge mode,
-- a ready-gated live-together mode and a local-only free run in the client.
-- The database deals the ranked course and replays every submitted action: distance,
-- hearts and the winner are never accepted from a phone.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.game_matches') IS NULL THEN
    RAISE EXCEPTION 'Apply the Games migrations before 202610180008_dash_duel.sql.';
  END IF;
END $$;

ALTER TABLE public.game_matches DROP CONSTRAINT IF EXISTS game_matches_game_check;
ALTER TABLE public.game_matches ADD CONSTRAINT game_matches_game_check
  CHECK (game IN ('rock-paper-scissors','snake','chess','tetris','connect-four','dash-duel'));
ALTER TABLE public.game_matches ADD COLUMN IF NOT EXISTS dash jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.game_matches ADD COLUMN IF NOT EXISTS dash_mode text;
ALTER TABLE public.game_matches ADD COLUMN IF NOT EXISTS dash_level text;
ALTER TABLE public.game_matches DROP CONSTRAINT IF EXISTS game_matches_dash_mode_check;
ALTER TABLE public.game_matches ADD CONSTRAINT game_matches_dash_mode_check
  CHECK (dash_mode IS NULL OR dash_mode IN ('challenge','together'));
ALTER TABLE public.game_matches DROP CONSTRAINT IF EXISTS game_matches_dash_level_check;
ALTER TABLE public.game_matches ADD CONSTRAINT game_matches_dash_level_check
  CHECK (dash_level IS NULL OR dash_level IN ('easy','steady','spicy'));

-- The non-Tetris index covers ordinary games. Dash has one open match per mode, while
-- Tetris retains its own per-mode index; no older game is allowed to regress.
DROP INDEX IF EXISTS public.game_one_practice;
CREATE UNIQUE INDEX IF NOT EXISTS game_one_practice ON public.game_matches(couple_id, game)
  WHERE NOT finished AND game NOT IN ('tetris','dash-duel');
CREATE UNIQUE INDEX IF NOT EXISTS game_one_practice_dash ON public.game_matches(couple_id, game, dash_mode)
  WHERE NOT finished AND game = 'dash-duel';

CREATE OR REPLACE FUNCTION public.dash_max_ticks() RETURNS integer
LANGUAGE sql IMMUTABLE AS $$ SELECT 900 $$;

CREATE OR REPLACE FUNCTION public.dash_budget(p_started timestamptz) RETURNS integer
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT least(greatest(floor(extract(epoch FROM (now() - p_started)) * 1000 / 120)::integer + 6, 0), public.dash_max_ticks())
$$;

-- One server-dealt shared course. The first partner to create a challenge chooses its
-- level; later openers resume that exact immutable route. Barriers always leave at least
-- one unblocked lane (and are jumpable), while later thirds tighten the cadence.
CREATE OR REPLACE FUNCTION public.dash_deal_course(p_level text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = public AS $$
DECLARE
  course jsonb := '[]'::jsonb;
  tick integer := 30;
  cadence integer;
  heart_chance double precision;
  double_chance double precision;
  first_lane integer;
  second_lane integer;
  lanes integer[];
BEGIN
  IF p_level NOT IN ('easy','steady','spicy') THEN RAISE EXCEPTION 'Choose an Easy, Steady or Spicy route.'; END IF;
  IF p_level = 'easy' THEN heart_chance := 0.18; double_chance := 0.20;
  ELSIF p_level = 'spicy' THEN heart_chance := 0.08; double_chance := 0.56;
  ELSE heart_chance := 0.11; double_chance := 0.38;
  END IF;
  WHILE tick <= public.dash_max_ticks() LOOP
    IF random() < heart_chance THEN
      course := course || jsonb_build_array(jsonb_build_object(
        'tick',tick,'kind','heart','lane',floor(random()*3)::integer));
    ELSE
      first_lane := floor(random()*3)::integer;
      lanes := ARRAY[first_lane];
      IF random() < double_chance THEN
        second_lane := (first_lane + 1 + floor(random()*2)::integer) % 3;
        lanes := ARRAY[first_lane,second_lane];
      END IF;
      course := course || jsonb_build_array(jsonb_build_object(
        'tick',tick,'kind','barrier','lanes',to_jsonb(lanes),'jumpable',true));
    END IF;
    cadence := CASE
      WHEN tick < 300 THEN CASE p_level WHEN 'easy' THEN 13 WHEN 'spicy' THEN 10 ELSE 11 END
      WHEN tick < 600 THEN CASE p_level WHEN 'easy' THEN 12 WHEN 'spicy' THEN 9 ELSE 10 END
      ELSE CASE p_level WHEN 'easy' THEN 11 WHEN 'spicy' THEN 8 ELSE 9 END
    END;
    tick := tick + cadence + floor(random()*3)::integer - 1;
  END LOOP;
  RETURN course;
END $$;

-- Deterministic referee, kept in lockstep with src/lib/dash.ts. Input ticks are zero-based;
-- event ticks are one-based. Each processed tick applies input, resolves an event, then
-- increments distance only if the runner survived. The collision tick is included in ticks
-- but not in distance. Jump covers exactly three collision checks.
CREATE OR REPLACE FUNCTION public.dash_replay(
  p_course jsonb, p_actions jsonb, p_ticks integer, p_cap integer DEFAULT 900
) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  cap integer := least(greatest(coalesce(p_cap, public.dash_max_ticks()),0), public.dash_max_ticks());
  goal integer := least(greatest(coalesce(p_ticks,0),0), least(greatest(coalesce(p_cap,public.dash_max_ticks()),0), public.dash_max_ticks()));
  events jsonb[];
  action_ticks integer[];
  action_names text[];
  event_count integer := 0;
  action_count integer := 0;
  event_idx integer := 1;
  action_idx integer := 1;
  tick integer := 0;
  lane integer := 1;
  hearts integer := 0;
  distance integer := 0;
  jump_ticks integer := 0;
  current_action text;
  current_event jsonb;
  event_lanes jsonb;
  event_lane integer;
  airborne boolean;
  crashed boolean;
  ended text := NULL;
BEGIN
  SELECT coalesce(array_agg(value ORDER BY ord), ARRAY[]::jsonb[])
    INTO events
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(coalesce(p_course,'[]'::jsonb))='array' THEN p_course ELSE '[]'::jsonb END)
      WITH ORDINALITY AS e(value,ord);
  event_count := coalesce(array_length(events,1),0);
  SELECT coalesce(array_agg((value->>0)::integer ORDER BY ord), ARRAY[]::integer[]),
         coalesce(array_agg(value->>1 ORDER BY ord), ARRAY[]::text[])
    INTO action_ticks, action_names
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(coalesce(p_actions,'[]'::jsonb))='array' THEN p_actions ELSE '[]'::jsonb END)
      WITH ORDINALITY AS a(value,ord)
   WHERE jsonb_typeof(value)='array' AND jsonb_array_length(value)=2
     AND (value->>0) ~ '^[0-9]{1,4}$'
     AND (value->>1) IN ('left','right','jump');
  action_count := coalesce(array_length(action_ticks,1),0);

  WHILE tick < goal AND ended IS NULL LOOP
    tick := tick + 1;
    current_action := NULL;
    WHILE action_idx <= action_count AND action_ticks[action_idx] < tick - 1 LOOP
      action_idx := action_idx + 1;
    END LOOP;
    IF action_idx <= action_count AND action_ticks[action_idx] = tick - 1 THEN
      current_action := action_names[action_idx];
      action_idx := action_idx + 1;
    END IF;
    IF current_action = 'left' AND lane > 0 THEN lane := lane - 1;
    ELSIF current_action = 'right' AND lane < 2 THEN lane := lane + 1;
    ELSIF current_action = 'jump' AND jump_ticks = 0 THEN jump_ticks := 3;
    END IF;

    WHILE event_idx <= event_count LOOP
      IF jsonb_typeof(events[event_idx]) <> 'object'
         OR coalesce((events[event_idx]->>'tick')::integer,0) >= tick THEN EXIT; END IF;
      event_idx := event_idx + 1;
    END LOOP;
    current_event := CASE WHEN event_idx <= event_count THEN events[event_idx] ELSE NULL END;
    airborne := jump_ticks > 0;
    crashed := false;
    IF current_event IS NOT NULL AND (current_event->>'tick')::integer = tick THEN
      IF current_event->>'kind' = 'heart' THEN
        IF (current_event->>'lane') ~ '^[0-2]$' AND (current_event->>'lane')::integer = lane THEN hearts := hearts + 1; END IF;
      ELSIF current_event->>'kind' = 'barrier' THEN
        event_lanes := current_event->'lanes';
        IF jsonb_typeof(event_lanes) = 'array' THEN
          FOR event_lane IN SELECT value::integer FROM jsonb_array_elements_text(event_lanes)
             WHERE value ~ '^[0-2]$' LOOP
            IF event_lane = lane THEN crashed := true; END IF;
          END LOOP;
        END IF;
        IF crashed AND NOT (coalesce((current_event->>'jumpable')::boolean,false) AND airborne) THEN
          ended := 'barrier';
        ELSE
          crashed := false;
        END IF;
      END IF;
      IF ended IS NULL THEN event_idx := event_idx + 1; END IF;
    END IF;
    IF ended IS NOT NULL THEN EXIT; END IF;
    distance := distance + 1;
    jump_ticks := greatest(jump_ticks - 1,0);
    IF tick >= cap THEN ended := 'cap'; END IF;
  END LOOP;

  RETURN jsonb_build_object('lane',lane,'hearts',hearts,'ticks',tick,'distance',distance,
    'jump_ticks',jump_ticks,'ended',ended);
END $$;

CREATE OR REPLACE FUNCTION public.dash_settle(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m public.game_matches;
  state jsonb;
  x_run jsonb;
  o_run jsonb;
  x_status text;
  o_status text;
  x_distance integer;
  o_distance integer;
  x_hearts integer;
  o_hearts integer;
  victor uuid;
BEGIN
  SELECT * INTO m FROM public.game_matches WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR m.game<>'dash-duel' OR m.finished THEN RETURN; END IF;
  state := coalesce(m.dash,'{}'::jsonb);
  x_run := state -> m.player_x::text;
  o_run := state -> m.player_o::text;
  x_status := coalesce(x_run->>'status','waiting');
  o_status := coalesce(o_run->>'status','waiting');

  -- In live-together mode a crash/forfeit immediately hands the race to the active runner.
  -- Completing the full course is not a crash: let the other runner finish, then compare
  -- verified distance/hearts just as in an async challenge.
  IF m.dash_mode='together' AND x_status IN ('crash','forfeit') AND o_status IN ('ready','running') THEN
    o_run := o_run || jsonb_build_object('status','done','ended','opponent-crash','finished_at',now());
    state := state || jsonb_build_object(m.player_o::text,o_run);
    UPDATE public.game_matches SET dash=state,finished=true,winner_id=m.player_o WHERE id=m.id;
    RETURN;
  ELSIF m.dash_mode='together' AND o_status IN ('crash','forfeit') AND x_status IN ('ready','running') THEN
    x_run := x_run || jsonb_build_object('status','done','ended','opponent-crash','finished_at',now());
    state := state || jsonb_build_object(m.player_x::text,x_run);
    UPDATE public.game_matches SET dash=state,finished=true,winner_id=m.player_x WHERE id=m.id;
    RETURN;
  END IF;

  IF x_status NOT IN ('crash','done','forfeit') OR o_status NOT IN ('crash','done','forfeit') THEN RETURN; END IF;
  x_distance := coalesce((x_run->>'distance')::integer,0);
  o_distance := coalesce((o_run->>'distance')::integer,0);
  x_hearts := coalesce((x_run->>'hearts')::integer,0);
  o_hearts := coalesce((o_run->>'hearts')::integer,0);
  IF x_distance > o_distance OR (x_distance=o_distance AND x_hearts>o_hearts) THEN victor := m.player_x;
  ELSIF o_distance > x_distance OR (x_distance=o_distance AND o_hearts>x_hearts) THEN victor := m.player_o;
  ELSE victor := NULL;
  END IF;
  UPDATE public.game_matches SET finished=true,winner_id=victor,
    dash=state || jsonb_build_object('settled_at',now()) WHERE id=m.id;
END $$;

-- An async match expires after seven days. Missing or unfinished attempts become zero-score
-- forfeits so an offline partner never blocks a rematch forever.
CREATE OR REPLACE FUNCTION public.dash_sweep(p_couple uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m public.game_matches;
  state jsonb;
  side_id uuid;
  entry jsonb;
BEGIN
  FOR m IN SELECT * FROM public.game_matches
    WHERE couple_id=p_couple AND game='dash-duel' AND NOT finished
      AND created_at <= now()-interval '7 days'
    FOR UPDATE LOOP
    state := coalesce(m.dash,'{}'::jsonb);
    FOREACH side_id IN ARRAY ARRAY[m.player_x,m.player_o] LOOP
      entry := state -> side_id::text;
      IF entry IS NULL OR entry->>'status' IN ('waiting','ready','running') THEN
        entry := coalesce(entry,'{}'::jsonb) || jsonb_build_object(
          'status','forfeit','ended','forfeit','distance',0,'hearts',0,
          'ticks',0,'jump_ticks',0,'actions','[]'::jsonb,'finished_at',now());
        state := state || jsonb_build_object(side_id::text,entry);
      END IF;
    END LOOP;
    UPDATE public.game_matches SET dash=state WHERE id=m.id;
    PERFORM public.dash_settle(m.id);
  END LOOP;
END $$;

-- Create or resume one shared course for the couple. An existing challenge ignores a later
-- level choice by design: its first creator owns the course everyone else must chase.
CREATE OR REPLACE FUNCTION public.start_dash(p_mode text DEFAULT 'challenge', p_level text DEFAULT 'steady') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cid uuid := public.get_user_couple_id(auth.uid());
  partner uuid;
  mid uuid;
  course jsonb;
  state jsonb;
BEGIN
  IF auth.uid() IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('challenge','together') THEN RAISE EXCEPTION 'Choose a Dash Duel mode.'; END IF;
  IF p_level IS NULL OR p_level NOT IN ('easy','steady','spicy') THEN RAISE EXCEPTION 'Choose an Easy, Steady or Spicy route.'; END IF;
  PERFORM 1 FROM public.couples WHERE id=cid FOR UPDATE;
  SELECT id INTO partner FROM public.profiles WHERE couple_id=cid AND id<>auth.uid();
  IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;
  PERFORM public.dash_sweep(cid);
  SELECT id INTO mid FROM public.game_matches
   WHERE couple_id=cid AND game='dash-duel' AND dash_mode=p_mode AND NOT finished;
  IF mid IS NOT NULL THEN RETURN mid; END IF;
  course := public.dash_deal_course(p_level);
  state := jsonb_build_object('course_version',1,'course',course,'mode',p_mode,
    'level',p_level,'created_by',auth.uid(),'created_at',now());
  INSERT INTO public.game_matches(couple_id,game,player_x,player_o,turn_id,best_of,dash,dash_mode,dash_level)
  VALUES(cid,'dash-duel',auth.uid(),partner,auth.uid(),3,state,p_mode,p_level) RETURNING id INTO mid;
  RETURN mid;
END $$;

CREATE OR REPLACE FUNCTION public.dash_start(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  partner uuid;
  m public.game_matches;
  state jsonb;
  entry jsonb;
  other jsonb;
  shared_start timestamptz;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM public.dash_sweep(cid);
  SELECT * INTO m FROM public.game_matches WHERE id=p_id AND couple_id=cid FOR UPDATE;
  IF NOT FOUND OR m.game<>'dash-duel' OR uid NOT IN (m.player_x,m.player_o) THEN RAISE EXCEPTION 'Dash Duel not found.'; END IF;
  IF m.finished THEN RAISE EXCEPTION 'This Dash Duel is already over.'; END IF;
  partner := CASE WHEN uid=m.player_x THEN m.player_o ELSE m.player_x END;
  state := coalesce(m.dash,'{}'::jsonb);
  entry := state -> uid::text;
  IF entry IS NOT NULL AND entry->>'status' IN ('running','ready') THEN RETURN entry; END IF;
  IF entry IS NOT NULL THEN RAISE EXCEPTION 'You have already played your run in this Dash Duel.'; END IF;

  IF m.dash_mode='together' THEN
    entry := jsonb_build_object('status','ready','ended',NULL,'distance',0,'hearts',0,'ticks',0,
      'jump_ticks',0,'actions','[]'::jsonb,'ready_at',now(),'last_seen',now());
    other := state -> partner::text;
    IF other IS NOT NULL AND other->>'status'='ready' THEN
      shared_start := now();
      entry := entry || jsonb_build_object('status','running','started_at',shared_start,'last_seen',shared_start);
      other := other || jsonb_build_object('status','running','started_at',shared_start,'last_seen',shared_start);
      state := state || jsonb_build_object(partner::text,other);
    END IF;
  ELSE
    entry := jsonb_build_object('status','running','ended',NULL,'distance',0,'hearts',0,'ticks',0,
      'jump_ticks',0,'actions','[]'::jsonb,'started_at',now(),'last_seen',now());
  END IF;
  state := state || jsonb_build_object(uid::text,entry);
  UPDATE public.game_matches SET dash=state WHERE id=m.id;
  RETURN entry;
END $$;

-- Merge a retry-safe action delta, replay the full run, and persist only referee-derived
-- progress. A same-tick identical retry is ignored; a conflicting action is rejected.
CREATE OR REPLACE FUNCTION public.dash_commit(p_id uuid,p_ticks integer,p_actions jsonb,p_final boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  m public.game_matches;
  state jsonb;
  entry jsonb;
  actions jsonb;
  delta jsonb;
  incoming jsonb;
  action_row jsonb;
  result jsonb;
  existing jsonb;
  action_tick integer;
  action_name text;
  previous_tick integer := -1;
  max_actions integer := 900;
  i integer;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM public.dash_sweep(cid);
  SELECT * INTO m FROM public.game_matches WHERE id=p_id AND couple_id=cid FOR UPDATE;
  IF NOT FOUND OR m.game<>'dash-duel' OR uid NOT IN (m.player_x,m.player_o) THEN RAISE EXCEPTION 'Dash Duel not found.'; END IF;
  state := coalesce(m.dash,'{}'::jsonb);
  entry := state -> uid::text;
  IF entry IS NULL THEN RAISE EXCEPTION 'Start your run first.'; END IF;
  IF entry->>'status' NOT IN ('running','ready') THEN RETURN entry; END IF;
  IF entry->>'status'='ready' THEN RAISE EXCEPTION 'Wait for your partner to be ready before running.'; END IF;
  IF m.finished THEN RETURN entry || jsonb_build_object('match_finished',true); END IF;
  IF p_ticks IS NULL OR p_ticks<0 OR p_ticks>public.dash_max_ticks()
     OR p_actions IS NULL OR jsonb_typeof(p_actions)<>'array' THEN
    RAISE EXCEPTION 'That Dash run report cannot be read.';
  END IF;
  IF p_ticks < coalesce((entry->>'ticks')::integer,0) THEN RAISE EXCEPTION 'That run report is older than the last one.'; END IF;
  IF p_ticks > public.dash_budget((entry->>'started_at')::timestamptz) THEN RAISE EXCEPTION 'That run is moving faster than real time.'; END IF;

  actions := coalesce(entry->'actions','[]'::jsonb);
  IF jsonb_array_length(actions)>max_actions OR jsonb_array_length(p_actions)>max_actions THEN
    RAISE EXCEPTION 'That Dash run has too many inputs.';
  END IF;
  delta := '[]'::jsonb;
  FOR action_row IN SELECT value FROM jsonb_array_elements(p_actions) LOOP
    IF jsonb_typeof(action_row)<>'array' OR jsonb_array_length(action_row)<>2
       OR (action_row->>0) !~ '^[0-9]{1,4}$'
       OR (action_row->>1) NOT IN ('left','right','jump') THEN
      RAISE EXCEPTION 'That Dash run report cannot be read.';
    END IF;
    action_tick := (action_row->>0)::integer;
    action_name := action_row->>1;
    IF action_tick<0 OR action_tick>=p_ticks THEN RAISE EXCEPTION 'That input is outside your reached ticks.'; END IF;
    IF action_tick<previous_tick THEN RAISE EXCEPTION 'Dash inputs must be in tick order.'; END IF;
    IF action_tick=previous_tick THEN
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(delta) prior WHERE (prior->>0)::integer=action_tick AND prior->>1=action_name)
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(actions) prior WHERE (prior->>0)::integer=action_tick AND prior->>1=action_name) THEN
        RAISE EXCEPTION 'Only one action is allowed per tick.';
      END IF;
      CONTINUE;
    END IF;
    previous_tick := action_tick;
    SELECT value INTO existing FROM jsonb_array_elements(actions) WHERE (value->>0)::integer=action_tick LIMIT 1;
    IF existing IS NOT NULL THEN
      IF existing->>1<>action_name THEN RAISE EXCEPTION 'That tick already has a different action.'; END IF;
      CONTINUE;
    END IF;
    SELECT value INTO existing FROM jsonb_array_elements(delta) WHERE (value->>0)::integer=action_tick LIMIT 1;
    IF existing IS NOT NULL THEN
      IF existing->>1<>action_name THEN RAISE EXCEPTION 'Only one action is allowed per tick.'; END IF;
      CONTINUE;
    END IF;
    IF action_tick < coalesce((entry->>'ticks')::integer,0) THEN RAISE EXCEPTION 'That run report is out of order.'; END IF;
    delta := delta || jsonb_build_array(jsonb_build_array(action_tick,action_name));
  END LOOP;
  actions := actions || delta;
  result := public.dash_replay(state->'course',actions,p_ticks,public.dash_max_ticks());
  -- Actions beyond a replayed collision cannot affect the result and are discarded so
  -- retries after a crash cannot smuggle extra moves into a finished attempt.
  IF result->>'ended'='barrier' THEN
    SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]'::jsonb) INTO actions
      FROM jsonb_array_elements(actions) WITH ORDINALITY AS a(value,ord)
     WHERE (value->>0)::integer < (result->>'ticks')::integer;
  END IF;
  entry := entry || jsonb_build_object('ticks',(result->>'ticks')::integer,
    'distance',(result->>'distance')::integer,'hearts',(result->>'hearts')::integer,
    'lane',(result->>'lane')::integer,'jump_ticks',(result->>'jump_ticks')::integer,
    'actions',actions,'last_seen',now());
  IF result->>'ended'='barrier' THEN
    entry := entry || jsonb_build_object('status','crash','ended','barrier','finished_at',now());
  ELSIF result->>'ended'='cap' THEN
    entry := entry || jsonb_build_object('status','done','ended','cap','finished_at',now());
  ELSIF p_final THEN
    RAISE EXCEPTION 'Your run is not finished yet.';
  END IF;
  state := state || jsonb_build_object(uid::text,entry);
  UPDATE public.game_matches SET dash=state WHERE id=m.id;
  IF result->>'ended' IN ('barrier','cap') THEN PERFORM public.dash_settle(m.id); END IF;
  RETURN entry;
END $$;

CREATE OR REPLACE FUNCTION public.dash_beat(p_id uuid,p_ticks integer,p_actions jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.dash_commit(p_id,p_ticks,p_actions,false)
$$;
CREATE OR REPLACE FUNCTION public.dash_finish(p_id uuid,p_ticks integer,p_actions jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT public.dash_commit(p_id,p_ticks,p_actions,true)
$$;

CREATE OR REPLACE FUNCTION public.dash_forfeit(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  m public.game_matches;
  state jsonb;
  entry jsonb;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT * INTO m FROM public.game_matches WHERE id=p_id AND couple_id=cid FOR UPDATE;
  IF NOT FOUND OR m.game<>'dash-duel' OR uid NOT IN (m.player_x,m.player_o) THEN RAISE EXCEPTION 'Dash Duel not found.'; END IF;
  state := coalesce(m.dash,'{}'::jsonb);
  entry := state -> uid::text;
  IF entry IS NULL THEN RETURN '{}'::jsonb; END IF;
  IF entry->>'status' NOT IN ('running','ready') THEN RETURN entry; END IF;
  entry := entry || jsonb_build_object('status','forfeit','ended','forfeit','distance',0,
    'hearts',0,'ticks',0,'jump_ticks',0,'finished_at',now());
  state := state || jsonb_build_object(uid::text,entry);
  UPDATE public.game_matches SET dash=state WHERE id=m.id;
  PERFORM public.dash_settle(m.id);
  RETURN entry;
END $$;

-- The partner's distance/heart count is visible while running, but their input log is not.
CREATE OR REPLACE FUNCTION public.dash_view(
  p_state jsonb,p_uid uuid,p_finished boolean,p_x uuid,p_o uuid,p_mode text,p_level text
) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  mine jsonb;
  theirs jsonb;
  partner jsonb;
  partner_id uuid := CASE WHEN p_x=p_uid THEN p_o ELSE p_x END;
BEGIN
  IF p_state IS NULL THEN RETURN NULL; END IF;
  mine := p_state -> p_uid::text;
  theirs := p_state -> partner_id::text;
  IF theirs IS NULL THEN
    partner := jsonb_build_object('status','waiting');
  ELSE
    partner := jsonb_build_object('status',theirs->>'status','ended',theirs->>'ended',
      'distance',coalesce((theirs->>'distance')::integer,0),
      'hearts',coalesce((theirs->>'hearts')::integer,0),
      'ticks',coalesce((theirs->>'ticks')::integer,0));
    IF theirs->>'status' IN ('running','ready') THEN
      partner := partner || jsonb_build_object('last_seen',theirs->>'last_seen','ready_at',theirs->>'ready_at');
    END IF;
  END IF;
  RETURN jsonb_build_object('course_version',coalesce((p_state->>'course_version')::integer,1),
    'course',coalesce(p_state->'course','[]'::jsonb),'level',p_level,'mode',p_mode,
    'created_by',p_state->>'created_by','mine',coalesce(mine,'null'::jsonb),'partner',partner);
END $$;

-- Keep the canonical Games snapshot in sync; all run details remain behind this RPC.
CREATE OR REPLACE FUNCTION public.games_state() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); result jsonb;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  PERFORM public.snake_sweep(cid);
  PERFORM public.tetris_sweep(cid);
  PERFORM public.dash_sweep(cid);
  SELECT jsonb_build_object(
    'wins',(SELECT coalesce(jsonb_object_agg(winner_id,n),'{}'::jsonb) FROM
      (SELECT winner_id,count(*) n FROM public.game_matches WHERE couple_id=cid AND finished AND winner_id IS NOT NULL GROUP BY winner_id) w),
    'matches',coalesce((SELECT jsonb_agg(safe ORDER BY created_at DESC) FROM (
      SELECT created_at,(to_jsonb(m)-'pick_x'-'pick_o'-'snake'-'chess'-'tetris'-'dash') || jsonb_build_object(
        'my_pick',CASE WHEN auth.uid()=player_x THEN pick_x ELSE pick_o END,
        'partner_locked',CASE WHEN auth.uid()=player_x THEN pick_o IS NOT NULL ELSE pick_x IS NOT NULL END,
        'snake',CASE WHEN m.game='snake' THEN public.snake_view(m.snake,auth.uid(),m.finished,m.player_x,m.player_o) END,
        'chess',CASE WHEN m.game='chess' THEN public.chess_view(m.chess) END,
        'tetris',CASE WHEN m.game='tetris' THEN public.tetris_view(m.tetris,auth.uid(),m.finished,m.player_x,m.player_o,m.tetris_mode) END,
        'dash',CASE WHEN m.game='dash-duel' THEN public.dash_view(m.dash,auth.uid(),m.finished,m.player_x,m.player_o,m.dash_mode,m.dash_level) END
      ) safe
      FROM public.game_matches m WHERE couple_id=cid AND (NOT finished OR id IN
        (SELECT id FROM public.game_matches WHERE couple_id=cid ORDER BY created_at DESC LIMIT 30))
    ) recent),'[]'::jsonb)
  ) INTO result;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.dash_max_ticks(),public.dash_budget(timestamptz),
  public.dash_deal_course(text),public.dash_replay(jsonb,jsonb,integer,integer),
  public.dash_settle(uuid),public.dash_sweep(uuid),public.dash_commit(uuid,integer,jsonb,boolean),
  public.dash_view(jsonb,uuid,boolean,uuid,uuid,text,text),
  public.dash_beat(uuid,integer,jsonb),public.dash_finish(uuid,integer,jsonb),
  public.dash_forfeit(uuid),public.dash_start(uuid),public.start_dash(text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.start_dash(text,text),public.dash_start(uuid),
  public.dash_beat(uuid,integer,jsonb),public.dash_finish(uuid,integer,jsonb),
  public.dash_forfeit(uuid) TO authenticated;

COMMIT;
