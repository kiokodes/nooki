-- Connect Four: turns and outcomes are validated under a row lock in Postgres.
BEGIN;
ALTER TABLE public.game_matches DROP CONSTRAINT IF EXISTS game_matches_game_check;
ALTER TABLE public.game_matches ADD CONSTRAINT game_matches_game_check
  CHECK (game IN ('rock-paper-scissors','snake','chess','tetris','connect-four'));
ALTER TABLE public.game_matches ADD COLUMN IF NOT EXISTS board text[] NOT NULL DEFAULT array_fill(''::text, ARRAY[42]);

CREATE OR REPLACE FUNCTION public.start_connect_four() RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); partner uuid; mid uuid;
BEGIN
 IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
 PERFORM 1 FROM public.couples WHERE id=cid FOR UPDATE;
 SELECT id INTO partner FROM public.profiles WHERE couple_id=cid AND id<>auth.uid();
 IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;
 SELECT id INTO mid FROM public.game_matches WHERE couple_id=cid AND game='connect-four' AND NOT finished;
 IF mid IS NOT NULL THEN RETURN mid; END IF;
 INSERT INTO public.game_matches(couple_id,game,player_x,player_o,turn_id,best_of,board)
 VALUES(cid,'connect-four',auth.uid(),partner,auth.uid(),3,array_fill(''::text,ARRAY[42])) RETURNING id INTO mid;
 RETURN mid;
END $$;

CREATE OR REPLACE FUNCTION public.connect_four_move(p_id uuid, p_round integer, p_column integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m public.game_matches; row_n integer; idx integer; mark text; r integer; c integer; dr integer; dc integer; dir integer; count_n integer; won boolean := false;
BEGIN
 SELECT * INTO m FROM public.game_matches WHERE id=p_id AND couple_id=public.get_user_couple_id(auth.uid()) FOR UPDATE;
 IF NOT FOUND OR m.game<>'connect-four' THEN RAISE EXCEPTION 'Game not found.'; END IF;
 IF m.finished THEN RAISE EXCEPTION 'This match is finished.'; END IF;
 IF p_round IS DISTINCT FROM m.round THEN RAISE EXCEPTION 'The game changed. Try again.'; END IF;
 IF m.turn_id<>auth.uid() THEN RAISE EXCEPTION 'It is your partner''s turn.'; END IF;
 IF p_column IS NULL OR p_column NOT BETWEEN 0 AND 6 THEN RAISE EXCEPTION 'Choose a column.'; END IF;
 FOR row_n IN REVERSE 5..0 LOOP
   idx:=row_n*7+p_column+1;
   IF m.board[idx]='' THEN EXIT; END IF;
   idx:=NULL;
 END LOOP;
 IF idx IS NULL OR m.board[idx]<>'' THEN RAISE EXCEPTION 'That column is full.'; END IF;
 mark:=CASE WHEN auth.uid()=m.player_x THEN 'X' ELSE 'O' END;
 m.board[idx]:=mark;
 FOR r IN 0..5 LOOP FOR c IN 0..6 LOOP
   IF m.board[r*7+c+1]<>mark THEN CONTINUE; END IF;
   FOR dir IN 1..4 LOOP
     dr:=CASE dir WHEN 1 THEN 0 WHEN 2 THEN 1 ELSE 1 END;
     dc:=CASE dir WHEN 1 THEN 1 WHEN 2 THEN 0 WHEN 3 THEN 1 ELSE -1 END;
     count_n:=0;
     FOR row_n IN 0..3 LOOP
       IF r+dr*row_n BETWEEN 0 AND 5 AND c+dc*row_n BETWEEN 0 AND 6 AND m.board[(r+dr*row_n)*7+c+dc*row_n+1]=mark THEN count_n:=count_n+1; END IF;
     END LOOP;
     IF count_n=4 THEN won:=true; END IF;
   END LOOP;
 END LOOP; END LOOP;
 m.finished:=won OR NOT (''=ANY(m.board));
 m.winner_id:=CASE WHEN won THEN auth.uid() ELSE NULL END;
 m.turn_id:=CASE WHEN auth.uid()=m.player_x THEN m.player_o ELSE m.player_x END;
 m.round:=m.round+1;
 UPDATE public.game_matches SET board=m.board,turn_id=m.turn_id,round=m.round,finished=m.finished,winner_id=m.winner_id WHERE id=m.id;
END $$;
REVOKE ALL ON FUNCTION public.start_connect_four(), public.connect_four_move(uuid,integer,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_connect_four(), public.connect_four_move(uuid,integer,integer) TO authenticated;
COMMIT;
