import React, { useState } from 'react';
import type { GamesState } from '../../hooks/useGames';
import { snakeChanges, snakePoints, type GameMatch, type SnakeRun, type SnakeSide } from '../../lib/gamesService';
import { SnakeBoard } from './SnakeBoard';
import { SnakeLeaveDialog } from './SnakeLeaveDialog';

/** How a run ended, told to the person reading it rather than to the board. */
function endReason(side: SnakeSide | SnakeRun | null, mine: boolean, partnerName: string): string {
  if (!side || side.status === 'waiting') return 'never played';
  if (side.status === 'running') return 'playing now';
  if (side.status === 'forfeit') return mine ? 'you left the run' : `${partnerName} left the run`;
  switch (side.ended) {
    case 'wall': return 'hit the wall';
    case 'self': return 'bit its own tail';
    case 'cap': return 'four minutes up';
    default: return 'run over';
  }
}

interface SnakeDuelProps {
  match: GameMatch;
  userId: string;
  partnerName: string;
  games: GamesState;
  /** Deal a practice run — the Games tab renders it in place of this panel. */
  onWarmUp: () => void;
  /** Drop any warm-up that is still lying around, so the fresh duel opens on its own gate. */
  onWarmUpSkip: () => void;
}

/**
 * The Snake duel, whole: the run that is being played or is waiting to be played, and the
 * reveal once both partners have had their go. A blind duel — nobody sees what they are up
 * against until both runs are in, and a run is one attempt with the clock running.
 */
export const SnakeDuel: React.FC<SnakeDuelProps> = ({
  match, userId, partnerName, games, onWarmUp, onWarmUpSkip,
}) => {
  const [confirmLeave, setConfirmLeave] = useState(false);
  const mine = match.snake?.mine ?? null;
  const them: SnakeSide = match.snake?.partner ?? { status: 'waiting', ended: null };
  const running = mine?.status === 'running' && !match.finished;
  const won = match.winner_id === userId;
  const drew = match.finished && match.winner_id === null;
  const outcome = won ? 'You won the duel 🎉' : drew ? 'A draw — honours even' : `${partnerName} won the duel 🎉`;

  // --- The result ------------------------------------------------------------------
  if (match.finished) {
    return (
      <>
        <div className="game-card" data-snake-result="finished">
          <h2>{outcome}</h2>
          <div className="snake-result">
            <div>
              <span>You</span>
              <strong data-snake-score-you>{mine?.score ?? '—'}</strong>
              <small>{endReason(mine, true, partnerName)}</small>
            </div>
            <div>
              <span>{partnerName}</span>
              <strong data-snake-score-partner>{them.score ?? '—'}</strong>
              <small>{endReason(them, false, partnerName)}</small>
            </div>
          </div>
          <p className="game-hint">
            Both runs are in, so the scores are open. Start a new duel whenever you like —
            you still never need to be online at the same time.
          </p>
          <button
            type="button"
            disabled={games.busy}
            onClick={() => { onWarmUpSkip(); void games.start('snake', 3); }}
          >
            Start a new duel
          </button>
        </div>
      </>
    );
  }

  // --- A live run ------------------------------------------------------------------
  if (running && mine) {
    const foods = snakePoints(mine.foods);
    return (
      <>
        <SnakeBoard
          key={`${match.id}:${mine.started_at}`}
          foods={foods}
          resume={{ ticks: mine.ticks, dirs: snakeChanges(mine.dirs) }}
          live={!match.finished}
          onBeat={(ticks, changes) => games.beat(match.id, ticks, changes)}
          onFinish={(ticks, changes) => games.finish(match.id, ticks, changes)}
          onExit={() => setConfirmLeave(true)}
        />
        {confirmLeave && (
          <SnakeLeaveDialog
            partnerName={partnerName}
            busy={games.busy}
            onKeepPlaying={() => setConfirmLeave(false)}
            onForfeit={() => { setConfirmLeave(false); void games.forfeitSnake(match.id); }}
          />
        )}
      </>
    );
  }

  // --- My run is in, and the duel is waiting on theirs ------------------------------
  if (mine && mine.status !== 'running') {
    return (
      <div className="game-card" data-snake-waiting="me">
        <h2>Your run is in: {mine.score} food</h2>
        <p className="game-status" role="status">
          {them.status === 'running'
            ? `${partnerName} is playing right now…`
            : `${partnerName} hasn't played yet — their go comes whenever it suits them.`}
        </p>
        <p className="game-hint">
          Your run: {endReason(mine, true, partnerName)}. Scores stay sealed until both runs are in.
        </p>
        <button type="button" disabled={games.busy} onClick={onWarmUp} data-action="warm-up-while-waiting">
          Warm up while you wait
        </button>
      </div>
    );
  }

  // --- Not played yet: the gate, and what it means ----------------------------------
  return (
    <div className="game-card" data-snake-gate={them.status}>
      <h2>One run each. Highest score wins.</h2>
      <ul className="snake-rules">
        <li>Play whenever suits you — you never have to be online at the same time.</li>
        <li>Tap start and the run is live: there is no pause, and the clock does not stop.</li>
        <li>Leave this screen and you forfeit the duel to {partnerName} there and then.</li>
        <li>Go quiet for 30 seconds — locked phone, no signal — and the run is lost.</li>
        <li>
          One attempt each.{' '}
          {them.status === 'waiting'
            ? `${partnerName} hasn't played yet.`
            : them.status === 'running'
              ? `${partnerName} is playing right now — their score stays sealed until you have played too.`
              : `${partnerName} has played. Their score stays sealed until you have played too.`}
        </li>
      </ul>
      <div className="snake-gate-actions">
        <button
          type="button"
          disabled={games.busy || !games.data}
          onClick={() => { void games.startSnake(match.id); }}
          data-action="start-my-run"
        >
          {games.busy ? 'Starting run…' : 'Start my run'}
        </button>
        <button type="button" className="snake-secondary" onClick={onWarmUp} data-action="warm-up">
          Warm up first
        </button>
      </div>
    </div>
  );
};

export default SnakeDuel;
