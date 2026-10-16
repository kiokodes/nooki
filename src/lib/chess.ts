/**
 * Chess core: pure and deterministic, in the same spirit as `snake.ts` / `sudoku.ts`.
 *
 * This is a clean-room adaptation of the ideas in Kingcitaldo125/PyChess
 * (https://github.com/Kingcitaldo125/PyChess/tree/main/chess) — an 8×8 cell board,
 * one `get_moves`-style generator per piece, line-of-sight blocking for sliders and
 * a check test built from enemy attacks. No PyChess code or artwork is copied: that
 * project is GPL-3.0 and its engine omits most of the rules below, so this file
 * re-implements (and completes) the rules in TypeScript instead:
 *
 *   PyChess                          here
 *   -------------------------------- ------------------------------------------
 *   board.py  Cell/Board 8×8 grid    `ChessState.board`, 64 squares, index 0 = a8
 *   piece.py  get_moves/get_attacks  `pseudoMoves()` per piece kind
 *   move_handler.py  LOS DFS filter  ray casting that stops at the first blocker
 *   handler.py  evaluate_check       `isInCheck()` / `isSquareAttacked()`
 *   handler.py  evaluate_checkmate   `legalMoves()` + no-legal-move detection
 *                                    (PyChess only tested the king's own escapes)
 *
 * Added on top of PyChess (it has none of these): legal-move filtering for every
 * piece (you may not leave your king in check), castling, en passant, promotion,
 * stalemate, insufficient material, the fifty-move rule, threefold repetition —
 * and Nooki's situational win conditions, layered over normal chess:
 *
 *   - `capture-race` — first side to capture 7 enemy pieces wins on the spot.
 *   - `queen-hunt`   — first side to capture the enemy's *original* queen wins.
 *
 * In every mode checkmate still wins and being checkmated still loses: a situational
 * goal is scored the moment the capturing move lands, and because a legal move can
 * never leave your own king in check, a goal can never be "bought" by hanging
 * your king. Kings are never captured — checkmate ends the game first, exactly
 * as in normal chess.
 */

export type ChessColor = 'white' | 'black';
export type ChessPieceType = 'pawn' | 'knight' | 'bishop' | 'rook' | 'queen' | 'king';
export type ChessMode = 'classic' | 'capture-race' | 'queen-hunt';

export interface ChessPiece {
  /** Stable identity, e.g. `white-queen`. Promoted pieces get fresh ids, so the
   *  queen hunt can tell the original queen from a promoted one. */
  id: string;
  type: ChessPieceType;
  color: ChessColor;
}

/** Squares are 0–63, index 0 = a8, 63 = h1 (row 0 is rank 8, as on screen for White). */
export type ChessBoard = (ChessPiece | null)[];

export interface ChessMove {
  from: number;
  to: number;
  piece: ChessPieceType;
  captured: ChessPieceType | null;
  promotion: ChessPieceType | null;
  castle: 'king' | 'queen' | null;
  enPassant: boolean;
  /** Short algebraic-ish label, e.g. `e4`, `Nxf3`, `O-O`, `exd8=Q+`. */
  notation: string;
}

export type ChessEndReason =
  | 'checkmate' | 'stalemate' | 'resigned'
  | 'capture-race' | 'queen-hunt'
  | 'insufficient-material' | 'fifty-move' | 'threefold';

export interface ChessState {
  board: ChessBoard;
  turn: ChessColor;
  castling: { K: boolean; Q: boolean; k: boolean; q: boolean };
  /** Square behind a pawn that just double-stepped, or null. */
  enPassant: number | null;
  halfmove: number;
  fullmove: number;
  mode: ChessMode;
  /** Pieces each side has captured, in capture order (`white` = captured *by* White). */
  captures: Record<ChessColor, ChessPieceType[]>;
  winner: ChessColor | null;
  endReason: ChessEndReason | null;
  /** True when the game ended without a winner. */
  drawn: boolean;
  /** Notation of every move played, in order. */
  history: string[];
  /** Position keys seen so far (for threefold repetition), including the start. */
  repetitions: Record<string, number>;
}

