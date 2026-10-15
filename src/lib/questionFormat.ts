import { tokens } from '../tokens/designTokens';
import { QUESTION_INPUT_TYPES, REACTION_KINDS } from '../types/database';
import type { AnswerValue, Question, QuestionInputType, ReactionKind } from '../types/database';

/**
 * The Discuss tab's shared vocabulary.
 *
 * The question library is imported from the owner's CSV, so its spelling of a category or
 * an input type is not ours to control. The database canonicalises each row on the way in
 * (`canonical_question_category` / `canonical_question_input_type` /
 * `canonical_question_options` in supabase/migrations/202610150004_discuss_questions.sql);
 * the maps below are the same vocabulary on this side, so a project whose rows predate the
 * migration still renders instead of showing a blank card.
 *
 * tests/discuss-database.test.mjs feeds every alias through both implementations and
 * fails if they disagree — the two lists must be edited together.
 */

/** The eight categories the browse screen is designed around, in display order. */
export const DISCUSS_CATEGORIES = [
  { name: 'Fun', emoji: '🎈', blurb: 'Light and easy', accent: tokens.colors.primaryPinkDeep, accentSoft: tokens.colors.primaryPinkSoft },
  { name: 'Deep', emoji: '🌙', blurb: 'The big feelings', accent: tokens.colors.accentLavenderDeep, accentSoft: tokens.colors.accentLavenderSoft },
  { name: 'Family', emoji: '🏡', blurb: 'Both sides of the tree', accent: tokens.colors.primaryGreenDeep, accentSoft: tokens.colors.primaryGreenSoft },
  { name: 'Future', emoji: '🧭', blurb: 'Where this is going', accent: tokens.colors.accentSageDeep, accentSoft: tokens.colors.accentSageSoft },
  { name: 'Money', emoji: '🪙', blurb: 'Budgets and big buys', accent: tokens.colors.primaryPinkDeep, accentSoft: tokens.colors.primaryPinkSoft },
  { name: 'Home Life', emoji: '🛋️', blurb: 'Chores, routines, nesting', accent: tokens.colors.accentSageDeep, accentSoft: tokens.colors.accentSageSoft },
  { name: 'Intimacy', emoji: '🔞', blurb: '18+ · needs you both', accent: tokens.colors.primaryPinkDeep, accentSoft: tokens.colors.primaryPinkSoft, adult: true },
  { name: 'Silly', emoji: '🤪', blurb: 'Gloriously pointless', accent: tokens.colors.accentLavenderDeep, accentSoft: tokens.colors.accentLavenderSoft },
] as const;

/** A CSV may carry categories of its own; they still get a tile, just a plainer one. */
const FALLING_BACK_CATEGORY = {
  emoji: '✨',
  blurb: 'From your library',
  accent: tokens.colors.accentSageDeep,
  accentSoft: tokens.colors.accentSageSoft,
};

export interface CategoryDisplay {
  name: string;
  emoji: string;
  blurb: string;
  accent: string;
  accentSoft: string;
  /** True for the built-in 18+ category, which is gated on both partners agreeing. */
  adult: boolean;
}

export function categoryDisplay(name: string): CategoryDisplay {
  const known = DISCUSS_CATEGORIES.find((entry) => entry.name === name);
  if (known) {
    return { name: known.name, emoji: known.emoji, blurb: known.blurb, accent: known.accent, accentSoft: known.accentSoft, adult: 'adult' in known && known.adult === true };
  }
  return { name, ...FALLING_BACK_CATEGORY, adult: false };
}

/** The five seriousness levels, with the wording the browse screen uses for each. */
export const SERIOUSNESS_LEVELS = [
  { level: 1, label: 'Light', hint: 'Playful, no stakes' },
  { level: 2, label: 'Gentle', hint: 'Easy to answer' },
  { level: 3, label: 'Steady', hint: 'Worth a thought' },
  { level: 4, label: 'Real', hint: 'Honest answers' },
  { level: 5, label: 'Deep', hint: 'Sit down for this one' },
] as const;

export const SERIOUSNESS_MIN = 1;
export const SERIOUSNESS_MAX = 5;
/** The slider question type is a fixed 1-10 scale. */
export const SLIDER_MIN = 1;
export const SLIDER_MAX = 10;
/** Matches the `answers` payload check in the database. */
export const ANSWER_MAX_LENGTH = 4000;
/** Matches `answer_reactions_comment_length`. */
export const REACTION_COMMENT_MAX_LENGTH = 1000;

export const UNCATEGORISED = 'Uncategorised';

