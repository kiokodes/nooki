import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameMatch, WordRound } from '../lib/gamesService';
import type { GamesState } from '../hooks/useGames';
import { WordWheel } from '../components/games/WordWheel';
import {
  WORD_DURATIONS, WORD_LEVELS, WORD_LEVEL_LABELS, WORD_LEVEL_HINTS, compareWordAttempts,
  wordDurationLabel, type WordDuration, type WordLevel,
} from '../lib/wordWheel';
import { tokens } from '../tokens/designTokens';
import '../components/games/games.css';

/**
 * The Word Wheel settings and the round they open, played out on this page alone.
 *
 * Like the Snake and Tetris previews, this exists so the real component and its CSS can be
 * reviewed at /preview.html without a Supabase project or a second account. The tab is a
 * settings panel first — difficulty, clock, and the button that opens the wheel — because
 * that is all a library tab is for. Nothing starts ticking until the round is opened and
 * both sides are ready; the clock is the round's, not the page's.
 *
 * The sample wheel is `ceiprtu` (picture). The sample partner readies up on their own, and
 * every word the player finds is checked against the same hidden list the server would use.
 */
const LETTERS = 'ceiprtu';
const GRAND = 'picture';
/** Every sample word is buildable from `ceiprtu`, each letter used once. */
const POOL = ['cutie', 'price', 'truce', 'cure', 'cute', 'pure', 'trip', 'true', 'tie', 'ripe', 'cut', 'ice', 'put', 'pit', 'it'];
/** How many blanks each tab offers. Longer rounds ask for more; harder levels ask for longer words. */
const COUNTS: Record<WordLevel, Record<WordDuration, number>> = {
  easy: { 60: 7, 180: 10, 300: 13 },
  medium: { 60: 9, 180: 12, 300: 15 },
  hard: { 60: 12, 180: 14, 300: 16 },
};
/** The fake server's ready handshake: shorter than the real 8 seconds, so the preview moves. */
const PREVIEW_LEAD_MS = 1_500;
const PARTNER_READY_MS = 500;

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

function sampleWords(level: WordLevel, seconds: WordDuration): string[] {
  const others = [...POOL].sort((a, b) => (level === 'hard' ? b.length - a.length : a.length - b.length) || a.localeCompare(b));
  return [GRAND, ...others.slice(0, COUNTS[level][seconds] - 1)];
}

type Side = WordRound['mine'];

function emptySide(): Side {
  return { ready: false, ready_at: null, submitted: false, words: [], count: 0, finished_ms: null };
}

function lobbyRound(userId: string, level: WordLevel, seconds: WordDuration): WordRound {
  const words = sampleWords(level, seconds);
  return {
    letters: LETTERS,
    difficulty: level,
    duration_seconds: seconds,
    grand_word: GRAND,
    words,
    layout: [{ length: 7, count: 1 }],
    words_total: words.length,
    status: 'waiting',
    start_at: null,
    server_now: new Date().toISOString(),
    created_by: userId,
    winner_id: null,
    mine: emptySide(),
    partner: emptySide(),
  };
}

