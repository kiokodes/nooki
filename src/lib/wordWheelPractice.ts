import practicePuzzleBankUrl from '../../supabase/seed/word_puzzles.json?url';
import { wordGroups, normalizeWord } from './wordWheel';
import type { WordDuration, WordLevel } from './wordWheel';
import type { WordRound } from './gamesService';

export interface PracticePuzzle {
  letters: string;
  base_word: string;
  packs: Partial<Record<WordLevel, Record<string, string[]>>>;
}

export interface WordPracticeSession {
  id: string;
  round: WordRound;
}

let puzzleBankPromise: Promise<PracticePuzzle[]> | null = null;
let practiceSerial = 0;

async function loadPracticePuzzleBank(): Promise<PracticePuzzle[]> {
  if (!puzzleBankPromise) {
    puzzleBankPromise = fetch(practicePuzzleBankUrl)
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load the Word Wheel practice puzzles. Try again.');
        const puzzles: unknown = await response.json();
        if (!Array.isArray(puzzles)) throw new Error('The Word Wheel practice puzzle bank is unreadable.');
        return puzzles as PracticePuzzle[];
      })
      .catch((error: unknown) => {
        puzzleBankPromise = null;
        throw error;
      });
  }
  return puzzleBankPromise;
}

export function choosePracticePuzzle(
  puzzles: readonly PracticePuzzle[],
  difficulty: WordLevel,
  duration: WordDuration,
  random = Math.random,
): { letters: string; grandWord: string; words: string[] } {
  const eligible = puzzles.filter((puzzle) => {
    const words = puzzle.packs?.[difficulty]?.[String(duration)];
    return typeof puzzle.letters === 'string'
      && puzzle.letters.toLowerCase().replace(/[^a-z]/g, '').length === 7
      && typeof puzzle.base_word === 'string'
      && Array.isArray(words)
      && words.length >= 2;
  });
  if (!eligible.length) throw new Error('There are no local practice puzzles for those settings.');

  const puzzle = eligible[Math.min(eligible.length - 1, Math.floor(random() * eligible.length))];
  const grandWord = normalizeWord(puzzle.base_word);
  const words = [...new Set((puzzle.packs[difficulty]?.[String(duration)] ?? [])
    .map(normalizeWord).filter((word) => word.length >= 2 && word.length <= 7))];
  if (!grandWord || !words.includes(grandWord)) throw new Error('That practice puzzle is incomplete. Try another.');
  return {
    letters: puzzle.letters.toLowerCase().replace(/[^a-z]/g, '').slice(0, 7),
    grandWord,
    words,
  };
}

export function createPracticeWordSession(
  puzzle: { letters: string; grandWord: string; words: string[] },
  difficulty: WordLevel,
  duration: WordDuration,
  now = Date.now(),
  random = Math.random,
): WordPracticeSession {
  const startedAt = new Date(now).toISOString();
  const wordList = [...new Set(puzzle.words.map(normalizeWord).filter((word) => word.length >= 2 && word.length <= 7))];
  const grandWord = normalizeWord(puzzle.grandWord);
  if (puzzle.letters.length !== 7 || !grandWord || !wordList.includes(grandWord)) {
    throw new Error('That practice puzzle is incomplete. Try another.');
  }
  const layout = wordGroups(wordList, grandWord).map((group) => ({ length: group.length, count: group.words.length }));
  practiceSerial += 1;
  const suffix = Math.floor(random() * 0x1_0000_0000).toString(36);
  const id = `word-practice-${now}-${practiceSerial}-${suffix}`;
  const emptySide: WordRound['mine'] = {
    ready: false,
    ready_at: null,
    started: false,
    started_at: null,
    submitted: false,
    words: [],
    count: 0,
    finished_ms: null,
  };
  return {
    id,
    round: {
      letters: puzzle.letters.toLowerCase(),
      difficulty,
      duration_seconds: duration,
      grand_word: grandWord,
      words: wordList,
      layout,
      words_total: wordList.length,
      status: 'running',
      start_at: startedAt,
      server_now: startedAt,
      created_by: null,
      winner_id: null,
      mine: {
        ...emptySide,
        started: true,
        started_at: startedAt,
      },
      partner: emptySide,
    },
  };
}

export async function dealPracticeWordSession(
  difficulty: WordLevel,
  duration: WordDuration,
  random = Math.random,
  now = Date.now(),
): Promise<WordPracticeSession> {
  const puzzles = await loadPracticePuzzleBank();
  const puzzle = choosePracticePuzzle(puzzles, difficulty, duration, random);
  return createPracticeWordSession(puzzle, difficulty, duration, now, random);
}
