import { useMemo, useState } from 'react';
import {
  CHESS_MODES, PIECE_GLYPHS, applyMove, captureCount, chessStatusLabel, createChessState,
  isInCheck, legalMovesFrom, opponent, resignChess, squareName,
  type ChessColor, type ChessMode, type ChessPieceType, type ChessState,
} from '../../lib/chess';
import { chessStateFromMatch, type GameMatch } from '../../lib/gamesService';
import './games.css';

const PROMOTIONS: ChessPieceType[] = ['queen', 'knight', 'rook', 'bishop'];
const PROMO_CODE: Record<ChessPieceType, string> = { queen: 'q', rook: 'r', bishop: 'b', knight: 'n', pawn: '', king: '' };

export interface OnlineChess {
  match: GameMatch;
  userId: string;
  busy: boolean;
  onMove: (move: string) => void;
  onRematch: (mode: ChessMode) => void;
}

/**
 * Chess for the Games tab, adapted (clean-room) from PyChess's click-to-select,
 * highlight-the-moves board onto Nooki's turn-based couple games.
 *
 * Two ways in: online (`online` set) — a saved match refereed by the database
 * (migration 202610150011_chess.sql), where this phone plays one colour and waits
 * for its partner between moves; and local pass-and-play, used by the design
 * preview, where both colours share the phone and the board flips each turn.
 */