export const CHESS_MODES: { id: ChessMode; name: string; icon: string; goal: number | null; blurb: string }[] = [
  { id: 'classic', name: 'Classic Duel', icon: '♔', goal: null, blurb: 'Normal chess. Checkmate (or resignation) wins — stalemate is a draw.' },
  { id: 'capture-race', name: 'Capture Race · First to 7', icon: '🎯', goal: 7, blurb: 'First to capture 7 enemy pieces wins instantly — but get checkmated first and you still lose.' },
  { id: 'queen-hunt', name: 'Queen Hunt', icon: '♛', goal: null, blurb: 'Capture their original queen to win instantly — while keeping your king safe from checkmate.' },
];

export const PIECE_GLYPHS: Record<ChessColor, Record<ChessPieceType, string>> = {
  white: { king: '♔', queen: '♕', rook: '♖', bishop: '♗', knight: '♘', pawn: '♙' },
  black: { king: '♚', queen: '♛', rook: '♜', bishop: '♝', knight: '♞', pawn: '♟' },
};
export const PIECE_VALUES: Record<ChessPieceType, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };

export const opponent = (color: ChessColor): ChessColor => (color === 'white' ? 'black' : 'white');
export const squareName = (sq: number) => `${'abcdefgh'[sq % 8]}${8 - Math.floor(sq / 8)}`;
export const squareFromName = (name: string) => (8 - Number(name[1])) * 8 + 'abcdefgh'.indexOf(name[0]);

const BACK_RANK: ChessPieceType[] = ['rook', 'knight', 'bishop', 'queen', 'king', 'bishop', 'knight', 'rook'];
const piece = (color: ChessColor, type: ChessPieceType, n = 0): ChessPiece => ({
  color, type, id: n ? `${color}-${type}-${n}` : `${color}-${type}`,
});

export function createChessState(mode: ChessMode = 'classic'): ChessState {
  const board: ChessBoard = new Array(64).fill(null);
  BACK_RANK.forEach((type, file) => {
    board[file] = piece('black', type, type === 'rook' || type === 'knight' || type === 'bishop' ? file % 2 + 1 : 0);
    board[56 + file] = piece('white', type, type === 'rook' || type === 'knight' || type === 'bishop' ? file % 2 + 1 : 0);
    board[8 + file] = piece('black', 'pawn', file + 1);
    board[48 + file] = piece('white', 'pawn', file + 1);
  });
  const state: ChessState = {
    board, turn: 'white', mode,
    castling: { K: true, Q: true, k: true, q: true },
    enPassant: null, halfmove: 0, fullmove: 1,
    captures: { white: [], black: [] },
    winner: null, endReason: null, drawn: false, history: [],
    repetitions: {},
  };
  state.repetitions[positionKey(state)] = 1;
  return state;
}

export function positionKey(state: ChessState): string {
  const cells = state.board.map((p) => (p ? (p.color === 'white' ? 'PNBRQK' : 'pnbrqk')['pawn,knight,bishop,rook,queen,king'.split(',').indexOf(p.type)] : '.')).join('');
  const castling = (state.castling.K ? 'K' : '') + (state.castling.Q ? 'Q' : '') + (state.castling.k ? 'k' : '') + (state.castling.q ? 'q' : '');
  return `${cells} ${state.turn === 'white' ? 'w' : 'b'} ${castling || '-'} ${state.enPassant ?? '-'}`;
}

const inBoard = (row: number, col: number) => row >= 0 && row < 8 && col >= 0 && col < 8;

/** Is `sq` attacked by any `by` piece? The check test PyChess builds from attacks. */
export function isSquareAttacked(board: ChessBoard, sq: number, by: ChessColor): boolean {
  const row = Math.floor(sq / 8), col = sq % 8;
  // Pawns attack diagonally forwards (white towards row 0).
  const pawnRow = by === 'white' ? row + 1 : row - 1;
  for (const dc of [-1, 1]) {
    if (!inBoard(pawnRow, col + dc)) continue;
    const p = board[pawnRow * 8 + col + dc];
    if (p?.type === 'pawn' && p.color === by) return true;
  }
  for (const [dr, dc] of [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]) {
    if (!inBoard(row + dr, col + dc)) continue;
    const p = board[(row + dr) * 8 + col + dc];
    if (p?.type === 'knight' && p.color === by) return true;
  }
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    if (!inBoard(row + dr, col + dc)) continue;
    const p = board[(row + dr) * 8 + col + dc];
    if (p?.type === 'king' && p.color === by) return true;
  }
  const ray = (dirs: [number, number][], kinds: ChessPieceType[]) => {
    for (const [dr, dc] of dirs) {
      let r = row + dr, c = col + dc;
      while (inBoard(r, c)) {
        const p = board[r * 8 + c];
        if (p) { if (p.color === by && kinds.includes(p.type)) return true; break; }
        r += dr; c += dc;
      }
    }
    return false;
  };
  return ray([[0, 1], [0, -1], [1, 0], [-1, 0]], ['rook', 'queen'])
      || ray([[1, 1], [1, -1], [-1, 1], [-1, -1]], ['bishop', 'queen']);
}

