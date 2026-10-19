import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { GameMatch } from '../../lib/gamesService';
import type { GamesState } from '../../hooks/useGames';
import { useNow } from '../../hooks/useNow';
import {
  WORD_HINTS, WORD_LEVEL_LABELS, WORD_LEVEL_HINTS, chooseHint, compareWordAttempts, formatWordClock,
  formatWordTime, normalizeWord, shuffleLetters, wordDurationLabel, wordDurationLabelShort, wordGroups,
} from '../../lib/wordWheel';

const WHEEL_RADIUS = 36;
const HIT_RADIUS_RATIO = 0.085;

interface Point { left: number; top: number }

function wheelPoints(count: number): Point[] {
  return Array.from({ length: count }, (_, index) => {
    const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
    return {
      left: 50 + WHEEL_RADIUS * Math.cos(angle),
      top: 50 + WHEEL_RADIUS * Math.sin(angle),
    };
  });
}

function ownerWords(side: { words: string[] }): string[] {
  return side.words;
}

export function WordWheel({ match, userId, partnerName, games, onExit }: {
  match: GameMatch;
  userId: string;
  partnerName: string;
  games: GamesState;
  onExit: () => void;
}) {
  const round = match.word;
  const now = useNow(250);
  const [order, setOrder] = useState(() => (round?.letters ?? '').split(''));
  const [path, setPath] = useState<number[]>([]);
  const [found, setFound] = useState<string[]>(() => round?.mine.words ?? []);
  const [revealed, setRevealed] = useState<Map<string, Set<number>>>(() => new Map());
  const [hintsLeft, setHintsLeft] = useState(WORD_HINTS);
  const [message, setMessage] = useState<{ kind: 'correct' | 'wrong' | 'info'; text: string } | null>(null);
  const [shakeKey, setShakeKey] = useState(0);
  const [typed, setTyped] = useState('');
  const [localSubmitted, setLocalSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dragging = useRef(false);
  const pathRef = useRef<number[]>([]);
  const foundRef = useRef<string[]>(round?.mine.words ?? []);
  const lastFoundMs = useRef<number>(round?.mine.finished_ms ?? 0);
  const submittedRef = useRef(false);
  const expiredRef = useRef(false);
  const submitRef = useRef<(words: string[], finishedMs: number) => Promise<void>>(async () => {});
  const wheelRef = useRef<HTMLDivElement>(null);
  const shakeTimer = useRef<number | null>(null);
  const messageTimer = useRef<number | null>(null);

  const points = useMemo(() => wheelPoints(order.length), [order.length]);

  /* A new round is a clean board. A refreshed view of the same round must not wipe
     words the local swipe already found. */
  useEffect(() => {
    submittedRef.current = round?.mine.submitted === true;
    setLocalSubmitted(round?.mine.submitted === true);
    setOrder((round?.letters ?? '').split(''));
    setPath([]);
    pathRef.current = [];
    setFound(round?.mine.words ?? []);
    foundRef.current = round?.mine.words ?? [];
    setRevealed(new Map());
    setHintsLeft(WORD_HINTS);
    setTyped('');
    setMessage(null);
    setSubmitError(null);
    lastFoundMs.current = round?.mine.finished_ms ?? 0;
    // Only the round identity resets the board.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match.id]);

  const serverWordsKey = round?.mine.words.join('|') ?? '';
  useEffect(() => {
    if (!serverWordsKey) return;
    const serverWords = serverWordsKey.split('|');
    setFound((previous) => {
      const merged = [...new Set([...previous, ...serverWords])];
      foundRef.current = merged;
      return merged;
    });
  }, [serverWordsKey]);

  const offset = useMemo(() => {
    const server = round?.server_now ? Date.parse(round.server_now) : NaN;
    return Number.isFinite(server) ? server - Date.now() : 0;
  }, [round?.server_now]);

  const serverNow = now.getTime() + offset;
  const startAt = round?.start_at ? Date.parse(round.start_at) : null;
  const durationMs = (round?.duration_seconds ?? 60) * 1000;
  const countdownMs = startAt === null ? null : Math.max(0, startAt - serverNow);
  const remainingMs = startAt === null ? durationMs : Math.max(0, startAt + durationMs - serverNow);
  const elapsedMs = Math.max(0, Math.min(durationMs, durationMs - remainingMs));
  const started = startAt !== null && serverNow >= startAt;
  const mySubmitted = localSubmitted || round?.mine.submitted === true;
  const running = round?.status === 'running';
  const finished = round?.status === 'finished';
  const total = round?.words.length ?? 0;
  const disabled = !running || !started || mySubmitted || finished;

  const flash = useCallback((kind: 'correct' | 'wrong' | 'info', text: string) => {
    setMessage({ kind, text });
    if (messageTimer.current) window.clearTimeout(messageTimer.current);
    messageTimer.current = window.setTimeout(() => setMessage(null), 2200);
  }, []);

  const shake = useCallback(() => {
    setShakeKey((key) => key + 1);
    if (shakeTimer.current) window.clearTimeout(shakeTimer.current);
    shakeTimer.current = window.setTimeout(() => setShakeKey(0), 450);
  }, []);

  useEffect(() => () => {
    if (shakeTimer.current) window.clearTimeout(shakeTimer.current);
    if (messageTimer.current) window.clearTimeout(messageTimer.current);
  }, []);

  const submit = useCallback(async (words: string[], finishedMs: number) => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    setSaving(true);
    setSubmitError(null);
    try {
      await games.submitWord(match.id, words, finishedMs);
      setLocalSubmitted(true);
    } catch (error) {
      submittedRef.current = false;
      setSubmitError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }, [games, match.id]);

  /* Time up: save what was found. The last word's time, not the clock's end, is the
     tie-break, so it is carried separately. */
  useEffect(() => {
    if (!running || !started || mySubmitted || submittedRef.current) return;
    if (remainingMs > 0) return;
    void submit(foundRef.current, lastFoundMs.current);
  }, [running, started, mySubmitted, remainingMs, submit]);

  /* The clock can expire and the player can leave in the same moment. Keep the
     submission function and the expired flag in refs so the unmount path can still
     save the words the phone found instead of letting the grace sweep count zero. */
  useEffect(() => { submitRef.current = submit; expiredRef.current = running && started && remainingMs <= 0 && !mySubmitted; }, [submit, running, started, remainingMs, mySubmitted]);
  useEffect(() => () => {
    if (expiredRef.current) void submitRef.current(foundRef.current, lastFoundMs.current);
  }, []);

  const evaluate = useCallback((candidate: string) => {
    if (disabled || !round) return;
    const word = normalizeWord(candidate);
    if (!word) return;
    const targetsForRound = round.words;
    if (!targetsForRound.includes(word)) {
      setPath([]);
      pathRef.current = [];
      shake();
      flash('wrong', 'Not one of the hidden words.');
      return;
    }
    if (foundRef.current.includes(word)) {
      setPath([]);
      pathRef.current = [];
      flash('info', 'Already found.');
      return;
    }
    const next = [...foundRef.current, word];
    foundRef.current = next;
    setFound(next);
    const at = Math.min(durationMs, elapsedMs);
    lastFoundMs.current = at;
    setPath([]);
    pathRef.current = [];
    flash('correct', `Found ${word.toUpperCase()}!`);
    if (next.length >= targetsForRound.length) void submit(next, at);
  }, [disabled, round, durationMs, elapsedMs, shake, flash, submit]);

  const nearestLetter = useCallback((clientX: number, clientY: number): number | null => {
    const element = wheelRef.current;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const hit = HIT_RADIUS_RATIO * rect.width;
    let best: number | null = null;
    let bestDistance = Infinity;
    points.forEach((point, index) => {
      const px = (point.left / 100) * rect.width;
      const py = (point.top / 100) * rect.height;
      const distance = Math.hypot(px - x, py - y);
      if (distance <= hit && distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    });
    return best;
  }, [points]);

  const pick = useCallback((index: number | null) => {
    if (index === null) return;
    setPath((previous) => {
      let next = previous;
      if (!previous.length) next = [index];
      else {
        const last = previous[previous.length - 1];
        // Swiping back onto the previous letter undoes the most recent one.
        if (index === last) next = previous;
        else if (previous.length >= 2 && index === previous[previous.length - 2]) next = previous.slice(0, -1);
        else if (previous.includes(index)) next = previous;
        else next = [...previous, index];
      }
      pathRef.current = next;
      return next;
    });
  }, []);

  const endPath = useCallback(() => {
    dragging.current = false;
    const current = pathRef.current;
    if (current.length < 2) {
      setPath([]);
      pathRef.current = [];
      return;
    }
    evaluate(current.map((index) => order[index] ?? '').join(''));
  }, [evaluate, order]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    event.preventDefault();
    dragging.current = true;
    wheelRef.current?.setPointerCapture(event.pointerId);
    pick(nearestLetter(event.clientX, event.clientY));
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current || disabled) return;
    event.preventDefault();
    pick(nearestLetter(event.clientX, event.clientY));
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    if (wheelRef.current?.hasPointerCapture(event.pointerId)) {
      wheelRef.current.releasePointerCapture(event.pointerId);
    }
    endPath();
  };

  const onPointerCancel = () => {
    dragging.current = false;
    setPath([]);
    pathRef.current = [];
  };

  const spendHint = () => {
    if (disabled || hintsLeft <= 0 || !round) return;
    const choice = chooseHint(round.words, found, revealed);
    if (!choice) {
      flash('info', 'Every word is already found!');
      return;
    }
    setRevealed((previous) => {
      const next = new Map(previous);
      const letters = new Set(next.get(choice.word) ?? []);
      letters.add(choice.index);
      next.set(choice.word, letters);
      return next;
    });
    setHintsLeft((left) => left - 1);
    flash('info', 'A letter appears in the blanks.');
  };

  const shuffle = () => {
    if (!round) return;
    setOrder(shuffleLetters(round.letters));
    setPath([]);
    pathRef.current = [];
  };

  const typeWord = () => {
    const word = normalizeWord(typed);
    setTyped('');
    if (word) evaluate(word);
  };

  if (!round) {
    return <section className="game-card word-wheel-card">
      <p role="alert">This Word Wheel round is missing its puzzle. Try opening it again from Ongoing games.</p>
      <button type="button" onClick={onExit}>← All games</button>
    </section>;
  }

  const groups = wordGroups(round.words, round.grand_word);
  const currentWord = path.map((index) => order[index] ?? '').join('');
  const winner = finished
    ? round.winner_id === userId
      ? 'mine'
      : round.winner_id === null
        ? 'draw'
        : 'partner'
    : null;
  const myAttempt = { word: '', count: found.length, finishedMs: round.mine.finished_ms ?? lastFoundMs.current };
  const theirAttempt = { word: '', count: round.partner.count, finishedMs: round.partner.finished_ms ?? durationMs };
  const localComparison = compareWordAttempts(myAttempt, theirAttempt);

  /* ------------------------------------------------------------------ lobby -- */
  if (!running && !finished) {
    return <section className="game-card word-wheel-card word-lobby">
      <div className="word-lobby-head">
        <div>
          <span className="word-eyebrow">Word Wheel</span>
          <h2>{WORD_LEVEL_LABELS[round.difficulty]} · {wordDurationLabel(round.duration_seconds)}</h2>
        </div>
        <span className="word-pill">{total} words</span>
      </div>
      <WheelPreview letters={round.letters} />
      <p className="word-lobby-copy">
        You both get this exact wheel and the same {total} hidden words. {WORD_LEVEL_HINTS[round.difficulty]}
      </p>
      <div className="word-ready-grid">
        <div className={round.mine.ready ? 'is-ready' : ''}>
          <span>You</span>
          <strong>{round.mine.ready ? 'Ready' : 'Not ready yet'}</strong>
        </div>
        <div className={round.partner.ready ? 'is-ready' : ''}>
          <span>{partnerName}</span>
          <strong>{round.partner.ready ? 'Ready' : 'Waiting'}</strong>
        </div>
      </div>
      {round.start_at && countdownMs !== null && countdownMs > 0 && (
        <p className="word-countdown" role="status">Starting in {Math.ceil(countdownMs / 1000)}…</p>
      )}
      {startAt !== null && countdownMs === 0 && (
        <p className="word-countdown" role="status">The clock is running. Open the wheel when you are ready.</p>
      )}
      <ul className="word-rules">
        <li>Swipe across letters to build a word; each letter once.</li>
        <li>Swipe back over the last letter to undo it.</li>
        <li>Most words wins. A tie goes to the earlier last found word.</li>
        <li>The seven-letter grand prize is always one of the blanks.</li>
      </ul>
      {submitError && <p className="word-error" role="alert">{submitError}</p>}
      {games.error && <p className="word-error" role="alert">{games.error}</p>}
      <div className="word-actions">
        {!round.mine.ready ? (
          <button type="button" disabled={games.busy} onClick={() => void games.readyWord(match.id)}>
            {games.busy ? 'Saying ready…' : 'I’m ready'}
          </button>
        ) : (
          <button type="button" className="snake-secondary" disabled={games.busy || countdownMs === 0} onClick={() => void games.readyWord(match.id)}>
            {round.partner.ready ? 'Both ready' : `Waiting for ${partnerName}…`}
          </button>
        )}
        <button type="button" className="snake-secondary" onClick={onExit}>← All games</button>
      </div>
      <p className="game-hint">The round starts for both of you at the same server time, even if one phone opens late.</p>
    </section>;
  }

  /* -------------------------------------------------------------- countdown -- */
  if (running && !started) {
    return <section className="game-card word-wheel-card word-countdown-screen">
      <span className="word-eyebrow">Get ready</span>
      <h2>{WORD_LEVEL_LABELS[round.difficulty]} · {wordDurationLabel(round.duration_seconds)}</h2>
      <WheelPreview letters={round.letters} />
      <p className="word-big-countdown" role="status">{Math.max(1, Math.ceil((countdownMs ?? 0) / 1000))}</p>
      <p>Both clocks start together. {total} words to find.</p>
      <p className="game-hint">The buttons unlock at zero. You can still join if the countdown has already passed — your clock is already running.</p>
      <div className="word-actions"><button type="button" className="snake-secondary" onClick={onExit}>← All games</button></div>
    </section>;
  }

  /* ------------------------------------------------------------ saved result -- */
  if (running && mySubmitted && !finished) {
    return <section className="game-card word-wheel-card word-saved">
      <span className="word-eyebrow">Round saved</span>
      <h2>You found {found.length} of {total}</h2>
      <p className="word-saved-line">
        Last word at <strong>{formatWordTime(round.mine.finished_ms ?? lastFoundMs.current)}</strong>.
        {' '}Waiting for {partnerName} to finish — the result is decided when both attempts are in.
      </p>
      {submitError && <p className="word-error" role="alert">{submitError}</p>}
      <WheelPreview letters={round.letters} />
      <div className="word-actions">
        <button type="button" className="snake-secondary" onClick={onExit}>← All games</button>
      </div>
      <p className="game-hint">You can leave this screen. The round will settle on the next refresh.</p>
    </section>;
  }

  /* ---------------------------------------------------------------- finished -- */
  if (finished) {
    return <section className="game-card word-wheel-card word-result">
      <span className="word-eyebrow">Round complete</span>
      <h2>{winner === 'mine' ? 'You won! 🎉' : winner === 'partner' ? `${partnerName} won 🎉` : 'A draw!'}</h2>
      <p className="word-result-sub">
        {localComparison === 'draw' && winner === null
          ? 'The same number of words, found at the same moment.'
          : 'Most words wins; on a tie, the earlier last found word takes it.'}
      </p>
      <div className="word-result-grid">
        <div className={winner === 'mine' ? 'is-winner' : ''}>
          <span>You</span>
          <strong>{found.length}/{total}</strong>
          <small>last word {formatWordTime(round.mine.finished_ms ?? 0)}</small>
        </div>
        <div className={winner === 'partner' ? 'is-winner' : ''}>
          <span>{partnerName}</span>
          <strong>{round.partner.count}/{total}</strong>
          <small>last word {formatWordTime(round.partner.finished_ms)}</small>
        </div>
      </div>
      <div className="word-found-list">
        <h3>Your words</h3>
        <p>{found.length ? found.map((word) => word.toUpperCase()).join(' · ') : 'None this time.'}</p>
        <h3>{partnerName}’s words</h3>
        <p>{round.partner.words.length ? ownerWords(round.partner).map((word) => word.toUpperCase()).join(' · ') : 'None this time.'}</p>
      </div>
      <div className="word-actions">
        <button type="button" disabled={games.busy} onClick={() => void games.startWordRound(round.difficulty, round.duration_seconds)}>
          {games.busy ? 'Setting a new wheel…' : 'Play again →'}
        </button>
        <button type="button" className="snake-secondary" onClick={onExit}>← All games</button>
      </div>
      <p className="game-hint">A rematch keeps the same difficulty and {wordDurationLabelShort(round.duration_seconds)} clock.</p>
    </section>;
  }

  /* ------------------------------------------------------------------- board -- */
  const progress = total ? (found.length / total) * 100 : 0;
  return <section className="word-wheel-card word-play">
    <div className="word-hud">
      <div className="word-timer">
        <span>Time left</span>
        <strong className={remainingMs <= 10_000 ? 'is-low' : ''}>{formatWordClock(remainingMs)}</strong>
      </div>
      <div className="word-score">
        <span>Words</span>
        <strong>{found.length}<small>/{total}</small></strong>
      </div>
      <div className="word-hud-side">
        <span className={`word-pill ${mySubmitted ? 'is-ready' : ''}`}>{mySubmitted ? 'Saved' : 'Round live'}</span>
        <small>{partnerName}: {round.partner.submitted ? 'finished' : 'playing'}</small>
      </div>
    </div>
    <div className="word-progress" aria-hidden="true"><i style={{ width: `${progress}%` }} /></div>

    <div className="word-blanks" aria-label="Hidden words">
      {groups.map((group) => (
        <div className={`word-group ${group.grand ? 'is-grand' : ''}`} key={`${group.grand ? 'grand' : group.length}-${group.words[0]}`}>
          <span className="word-group-label">{group.grand ? 'Grand prize' : `${group.length}`}</span>
          <div className="word-slots">
            {group.words.map((word) => {
              const isFound = found.includes(word);
              const shown = revealed.get(word) ?? new Set<number>();
              return <span
                className={`word-slot ${isFound ? 'is-found' : ''}`}
                key={word}
                aria-label={isFound ? word : `${word.length}-letter word`}
              >
                {Array.from(word, (letter, index) => (
                  <span key={index} className="word-slot-letter">
                    {isFound ? letter.toUpperCase() : shown.has(index) ? letter.toUpperCase() : '·'}
                  </span>
                ))}
              </span>;
            })}
          </div>
        </div>
      ))}
    </div>

    <div className="word-current" aria-live="polite">
      {currentWord ? currentWord.toUpperCase() : 'Swipe the letters'}
    </div>

    <div
      className={`word-wheel ${shakeKey ? 'is-shaking' : ''}`}
      key={shakeKey || 'wheel'}
      ref={wheelRef}
      role="application"
      aria-label="Letter wheel. Swipe across letters to make a word, or type a word below."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      style={{ touchAction: 'none' }}
    >
      <svg className="word-wheel-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {path.length > 1 && (
          <polyline
            points={path.map((index) => `${points[index]?.left ?? 50},${points[index]?.top ?? 50}`).join(' ')}
            fill="none"
            stroke="#ed91ad"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {path.map((index) => (
          <circle key={index} cx={points[index]?.left ?? 50} cy={points[index]?.top ?? 50} r="1.6" fill="#8a6c93" />
        ))}
      </svg>
      {order.map((letter, index) => (
        <button
          key={`${letter}-${index}`}
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          className={`word-letter ${path.includes(index) ? 'is-picked' : ''}`}
          style={{ left: `${points[index]?.left ?? 50}%`, top: `${points[index]?.top ?? 50}%` }}
          data-letter={letter}
        >
          {letter.toUpperCase()}
        </button>
      ))}
      <div className="word-wheel-core" aria-hidden="true">
        <span>{found.length}</span>
        <small>found</small>
      </div>
    </div>

    <div className="word-feedback" aria-live="polite">
      {message && <span className={`word-message is-${message.kind}`}>{message.text}</span>}
    </div>

    <div className="word-controls">
      <button type="button" className="snake-secondary" onClick={shuffle} disabled={disabled}>⇄ Shuffle</button>
      <button type="button" className="snake-secondary" onClick={spendHint} disabled={disabled || hintsLeft <= 0}>
        💡 Hint · {hintsLeft}
      </button>
    </div>

    <form className="word-type" onSubmit={(event) => { event.preventDefault(); typeWord(); }}>
      <label htmlFor="word-type-input">Type a word</label>
      <div>
        <input
          id="word-type-input"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="for keyboards"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={disabled}
        />
        <button type="submit" disabled={disabled || !typed.trim()}>Check</button>
      </div>
    </form>

    {saving && <p className="word-saving" role="status">Saving your result…</p>}
    {submitError && <p className="word-error" role="alert">{submitError}</p>}
    <div className="word-actions">
      <button type="button" className="snake-secondary" onClick={onExit}>← All games</button>
    </div>
    <p className="game-hint">Leaving does not pause the clock. You can come back before it runs out.</p>
  </section>;
}

function WheelPreview({ letters }: { letters: string }) {
  const points = wheelPoints(letters.length);
  return <div className="word-wheel-preview" aria-hidden="true">
    {letters.split('').map((letter, index) => (
      <span
        key={`${letter}-${index}`}
        className="word-preview-letter"
        style={{ left: `${points[index]?.left ?? 50}%`, top: `${points[index]?.top ?? 50}%` }}
      >
        {letter.toUpperCase()}
      </span>
    ))}
  </div>;
}

export default WordWheel;