export function ChessDuel({ partnerName, onExit, online }: { partnerName: string; onExit?: () => void; online?: OnlineChess }) {
  const [mode, setMode] = useState<ChessMode>('classic');
  const [localGame, setLocalGame] = useState<ChessState | null>(null);
  const [past, setPast] = useState<ChessState[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<{ from: number; to: number } | null>(null);
  const [flip, setFlip] = useState(true);

  const serverGame = useMemo(() => (online ? chessStateFromMatch(online.match) : null), [online]);
  const game = online ? serverGame : localGame;
  const myColor: ChessColor | null = online
    ? (online.match.player_x === online.userId ? 'white' : 'black')
    : null;
  const names: Record<ChessColor, string> = online
    ? {
        white: myColor === 'white' ? 'White (you)' : `White (${partnerName})`,
        black: myColor === 'black' ? 'Black (you)' : `Black (${partnerName})`,
      }
    : { white: 'White (you first)', black: `Black (${partnerName})` };

  const targets = useMemo(
    () => (game && selected !== null ? legalMovesFrom(game, selected) : []),
    [game, selected],
  );
  const targetSquares = useMemo(() => new Map(targets.map((m) => [m.to, m])), [targets]);

  const start = (nextMode: ChessMode) => {
    setMode(nextMode);
    setLocalGame(createChessState(nextMode));
    setPast([]); setSelected(null); setPendingPromotion(null);
  };

  const move = (from: number, to: number, promotion?: ChessPieceType) => {
    if (!game) return;
    if (online) {
      online.onMove(`${squareName(from)}${squareName(to)}${promotion ? PROMO_CODE[promotion] : ''}`);
    } else {
      try {
        setPast((p) => [...p, game]);
        setLocalGame(applyMove(game, from, to, promotion));
      } catch { /* illegal taps are simply ignored; legal targets are highlighted */ }
    }
    setSelected(null); setPendingPromotion(null);
  };

  const myTurn = !online || (game !== null && game.turn === myColor);
  const tap = (sq: number) => {
    if (!game || game.winner || game.drawn || pendingPromotion || !myTurn || online?.busy) return;
    const target = selected !== null ? targetSquares.get(sq) : undefined;
    if (target) {
      if (target.promotion) setPendingPromotion({ from: target.from, to: target.to });
      else move(target.from, target.to);
      return;
    }
    const p = game.board[sq];
    setSelected(p?.color === game.turn && (!online || p.color === myColor) ? sq : null);
  };

  if (!game) {
    return <div className="game-card" data-chess="setup">
      <div className="game-icon" aria-hidden="true">♞</div>
      <h2>Chess</h2>
      <p>Normal chess rules, plus a situational twist if you want one. Checkmate always counts — no goal saves a mated king.</p>
      <fieldset><legend>Choose your duel</legend>
        {CHESS_MODES.map((m) => <button key={m.id} type="button" aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>{m.icon} {m.name}</button>)}
      </fieldset>
      <p className="game-hint">{CHESS_MODES.find((m) => m.id === mode)?.blurb}</p>
      <p className="game-hint">Pass-and-play on this phone: White starts, then hand it over.</p>
      <button type="button" onClick={() => start(mode)} data-action="chess-start">Start {CHESS_MODES.find((m) => m.id === mode)?.name} →</button>
      {onExit && <button type="button" className="snake-secondary" onClick={onExit}>Back</button>}
    </div>;
  }

  const over = Boolean(game.winner || game.drawn);
  const viewColor: ChessColor = online ? (myColor ?? 'white') : flip && !over ? game.turn : 'white';
  const rows = viewColor === 'white' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const goalProgress = (color: ChessColor) => game.mode === 'capture-race'
    ? `${captureCount(game, color)}/7 captured`
    : game.mode === 'queen-hunt'
      ? (game.board.some((p) => p?.id === `${opponent(color)}-queen`) ? `${captureCount(game, color)} captured · their queen still stands ♛` : 'queen captured!')
      : `${captureCount(game, color)} captured`;
  const status = online && !over && !myTurn
    ? `Waiting for ${partnerName}…`
    : chessStatusLabel(game, names);

  return <div className="game-card" data-chess="playing" data-chess-mode={game.mode}>
    <p className="game-status" role="status">{status}</p>
    <div className="chess-scores" aria-label="Captures">
      {(['white', 'black'] as ChessColor[]).map((color) => <div key={color} className={game.turn === color && !over ? 'chess-turn' : ''}>
        <strong>{color === 'white' ? `♔ ${names.white}` : `♚ ${names.black}`}</strong>
        <span>{goalProgress(color)}</span>
        <span className="chess-captured" aria-label={`Pieces captured by ${color}`}>
          {game.captures[color].map((t, i) => <span key={i}>{PIECE_GLYPHS[opponent(color)][t]}</span>)}
        </span>
      </div>)}
    </div>

    <div className="chess-board" role="group" aria-label="Chess board">
      {rows.map((row) => rows.map((col) => {
        const sq = row * 8 + col;
        const p = game.board[sq];
        const target = targetSquares.get(sq);
        const inCheck = p?.type === 'king' && isInCheck(game, p.color);
        return <button key={sq} type="button"
          className={`chess-cell ${(row + col) % 2 ? 'chess-dark' : 'chess-light'}${selected === sq ? ' chess-selected' : ''}${target ? ' chess-target' : ''}${target && p ? ' chess-capture' : ''}${inCheck ? ' chess-check' : ''}`}
          aria-label={`${squareName(sq)}${p ? `: ${p.color} ${p.type}` : ': empty'}${target ? ', legal move' : ''}`}
          aria-pressed={selected === sq}
          disabled={over || !myTurn || Boolean(online?.busy)}
          onClick={() => tap(sq)}>
          {p && <span className={p.color === 'white' ? 'chess-piece-white' : 'chess-piece-black'} aria-hidden="true">{PIECE_GLYPHS[p.color][p.type]}</span>}
          {target && !p && <span className="chess-dot" aria-hidden="true" />}
        </button>;
      }))}
    </div>

    {pendingPromotion && <fieldset className="chess-promotion"><legend>Promote to…</legend>
      {PROMOTIONS.map((t) => <button key={t} type="button" onClick={() => move(pendingPromotion.from, pendingPromotion.to, t)}>
        <span aria-hidden="true">{PIECE_GLYPHS[game.turn][t]}</span> {t}</button>)}
      <button type="button" className="snake-secondary" onClick={() => setPendingPromotion(null)}>Cancel</button>
    </fieldset>}

    {!!game.history.length && <p className="game-hint chess-history">{game.history.map((n, i) => i % 2 ? n : `${i / 2 + 1}. ${n}`).join('  ')}</p>}
    <p className="game-hint">{over
      ? (online ? 'Start a rematch, or head back to all games.' : 'Start a rematch, or head back to all games.')
      : online
        ? (myTurn ? 'Your move: tap one of your pieces, then a highlighted square.' : `${partnerName} is thinking — the board refreshes on its own.`)
        : `Tap a ${game.turn} piece, then a highlighted square.${flip ? ' The board flips each turn.' : ''}`}</p>
    <div className="chess-actions">
      {!online && !over && <button type="button" className="snake-secondary" onClick={() => setFlip((f) => !f)} aria-pressed={flip}>Flip board each turn</button>}
      {!online && !!past.length && <button type="button" className="snake-secondary" onClick={() => { setLocalGame(past[past.length - 1]); setPast(past.slice(0, -1)); setSelected(null); }}>Undo move</button>}
      {!over && (online
        ? <button type="button" className="snake-secondary" disabled={online.busy} onClick={() => online.onMove('resign')}>Resign</button>
        : <button type="button" className="snake-secondary" onClick={() => setLocalGame(resignChess(game, game.turn))}>{names[game.turn].split(' ')[0]} resigns</button>)}
      {online
        ? over && <button type="button" disabled={online.busy} onClick={() => online.onRematch(game.mode)}>Play again ({CHESS_MODES.find((m) => m.id === game.mode)?.name})</button>
        : <>
            <button type="button" onClick={() => start(mode)}>New game</button>
            <button type="button" className="snake-secondary" onClick={() => setLocalGame(null)}>Change duel</button>
          </>}
      {onExit && <button type="button" className="snake-secondary" onClick={onExit}>All games</button>}
    </div>
  </div>;
}