export function PreviewWordWheel({ userId, partnerId, partnerName }: {
  userId: string;
  partnerId: string;
  partnerName: string;
}) {
  const [level, setLevel] = useState<WordLevel>('easy');
  const [seconds, setSeconds] = useState<WordDuration>(60);
  /** The round exists only once the settings button is used — the tab itself never starts a clock. */
  const [round, setRound] = useState<WordRound | null>(null);
  const timers = useRef<number[]>([]);

  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(fn, ms);
    timers.current.push(id);
  }, []);

  useEffect(() => () => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
  }, []);

  const open = useCallback(() => {
    setRound(lobbyRound(userId, level, seconds));
  }, [level, seconds, userId]);

  const close = useCallback(() => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
    setRound(null);
  }, []);

  /** This phone readies; the sample partner follows a beat later, and the server sets a start. */
  const ready = useCallback(async () => {
    setRound((current) => (current ? { ...current, mine: { ...current.mine, ready: true, ready_at: new Date().toISOString() } } : current));
    later(() => {
      setRound((current) => {
        if (!current || current.status !== 'waiting') return current;
        const at = new Date(Date.now() + PREVIEW_LEAD_MS).toISOString();
        return {
          ...current,
          status: 'running',
          start_at: at,
          partner: { ...current.partner, ready: true, ready_at: new Date().toISOString() },
        };
      });
    }, PARTNER_READY_MS);
    return round ?? lobbyRound(userId, level, seconds);
  }, [later, level, round, seconds, userId]);

  /** Both attempts in: most words wins, the earlier last word breaks a tie, equal is a draw. */
  const settle = useCallback((current: WordRound, words: string[], finishedMs: number): WordRound => {
    const mine = { ...current.mine, submitted: true, words, count: words.length, finished_ms: finishedMs };
    const theirs = [...current.words].filter((word) => word !== GRAND && Math.random() > 0.4);
    const partnerMs = Math.max(1_000, Math.min(current.duration_seconds * 1000, Math.round(current.duration_seconds * 1000 * (0.55 + Math.random() * 0.4))));
    const partner = { ...current.partner, submitted: true, words: theirs, count: theirs.length, finished_ms: partnerMs };
    const verdict = compareWordAttempts(
      { word: '', count: mine.count, finishedMs: mine.finished_ms ?? current.duration_seconds * 1000 },
      { word: '', count: partner.count, finishedMs: partner.finished_ms ?? current.duration_seconds * 1000 },
    );
    return {
      ...current,
      status: 'finished',
      winner_id: verdict === 'mine' ? userId : verdict === 'partner' ? partnerId : null,
      mine,
      partner,
    };
  }, [partnerId, userId]);

  const finish = useCallback((words: string[], finishedMs: number) => {
    setRound((current) => (current ? settle(current, words, finishedMs) : current));
  }, [settle]);

  if (!round) {
    return (
      <section style={cardStyle} data-preview-word-wheel="settings">
        <h2 style={{ fontSize: '1.15rem', margin: '0 0 8px' }}>Word Wheel</h2>
        <p style={{ fontSize: '0.85rem', lineHeight: 1.55, color: tokens.colors.textSecondary, margin: '0 0 14px' }}>
          The same seven-letter wheel on both phones, the same hidden words, and one shared
          clock. Pick a difficulty and a round length; nothing starts until you set the wheel
          and you have both readied up.
        </p>
        <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          <legend style={{ fontSize: '0.75rem', fontWeight: 700, margin: '0 0 8px' }}>Choose the difficulty</legend>
          {WORD_LEVELS.map((option) => (
            <button
              key={option}
              type="button"
              style={option === level ? buttonStyle : secondaryStyle}
              aria-pressed={option === level}
              onClick={() => setLevel(option)}
              data-preview-word-level={option}
            >
              {WORD_LEVEL_LABELS[option]}
            </button>
          ))}
        </fieldset>
        <p style={{ fontSize: '0.78rem', lineHeight: 1.5, color: tokens.colors.textMuted, margin: '0 0 12px' }}>
          {WORD_LEVEL_HINTS[level]}
        </p>
        <fieldset style={{ border: 0, padding: 0, margin: '0 0 14px', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
          <legend style={{ fontSize: '0.75rem', fontWeight: 700, margin: '0 0 8px' }}>How long is the round?</legend>
          {WORD_DURATIONS.map((option) => (
            <button
              key={option}
              type="button"
              style={option === seconds ? buttonStyle : secondaryStyle}
              aria-pressed={option === seconds}
              onClick={() => setSeconds(option)}
              data-preview-word-duration={option}
            >
              {wordDurationLabel(option)}
            </button>
          ))}
        </fieldset>
        <button type="button" style={buttonStyle} onClick={open} data-action="preview-open-wheel">
          Set the wheel for {partnerName} →
        </button>
        <p style={{ fontSize: '0.72rem', lineHeight: 1.5, color: tokens.colors.textMuted, margin: '12px 0 0' }}>
          Preview only: this round is played out on this page, with a sample wheel and a sample
          partner. The real one is timed, filtered and scored by the database — see the README.
        </p>
      </section>
    );
  }

  const match: GameMatch = {
    id: `sample-word-wheel-${round.status}`,
    game: 'word-wheel',
    player_x: userId,
    player_o: partnerId,
    turn_id: userId,
    best_of: 1,
    round: 1,
    score_x: 0,
    score_o: 0,
    my_pick: null,
    partner_locked: false,
    finished: round.status === 'finished',
    winner_id: round.winner_id,
    rounds: [],
    word: round,
  };
  const games = {
    busy: false,
    error: null,
    submitWord: async (_id: string, words: string[], finishedMs: number) => {
      finish(words, finishedMs);
      return round;
    },
    readyWord: ready,
    /** A rematch deals a fresh lobby with the same settings, exactly as the real RPC does. */
    startWordRound: async (nextLevel?: WordLevel, nextSeconds?: WordDuration) => {
      setRound(lobbyRound(userId, nextLevel ?? round.difficulty, nextSeconds ?? (round.duration_seconds as WordDuration)));
      return 'sample-word-wheel';
    },
    cancelWord: async () => round,
  } as unknown as GamesState;

  return <WordWheel
    match={match}
    userId={userId}
    partnerName={partnerName}
    games={games}
    onExit={close}
  />;
}

export default PreviewWordWheel;
