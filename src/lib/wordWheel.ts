/**
 * Word Wheel's rules, kept free of React and the network so they can be tested on
 * their own. The server deals one shared puzzle and validates every submission; this
 * module gives the phone instant local feedback while it swipes.
 */

export const WORD_LEVELS = ['easy', 'medium', 'hard'] as const;
export type WordLevel = typeof WORD_LEVELS[number];
export const WORD_DURATIONS = [60, 180, 300] as const;
export type WordDuration = typeof WORD_DURATIONS[number];

/** Hints are limited per round: each one reveals a single letter of an unfound word. */
export const WORD_HINTS = 2;
/** How far ahead the server sets the shared start, so both phones can receive it. */
export const WORD_START_LEAD_MS = 8_000;

export const WORD_LEVEL_LABELS: Record<WordLevel, string> = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
};

export const WORD_LEVEL_HINTS: Record<WordLevel, string> = {
  easy: 'Short, friendly words and a gentle mix. The seven-letter grand prize is still in play.',
  medium: 'More words, a couple of sixes and a busier wheel.',
  hard: 'The longest list, with the most five- and six-letter words to find.',
};

export function wordDurationLabel(seconds: number): string {
  if (seconds === 60) return '1 minute';
  if (seconds === 300) return '5 minutes';
  return `${Math.round(seconds / 60)} minutes`;
}

export function wordDurationLabelShort(seconds: number): string {
  if (seconds === 60) return '1 min';
  if (seconds === 300) return '5 min';
  return `${Math.round(seconds / 60)} min`;
}

export function isWordLevel(value: unknown): value is WordLevel {
  return typeof value === 'string' && (WORD_LEVELS as readonly string[]).includes(value);
}

export function isWordDuration(value: unknown): value is WordDuration {
  return typeof value === 'number' && (WORD_DURATIONS as readonly number[]).includes(value);
}

/** Lowercase a guess and keep only letters; the wheel only ever deals a–z. */
export function normalizeWord(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^a-z]/g, '') : '';
}

/** True when `word` can be built from `letters`, using each wheel letter at most once. */
export function canBuildWord(letters: string, word: string): boolean {
  const available = new Map<string, number>();
  for (const letter of letters.toLowerCase()) available.set(letter, (available.get(letter) ?? 0) + 1);
  for (const letter of word.toLowerCase()) {
    const left = available.get(letter) ?? 0;
    if (left <= 0) return false;
    available.set(letter, left - 1);
  }
  return true;
}

/** One row of blanks: words of the same length, with the seven-letter prize marked. */
export interface WordGroup {
  length: number;
  words: string[];
  grand: boolean;
}

/**
 * Groups a round's hidden words for the blank rows. The grand prize is its own row
 * first; the rest read from shortest to longest, the way a word-wheel puzzle usually
 * lays them out.
 */
export function wordGroups(words: string[], grandWord?: string): WordGroup[] {
  const seen = new Set<string>();
  const clean = words.map(normalizeWord).filter((word) => {
    if (!word || word.length < 2 || word.length > 7 || seen.has(word)) return false;
    seen.add(word);
    return true;
  });
  const grand = normalizeWord(grandWord) || clean.find((word) => word.length === 7) || '';
  const groups = new Map<number, string[]>();
  for (const word of clean) {
    if (word === grand) continue;
    const list = groups.get(word.length) ?? [];
    list.push(word);
    groups.set(word.length, list);
  }
  const rows: WordGroup[] = [];
  if (grand) rows.push({ length: 7, words: [grand], grand: true });
  for (const length of [...groups.keys()].sort((a, b) => a - b)) {
    rows.push({ length, words: (groups.get(length) ?? []).sort(), grand: false });
  }
  return rows;
}

/** The next letter index a hint should reveal, or null when the word is complete. */
export function nextHintIndex(word: string, revealed: Iterable<number>, random = Math.random): number | null {
  const taken = new Set(revealed);
  const candidates: number[] = [];
  for (let index = 0; index < word.length; index += 1) {
    if (!taken.has(index)) candidates.push(index);
  }
  if (!candidates.length) return null;
  return candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
}

export interface HintChoice {
  word: string;
  index: number;
}

/**
 * Choose a hint: a random word still missing, then one of its unrevealed letters.
 * `revealed` is the local map of word → letter indexes already shown.
 */
export function chooseHint(
  targets: string[],
  found: Iterable<string>,
  revealed: Map<string, Set<number>>,
  random = Math.random,
): HintChoice | null {
  const foundSet = new Set([...found].map(normalizeWord));
  const open = targets
    .map(normalizeWord)
    .filter((word) => word && !foundSet.has(word))
    .map((word) => ({ word, index: nextHintIndex(word, revealed.get(word) ?? [], random) }))
    .filter((choice): choice is HintChoice => choice.index !== null);
  if (!open.length) return null;
  return open[Math.min(open.length - 1, Math.floor(random() * open.length))];
}

export interface WordAttempt {
  word: string;
  count: number;
  finishedMs: number;
}

/** Most words wins; on a tie the earlier last-word time wins; an exact tie is a draw. */
export function compareWordAttempts(mine: WordAttempt, theirs: WordAttempt): 'mine' | 'partner' | 'draw' {
  if (mine.count !== theirs.count) return mine.count > theirs.count ? 'mine' : 'partner';
  if (mine.finishedMs !== theirs.finishedMs) return mine.finishedMs < theirs.finishedMs ? 'mine' : 'partner';
  return 'draw';
}

/** Clock formatting for the HUD: 1:00, 0:09. */
export function formatWordClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** The time of the last found word, which is the tie-break, formatted as 0:42. */
export function formatWordTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * A stable random order for the wheel. Shuffling reorders only the display; the
 * letters themselves and the hidden words never change.
 */
export function shuffleLetters(letters: string, random = Math.random): string[] {
  const list = letters.split('');
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [list[index], list[swap]] = [list[swap], list[index]];
  }
  return list;
}
