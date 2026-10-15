-- Games are RPC-only: never expose the table containing unrevealed picks.
BEGIN;
CREATE TABLE IF NOT EXISTS public.game_matches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 couple_id uuid NOT NULL REFERENCES public.couples(id) ON DELETE CASCADE,
 game text NOT NULL CHECK (game IN ('tic-tac-toe','rock-paper-scissors')),
 daily_date date,
 player_x uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 player_o uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 board text[] NOT NULL DEFAULT ARRAY['','','','','','','','',''],
 turn_id uuid NOT NULL,
 best_of integer NOT NULL DEFAULT 3 CHECK (best_of IN (3,5)),
 round integer NOT NULL DEFAULT 1,
 pick_x text, pick_o text,
 score_x integer NOT NULL DEFAULT 0, score_o integer NOT NULL DEFAULT 0,
 rounds jsonb NOT NULL DEFAULT '[]',
 finished boolean NOT NULL DEFAULT false,
 winner_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(couple_id, daily_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS game_one_practice ON public.game_matches(couple_id,game) WHERE daily_date IS NULL AND NOT finished;
ALTER TABLE public.game_matches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.game_matches FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.games_state() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); result jsonb;
BEGIN
 IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
 SELECT jsonb_build_object('today', (now() AT TIME ZONE 'UTC')::date,
 'wins', (SELECT coalesce(jsonb_object_agg(winner_id,n),'{}') FROM
   (SELECT winner_id,count(*) n FROM public.game_matches WHERE couple_id=cid AND finished AND winner_id IS NOT NULL GROUP BY winner_id) w),
 'matches',coalesce((SELECT jsonb_agg(safe ORDER BY created_at DESC) FROM (
 SELECT created_at, (to_jsonb(m)-'pick_x'-'pick_o') || jsonb_build_object(
 'my_pick',CASE WHEN auth.uid()=player_x THEN pick_x ELSE pick_o END,
 'partner_locked',CASE WHEN auth.uid()=player_x THEN pick_o IS NOT NULL ELSE pick_x IS NOT NULL END) safe
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
 IF p_daily IS NULL OR p_game IS NULL OR p_game NOT IN ('tic-tac-toe','rock-paper-scissors') OR p_best_of IS NULL OR p_best_of NOT IN (3,5) THEN RAISE EXCEPTION 'Invalid game settings.'; END IF;
 IF p_daily THEN
   SELECT id INTO mid FROM public.game_matches WHERE couple_id=cid AND daily_date=(now() AT TIME ZONE 'UTC')::date;
 ELSE
   SELECT id INTO mid FROM public.game_matches WHERE couple_id=cid AND game=p_game AND daily_date IS NULL AND NOT finished;
 END IF;
 IF mid IS NOT NULL THEN RETURN mid; END IF;
 chosen := CASE WHEN p_daily THEN (ARRAY['tic-tac-toe','rock-paper-scissors'])[1+floor(random()*2)::integer] ELSE p_game END;
 INSERT INTO public.game_matches(couple_id,game,daily_date,player_x,player_o,turn_id,best_of)
 VALUES(cid,chosen,CASE WHEN p_daily THEN (now() AT TIME ZONE 'UTC')::date END,auth.uid(),partner,auth.uid(),CASE WHEN p_daily THEN 3 ELSE p_best_of END) RETURNING id INTO mid;
 RETURN mid;
END $$;

CREATE OR REPLACE FUNCTION public.play_game(p_id uuid, p_round integer, p_move text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m public.game_matches; mark text; cell integer; line integer[]; victor uuid;
BEGIN
 SELECT * INTO m FROM public.game_matches WHERE id=p_id AND couple_id=public.get_user_couple_id(auth.uid()) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.'; END IF;
 IF m.finished THEN RAISE EXCEPTION 'This match is finished.'; END IF;
 IF p_round IS DISTINCT FROM m.round THEN RAISE EXCEPTION 'The game changed. Try again.'; END IF;
 IF m.game='tic-tac-toe' THEN
   IF m.turn_id<>auth.uid() THEN RAISE EXCEPTION 'It is your partner''s turn.'; END IF;
   IF p_move IS NULL OR p_move !~ '^[0-8]$' THEN RAISE EXCEPTION 'Choose a square.'; END IF;
   cell:=p_move::integer+1;
   IF m.board[cell]<>'' THEN RAISE EXCEPTION 'That square is taken.'; END IF;
   mark:=CASE WHEN auth.uid()=m.player_x THEN 'X' ELSE 'O' END;
   m.board[cell]:=mark;
   FOREACH line SLICE 1 IN ARRAY ARRAY[[1,2,3],[4,5,6],[7,8,9],[1,4,7],[2,5,8],[3,6,9],[1,5,9],[3,5,7]] LOOP
     IF m.board[line[1]]=mark AND m.board[line[2]]=mark AND m.board[line[3]]=mark THEN m.finished:=true; m.winner_id:=auth.uid(); END IF;
   END LOOP;
   IF NOT (''=ANY(m.board)) THEN m.finished:=true; END IF;
   m.turn_id:=CASE WHEN auth.uid()=m.player_x THEN m.player_o ELSE m.player_x END;
   m.round:=m.round+1;
 ELSE
   IF p_move IS NULL OR p_move NOT IN ('rock','paper','scissors') THEN RAISE EXCEPTION 'Choose rock, paper or scissors.'; END IF;
   IF auth.uid()=m.player_x THEN
     IF m.pick_x IS NOT NULL THEN RAISE EXCEPTION 'Your pick is already locked.'; END IF;
     m.pick_x:=p_move;
   ELSE
     IF m.pick_o IS NOT NULL THEN RAISE EXCEPTION 'Your pick is already locked.'; END IF;
     m.pick_o:=p_move;
   END IF;
   IF m.pick_x IS NOT NULL AND m.pick_o IS NOT NULL THEN
     IF m.pick_x<>m.pick_o THEN
       IF (m.pick_x='rock' AND m.pick_o='scissors') OR (m.pick_x='paper' AND m.pick_o='rock') OR (m.pick_x='scissors' AND m.pick_o='paper') THEN
         m.score_x:=m.score_x+1; victor:=m.player_x;
       ELSE m.score_o:=m.score_o+1; victor:=m.player_o; END IF;
     END IF;
     m.rounds:=m.rounds || jsonb_build_array(jsonb_build_object('round',m.round,'x',m.pick_x,'o',m.pick_o,'winner',victor));
     IF greatest(m.score_x,m.score_o)>m.best_of/2 THEN m.finished:=true; m.winner_id:=victor; END IF;
     m.pick_x:=NULL; m.pick_o:=NULL; m.round:=m.round+1;
   END IF;
 END IF;
 UPDATE public.game_matches SET board=m.board,turn_id=m.turn_id,round=m.round,pick_x=m.pick_x,pick_o=m.pick_o,score_x=m.score_x,score_o=m.score_o,rounds=m.rounds,finished=m.finished,winner_id=m.winner_id WHERE id=m.id;
END $$;
REVOKE ALL ON FUNCTION public.games_state(), public.start_game(text,boolean,integer), public.play_game(uuid,integer,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.games_state(), public.start_game(text,boolean,integer), public.play_game(uuid,integer,text) TO authenticated;
COMMIT;
