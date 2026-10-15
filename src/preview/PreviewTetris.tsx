import { useCallback, useState } from 'react';
import { tokens } from '../tokens/designTokens';
// The board and the leave question are real components, so they need the real stylesheet:
// jsdom cannot tell a stylesheet apart from a missing one, but a browser certainly can.
import '../components/games/games.css';
import { TetrisBoard } from '../components/games/TetrisBoard';
import { DuelLeaveDialog } from '../components/games/DuelLeaveDialog';
import {
  dealPracticePieces, replayTetris, tetrisDecide, tetrisModeLabel,
  type TetrisInput, type TetrisMode,
} from '../lib/tetris';

/**
 * The Tetris duel, simulated on this page alone.
 *
 * The development preview has no backend by design, and the real duel is the one feature
 * that cannot work without one — the score is derived by the database from the pieces it
 * dealt and the taps the phone reported. So this stands in for it: the same board, the same
 * gate, the same two ways of settling it, the same "leaving is a forfeit" question, and a
 * partner who plays back after a few seconds with a run of their own. Everything here is
 * in-memory; nothing is sent anywhere, and the sample partner is not a real person.
 */
type Phase = 'gate' | 'playing' | 'waiting' | 'result';

interface Outcome {
  mine: { score: number; lines: number; ticks: number; ended: string; forfeited: boolean };
  theirs: { score: number; lines: number; ticks: number; ended: string };
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

const secondaryStyle = { ...buttonStyle, backgroundColor: tokens.colors.accentLavenderSoft, color: tokens.colors.accentLavenderDeep };

export const PreviewTetris = ({ partnerName }: { partnerName: string }) => {
  const [phase, setPhase] = useState<Phase>('gate');
  const [mode, setMode] = useState<TetrisMode>('sprint');
  const [pieces, setPieces] = useState<number[]>([]);
  const [run, setRun] = useState({ nonce: 0, pieces: [] as number[] });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const startRun = useCallback(() => {
    const dealt = dealPracticePieces();
    setPieces(dealt);
    setRun((current) => ({ nonce: current.nonce + 1, pieces: dealt }));
    setOutcome(null);
    setPhase('playing');
  }, []);

  /** The partner's go: sealed while it is happening, revealed with yours at the end. */
  const partnerPlays = useCallback((mine: Outcome['mine']) => {
    setPhase('waiting');
    // A partner who plays the same pieces, and is either a little better or a little worse.
    const theirs = { score: Math.max(0, Math.round(mine.score * (0.6 + Math.random() * 0.9))), lines: Math.max(0, Math.round(mine.lines * (0.6 + Math.random() * 0.9))), ticks: mine.ticks, ended: 'cap' };
    if (mode === 'survival') theirs.ticks = Math.round(Math.random() * 6000);
    window.setTimeout(() => {
      setOutcome({ mine, theirs });
      setPhase('result');
    }, 2800);
  }, [mode]);

  const finish = (ticks: number, inputs: TetrisInput[]) => {
    // The database is what really scores a ranked run; in this preview the phone's own
    // replay of its run stands in for it, which is the same arithmetic.
    const ended = replayTetris(pieces, ticks, inputs);
    partnerPlays({ score: ended.score, lines: ended.lines, ticks: ended.ticks, ended: ended.ended ?? 'cap', forfeited: false });
  };

  const forfeit = () => {
    setConfirmLeave(false);
    const ended = replayTetris(pieces, 0, []);
    partnerPlays({ score: ended.score, lines: ended.lines, ticks: 0, ended: 'forfeit', forfeited: true });
  };

  if (phase === 'playing') {
    return (
      <>
        <TetrisBoard
          key={run.nonce}
          pieces={run.pieces}
          live
          onBeat={() => Promise.resolve()}
          onFinish={(ticks, inputs) => { finish(ticks, inputs); return Promise.resolve(); }}
          onExit={() => setConfirmLeave(true)}
        />
        {confirmLeave && (
          <DuelLeaveDialog
            runLabel="your run"
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
      <section style={cardStyle} data-preview-tetris="waiting">
        <h2 style={{ fontSize: '1.15rem', margin: '0 0 8px' }}>Your run is in. {partnerName} is playing…</h2>
        <p style={{ fontSize: '0.85rem', lineHeight: 1.55, color: tokens.colors.textSecondary, margin: 0 }}>
          Their score stays sealed until both runs are in. This is the whole point of the duel:
          nobody has to be online at the same time.
        </p>
      </section>
    );
  }

  if (phase === 'result' && outcome) {
    const decided = tetrisDecide(mode, { status: outcome.mine.forfeited ? 'forfeit' : 'done', score: outcome.mine.score, ticks: outcome.mine.ticks }, { status: 'done', score: outcome.theirs.score, ticks: outcome.theirs.ticks });
    const headline = decided === 'mine' ? 'You won the duel 🎉' : decided === 'draw' ? 'A draw — honours even' : `${partnerName} won the duel 🎉`;
    const reason = outcome.mine.ended === 'top' ? 'your well filled up' : outcome.mine.ended === 'cap' ? 'you ran the clock out' : 'you left the run';
    return (
      <section style={cardStyle} data-preview-tetris="result">
        <h2 style={{ fontSize: '1.15rem', margin: '0 0 6px' }}>{headline}</h2>
        <p style={{ fontSize: '0.85rem', lineHeight: 1.55, color: tokens.colors.textSecondary, margin: '0 0 14px' }}>
          {tetrisModeLabel(mode)}. You scored {outcome.mine.score} across {outcome.mine.lines} lines — {reason}.
          {' '}{partnerName} scored {outcome.theirs.score} across {outcome.theirs.lines} lines.
          {mode === 'survival' && ` You lasted ${Math.round((outcome.mine.ticks * 50) / 1000)}s, they lasted ${Math.round((outcome.theirs.ticks * 50) / 1000)}s.`}
        </p>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button type="button" style={buttonStyle} onClick={startRun}>Duel again</button>
          <button type="button" style={secondaryStyle} onClick={() => setPhase('gate')}>Back to the gate</button>
        </div>
      </section>
    );
  }

  return (
    <section style={cardStyle} data-preview-tetris="gate">
      <h2 style={{ fontSize: '1.15rem', margin: '0 0 8px' }}>Tetris Duel</h2>
      <p style={{ fontSize: '0.85rem', lineHeight: 1.55, color: tokens.colors.textSecondary, margin: '0 0 10px' }}>
        Five minutes each, and both of you play the same pieces. Play whenever suits you — you
        never have to be online at the same time, which is exactly what a couple in two time
        zones needs.
      </p>
      <fieldset style={{ border: 0, padding: 0, margin: '0 0 14px', display: 'flex', gap: '8px' }}>
        <legend style={{ fontSize: '0.75rem', fontWeight: 700, margin: '0 0 8px' }}>How the duel is decided</legend>
        {(['sprint', 'survival'] as TetrisMode[]).map((option) => (
          <button
            key={option}
            type="button"
            style={option === mode ? buttonStyle : secondaryStyle}
            aria-pressed={option === mode}
            onClick={() => setMode(option)}
          >
            {tetrisModeLabel(option)}
          </button>
        ))}
      </fieldset>
      <ul style={{ fontSize: '0.82rem', lineHeight: 1.5, color: tokens.colors.textSecondary, paddingLeft: '18px', margin: '0 0 14px' }}>
        <li>No pause, ever. The clock starts with the run.</li>
        <li>Tap the board to turn the piece, slide it sideways, or swipe down to slam it.</li>
        <li>Leave the screen and you forfeit the duel to {partnerName} there and then.</li>
        <li>Go quiet for 30 seconds — locked phone, no signal — and the run is lost.</li>
        <li>Scores stay sealed until both runs are in.</li>
      </ul>
      <button type="button" style={buttonStyle} onClick={startRun} data-action="preview-start-duel">
        Start my 5 minutes
      </button>
      <p style={{ fontSize: '0.72rem', lineHeight: 1.5, color: tokens.colors.textMuted, margin: '12px 0 0' }}>
        Preview only: this duel is played out on this page. The real one has its pieces dealt
        and its score replayed by the database, so a score can never be claimed — see the README.
      </p>
    </section>
  );
};

export default PreviewTetris;
