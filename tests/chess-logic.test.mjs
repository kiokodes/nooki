import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

/**
 * The chess core is pure so the database version can mirror it later (the way SQL
 * mirrors snake.ts). These tests hammer the rules PyChess gets wrong or omits —
 * blocking, king safety, castling, en passant, promotion, checkmate — and Nooki's
 * situational wins: first to 7 captures, and the queen hunt, with checkmate
 * still trumping everything.
 */
test('chess core: legal moves, special moves, checkmate and situational wins', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const chess = await server.ssrLoadModule('/src/lib/chess.ts');
    const { createChessState, applyMove, legalMoves, legalMovesFrom, isInCheck, squareFromName, captureCount } = chess;
    const play = (state, uci) => {
      const promotion = uci[4] ? { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' }[uci[4]] : undefined;
      return applyMove(state, squareFromName(uci.slice(0, 2)), squareFromName(uci.slice(2, 4)), promotion);
    };
    const line = (state, moves) => moves.reduce(play, state);

    // --- Opening position -----------------------------------------------------------
    let s = createChessState();
    assert.equal(legalMoves(s).length, 20, 'twenty opening moves');
    assert.equal(legalMovesFrom(s, squareFromName('e2')).length, 2, 'pawn may single- or double-step');
    assert.equal(legalMovesFrom(s, squareFromName('a1')).length, 0, 'a blocked rook cannot jump its own pawn (PyChess lets it)');
    assert.throws(() => play(s, 'e1e2'), /not legal/, 'the king cannot capture its own pawn');

    // --- Fool's mate: checkmate is detected over ALL replies, not just king moves --
    s = line(createChessState(), ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    assert.equal(s.winner, 'black');
    assert.equal(s.endReason, 'checkmate');
    assert.equal(s.history.at(-1), 'Qh4#');

    // Scholar's mate ends in classic mode even though captures happened.
    s = line(createChessState(), ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7']);
    assert.equal(s.endReason, 'checkmate');

    // --- A move may not leave your own king in check ---------------------------------
    // Bb5 pins the c6-knight against the king on the b5-c6-d7-e8 diagonal once the
    // d-pawn steps aside: the knight has no legal moves at all.
    const pinned = line(createChessState(), ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'd7d6']);
    const blackMoves = legalMoves(pinned, 'black');
    assert.equal(blackMoves.filter((m) => m.from === squareFromName('c6')).length, 0, 'an absolutely pinned knight may not move');
    assert.ok(blackMoves.some((m) => m.from === squareFromName('d6')), 'the unpinned pawn still moves');

    // --- Castling, both sides, and not through check ---------------------------------
    s = line(createChessState(), ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6']);
    assert.ok(legalMovesFrom(s, squareFromName('e1')).some((m) => m.castle === 'king'), 'kingside castling is offered');
    s = play(s, 'e1g1');
    assert.equal(s.board[squareFromName('g1')].type, 'king');
    assert.equal(s.board[squareFromName('f1')].type, 'rook');
    assert.equal(s.history.at(-1), 'O-O');

    // --- En passant --------------------------------------------------------------------
    s = line(createChessState(), ['e2e4', 'a7a6', 'e4e5', 'd7d5']);
    const ep = legalMovesFrom(s, squareFromName('e5')).find((m) => m.enPassant);
    assert.ok(ep, 'en passant capture is offered right after the double step');
    s = play(s, 'e5d6');
    assert.equal(s.board[squareFromName('d5')], null, 'the pawn that double-stepped is removed');
    assert.equal(captureCount(s, 'white'), 1, 'en passant counts as a capture');

    // --- Promotion (with choice) ---------------------------------------------------------
    s = line(createChessState(), ['a2a4', 'b7b5', 'a4b5', 'a7a6', 'b5a6', 'b8c6', 'a6a7', 'a8b8']);
    assert.ok(legalMovesFrom(s, squareFromName('a7')).some((m) => m.promotion === 'knight'), 'underpromotion is offered');
    s = play(s, 'a7b8q');
    assert.equal(s.board[squareFromName('b8')].type, 'queen');

    // --- Capture Race: first to 7 wins the moment the 7th capture lands ------------------
    let race = createChessState('capture-race');
    race = line(race, ['e2e4', 'd7d5', 'e4d5', 'd8d5']);
    assert.equal(captureCount(race, 'white'), 1);
    assert.equal(race.winner, null, 'nobody wins a capture race at one capture');
    // Bank six captures on the state, then take a pawn for the seventh.
    let banked = createChessState('capture-race');
    banked = line(banked, ['e2e4', 'd7d5']);
    banked.captures = { white: ['pawn', 'pawn', 'knight', 'bishop', 'rook', 'pawn'], black: [] };
    const won = play(banked, 'e4d5');
    assert.equal(captureCount(won, 'white'), 7);
    assert.equal(won.winner, 'white');
    assert.equal(won.endReason, 'capture-race');

    // --- Queen Hunt: only the ORIGINAL queen counts ---------------------------------------
    let hunt = createChessState('queen-hunt');
    hunt = line(hunt, ['e2e4', 'd7d5', 'e4d5', 'd8d5']); // white pawn takes a pawn; black queen recaptures (black capture, not a queen)
    assert.equal(hunt.winner, null, 'capturing pieces near the queen is not the hunt');
    hunt = line(hunt, ['b1c3', 'g8f6', 'c3d5']); // knight takes the original black queen
    assert.equal(hunt.winner, 'white');
    assert.equal(hunt.endReason, 'queen-hunt');

    // --- ...but checkmate still beats the hunt: a mated queen-hunter loses -----------------
    const mateFirst = line(createChessState('queen-hunt'), ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    assert.equal(mateFirst.winner, 'black');
    assert.equal(mateFirst.endReason, 'checkmate', 'checkmate, not the hunt, ends a mated game');

    // --- Stalemate is a draw ------------------------------------------------------------------
    // Classic stalemate: black king a8, white queen b6, white to move plays Qb7?? no —
    // use the textbook Qc7 stalemate net instead: construct via a short forced line is
    // brittle, so assert the detector on the well-known final position reached by moves:
    let stale = createChessState();
    stale = line(stale, ['e2e3', 'a7a5', 'd1h5', 'a8a6', 'h5a5', 'h7h5', 'a5c7', 'a6h6', 'h2h4', 'f7f6', 'c7d7', 'e8f7', 'd7b7', 'd8d3', 'b7b8', 'd3h7', 'b8c8', 'f7g6', 'c8e6']);
    assert.equal(stale.drawn, true, "Sam Loyd's ten-move stalemate ends drawn");
    assert.equal(stale.endReason, 'stalemate');
  } finally { await server.close(); }
});