export function isInCheck(state: ChessState, color: ChessColor = state.turn): boolean {
  const king = state.board.findIndex((p) => p?.type === 'king' && p.color === color);
  return king >= 0 && isSquareAttacked(state.board, king, opponent(color));
}

type RawMove = { from: number; to: number; promotion?: ChessPieceType; castle?: 'king' | 'queen'; enPassant?: boolean };

/** Pseudo-legal moves for the piece on `from` (PyChess's get_moves + LOS filter). */
function pseudoMoves(state: ChessState, from: number): RawMove[] {
  const p = state.board[from];
  if (!p) return [];
  const row = Math.floor(from / 8), col = from % 8;
  const out: RawMove[] = [];
  const push = (r: number, c: number, extra: Partial<RawMove> = {}) => {
    if (!inBoard(r, c)) return false;
    const target = state.board[r * 8 + c];
    if (target?.color === p.color) return false;
    out.push({ from, to: r * 8 + c, ...extra });
    return !target; // sliders may only continue past empty squares
  };
  const slide = (dirs: [number, number][]) => {
    for (const [dr, dc] of dirs) {
      let r = row + dr, c = col + dc;
      while (inBoard(r, c) && push(r, c)) { r += dr; c += dc; }
    }
  };
  switch (p.type) {
    case 'pawn': {
      const dir = p.color === 'white' ? -1 : 1;
      const startRow = p.color === 'white' ? 6 : 1;
      const lastRow = p.color === 'white' ? 0 : 7;
      const step = (r: number, c: number, extra: Partial<RawMove> = {}) => {
        if (r === lastRow) for (const promotion of ['queen', 'rook', 'bishop', 'knight'] as ChessPieceType[]) out.push({ from, to: r * 8 + c, promotion, ...extra });
        else out.push({ from, to: r * 8 + c, ...extra });
      };
      if (inBoard(row + dir, col) && !state.board[(row + dir) * 8 + col]) {
        step(row + dir, col);
        if (row === startRow && !state.board[(row + 2 * dir) * 8 + col]) out.push({ from, to: (row + 2 * dir) * 8 + col });
      }
      for (const dc of [-1, 1]) {
        const r = row + dir, c = col + dc;
        if (!inBoard(r, c)) continue;
        const target = state.board[r * 8 + c];
        if (target && target.color !== p.color) step(r, c);
        else if (state.enPassant === r * 8 + c) out.push({ from, to: r * 8 + c, enPassant: true });
      }
      break;
    }
    case 'knight':
      for (const [dr, dc] of [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]) push(row + dr, col + dc);
      break;
    case 'bishop': slide([[1, 1], [1, -1], [-1, 1], [-1, -1]]); break;
    case 'rook': slide([[0, 1], [0, -1], [1, 0], [-1, 0]]); break;
    case 'queen': slide([[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]); break;
    case 'king': {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (dr || dc) push(row + dr, col + dc);
      const home = p.color === 'white' ? 60 : 4;
      const rights = p.color === 'white' ? ['K', 'Q'] as const : ['k', 'q'] as const;
      if (from === home && !isSquareAttacked(state.board, home, opponent(p.color))) {
        const sides: ['king' | 'queen', number, number[], number][] = [
          ['king', home + 2, [home + 1, home + 2], home + 3],
          ['queen', home - 2, [home - 1, home - 2, home - 3], home - 4],
        ];
        sides.forEach(([side, dest, empties, rookFrom], i) => {
          if (!state.castling[rights[i]]) return;
          if (!empties.every((sq) => !state.board[sq])) return;
          if (state.board[rookFrom]?.type !== 'rook' || state.board[rookFrom]?.color !== p.color) return;
          if ([dest, side === 'king' ? home + 1 : home - 1].some((sq) => isSquareAttacked(state.board, sq, opponent(p.color)))) return;
          out.push({ from, to: dest, castle: side });
        });
      }
      break;
    }
  }
  return out;
}

/** Apply a raw move to a bare board (no state bookkeeping) — used for king safety. */
function movedBoard(state: ChessState, move: { from: number; to: number; promotion?: ChessPieceType | null; castle?: 'king' | 'queen' | null; enPassant?: boolean }): ChessBoard {
  const board = state.board.slice();
  const moving = board[move.from]!;
  board[move.from] = null;
  if (move.enPassant) board[move.to + (moving.color === 'white' ? 8 : -8)] = null;
  board[move.to] = move.promotion ? { ...moving, type: move.promotion, id: `${moving.id}=${move.promotion}` } : moving;
  if (move.castle) {
    const home = moving.color === 'white' ? 60 : 4;
    const rookFrom = move.castle === 'king' ? home + 3 : home - 4;
    const rookTo = move.castle === 'king' ? home + 1 : home - 1;
    board[rookTo] = board[rookFrom];
    board[rookFrom] = null;
  }
  return board;
}

function toChessMove(state: ChessState, move: { from: number; to: number; promotion?: ChessPieceType | null; castle?: 'king' | 'queen' | null; enPassant?: boolean }, next: ChessState): ChessMove {
  const moving = state.board[move.from]!;
  const capturedPiece = move.enPassant
    ? state.board[move.to + (moving.color === 'white' ? 8 : -8)]
    : state.board[move.to];
  let notation: string;
  if (move.castle) notation = move.castle === 'king' ? 'O-O' : 'O-O-O';
  else if (moving.type === 'pawn') {
    notation = (capturedPiece ? `${'abcdefgh'[move.from % 8]}x` : '') + squareName(move.to) + (move.promotion ? `=${move.promotion[0].toUpperCase()}` : '');
  } else {
    notation = `${moving.type === 'knight' ? 'N' : moving.type[0].toUpperCase()}${capturedPiece ? 'x' : ''}${squareName(move.to)}`;
  }
  if (next.endReason === 'checkmate') notation += '#';
  else if (isInCheck(next, next.turn)) notation += '+';
  return {
    from: move.from, to: move.to, piece: moving.type,
    captured: capturedPiece?.type ?? null, promotion: move.promotion ?? null,
    castle: move.castle ?? null, enPassant: Boolean(move.enPassant), notation,
  };
}

/** Every fully legal move for `color` (defaults to the side to move). */
export function legalMoves(state: ChessState, color: ChessColor = state.turn): ChessMove[] {
  if (state.winner || state.drawn) return [];
  const moves: ChessMove[] = [];
  state.board.forEach((p, from) => {
    if (p?.color !== color) return;
    for (const raw of pseudoMoves(state, from)) {
      const probe: ChessState = { ...state, board: movedBoard(state, raw), turn: color };
      if (!isInCheck(probe, color)) moves.push(toChessMove(state, raw, { ...state, board: probe.board, turn: opponent(color) }));
    }
  });
  return moves;
}

export function legalMovesFrom(state: ChessState, from: number): ChessMove[] {
  return legalMoves(state).filter((m) => m.from === from);
}

/** Captures scored by `color` so far (the situational-goal scoreboard). */
export const captureCount = (state: ChessState, color: ChessColor) => state.captures[color].length;
export const capturedQueen = (state: ChessState, color: ChessColor) =>
  state.history.length > 0 && state.winner === color && state.endReason === 'queen-hunt';

function insufficientMaterial(board: ChessBoard): boolean {
  const rest = board.filter(Boolean) as ChessPiece[];
  if (rest.some((p) => ['pawn', 'rook', 'queen'].includes(p.type))) return false;
  const minors = rest.filter((p) => p.type !== 'king');
  if (minors.length <= 1) return true;
  // King + bishop vs king + bishop, bishops on the same colour, can never mate.
  return minors.length === 2 && minors.every((p) => p.type === 'bishop')
    && ((board.indexOf(minors[0]) % 8 + Math.floor(board.indexOf(minors[0]) / 8)) % 2)
      === ((board.indexOf(minors[1]) % 8 + Math.floor(board.indexOf(minors[1]) / 8)) % 2);
}

/**
 * Play a move (`from`/`to` square indexes, `promotion` defaults to queen).
 * Throws on anything illegal — callers should offer `legalMovesFrom` as the menu.
 */
export function applyMove(state: ChessState, from: number, to: number, promotion: ChessPieceType = 'queen'): ChessState {
  const legal = legalMoves(state).find((m) => m.from === from && m.to === to && (m.promotion ?? 'queen') === (promotion ?? 'queen'));
  if (!legal) throw new Error('That move is not legal.');
  const mover = state.turn;
  const moving = state.board[from]!;
  const capturedPiece = legal.enPassant
    ? state.board[to + (mover === 'white' ? 8 : -8)]
    : state.board[to];

  const next: ChessState = {
    ...state,
    board: movedBoard(state, legal),
    turn: opponent(mover),
    enPassant: moving.type === 'pawn' && Math.abs(to - from) === 16 ? (from + to) / 2 : null,
    halfmove: moving.type === 'pawn' || capturedPiece ? 0 : state.halfmove + 1,
    fullmove: mover === 'black' ? state.fullmove + 1 : state.fullmove,
    castling: { ...state.castling },
    captures: {
      white: mover === 'white' && capturedPiece ? [...state.captures.white, capturedPiece.type] : state.captures.white,
      black: mover === 'black' && capturedPiece ? [...state.captures.black, capturedPiece.type] : state.captures.black,
    },
    repetitions: { ...state.repetitions },
  };
  // Castling rights die when a king/rook moves or a home rook is captured.
  if (moving.type === 'king') { if (mover === 'white') { next.castling.K = next.castling.Q = false; } else { next.castling.k = next.castling.q = false; } }
  const rookHomes: [number, 'K' | 'Q' | 'k' | 'q'][] = [[63, 'K'], [56, 'Q'], [7, 'k'], [0, 'q']];
  for (const [sq, right] of rookHomes) if (from === sq || to === sq) next.castling[right] = false;

  // --- Situational goals, scored the moment the capturing move lands. ---------
  // Checkmate is evaluated right after: a mating move wins either way (same
  // player), and a goal move can never expose the mover's own king because
  // `legalMoves` already filtered those out — so "first to the goal, unless
  // checkmated" falls out naturally: the opponent gets no move to mate you with.
  if (capturedPiece && next.mode === 'capture-race' && captureCount(next, mover) >= (CHESS_MODES[1].goal ?? 7)) {
    next.winner = mover; next.endReason = 'capture-race';
  } else if (capturedPiece && next.mode === 'queen-hunt' && capturedPiece.id === `${opponent(mover)}-queen`) {
    next.winner = mover; next.endReason = 'queen-hunt';
  }

  if (!next.winner) {
    const replies = legalMoves({ ...next, winner: null, drawn: false });
    if (replies.length === 0) {
      if (isInCheck(next, next.turn)) { next.winner = mover; next.endReason = 'checkmate'; }
      else { next.drawn = true; next.endReason = 'stalemate'; }
    } else if (insufficientMaterial(next.board)) { next.drawn = true; next.endReason = 'insufficient-material'; }
    else if (next.halfmove >= 100) { next.drawn = true; next.endReason = 'fifty-move'; }
  }
  const key = positionKey(next);
  next.repetitions[key] = (next.repetitions[key] ?? 0) + 1;
  if (!next.winner && !next.drawn && next.repetitions[key] >= 3) { next.drawn = true; next.endReason = 'threefold'; }

  return { ...next, history: [...state.history, toChessMove(state, legal, next).notation] };
}

/** Resignation ends any mode at once — the situational goals never protect a king. */
export function resignChess(state: ChessState, color: ChessColor): ChessState {
  return state.winner || state.drawn ? state : { ...state, winner: opponent(color), endReason: 'resigned' };
}

export function chessStatusLabel(state: ChessState, names: Record<ChessColor, string>): string {
  if (state.winner) {
    const winner = names[state.winner];
    switch (state.endReason) {
      case 'checkmate': return `${winner} wins by checkmate! 🎉`;
      case 'capture-race': return `${winner} wins the Capture Race — 7 pieces captured! 🎯`;
      case 'queen-hunt': return `${winner} wins the Queen Hunt — the queen has fallen! ♛`;
      case 'resigned': return `${winner} wins — ${names[opponent(state.winner)]} resigned.`;
      default: return `${winner} wins! 🎉`;
    }
  }
  if (state.drawn) return state.endReason === 'stalemate' ? 'A draw — stalemate.' : 'A draw.';
  return `${names[state.turn]} to move${isInCheck(state) ? ' — in check!' : ''}`;
}
