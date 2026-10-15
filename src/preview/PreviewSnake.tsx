import { useCallback, useState } from 'react';
import { tokens } from '../tokens/designTokens';
// The board and the leave question are real components, so they need the real stylesheet:
// jsdom cannot tell a stylesheet apart from a missing one, but a browser certainly can.
import '../components/games/games.css';
import { SnakeBoard } from '../components/games/SnakeBoard';
import { SnakeLeaveDialog } from '../components/games/SnakeLeaveDialog';
import { dealPracticeFoods, replaySnake, type SnakeChange, type SnakePoint } from '../lib/snake';

/**
 * The Snake Duel, simulated on this page alone.
 *
 * The development preview has no backend by design, and the real duel is the one feature
 * that cannot work without one — the score is derived by the database from the food it
 * dealt and the run the phone reported. So this stands in for it: the same board, the same
 * gate, the same "leaving is a forfeit" question, and a partner who plays back after a few
 * seconds with a score of their own. Everything here is in-memory; nothing is sent
 * anywhere, and the sample partner is not a real person.
 */
type Phase = 'gate' | 'playing' | 'waiting' | 'result';

interface Outcome {
  mine: { score: number; ended: string; forfeited: boolean };
  theirs: number;
}

const cardStyle = {
  backgroundColor: tokens.colors.bgSurface,
  borderRadius: tokens.radii.lg,
  boxShadow: tokens.shadows.card,
  padding: '18px',
  margin: '0 0 12px',
};

const buttonStyle = {
  font: 'inherit',
  fontSize: '0.85rem',
  fontWeight: 700,
  border: 'none',
  borderRadius: '14px',
  padding: '12px 16px',
  backgroundColor: tokens.colors.primaryPink,
  color: tokens.colors.textPrimary,
  cursor: 'pointer',
};

export const PreviewSnake = ({ partnerName }: { partnerName: string }) => {
  const [phase, setPhase] = useState<Phase>('gate');
  const [foods, setFoods] = useState<SnakePoint[]>([]);
  const [run, setRun] = useState({ nonce: 0, foods: [] as SnakePoint[] });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const startRun = useCallback(() => {
    const dealt = dealPracticeFoods();
    setFoods(dealt);
    setRun((current) => ({ nonce: current.nonce + 1, foods: dealt }));
    setOutcome(null);
    setPhase('playing');
  }, []);

  /** The partner's go: sealed while it is happening, revealed with yours at the end. */
  const partnerPlays = useCallback((mine: { score: number; ended: string; forfeited: boolean }) => {
    setPhase('waiting');
    const theirs = Math.floor(Math.random() * 24);
    window.setTimeout(() => {
      setOutcome({ mine, theirs });
      setPhase('result');
    }, 2800);
  }, []);

  const finish = (ticks: number, changes: SnakeChange[]) => {
    // The database is what really scores a ranked run; in this preview the phone's own
    // replay of its run stands in for it, which is the same arithmetic.
    const ended = replaySnake(foods, ticks, changes);
    partnerPlays({ score: ended.score, ended: ended.ended ?? 'wall', forfeited: false });
  };

  const forfeit = () => {
    setConfirmLeave(false);
    const ended = replaySnake(foods, 0, []);
    partnerPlays({ score: ended.score, ended: 'forfeit', forfeited: true });
  };

  if (phase === 'playing') {
    return (
      <>
        <SnakeBoard
          key={run.nonce}
          foods={run.foods}
          live
          onBeat={() => Promise.resolve()}
          onFinish={(ticks, changes) => { finish(ticks, changes); return Promise.resolve(); }}
          onExit={() => setConfirmLeave(true)}
        />
        {confirmLeave && (
          <SnakeLeaveDialog
            partnerName={partnerName}
            onKeepPlaying={() => setConfirmLeave(false)}
            onForfeit={forfeit}
          />
        )}
      </>
    );
  }

  if (phase === 'waiting') {
    return (
      <section style={cardStyle} data-preview-snake="waiting">
        <h2 style={{ fontSize: '1.15rem', margin: '0 0 8px' }}>Your run is in. {partnerName} is playing…</h2>
        <p style={{ fontSize: '0.85rem', lineHeight: 1.55, color: tokens.colors.textSecondary, margin: 0 }}>
          Their score stays sealed until both runs are in. This is the whole point of the duel:
          nobody has to be online at the same time.
        </p>
      </section>
    );
  }

  if (phase === 'result' && outcome) {
    const won = outcome.mine.forfeited ? false : outcome.mine.score >= outcome.theirs;
    const drew = !outcome.mine.forfeited && outcome.mine.score === outcome.theirs;
    return (
      <section style={cardStyle} data-preview-snake="result">
        <h2 style={{ fontSize: '1.15rem', margin: '0 0 6px' }}>
          {outcome.mine.forfeited ? `You left the run — ${partnerName} wins` : drew ? 'A draw — honours even' : won ? 'You won the duel 🎉' : `${partnerName} won the duel 🎉`}
        </h2>
        <p style={{ fontSize: '0.85rem', lineHeight: 1.55, color: tokens.colors.textSecondary, margin: '0 0 14px' }}>
          You scored {outcome.mine.score} — {outcome.mine.forfeited ? 'you left the run, so it was a forfeit' : `the snake ${outcome.mine.ended === 'self' ? 'bit its own tail' : outcome.mine.ended === 'cap' ? 'ran out of time' : 'hit the wall'}`}.
          {' '}{partnerName} scored {outcome.theirs}.
        </p>
        <button type="button" style={buttonStyle} onClick={startRun}>Duel again</button>
      </section>
    );
  }

  return (
    <section style={cardStyle} data-preview-snake="gate">
      <h2 style={{ fontSize: '1.15rem', margin: '0 0 8px' }}>Snake Duel</h2>
      <p style={{ fontSize: '0.85rem', lineHeight: 1.55, color: tokens.colors.textSecondary, margin: '0 0 10px' }}>
        One run each, highest score wins. Play whenever suits you — you never have to be online
        at the same time, which is exactly what a couple in two time zones needs.
      </p>
      <ul style={{ fontSize: '0.82rem', lineHeight: 1.5, color: tokens.colors.textSecondary, paddingLeft: '18px', margin: '0 0 14px' }}>
        <li>No pause, ever. The clock starts with the run.</li>
        <li>Leave the screen and you forfeit the duel to {partnerName} there and then.</li>
        <li>Go quiet for 30 seconds — locked phone, no signal — and the run is lost.</li>
        <li>Scores stay sealed until both runs are in.</li>
      </ul>
      <button type="button" style={buttonStyle} onClick={startRun} data-action="preview-start-duel">
        Start my run
      </button>
      <p style={{ fontSize: '0.72rem', lineHeight: 1.5, color: tokens.colors.textMuted, margin: '12px 0 0' }}>
        Preview only: this duel is played out on this page. The real one has its food dealt and
        its score replayed by the database, so a score can never be claimed — see the README.
      </p>
    </section>
  );
};

export default PreviewSnake;
