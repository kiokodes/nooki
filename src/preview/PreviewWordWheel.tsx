import { useCallback, useMemo, useState } from 'react';
import type { GameMatch, WordRound } from '../lib/gamesService';
import type { GamesState } from '../hooks/useGames';
import { WordWheel } from '../components/games/WordWheel';
import '../components/games/games.css';

/**
 * The Word Wheel board, played out on this page alone.
 *
 * Like the Snake and Tetris previews, this exists so the real component and its CSS can
 * be reviewed at /preview.html without a Supabase project or a second account. A correct
 * swipe fills a blank and a full clear settles a sample round; nothing is sent anywhere.
 */
const LETTERS = 'ceiprtu';
const HIDDEN = ['picture', 'cutie', 'price', 'truce', 'cure', 'cute', 'pure', 'trip', 'true', 'cut', 'ice', 'put', 'it'];
const PARTNER_WORDS = ['picture', 'price', 'truce', 'cute', 'true', 'cut', 'ice', 'it'];

function freshRound(userId: string, finished = false): WordRound {
  const start = new Date(Date.now() - 12_000).toISOString();
  return {
    letters: LETTERS,
    difficulty: 'medium',
    duration_seconds: 180,
    grand_word: 'picture',
    words: HIDDEN,
    layout: [
      { length: 2, count: 1 },
      { length: 3, count: 3 },
      { length: 4, count: 5 },
      { length: 5, count: 3 },
      { length: 7, count: 1 },
    ],
    words_total: HIDDEN.length,
    status: finished ? 'finished' : 'running',
    start_at: start,
    server_now: new Date().toISOString(),
    created_by: userId,
    winner_id: finished ? userId : null,
    mine: { ready: true, ready_at: start, submitted: finished, words: [], count: 0, finished_ms: finished ? 52_000 : null },
    partner: {
      ready: true,
      ready_at: start,
      submitted: finished,
      words: finished ? PARTNER_WORDS : [],
      count: finished ? PARTNER_WORDS.length : 0,
      finished_ms: finished ? 67_000 : null,
    },
  };
}

export function PreviewWordWheel({ userId, partnerId, partnerName }: {
  userId: string;
  partnerId: string;
  partnerName: string;
}) {
  const [round, setRound] = useState(() => freshRound(userId));
  const match = useMemo<GameMatch>(() => ({
    id: 'sample-word-wheel',
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
  }), [partnerId, round, userId]);

  const finish = useCallback((words: string[], finishedMs: number) => {
    setRound((current) => ({
      ...current,
      status: 'finished',
      winner_id: words.length >= PARTNER_WORDS.length ? userId : partnerId,
      mine: { ...current.mine, submitted: true, words, count: words.length, finished_ms: finishedMs },
      partner: {
        ...current.partner,
        submitted: true,
        words: PARTNER_WORDS,
        count: PARTNER_WORDS.length,
        finished_ms: 67_000,
      },
    }));
  }, [partnerId, userId]);

  const games = useMemo(() => ({
    busy: false,
    error: null,
    submitWord: async (_id: string, words: string[], finishedMs: number) => {
      finish(words, finishedMs);
      return round;
    },
    readyWord: async () => round,
    startWordRound: async () => { setRound(freshRound(userId)); return 'sample-word-wheel'; },
    cancelWord: async () => round,
  }) as unknown as GamesState, [finish, round, userId]);

  return <WordWheel
    match={match}
    userId={userId}
    partnerName={partnerName}
    games={games}
    onExit={() => {}}
  />;
}
