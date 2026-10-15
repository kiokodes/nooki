import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tokens } from '../../tokens/designTokens';
import {
  generatePuzzle,
  isComplete,
  conflictingCells,
  isValidPlacement,
  formatTime,
  SUDOKU_MAX_MISTAKES,
  type SudokuBoard,
  type SudokuDifficulty,
  type SudokuPuzzle,
} from '../../lib/sudoku';
import './games.css';

type SudokuMode = 'solo' | 'competition' | 'collaboration';

interface Props {
  partnerName?: string;
  onExit?: () => void;
}

const cardStyle: React.CSSProperties = {
  backgroundColor: tokens.colors.bgSurface,
  borderRadius: tokens.radii.lg,
  boxShadow: tokens.shadows.card,
  padding: '18px',
  margin: '0 0 12px',
};

export function Sudoku({ partnerName = 'your partner', onExit }: Props) {
  const [mode, setMode] = useState<SudokuMode>('solo');
  const [difficulty, setDifficulty] = useState<SudokuDifficulty>('medium');
  const [puzzle, setPuzzle] = useState<SudokuPuzzle | null>(null);
  const [board, setBoard] = useState<SudokuBoard>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [mistakes, setMistakes] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [finished, setFinished] = useState(false);
  const [won, setWon] = useState(false);
  const timerRef = useRef<number | null>(null);

  const givens = useMemo(() => {
    if (!puzzle) return new Set<number>();
    const s = new Set<number>();
    puzzle.puzzle.forEach((v, i) => { if (v !== 0) s.add(i); });
    return s;
  }, [puzzle]);

  useEffect(() => {
    if (startedAt === null || finished) return;
    timerRef.current = window.setInterval(() => {
      setElapsed(Date.now() - startedAt);
    }, 250);
    return () => { if (timerRef.current) window.clearInterval(timerRef.current); };
  }, [startedAt, finished]);

  const start = useCallback(() => {
    const p = generatePuzzle(difficulty);
    setPuzzle(p);
    setBoard(p.puzzle.slice());
    setSelected(null);
    setMistakes(0);
    setStartedAt(Date.now());
    setElapsed(0);
    setFinished(false);
    setWon(false);
  }, [difficulty]);

  const conflicts = useMemo(() => (board.length ? conflictingCells(board) : new Set<number>()), [board]);

  const place = useCallback((value: number) => {
    if (!puzzle || finished || selected === null) return;
    if (givens.has(selected)) return;
    const idx = selected;
    if (value === 0) {
      const nb = board.slice();
      nb[idx] = 0;
      setBoard(nb);
      return;
    }
    if (!isValidPlacement(board, idx, value)) {
      // wrong try
      const nb = board.slice();
      nb[idx] = value;
      setBoard(nb);
      const next = mistakes + 1;
      setMistakes(next);
      if (mode !== 'solo' && next >= SUDOKU_MAX_MISTAKES) {
        setFinished(true);
        setWon(false);
      }
      return;
    }
    const nb = board.slice();
    nb[idx] = value;
    setBoard(nb);
    if (isComplete(nb)) {
      setFinished(true);
      setWon(true);
    }
  }, [puzzle, finished, selected, givens, board, mistakes, mode]);

  // keyboard
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (selected === null) return;
      if (e.key >= '1' && e.key <= '9') place(Number(e.key));
      else if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') place(0);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selected, place]);

  if (!puzzle) {
    return (
      <section style={cardStyle} data-sudoku="setup">
        <h2 style={{ fontSize: '1.15rem', margin: '0 0 8px' }}>Sudoku</h2>
        <p style={{ fontSize: '0.85rem', lineHeight: 1.55, color: tokens.colors.textSecondary, margin: '0 0 12px' }}>
          Fill the 9×9 grid so every row, column and 3×3 box holds 1–9. {partnerName ? '' : ''}
        </p>
        <fieldset style={{ border: 'none', padding: 0, margin: '0 0 12px' }}>
          <legend style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: 6 }}>Difficulty</legend>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['easy', 'medium', 'hard'] as SudokuDifficulty[]).map((d) => (
              <button key={d} type="button" aria-pressed={difficulty === d} onClick={() => setDifficulty(d)}
                style={{ ...buttonStyle(difficulty === d) }}>{d}</button>
            ))}
          </div>
        </fieldset>
        <fieldset style={{ border: 'none', padding: 0, margin: '0 0 12px' }}>
          <legend style={{ fontSize: '0.8rem', fontWeight: 700, marginBottom: 6 }}>Mode</legend>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(['solo', 'competition', 'collaboration'] as SudokuMode[]).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
                style={{ ...buttonStyle(mode === m) }}>{m}</button>
            ))}
          </div>
          <p style={{ fontSize: '0.75rem', color: tokens.colors.textMuted, margin: '6px 0 0' }}>
            {mode === 'competition' && 'Race your partner: fastest to finish wins. 3 mistakes each.'}
            {mode === 'collaboration' && 'Solve together: you share only 3 wrong tries.'}
            {mode === 'solo' && 'Practice on your own.'}
          </p>
        </fieldset>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" style={primaryButton} onClick={start} data-action="sudoku-start">Start puzzle</button>
          {onExit && <button type="button" style={secondaryButton} onClick={onExit}>Back</button>}
        </div>
      </section>
    );
  }

  return (
    <section style={cardStyle} data-sudoku="playing">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ fontSize: '1.15rem', margin: 0 }}>Sudoku · {difficulty}</h2>
        <div style={{ fontSize: '0.85rem', fontWeight: 700 }}>
          ⏱ {formatTime(elapsed)} · mistakes {mistakes}/{SUDOKU_MAX_MISTAKES}
        </div>
      </div>
      {finished && (
        <div style={{ ...cardStyle, backgroundColor: tokens.colors.accentLavenderSoft }} data-sudoku-result={won ? 'won' : 'lost'}>
          <strong>{won ? 'You solved it! 🎉' : 'Too many mistakes — try again.'}</strong>
          <div style={{ marginTop: 8 }}>
            <button type="button" style={primaryButton} onClick={start}>New puzzle</button>
            <button type="button" style={secondaryButton} onClick={() => setPuzzle(null)}>Change settings</button>
          </div>
        </div>
      )}
      <div className="sudoku-board" data-sudoku-board style={{
        display: 'grid', gridTemplateColumns: 'repeat(9, 1fr)', gap: 2,
        maxWidth: 320, margin: '0 auto 12px', aspectRatio: '1',
        border: `2px solid ${tokens.colors.textPrimary}`,
      }}>
        {board.map((v, i) => {
          const isGiven = givens.has(i);
          const conflict = conflicts.has(i);
          const isSel = selected === i;
          const boxBorderRight = (i % 9 === 2 || i % 9 === 5) ? '2px solid' : '1px solid';
          const boxBorderBottom = (Math.floor(i / 9) === 2 || Math.floor(i / 9) === 5) ? '2px solid' : '1px solid';
          return (
            <button
              key={i}
              type="button"
              className="sudoku-cell"
              data-sudoku-cell={i}
              aria-label={`Row ${row(i) + 1} column ${col(i) + 1}`}
              onClick={() => setSelected(i)}
              style={{
                aspectRatio: '1',
                border: 'none',
                borderRight: boxBorderRight,
                borderBottom: boxBorderBottom,
                borderColor: tokens.colors.textPrimary,
                backgroundColor: isSel ? tokens.colors.accentLavenderSoft : conflict ? '#fde2e2' : tokens.colors.bgSurface,
                color: isGiven ? tokens.colors.textPrimary : tokens.colors.accentLavenderDeep,
                fontWeight: isGiven ? 700 : 500,
                fontSize: '1rem',
                cursor: isGiven ? 'default' : 'pointer',
              }}
            >
              {v === 0 ? '' : v}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {[1,2,3,4,5,6,7,8,9].map((n) => (
          <button key={n} type="button" style={digitButton} onClick={() => place(n)} disabled={finished}>{n}</button>
        ))}
        <button type="button" style={digitButton} onClick={() => place(0)} disabled={finished}>✕</button>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        <button type="button" style={secondaryButton} onClick={() => setPuzzle(null)}>Settings</button>
        {onExit && <button type="button" style={secondaryButton} onClick={onExit}>Back</button>}
      </div>
    </section>
  );
}

function row(i: number) { return Math.floor(i / 9); }
function col(i: number) { return i % 9; }

const buttonStyle = (active: boolean): React.CSSProperties => ({
  font: 'inherit', fontSize: '0.8rem', fontWeight: 700, padding: '8px 12px',
  borderRadius: '12px', border: 'none', cursor: 'pointer',
  backgroundColor: active ? tokens.colors.primaryPink : tokens.colors.bgSurfaceSubtle,
  color: active ? tokens.colors.textPrimary : tokens.colors.textSecondary,
});

const primaryButton: React.CSSProperties = {
  font: 'inherit', fontSize: '0.85rem', fontWeight: 700, padding: '10px 16px',
  borderRadius: '14px', border: 'none', cursor: 'pointer',
  backgroundColor: tokens.colors.primaryPink, color: tokens.colors.textPrimary,
};

const secondaryButton: React.CSSProperties = {
  font: 'inherit', fontSize: '0.85rem', fontWeight: 700, padding: '10px 16px',
  borderRadius: '14px', border: 'none', cursor: 'pointer',
  backgroundColor: tokens.colors.bgSurfaceSubtle, color: tokens.colors.textSecondary,
};

const digitButton: React.CSSProperties = {
  font: 'inherit', fontSize: '1rem', fontWeight: 700, width: 32, height: 32,
  borderRadius: '10px', border: 'none', cursor: 'pointer',
  backgroundColor: tokens.colors.bgSurfaceSubtle, color: tokens.colors.textPrimary,
};

export default Sudoku;
