import { connectFourWinner } from '../../lib/connectFour';
import type { GameMatch } from '../../lib/gamesService';
import './connectFour.css';

export function ConnectFour({ match, userId, partnerName, busy, onMove, onExit }: {
  match: GameMatch; userId: string; partnerName: string; busy: boolean;
  onMove: (column: number) => void; onExit: () => void;
}) {
  const board = (match.board ?? Array(42).fill('')) as Array<'X' | 'O' | ''>;
  const winner = connectFourWinner(board);
  const myMark = match.player_x === userId ? 'X' : 'O';
  const myTurn = match.turn_id === userId;
  const drawn = !winner && board.length === 42 && board.every(Boolean);
  const status = match.finished ? (match.winner_id === userId ? 'You connected four! 🎉' : match.winner_id ? `${partnerName} connected four!` : 'It’s a draw!')
    : myTurn ? 'Your turn — choose a column.' : `${partnerName} is thinking. Come back whenever you like.`;
  return <section className="game-card connect-four" aria-label="Connect Four">
    <div className="connect-four-top"><div><span className="games-eyebrow">Async · server-refereed</span><h2>Connect Four</h2></div><button type="button" className="game-back" onClick={onExit}>← Games</button></div>
    <p className="game-status" role="status">{status}</p>
    <p className="connect-four-score"><span className="cf-red">●</span> {myMark === 'X' ? 'You' : partnerName} · <span className="cf-yellow">●</span> {myMark === 'O' ? 'You' : partnerName}</p>
    <div className="connect-four-board" role="grid" aria-label="Connect Four board">
      {Array.from({ length: 7 }, (_, col) => <button key={col} type="button" className="connect-four-column" aria-label={`Drop in column ${col + 1}`} disabled={!myTurn || busy || match.finished || !!board[col]} onClick={() => onMove(col)}>
        {Array.from({ length: 6 }, (_, row) => { const cell = board[row * 7 + col]; return <span key={row} className={`connect-four-cell ${cell === 'X' ? 'is-red' : cell === 'O' ? 'is-yellow' : ''}`} aria-hidden="true" />; })}
      </button>)}
    </div>
    <p className="game-hint">Your moves are saved automatically. Connect four horizontally, vertically, or diagonally to win{drawn ? ' · board full!' : ''}.</p>
  </section>;
}
