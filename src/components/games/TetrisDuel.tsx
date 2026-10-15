import React, { useState } from 'react';
import type { GamesState } from '../../hooks/useGames';
import { tetrisInputs, tetrisPieces, type GameMatch, type TetrisRun, type TetrisSide } from '../../lib/gamesService';
import { TETRIS_RUN_SECONDS, tetrisModeLabel } from '../../lib/tetris';
import { TetrisBoard } from './TetrisBoard';
import { DuelLeaveDialog } from './DuelLeaveDialog';

/** How a run ended, told to the person reading it rather than to the board. */
function endReason(side: TetrisSide | TetrisRun | null, mine: boolean, partnerName: string): string {
  if (!side || side.status === 'waiting') return 'never played';
  if (side.status === 'running') return 'playing now';
  if (side.status === 'forfeit') return mine ? 'you left the run' : `${partnerName} left the run`;
  switch (side.ended) {
    case 'top': return 'the well filled up';
    case 'cap': return 'the five minutes ran out';
    default: return 'run over';
  }
}

/** What the two modes are actually asking of the couple, for the gate and the result. */
function modeExplanation(mode: string | null, partnerName: string): string {
  return mode === 'survival'
    ? `Whoever keeps stacking longer wins — the five minutes are a ceiling, not a target. Lose your well first and ${partnerName} takes it, whatever either of you scored.`
    : `Highest score when the five minutes are up. Fill your well early and you bank what you had — usually not enough.`;
}

interface TetrisDuelProps {
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
 * The Tetris duel, whole: the run that is being played or is waiting to be played, and the
 * reveal once both partners have had their go. A blind duel — nobody sees what they are up
 * against until both runs are in, and a run is one attempt with the clock running.
 */
export const TetrisDuel: React.FC<TetrisDuelProps> = ({
  match, userId, partnerName, games, onWarmUp, onWarmUpSkip,
}) => {
  const [confirmLeave, setConfirmLeave] = useState(false);
  const mine = match.tetris?.mine ?? null;
  const them: TetrisSide = match.tetris?.partner ?? { status: 'waiting', ended: null };
  const mode = match.tetris?.mode ?? 'sprint';
  const running = mine?.status === 'running' && !match.finished;
  const won = match.winner_id === userId;
  const drew = match.finished && match.winner_id === null;
  const outcome = won ? 'You won the duel 🎉' : drew ? 'A draw — honours even' : `${partnerName} won the duel 🎉`;
  const minutes = TETRIS_RUN_SECONDS / 60;

  // --- The result ------------------------------------------------------------------
  if (match.finished) {
    return (
      <>
        <div className="game-card" data-tetris-result="finished">
          <h2>{outcome}</h2>
          <p className="game-status" role="status">{tetrisModeLabel(mode)}</p>
          <div className="tetris-result">
            <div>
              <span>You</span>
              <strong data-tetris-score-you>{mine?.score ?? '—'}</strong>
              <small>{mine?.lines ?? 0} lines · {endReason(mine, true, partnerName)}</small>
            </div>
            <div>
              <span>{partnerName}</span>
              <strong data-tetris-score-partner>{them.score ?? '—'}</strong>
              <small>{them.lines ?? 0} lines · {endReason(them, false, partnerName)}</small>
            </div>
          </div>
          {mode === 'survival' && (
            <p className="game-hint">
              Stacking time: you {Math.round(((mine?.ticks ?? 0) * 50) / 1000)}s —{' '}
              {Math.round(((them.ticks ?? 0) * 50) / 1000)}s {partnerName}.
            </p>
          )}
          <p className="game-hint">
            Both runs are in, so the scores are open. Start a new duel whenever you like —
            you still never need to be online at the same time.
          </p>
          <button
            type="button"
            disabled={games.busy}
            onClick={() => { onWarmUpSkip(); void games.start('tetris', false, 3, mode); }}
          >
            Start a new duel
          </button>
        </div>
      </>
    );
  }

  // --- A live run ------------------------------------------------------------------
  if (running && mine) {
    return (
      <>
        <TetrisBoard
          key={`${match.id}:${mine.started_at}`}
          pieces={tetrisPieces(mine.pieces)}
          resume={{ ticks: mine.ticks, inputs: tetrisInputs(mine.inputs) }}
          live={!match.finished}
          onBeat={(ticks, inputs) => games.beatTetris(match.id, ticks, inputs)}
          onFinish={(ticks, inputs) => games.finishTetris(match.id, ticks, inputs)}
          onExit={() => setConfirmLeave(true)}
        />
        {confirmLeave && (
          <DuelLeaveDialog
            runLabel="your run"
            partnerName={partnerName}
            busy={games.busy}
            onKeepPlaying={() => setConfirmLeave(false)}
            onForfeit={() => { setConfirmLeave(false); void games.forfeitTetris(match.id); }}
          />
        )}
      </>
    );
  }

  // --- My run is in, and the duel is waiting on theirs ------------------------------
  if (mine && mine.status !== 'running') {
    return (
      <div className="game-card" data-tetris-waiting="me">
        <h2>Your run is in: {mine.score} points</h2>
        <p className="game-status" role="status">
          {them.status === 'running'
            ? `${partnerName} is playing right now…`
            : `${partnerName} hasn't played yet — their go comes whenever it suits them.`}
        </p>
        <p className="game-hint">
          Your run: {mine.lines} lines, {endReason(mine, true, partnerName)}. Scores stay sealed
          until both runs are in.
        </p>
        <button type="button" disabled={games.busy} onClick={onWarmUp} data-action="warm-up-while-waiting">
          Warm up while you wait
        </button>
      </div>
    );
  }

  // --- Not played yet: the gate, and what it means ----------------------------------
  return (
    <div className="game-card" data-tetris-gate={them.status}>
      <h2>{tetrisModeLabel(mode)}</h2>
      <p>{modeExplanation(mode, partnerName)}</p>
      <ul className="tetris-rules">
        <li>Play whenever suits you — you never have to be online at the same time.</li>
        <li>
          Tap start and the run is live: {minutes} minutes, no pause, and the clock does not
          stop.
        </li>
        <li>You both play the same pieces, dealt once for the duel, so it is like for like.</li>
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
      <div className="tetris-gate-actions">
        <button
          type="button"
          disabled={games.busy || !games.data}
          onClick={() => { void games.startTetris(match.id); }}
          data-action="start-my-run"
        >
          Start my {minutes} minutes
        </button>
        <button type="button" className="tetris-secondary" onClick={onWarmUp} data-action="warm-up">
          Warm up first
        </button>
      </div>
    </div>
  );
};

export default TetrisDuel;
