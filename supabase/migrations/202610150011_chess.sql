-- Chess: classic checkmate, the Capture Race (first to 7 captures) and the Queen Hunt
-- (capture the opponent's original queen) — over entirely normal chess rules.
--
-- The point of this migration, like the Snake duel's, is that the *database* decides.
-- `src/lib/chess.ts` is mirrored here function for function (`chess_attacked`,
-- `chess_pseudo`, `chess_legal`, `chess_has_move`), and the only thing a phone may
-- send is a move in coordinate notation (`e2e4`, `e7e8q`, or `resign`). The server
-- checks the move is legal for the side to move, applies it, counts the capture
-- itself, spots checkmate/stalemate/draws itself and scores the situational goal
-- itself — so a phone can never claim a capture, or a queen, it did not really make.
-- Kings are never captured: legal-move filtering means checkmate ends the game first.
--
-- A chess match lives on the same match row as the other games: player_x is White,
-- turn_id is the side to move, round is the ply count + 1 (the optimistic-concurrency
-- token `chess_move` checks, exactly as `play_game` does), finished/winner_id are the
-- result. The position itself lives in the `chess` jsonb: the board as 64 codes
-- (`wP`, `bQ`, `wQ*` for a *promoted* queen — the hunt only counts the original),
-- castling rights, the en-passant square, captures by each colour, the move history
-- and position counts for threefold repetition.
--
-- Chess is RPC-only like the rest of Games, and it is never the daily challenge.
BEGIN;

ALTER TABLE public.game_matches DROP CONSTRAINT IF EXISTS game_matches_game_check;
ALTER TABLE public.game_matches ADD CONSTRAINT game_matches_game_check
  CHECK (game IN ('tic-tac-toe','rock-paper-scissors','snake','chess'));
ALTER TABLE public.game_matches ADD COLUMN IF NOT EXISTS chess jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The starting position, index 0 = a8 as on the phone. `*` marks a promoted piece.
CREATE OR REPLACE FUNCTION public.chess_start_board() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT jsonb_agg(cell ORDER BY n) FROM (
    SELECT n, CASE
      WHEN n IN (0,7) THEN 'bR' WHEN n IN (1,6) THEN 'bN' WHEN n IN (2,5) THEN 'bB'
      WHEN n = 3 THEN 'bQ' WHEN n = 4 THEN 'bK'
      WHEN n BETWEEN 8 AND 15 THEN 'bP' WHEN n BETWEEN 48 AND 55 THEN 'wP'
      WHEN n IN (56,63) THEN 'wR' WHEN n IN (57,62) THEN 'wN' WHEN n IN (58,61) THEN 'wB'
      WHEN n = 59 THEN 'wQ' WHEN n = 60 THEN 'wK' ELSE '' END AS cell
    FROM generate_series(0,63) AS n) s
$$;

-- Mirror of isSquareAttacked in src/lib/chess.ts (squares are 0-based here too).
CREATE OR REPLACE FUNCTION public.chess_attacked(p_board text[], p_sq integer, p_by text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  r integer := p_sq / 8; c integer := p_sq % 8;
  pr integer; pc integer; cell text;
  dr integer; dc integer; rr integer; cc integer;
  steps integer[][] := ARRAY[[0,1],[0,-1],[1,0],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]];
  kinds text;
BEGIN
  pr := CASE WHEN p_by = 'w' THEN r + 1 ELSE r - 1 END;
  FOREACH pc IN ARRAY ARRAY[c-1,c+1] LOOP
    IF pr BETWEEN 0 AND 7 AND pc BETWEEN 0 AND 7 AND p_board[pr*8+pc+1] = p_by||'P' THEN RETURN true; END IF;
  END LOOP;
  FOREACH dr IN ARRAY ARRAY[-2,-1,1,2] LOOP
    FOREACH dc IN ARRAY ARRAY[-2,-1,1,2] LOOP
      IF abs(dr) <> abs(dc) AND r+dr BETWEEN 0 AND 7 AND c+dc BETWEEN 0 AND 7
         AND p_board[(r+dr)*8+c+dc+1] = p_by||'N' THEN RETURN true; END IF;
    END LOOP;
  END LOOP;
  FOR dr IN -1..1 LOOP FOR dc IN -1..1 LOOP
    IF (dr <> 0 OR dc <> 0) AND r+dr BETWEEN 0 AND 7 AND c+dc BETWEEN 0 AND 7
       AND p_board[(r+dr)*8+c+dc+1] = p_by||'K' THEN RETURN true; END IF;
  END LOOP; END LOOP;
  FOR i IN 1..8 LOOP
    dr := steps[i][1]; dc := steps[i][2];
    kinds := CASE WHEN i <= 4 THEN 'RQ' ELSE 'BQ' END;
    rr := r + dr; cc := c + dc;
    WHILE rr BETWEEN 0 AND 7 AND cc BETWEEN 0 AND 7 LOOP
      cell := p_board[rr*8+cc+1];
      IF cell <> '' THEN
        IF left(cell,1) = p_by AND kinds LIKE '%'||substring(cell,2,1)||'%' THEN RETURN true; END IF;
        EXIT;
      END IF;
      rr := rr + dr; cc := cc + dc;
    END LOOP;
  END LOOP;
  RETURN false;
END $$;

-- Mirror of pseudoMoves, for one candidate move: movement rules only, no king safety.
-- Castling's "not out of, through or into check" is part of king safety (chess_legal);
-- what is checked here is rights, empty squares and the rook being home.
CREATE OR REPLACE FUNCTION public.chess_pseudo(p_board text[], p_castling text, p_ep integer, p_from integer, p_to integer) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  moving text := p_board[p_from+1]; target text := p_board[p_to+1];
  colour text; kind text;
  fr integer := p_from / 8; fc integer := p_from % 8;
  tr integer := p_to / 8; tc integer := p_to % 8;
  dr integer; dc integer; dir integer; step_r integer; step_c integer; rr integer; cc integer;
BEGIN
  IF moving = '' OR p_from = p_to THEN RETURN false; END IF;
  colour := left(moving,1); kind := substring(moving,2,1);
  IF target <> '' AND left(target,1) = colour THEN RETURN false; END IF;
  dr := tr - fr; dc := tc - fc;
  IF kind = 'P' THEN
      dir := CASE WHEN colour = 'w' THEN -1 ELSE 1 END;
      IF dc = 0 AND target = '' THEN
        RETURN dr = dir OR (dr = 2*dir AND fr = CASE WHEN colour='w' THEN 6 ELSE 1 END AND p_board[(fr+dir)*8+fc+1] = '');
      END IF;
      RETURN abs(dc) = 1 AND dr = dir AND (target <> '' OR (p_ep IS NOT NULL AND p_to = p_ep));
  ELSIF kind = 'N' THEN
      RETURN (abs(dr),abs(dc)) IN ((1,2),(2,1));
  ELSIF kind IN ('B','R','Q') THEN
      IF kind = 'B' AND abs(dr) <> abs(dc) THEN RETURN false; END IF;
      IF kind = 'R' AND dr <> 0 AND dc <> 0 THEN RETURN false; END IF;
      IF kind = 'Q' AND abs(dr) <> abs(dc) AND dr <> 0 AND dc <> 0 THEN RETURN false; END IF;
      step_r := sign(dr); step_c := sign(dc); rr := fr + step_r; cc := fc + step_c;
      WHILE rr <> tr OR cc <> tc LOOP
        IF p_board[rr*8+cc+1] <> '' THEN RETURN false; END IF;
        rr := rr + step_r; cc := cc + step_c;
      END LOOP;
      RETURN true;
  ELSIF kind = 'K' THEN
      IF greatest(abs(dr),abs(dc)) = 1 THEN RETURN true; END IF;
      IF dr = 0 AND abs(dc) = 2 AND p_from = (CASE WHEN colour='w' THEN 60 ELSE 4 END) THEN
        IF dc > 0 THEN
          RETURN p_castling LIKE '%'||(CASE WHEN colour='w' THEN 'K' ELSE 'k' END)||'%'
             AND p_board[p_from+2] = '' AND p_board[p_from+3] = '' AND p_board[p_from+4] = colour||'R';
        ELSE
          RETURN p_castling LIKE '%'||(CASE WHEN colour='w' THEN 'Q' ELSE 'q' END)||'%'
             AND p_board[p_from] = '' AND p_board[p_from-1] = '' AND p_board[p_from-2] = '' AND p_board[p_from-3] = colour||'R';
        END IF;
      END IF;
      RETURN false;
  END IF;
  RETURN false;
END $$;

-- Mirror of movedBoard: apply a pseudo-legal move to a bare board.
CREATE OR REPLACE FUNCTION public.chess_apply(p_board text[], p_from integer, p_to integer, p_promo text, p_ep integer) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  b text[] := p_board; moving text := p_board[p_from+1];
  colour text := left(moving,1); kind text := substring(moving,2,1);
BEGIN
  b[p_from+1] := '';
  IF kind = 'P' AND p_to = p_ep AND p_board[p_to+1] = '' AND (p_to % 8) <> (p_from % 8) THEN
    b[p_to + CASE WHEN colour='w' THEN 8 ELSE -8 END + 1] := '';   -- the pawn that double-stepped
  END IF;
  b[p_to+1] := CASE WHEN kind = 'P' AND p_to / 8 IN (0,7)
    THEN colour || coalesce(p_promo,'Q') || (CASE WHEN coalesce(p_promo,'Q') = 'Q' THEN '*' ELSE '' END)
    ELSE moving END;
  IF kind = 'K' AND abs(p_to - p_from) = 2 THEN                 -- castling: bring the rook over
    IF p_to > p_from THEN b[p_from+2] := b[p_from+4]; b[p_from+4] := '';
    ELSE b[p_from-1] := b[p_from-3]; b[p_from-3] := ''; END IF;
  END IF;
  RETURN b;
END $$;

-- Mirror of legalMoves' king-safety filter, for one candidate move (incl. castling
-- not out of, through or into check).
CREATE OR REPLACE FUNCTION public.chess_legal(p_board text[], p_castling text, p_ep integer, p_from integer, p_to integer, p_promo text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  moving text := p_board[p_from+1]; colour text := left(moving,1);
  enemy text := CASE WHEN colour='w' THEN 'b' ELSE 'w' END;
  b text[]; king_at integer;
BEGIN
  IF NOT public.chess_pseudo(p_board, p_castling, p_ep, p_from, p_to) THEN RETURN false; END IF;
  IF substring(moving,2,1) = 'K' AND abs(p_to - p_from) = 2 THEN
    IF public.chess_attacked(p_board, p_from, enemy)
       OR public.chess_attacked(p_board, (p_from+p_to)/2, enemy) THEN RETURN false; END IF;
  END IF;
  b := public.chess_apply(p_board, p_from, p_to, p_promo, p_ep);
  SELECT i-1 INTO king_at FROM generate_series(1,64) AS i WHERE b[i] = colour||'K' LIMIT 1;
  RETURN king_at IS NOT NULL AND NOT public.chess_attacked(b, king_at, enemy);
END $$;

-- Mirror of "the side to move has a legal reply": the checkmate/stalemate test.
CREATE OR REPLACE FUNCTION public.chess_has_move(p_board text[], p_castling text, p_ep integer, p_colour text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE f integer; t integer;
BEGIN
  FOR f IN 0..63 LOOP
    IF left(p_board[f+1],1) IS NOT DISTINCT FROM p_colour AND p_board[f+1] <> '' THEN
      FOR t IN 0..63 LOOP
        IF public.chess_legal(p_board, p_castling, p_ep, f, t, 'Q') THEN RETURN true; END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN false;
END $$;

CREATE OR REPLACE FUNCTION public.chess_in_check(p_board text[], p_colour text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE king_at integer;
BEGIN
  SELECT i-1 INTO king_at FROM generate_series(1,64) AS i WHERE p_board[i] = p_colour||'K' LIMIT 1;
  RETURN king_at IS NOT NULL AND public.chess_attacked(p_board, king_at, CASE WHEN p_colour='w' THEN 'b' ELSE 'w' END);
END $$;

-- What a phone may see of a match: everything, minus the repetition counts.
-- (Chess has no secrets to seal, unlike rock-paper-scissors picks or a blind snake run.)
CREATE OR REPLACE FUNCTION public.chess_view(p_chess jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE WHEN p_chess IS NULL OR p_chess = '{}'::jsonb THEN NULL ELSE p_chess - 'repetitions' END
$$;

CREATE OR REPLACE FUNCTION public.chess_state_json(p_mode text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE board jsonb := public.chess_start_board();
BEGIN
  RETURN jsonb_build_object(
    'mode', p_mode, 'board', board, 'castling', 'KQkq', 'en_passant', NULL,
    'halfmove', 0, 'captures', jsonb_build_object('white','[]'::jsonb,'black','[]'::jsonb),
    'history', '[]'::jsonb, 'end_reason', NULL, 'drawn', false,
    'repetitions', jsonb_build_object(
      array_to_string(ARRAY(SELECT jsonb_array_elements_text(board)), ',') || ' w KQkq -', 1));
END $$;

-- Start (or resume) the couple's one open chess match. player_x is White and moves
-- first. The situational mode is chosen by whoever starts; a rematch keeps the mode
-- only if the starter picks it again — the mode lives in the match, not the request.
CREATE OR REPLACE FUNCTION public.start_chess(p_mode text DEFAULT 'classic') RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cid uuid := public.get_user_couple_id(auth.uid()); partner uuid; mid uuid;
BEGIN
  IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('classic','capture-race','queen-hunt') THEN
    RAISE EXCEPTION 'Choose a chess duel: classic, capture-race or queen-hunt.';
  END IF;
  PERFORM 1 FROM public.couples WHERE id = cid FOR UPDATE;
  SELECT id INTO partner FROM public.profiles WHERE couple_id = cid AND id <> auth.uid();
  IF partner IS NULL THEN RAISE EXCEPTION 'Both partners must be paired.'; END IF;
  SELECT id INTO mid FROM public.game_matches
   WHERE couple_id = cid AND game = 'chess' AND daily_date IS NULL AND NOT finished;
  IF mid IS NOT NULL THEN RETURN mid; END IF;
  INSERT INTO public.game_matches(couple_id, game, daily_date, player_x, player_o, turn_id, best_of, chess)
  VALUES(cid, 'chess', NULL, auth.uid(), partner, auth.uid(), 3, public.chess_state_json(p_mode))
  RETURNING id INTO mid;
  RETURN mid;
END $$;

-- The one door moves come through. p_move is coordinate notation (`e2e4`, `e7e8q`
-- for a promotion, queen by default) or `resign`. p_round is the match's ply count,
-- checked exactly as play_game checks it, so two phones can never both move.
CREATE OR REPLACE FUNCTION public.chess_move(p_id uuid, p_round integer, p_move text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid uuid := auth.uid();
  cid uuid := public.get_user_couple_id(auth.uid());
  m public.game_matches;
  st jsonb; board text[]; castling text; ep integer; mode text;
  mover text; enemy text; mover_name text; enemy_name text;
  frm integer; dst integer; promo text;
  moving text; kind text; captured text := ''; captured_name text;
  nb text[]; new_castling text := ''; new_ep integer := NULL; halfmove integer;
  captures jsonb; cap_count integer; key text; reps jsonb;
  winner uuid := NULL; end_reason text := NULL; drawn boolean := false;
  notation text; names jsonb := '{"P":"pawn","N":"knight","B":"bishop","R":"rook","Q":"queen","K":"king"}'::jsonb;
BEGIN
  IF uid IS NULL OR cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
  SELECT * INTO m FROM public.game_matches WHERE id = p_id AND couple_id = cid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Game not found.'; END IF;
  IF m.game <> 'chess' THEN RAISE EXCEPTION 'That is not a chess match.'; END IF;
  IF m.finished THEN RAISE EXCEPTION 'This match is finished.'; END IF;
  st := m.chess;
  mode := st->>'mode';

  -- Resignation needs no turn: walking away is always allowed, and no situational
  -- goal protects a king whose owner has given up.
  IF p_move = 'resign' THEN
    st := st || jsonb_build_object('end_reason','resigned');
    UPDATE public.game_matches SET chess = st, finished = true,
      winner_id = CASE WHEN uid = m.player_x THEN m.player_o ELSE m.player_x END WHERE id = m.id;
    RETURN public.chess_view(st);
  END IF;

  IF m.turn_id <> uid THEN RAISE EXCEPTION 'It is your partner''s turn.'; END IF;
  IF p_round IS DISTINCT FROM m.round THEN RAISE EXCEPTION 'The game changed. Try again.'; END IF;
  IF p_move IS NULL OR p_move !~ '^[a-h][1-8][a-h][1-8][qrbn]?$' THEN
    RAISE EXCEPTION 'Send a move like e2e4 (or e7e8q to promote).';
  END IF;
  mover := CASE WHEN uid = m.player_x THEN 'w' ELSE 'b' END;
  enemy := CASE WHEN mover = 'w' THEN 'b' ELSE 'w' END;
  mover_name := CASE WHEN mover = 'w' THEN 'white' ELSE 'black' END;
  enemy_name := CASE WHEN mover = 'w' THEN 'black' ELSE 'white' END;
  frm := (8 - substring(p_move,2,1)::integer) * 8 + (ascii(substring(p_move,1,1)) - 97);
  dst := (8 - substring(p_move,4,1)::integer) * 8 + (ascii(substring(p_move,3,1)) - 97);
  promo := CASE WHEN length(p_move) = 5 THEN upper(substring(p_move,5,1)) END;

  SELECT ARRAY(SELECT jsonb_array_elements_text(st->'board')) INTO board;
  castling := st->>'castling';
  ep := (st->>'en_passant')::integer;
  moving := board[frm+1];
  IF moving = '' OR left(moving,1) <> mover THEN RAISE EXCEPTION 'That is not your piece.'; END IF;
  kind := substring(moving,2,1);
  IF kind = 'P' AND dst / 8 IN (0,7) THEN promo := coalesce(promo,'Q');
  ELSIF promo IS NOT NULL THEN RAISE EXCEPTION 'Only a pawn reaching the last rank promotes.'; END IF;
  IF NOT public.chess_legal(board, castling, ep, frm, dst, promo) THEN
    RAISE EXCEPTION 'That move is not legal.';
  END IF;

  -- What fell: the target square, or the pawn beside an en-passant capture. The
  -- database counts it; the phone only ever named two squares.
  captured := board[dst+1];
  IF kind = 'P' AND dst = ep AND captured = '' AND (dst % 8) <> (frm % 8) THEN
    captured := board[dst + CASE WHEN mover='w' THEN 8 ELSE -8 END + 1];
  END IF;

  nb := public.chess_apply(board, frm, dst, promo, ep);
  -- Castling rights: a king move spends both, a rook leaving (or being taken on) its
  -- home square spends that side's.
  BEGIN
    new_castling := castling;
    IF kind = 'K' THEN
      new_castling := replace(replace(new_castling, CASE WHEN mover='w' THEN 'K' ELSE 'k' END, ''),
                                      CASE WHEN mover='w' THEN 'Q' ELSE 'q' END, '');
    END IF;
    IF frm = 63 OR dst = 63 THEN new_castling := replace(new_castling,'K',''); END IF;
    IF frm = 56 OR dst = 56 THEN new_castling := replace(new_castling,'Q',''); END IF;
    IF frm = 7 OR dst = 7 THEN new_castling := replace(new_castling,'k',''); END IF;
    IF frm = 0 OR dst = 0 THEN new_castling := replace(new_castling,'q',''); END IF;
  END;
  IF kind = 'P' AND abs(dst - frm) = 16 THEN new_ep := (frm + dst) / 2; END IF;
  halfmove := CASE WHEN kind = 'P' OR captured <> '' THEN 0 ELSE (st->>'halfmove')::integer + 1 END;
  captures := st->'captures';
  IF captured <> '' THEN
    captured_name := names->>substring(captured,2,1);
    captures := jsonb_set(captures, ARRAY[mover_name],
      (captures->mover_name) || jsonb_build_array(captured_name));
  END IF;
  cap_count := jsonb_array_length(captures->mover_name);

  -- The situational layer, scored the moment the capturing move lands. Checkmate is
  -- evaluated right after in the same breath (a mating move wins either way — same
  -- player), and a goal move can never have exposed the mover's own king because
  -- chess_legal filtered those out: "first to the goal, unless checkmated" holds.
  IF captured <> '' AND mode = 'capture-race' AND cap_count >= 7 THEN
    winner := uid; end_reason := 'capture-race';
  ELSIF captured <> '' AND mode = 'queen-hunt' AND captured = enemy||'Q' THEN
    winner := uid; end_reason := 'queen-hunt';   -- exact code: a promoted `Q*` does not count
  END IF;

  reps := coalesce(st->'repetitions','{}'::jsonb);
  key := array_to_string(nb, ',') || ' ' || enemy || ' ' || coalesce(nullif(new_castling,''),'-')
         || ' ' || coalesce(new_ep::text,'-');
  reps := jsonb_set(reps, ARRAY[key], to_jsonb(coalesce((reps->>key)::integer,0) + 1));

  IF winner IS NULL THEN
    IF NOT public.chess_has_move(nb, new_castling, new_ep, enemy) THEN
      IF public.chess_in_check(nb, enemy) THEN winner := uid; end_reason := 'checkmate';
      ELSE drawn := true; end_reason := 'stalemate'; END IF;
    ELSIF halfmove >= 100 THEN drawn := true; end_reason := 'fifty-move';
    ELSIF NOT EXISTS (
      SELECT 1 FROM unnest(nb) AS cell WHERE cell <> '' AND substring(cell,2,1) IN ('P','R','Q')
    ) AND (SELECT count(*) FROM unnest(nb) AS cell WHERE cell <> '' AND substring(cell,2,1) IN ('B','N')) <= 1 THEN
      drawn := true; end_reason := 'insufficient-material';
    ELSIF (reps->>key)::integer >= 3 THEN drawn := true; end_reason := 'threefold';
    END IF;
  END IF;

  notation := CASE
    WHEN kind = 'K' AND abs(dst - frm) = 2 THEN CASE WHEN dst > frm THEN 'O-O' ELSE 'O-O-O' END
    WHEN kind = 'P' THEN (CASE WHEN captured <> '' THEN chr(97 + frm % 8) || 'x' ELSE '' END)
        || chr(97 + dst % 8) || (8 - dst / 8)::text || (CASE WHEN promo IS NOT NULL THEN '=' || promo ELSE '' END)
    ELSE (CASE WHEN kind='N' THEN 'N' ELSE kind END) || (CASE WHEN captured <> '' THEN 'x' ELSE '' END)
        || chr(97 + dst % 8) || (8 - dst / 8)::text END;
  IF end_reason = 'checkmate' THEN notation := notation || '#';
  ELSIF public.chess_in_check(nb, enemy) THEN notation := notation || '+'; END IF;

  st := jsonb_build_object(
    'mode', mode, 'board', to_jsonb(nb), 'castling', coalesce(nullif(new_castling,''),'-'),
    'en_passant', new_ep, 'halfmove', halfmove, 'captures', captures,
    'history', (st->'history') || jsonb_build_array(notation),
    'end_reason', end_reason, 'drawn', drawn, 'repetitions', reps);

  UPDATE public.game_matches SET chess = st,
    turn_id = CASE WHEN uid = m.player_x THEN m.player_o ELSE m.player_x END,
    round = m.round + 1,
    finished = winner IS NOT NULL OR drawn,
    winner_id = winner
  WHERE id = m.id;
  RETURN public.chess_view(st);
END $$;

-- `authenticated` is revoked by name, as in migration 010: Supabase's default privileges
-- grant EXECUTE on new public functions directly to authenticated, so a PUBLIC/anon-only
-- revoke would leave the whole chess referee callable by any signed-in phone.
REVOKE ALL ON FUNCTION public.chess_start_board(), public.chess_attacked(text[],integer,text),
  public.chess_pseudo(text[],text,integer,integer,integer), public.chess_apply(text[],integer,integer,text,integer),
  public.chess_legal(text[],text,integer,integer,integer,text), public.chess_has_move(text[],text,integer,text),
  public.chess_in_check(text[],text), public.chess_view(jsonb), public.chess_state_json(text),
  public.start_chess(text), public.chess_move(uuid,integer,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_chess(text), public.chess_move(uuid,integer,text) TO authenticated;

-- The snapshot carries the chess position (public information — there is nothing to
-- seal), and start_game refuses chess: a chess match needs its mode, so it starts
-- through start_chess.
CREATE OR REPLACE FUNCTION public.games_state() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); result jsonb;
BEGIN
 IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
 PERFORM public.snake_sweep(cid);
 SELECT jsonb_build_object('today', (now() AT TIME ZONE 'UTC')::date,
 'wins', (SELECT coalesce(jsonb_object_agg(winner_id,n),'{}') FROM
   (SELECT winner_id,count(*) n FROM public.game_matches WHERE couple_id=cid AND finished AND winner_id IS NOT NULL GROUP BY winner_id) w),
 'matches',coalesce((SELECT jsonb_agg(safe ORDER BY created_at DESC) FROM (
 SELECT created_at, (to_jsonb(m)-'pick_x'-'pick_o'-'snake'-'chess') || jsonb_build_object(
 'my_pick',CASE WHEN auth.uid()=player_x THEN pick_x ELSE pick_o END,
 'partner_locked',CASE WHEN auth.uid()=player_x THEN pick_o IS NOT NULL ELSE pick_x IS NOT NULL END,
 'snake',CASE WHEN m.game='snake' THEN public.snake_view(m.snake, auth.uid(), m.finished, m.player_x, m.player_o) END,
 'chess',CASE WHEN m.game='chess' THEN public.chess_view(m.chess) END) safe
 FROM public.game_matches m WHERE couple_id=cid AND (NOT finished OR daily_date=(now() AT TIME ZONE 'UTC')::date OR id IN (SELECT id FROM public.game_matches WHERE couple_id=cid ORDER BY created_at DESC LIMIT 30))
 ) recent),'[]')) INTO result;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.start_game(p_game text, p_daily boolean DEFAULT false, p_best_of integer DEFAULT 3)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cid uuid := public.get_user_couple_id(auth.uid()); partner uuid; mid uuid; chosen text;
BEGIN
 IF cid IS NULL THEN RAISE EXCEPTION 'Pair with your partner to play.'; END IF;
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
 chosen := CASE WHEN p_daily THEN (ARRAY['tic-tac-toe','rock-paper-scissors'])[1+floor(random()*2)::integer] ELSE p_game END;
 INSERT INTO public.game_matches(couple_id,game,daily_date,player_x,player_o,turn_id,best_of)
 VALUES(cid,chosen,CASE WHEN p_daily THEN (now() AT TIME ZONE 'UTC')::date END,auth.uid(),partner,auth.uid(),CASE WHEN p_daily THEN 3 ELSE p_best_of END) RETURNING id INTO mid;
 RETURN mid;
END $$;

COMMIT;