/** Exported so tests can feed every alias through the SQL canonicaliser too. */
export const CATEGORY_ALIASES: Record<string, string> = {
  fun: 'Fun',
  deep: 'Deep',
  family: 'Family',
  future: 'Future',
  money: 'Money',
  'home life': 'Home Life',
  home: 'Home Life',
  intimacy: 'Intimacy',
  intimate: 'Intimacy',
  sex: 'Intimacy',
  silly: 'Silly',
};

/** Exported so tests can feed every alias through the SQL canonicaliser too. */
export const INPUT_TYPE_ALIASES: Record<string, QuestionInputType> = {
  text: 'text',
  free: 'text',
  freetext: 'text',
  open: 'text',
  openended: 'text',
  short: 'text',
  long: 'text',
  paragraph: 'text',
  write: 'text',
  written: 'text',
  essay: 'text',
  // "Multiple choice" means one answer from several options, so it is a single pick.
  choice: 'choice',
  single: 'choice',
  singlechoice: 'choice',
  pick: 'choice',
  pickone: 'choice',
  multiplechoice: 'choice',
  radio: 'choice',
  select: 'choice',
  option: 'choice',
  options: 'choice',
  // Ticking more than one option is its own type, so the UI can offer checkboxes.
  multichoice: 'multi_choice',
  multi: 'multi_choice',
  multiselect: 'multi_choice',
  multiple: 'multi_choice',
  checkbox: 'multi_choice',
  checkboxes: 'multi_choice',
  ranking: 'ranking',
  rank: 'ranking',
  order: 'ranking',
  reorder: 'ranking',
  sort: 'ranking',
  dragdrop: 'ranking',
  draganddrop: 'ranking',
  slider: 'slider',
  scale: 'slider',
  rating: 'slider',
  range: 'slider',
  number: 'slider',
};

/** Mirrors `canonical_question_category`: unknown categories survive as written. */
export function canonicalCategory(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return UNCATEGORISED;
  const key = text.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return CATEGORY_ALIASES[key] ?? text;
}

/** Mirrors `canonical_question_input_type`: anything unknown degrades to free typing. */
export function canonicalInputType(raw: unknown): QuestionInputType {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const key = text.replace(/[_\-\s]+/g, '').toLowerCase();
  const mapped = INPUT_TYPE_ALIASES[key];
  return mapped && QUESTION_INPUT_TYPES.includes(mapped) ? mapped : 'text';
}

function labelFromOptionEntry(entry: unknown): string {
  if (typeof entry === 'string') return entry.trim();
  if (entry && typeof entry === 'object') {
    const record = entry as Record<string, unknown>;
    for (const key of ['label', 'text', 'value', 'title', 'name', 'id']) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
      if (typeof candidate === 'number') return String(candidate);
    }
    return '';
  }
  if (typeof entry === 'number' || typeof entry === 'boolean') return String(entry);
  return '';
}

/**
 * Mirrors `canonical_question_options`: accepts a JSON array, an array of objects, a
 * double-encoded JSON string (a common CSV accident) or a plain "Beach | City" list, and
 * always returns clean labels — or null when there is nothing to offer.
 */
export function normalizeQuestionOptions(raw: unknown): string[] | null {
  if (raw == null) return null;

  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    if (text.startsWith('[') || text.startsWith('{')) {
      try {
        return normalizeQuestionOptions(JSON.parse(text));
      } catch {
        // Not JSON after all: fall through to the delimiter split.
      }
    }
    const parts = text.split(/\s*[|;,]\s*/).map((part) => part.trim()).filter(Boolean);
    return parts.length ? parts : null;
  }

  if (Array.isArray(raw)) {
    const labels = raw.map(labelFromOptionEntry).filter(Boolean);
    return labels.length ? labels : null;
  }

  const single = labelFromOptionEntry(raw);
  return single ? [single] : null;
}

/** Turns a `questions` row into something the UI can trust, whatever the row looked like. */
export function toQuestion(row: Record<string, unknown>): Question {
  const inputType = canonicalInputType(row.input_type);
  const options = normalizeQuestionOptions(row.options);
  const seriousness = Number(row.seriousness);
  return {
    id: String(row.id ?? ''),
    text: String(row.text ?? '').trim(),
    category: canonicalCategory(row.category),
    seriousness: Number.isFinite(seriousness)
      ? Math.min(SERIOUSNESS_MAX, Math.max(SERIOUSNESS_MIN, Math.round(seriousness)))
      : 3,
    input_type: inputType,
    // Free typing and the 1-10 scale have nothing to offer.
    options: inputType === 'text' || inputType === 'slider' ? null : options,
    is_adult: Boolean(row.is_adult) || canonicalCategory(row.category) === 'Intimacy',
  };
}

