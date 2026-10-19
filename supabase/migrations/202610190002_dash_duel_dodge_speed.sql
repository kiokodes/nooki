-- Dash Duel v2: make the road flow top-to-bottom, remove jumping from new courses,
-- and ramp simulation speed in lockstep with the client. The original replay remains
-- able to read a saved v1 jump log so an already-open course can finish after upgrade.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.game_matches') IS NULL
     OR to_regprocedure('public.dash_replay(jsonb,jsonb,integer,integer)') IS NULL
     OR to_regprocedure('public.start_dash(text,text)') IS NULL THEN
    RAISE EXCEPTION 'Apply supabase/migrations/202610180009_dash_duel.sql before 202610190002_dash_duel_dodge_speed.sql.';
  END IF;
END $$;

-- A tick is 120 ms for the opening 300 ticks, then 105 ms through tick 600,
-- then 90 ms to the 900-tick cap. The browser clock and referee share these bands.
CREATE OR REPLACE FUNCTION public.dash_tick_duration(p_tick integer) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN coalesce(p_tick,1) <= 300 THEN 120
    WHEN p_tick <= 600 THEN 105
    ELSE 90
  END
$$;

-- Cumulative real milliseconds at a completed tick, used by parity tests and the
-- anti-fast-forward budget. The cap keeps all results inside a 900-tick course.
CREATE OR REPLACE FUNCTION public.dash_elapsed_ms(p_ticks integer) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN ticks <= 300 THEN ticks * 120
    WHEN ticks <= 600 THEN 300 * 120 + (ticks - 300) * 105
    ELSE 300 * 120 + 300 * 105 + (ticks - 600) * 90
  END
  FROM (SELECT least(greatest(coalesce(p_ticks,0),0),900) AS ticks) bounded
$$;

-- Invert the same ramp and keep six ticks of network/scheduling slack, matching the
-- client-side dashTickBudget helper without allowing a faster-than-real-time report.
CREATE OR REPLACE FUNCTION public.dash_budget(p_started timestamptz) RETURNS integer
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH elapsed AS (
    SELECT greatest(coalesce(floor(extract(epoch FROM (now() - p_started)) * 1000)::integer,0),0) AS ms
  ), reached AS (
    SELECT CASE
      WHEN ms < 36000 THEN floor(ms::numeric / 120)::integer
      WHEN ms < 67500 THEN 300 + floor((ms - 36000)::numeric / 105)::integer
      ELSE 600 + floor((ms - 67500)::numeric / 90)::integer
    END AS ticks
    FROM elapsed
  )
  SELECT least(greatest(ticks + 6,0),public.dash_max_ticks()) FROM reached
$$;

-- Version-two courses no longer mark barriers as jumpable. Every barrier still leaves
-- one lane open; later sections also tighten their cadence, on top of the faster clock.
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
        'tick',tick,'kind','barrier','lanes',to_jsonb(lanes)));
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

-- New matches use course version 2. Existing open version-one matches keep their original
-- course/version and saved actions, so the legacy replay can finish them safely.
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
  state := jsonb_build_object('course_version',2,'course',course,'mode',p_mode,
    'level',p_level,'created_by',auth.uid(),'created_at',now());
  INSERT INTO public.game_matches(couple_id,game,player_x,player_o,turn_id,best_of,dash,dash_mode,dash_level)
  VALUES(cid,'dash-duel',auth.uid(),partner,auth.uid(),3,state,p_mode,p_level) RETURNING id INTO mid;
  RETURN mid;
END $$;

-- New input deltas accept only lane changes. Previously saved v1 logs are left untouched
-- and dash_replay can still read them, but no client can submit a new jump action.
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
  action_row jsonb;
  result jsonb;
  existing jsonb;
  action_tick integer;
  action_name text;
  previous_tick integer := -1;
  max_actions integer := 900;
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
       OR (action_row->>1) NOT IN ('left','right') THEN
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

REVOKE ALL ON FUNCTION public.dash_tick_duration(integer),public.dash_elapsed_ms(integer),
  public.dash_max_ticks(),public.dash_budget(timestamptz),public.dash_deal_course(text),
  public.dash_replay(jsonb,jsonb,integer,integer),public.dash_settle(uuid),public.dash_sweep(uuid),
  public.dash_commit(uuid,integer,jsonb,boolean),public.dash_view(jsonb,uuid,boolean,uuid,uuid,text,text),
  public.dash_beat(uuid,integer,jsonb),public.dash_finish(uuid,integer,jsonb),
  public.dash_forfeit(uuid),public.dash_start(uuid),public.start_dash(text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.start_dash(text,text),public.dash_start(uuid),
  public.dash_beat(uuid,integer,jsonb),public.dash_finish(uuid,integer,jsonb),
  public.dash_forfeit(uuid) TO authenticated;

COMMIT;
