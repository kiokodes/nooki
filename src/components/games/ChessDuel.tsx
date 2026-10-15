import { useMemo, useState } from 'react';
import {
  CHESS_MODES, PIECE_GLYPHS, applyMove, captureCount, chessStatusLabel, createChessState,
  isInCheck, legalMovesFrom, opponent, resignChess, squareName,
  type ChessColor, type ChessMode, type ChessPieceType, type ChessState,
} from '../../lib/chess';
import './games.css';

const PROMOTIONS: ChessPieceType[] = ['queen', 'knight', 'rook', 'bishop'];

/**
 * Chess for the Games tab, adapted (clean-room) from PyChess's click-to-select,
 * highlight-the-moves board onto Nooki's turn-based couple games.
 *
 * For now this is pass-and-play on one phone, like Sudoku is solo on one phone:
 * the pure engine in `src/lib/chess.ts` is the deliverable the database version
 * will mirror (the way `snake.ts` is mirrored by `snake_replay` in SQL). Wiring
 * it to `game_matches` needs a server-side move validator — a `chess` branch in
 * `start_game`/`play_game` plus FEN-ish board state in a new migration — so a
 * phone can never claim a capture (or a queen) it did not really make.
 */
export function ChessDuel({ partnerName, onExit }: { partnerName: string; onExit?: () => void }) {
  const [mode, setMode] = useState<ChessMode>('classic');
  const [game, setGame] = useState<ChessState | null>(null);
  const [past, setPast] = useState<ChessState[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<{ from: number; to: number } | null>(null);
  const [flip, setFlip] = useState(true);

  const names: Record<ChessColor, string> = { white: 'White (you first)', black: `Black (${partnerName})` };
  const targets = useMemo(
    () => (game && selected !== null ? legalMovesFrom(game, selected) : []),
    [game, selected],
  );
  const targetSquares = useMemo(() => new Map(targets.map((m) => [m.to, m])), [targets]);

  const start = (nextMode: ChessMode) => {
    setMode(nextMode);
    setGame(createChessState(nextMode));
    setPast([]); setSelected(null); setPendingPromotion(null);
  };

  const move = (from: number, to: number, promotion?: ChessPieceType) => {
    if (!game) return;
    try {
      setPast((p) => [...p, game]);
      setGame(applyMove(game, from, to, promotion));
    } catch { /* illegal taps are simply ignored; legal targets are highlighted */ }
    setSelected(null); setPendingPromotion(null);
  };

  const tap = (sq: number) => {
    if (!game || game.winner || game.drawn || pendingPromotion) return;
    const target = selected !== null ? targetSquares.get(sq) : undefined;
    if (target) {
      if (target.promotion) setPendingPromotion({ from: target.from, to: target.to });
      else move(target.from, target.to);
      return;
    }
    const p = game.board[sq];
    setSelected(p?.color === game.turn ? sq : null);
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
      <p className="game-hint">Pass-and-play on this phone for now: White starts, then hand it over. (Online turns arrive with the chess database migration.)</p>
      <button type="button" onClick={() => start(mode)} data-action="chess-start">Start {CHESS_MODES.find((m) => m.id === mode)?.name} →</button>
      {onExit && <button type="button" className="snake-secondary" onClick={onExit}>Back</button>}
    </div>;
  }

  const over = Boolean(game.winner || game.drawn);
  const viewColor: ChessColor = flip && !over ? game.turn : 'white';
  const rows = viewColor === 'white' ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const lastNotation = game.history[game.history.length - 1];
  void lastNotation;
  const goalProgress = (color: ChessColor) => game.mode === 'capture-race'
    ? `${captureCount(game, color)}/7 captured`
    : game.mode === 'queen-hunt'
      ? (game.board.some((p) => p?.id === `${opponent(color)}-queen`) ? `${captureCount(game, color)} captured · their queen still stands ♛` : 'queen captured!')
      : `${captureCount(game, color)} captured`;

  return <div className="game-card" data-chess="playing" data-chess-mode={game.mode}>
    <p className="game-status" role="status">{chessStatusLabel(game, names)}</p>
    <div className="chess-scores" aria-label="Captures">
      {(['white', 'black'] as ChessColor[]).map((color) => <div key={color} className={game.turn === color && !over ? 'chess-turn' : ''}>
        <strong>{color === 'white' ? '♔ White' : `♚ Black · ${partnerName}`}</strong>
        <span>{goalProgress(color)}</span>
        <span className="chess-captured" aria-label={`Pieces captured by ${color}`}>
          {game.captures[color].map((t, i) => <span key={i}>{PIECE_GLYPHS[opponent(color)][t]}</span>)}
        </span>
      </div>)}
    </div>

    <div className="chess-board" role="group" aria-label="Chess board">
      {rows.map((row) => rows.map((col) => {
        const sq = viewColor === 'white' ? row * 8 + col : row * 8 + col;
        const p = game.board[sq];
        const target = targetSquares.get(sq);
        const inCheck = p?.type === 'king' && isInCheck(game, p.color);
        return <button key={sq} type="button"
          className={`chess-cell ${(row + col) % 2 ? 'chess-dark' : 'chess-light'}${selected === sq ? ' chess-selected' : ''}${target ? ' chess-target' : ''}${target && p ? ' chess-capture' : ''}${inCheck ? ' chess-check' : ''}`}
          aria-label={`${squareName(sq)}${p ? `: ${p.color} ${p.type}` : ': empty'}${target ? ', legal move' : ''}`}
          aria-pressed={selected === sq}
          disabled={over}
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
    <p className="game-hint">{over ? 'Start a rematch, or head back to all games.' : `Tap a ${game.turn} piece, then a highlighted square.${flip ? ' The board flips each turn.' : ''}`}</p>
    <div className="chess-actions">
      {!over && <button type="button" className="snake-secondary" onClick={() => setFlip((f) => !f)} aria-pressed={flip}>Flip board each turn</button>}
      {!!past.length && <button type="button" className="snake-secondary" onClick={() => { setGame(past[past.length - 1]); setPast(past.slice(0, -1)); setSelected(null); }}>Undo move</button>}
      {!over && <button type="button" className="snake-secondary" onClick={() => setGame(resignChess(game, game.turn))}>{names[game.turn].split(' ')[0]} resigns</button>}
      <button type="button" onClick={() => start(mode)}>New game</button>
      <button type="button" className="snake-secondary" onClick={() => setGame(null)}>Change duel</button>
      {onExit && <button type="button" className="snake-secondary" onClick={onExit}>All games</button>}
    </div>
  </div>;
}