export const ANSWER_REACTIONS: { kind: ReactionKind; emoji: string; label: string }[] = [
  { kind: 'happy', emoji: '😊', label: 'Happy' },
  { kind: 'funny', emoji: '😂', label: 'Funny' },
  { kind: 'sad', emoji: '😢', label: 'Sad' },
  { kind: 'angry', emoji: '😠', label: 'Angry' },
  { kind: 'disappointed', emoji: '😞', label: 'Disappointed' },
];

export function reactionDisplay(kind: string): { emoji: string; label: string } {
  const known = ANSWER_REACTIONS.find((entry) => entry.kind === kind);
  return known ? { emoji: known.emoji, label: known.label } : { emoji: '💬', label: 'Reacted' };
}

export function isReactionKind(value: unknown): value is ReactionKind {
  return typeof value === 'string' && (REACTION_KINDS as string[]).includes(value);
}

/** The blank draft a composer starts from for each input type. */
export function emptyAnswer(inputType: QuestionInputType): AnswerValue {
  if (inputType === 'multi_choice' || inputType === 'ranking') return [];
  if (inputType === 'slider') return 0;
  return '';
}

/** True when there is nothing worth sending yet: a slider still at 0 has not been picked. */
export function isAnswerEmpty(value: AnswerValue | null): boolean {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'number') return !Number.isFinite(value) || value < SLIDER_MIN;
  return value.trim() === '';
}

/**
 * Mirrors the database's `guard_answer_payload` so a mistake is caught on the phone with
 * the same wording the server would have used. The server still checks: this is a nicety,
 * never the enforcement.
 */
export function validateAnswer(value: AnswerValue | null, question: Question): AnswerValue {
  const { input_type: inputType } = question;

  if (inputType === 'text') {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) throw new Error('Please write your answer first.');
    if (text.length > ANSWER_MAX_LENGTH) throw new Error(`Answers can be up to ${ANSWER_MAX_LENGTH} characters.`);
    return text;
  }

  if (inputType === 'slider') {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) throw new Error('This question expects a number from 1 to 10.');
    if (number < SLIDER_MIN || number > SLIDER_MAX) throw new Error('Pick a number between 1 and 10.');
    return number;
  }

  const options = question.options ?? [];
  if (!options.length) {
    throw new Error('This question has no options yet. Ask the app owner to re-import it.');
  }

  if (inputType === 'choice') {
    const picked = typeof value === 'string' ? value.trim() : '';
    if (!picked) throw new Error('Pick exactly one option.');
    if (!options.includes(picked)) throw new Error('That is not one of the options for this question.');
    return picked;
  }

  const given = Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
  if (!given.length) throw new Error('Please choose at least one option.');
  if (given.some((item) => !options.includes(item))) {
    throw new Error('That is not one of the options for this question.');
  }
  if (new Set(given).size !== given.length) throw new Error('You have listed the same option twice.');
  if (inputType === 'ranking' && given.length !== options.length) {
    throw new Error('Put every option in an order before you send it.');
  }
  return given;
}

/**
 * Type-agnostic read of a stored answer. An `answers` row does not carry its question, so
 * the transport keeps strings, lists and numbers exactly as stored and the screen that
 * knows the input type can tighten it with `parseAnswerValue`.
 */
export function coerceAnswerValue(raw: unknown): AnswerValue {
  if (Array.isArray(raw)) return raw.map((item) => (item == null ? '' : String(item)));
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  if (typeof raw === 'string') return raw;
  if (raw == null) return '';
  if (typeof raw === 'object') return String(labelFromOptionEntry(raw));
  return String(raw);
}

/** Defensive read of a stored answer: never throws on a shape the UI did not expect. */
export function parseAnswerValue(raw: unknown, inputType: QuestionInputType): AnswerValue | null {
  if (raw == null) return null;
  if (inputType === 'slider') {
    const number = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(number) ? number : null;
  }
  if (inputType === 'multi_choice' || inputType === 'ranking') {
    if (Array.isArray(raw)) return raw.map((item) => String(item));
    if (typeof raw === 'string') {
      const parsed = normalizeQuestionOptions(raw);
      return parsed ?? [];
    }
    return [];
  }
  if (Array.isArray(raw)) return raw.length ? String(raw[0]) : '';
  if (typeof raw === 'object') return String(labelFromOptionEntry(raw));
  return String(raw);
}

/** One line that describes an answer, for the history list and the waiting state. */
export function formatAnswerSummary(value: AnswerValue | null, inputType: QuestionInputType): string {
  if (value == null) return 'No answer';
  if (inputType === 'slider') return `${typeof value === 'number' ? value : Number(value) || 0} / ${SLIDER_MAX}`;
  if (inputType === 'ranking' && Array.isArray(value)) {
    return value.map((item, index) => `${index + 1}. ${item}`).join(' · ');
  }
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}
