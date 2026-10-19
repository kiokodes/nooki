#!/usr/bin/env node
/**
 * Build the Word Wheel puzzle bank.
 *
 * Run once (and again whenever the curated base list changes):
 *
 *   npm run build:word-puzzles
 *
 * It writes:
 *   supabase/seed/word_puzzles.sql   — idempotent INSERTs for Supabase
 *   supabase/seed/word_puzzles.json  — the same rows, for scripts/upload-word-puzzles.mjs
 *
 * The puzzle is fixed ahead of time and stored. Each seven-letter base word is the
 * grand prize; every 2–7 letter word that can be built from those letters (each letter
 * used once) is considered, then the most common words are packed into the nine
 * difficulty × duration rounds. A pack is omitted when that base cannot fill it, so the
 * server never deals an impossible round.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const dictionary = new Set(require('word-list-json'));
const frequencies = require('subtlex-word-frequencies');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const seedDir = path.join(root, 'supabase', 'seed');

const LEVELS = ['easy', 'medium', 'hard'];
const DURATIONS = [60, 180, 300];

/** How many hidden words (including the grand prize) a round asks for. */
export const PACK_SIZES = {
  easy: { 60: 7, 180: 10, 300: 13 },
  medium: { 60: 9, 180: 13, 300: 17 },
  hard: { 60: 12, 180: 16, 300: 20 },
};

/**
 * Length mix per pack. The seven is added separately as the grand prize. When a
 * base cannot supply a length, the deficit is redistributed (hard leans longer,
 * easy leans shorter) instead of shrinking the round.
 */
const QUOTAS = {
  easy: {
    60: { 2: 1, 3: 2, 4: 2, 5: 1 },
    180: { 2: 1, 3: 3, 4: 3, 5: 2 },
    300: { 2: 1, 3: 4, 4: 4, 5: 3 },
  },
  medium: {
    60: { 2: 1, 3: 2, 4: 2, 5: 2, 6: 1 },
    180: { 2: 1, 3: 3, 4: 3, 5: 3, 6: 2 },
    300: { 2: 1, 3: 4, 4: 4, 5: 4, 6: 3 },
  },
  hard: {
    60: { 2: 2, 3: 2, 4: 2, 5: 3, 6: 2 },
    180: { 2: 2, 3: 3, 4: 3, 5: 4, 6: 3 },
    300: { 2: 2, 3: 3, 4: 4, 5: 5, 6: 5 },
  },
};

const FALLBACK = {
  easy: [3, 4, 5, 2, 6],
  medium: [5, 4, 3, 6, 2],
  hard: [6, 5, 4, 3, 2],
};

/** Two-letter words we are happy to ask for. Everything else is too obscure. */
const TWO_LETTER = new Set([
  'am', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'if', 'in', 'is',
  'it', 'me', 'my', 'no', 'of', 'on', 'or', 'so', 'to', 'up', 'us', 'we',
]);

/** Commonness gate, by word length (SUBTLEX-US rank, 0 = most common). */
const MAX_RANK = { 2: Infinity, 3: 5000, 4: 6500, 5: 6500, 6: 6500, 7: 6500 };

/**
 * Rude, unkind, medical or simply odd words that a couple should never be asked to
 * swipe. Kept deliberately broad: missing a word costs a blank, but a rude word costs
 * the game's tone.
 */
const BLOCKED = new Set(`
  aa abo anal anus arse ass asses bitch bitches boob boobs bollock bollocks boner
  breast breasts cock cocks coon crap cum cunt damn dick dicks dildo dyke fag fags
  fuck fucked fucker fucks hell hoe hoes homo horny jerk jerks jizz kill killed killer
  killing kills lesbian lesbians masturbate nazi negro nigga nigger nuts penis piss
  pissed porn porno pornos prick pussy queer rape raped raper rapist retard retards
  screw screwed semen sex sexes sexy shag shit shits shitty slut sluts sperm spic
  suicide tits tit titty turd twat vagina whore whores wog xxx
  cancer casket corpse corpses dead death deaths died die dies dying doom grave graves
  gun guns hate hates lust murder murdered murderer murders poison poisoned sin sick
  slave slayer soviet thug urine vomit war wars weapon weapons weed
  ain arson heck kent norma recon roman thine scum sins cult est tis tech
  costa dean del demo mae meg mini nah nope pros hon ciao las coke dope
  ann bertha butler caesar cain carl carter craig dan dame dee erica fowler joey marge
  mason mona monte noah norma oscar padre paris pedro perry raines sam san sarge
  sawyer senor shan slater troy
  bout cos dang gee gents hiya ling ming mon oops pronto sec sorta thee thou unto
  diane carmen romeo john johnson michael peter paul mark david james robert
  richard william mary maria laura linda susan karen nancy betty helen sandra donna
  carol sharon michelle kevin brian jason jeff gary steven larry frank scott eric
  adam alice anna barbara barbie charlie chris christ daniel deborah debra dennis
  dorothy edward elizabeth emily emma frank george gina grace harry jack jane janet
  janice jennifer jessica jim jimmy joe joel johnny jose joseph josh joshua judy
  julia julie justin kate kathy katie keith kelly ken kenneth kim kimberly kristen
  kyle margaret marie martha martin matthew megan melissa nancy natalie nicholas
  nicole patricia patrick rachel ralph randy raymond rebecca roger ronald rose ross
  roy russell ruth ryan samantha samuel sarah scott shirley sophia stephanie stephen
  susan teresa thomas timothy tina todd tom tommy tony tracy tyler valerie vanessa
  victor virginia walter wendy willie
`.trim().split(/\s+/));

const input = JSON.parse(await readFile(path.join(here, 'word-puzzle-bases.json'), 'utf8'));
const baseWords = [...new Set(input.bases.map((word) => word.toLowerCase()))]
  .filter((word) => /^[a-z]{7}$/.test(word))
  .filter((word) => dictionary.has(word))
  .sort();

/** Frequency rank for every dictionary word we may use as a subword. */
const rank = new Map();
for (const entry of frequencies) {
  const word = entry.word.toLowerCase();
  if (!/^[a-z]{2,7}$/.test(word)) continue;
  if (!dictionary.has(word)) continue;
  if (!rank.has(word)) rank.set(word, rank.size);
}

function counts(word) {
  const map = new Map();
  for (const letter of word) map.set(letter, (map.get(letter) ?? 0) + 1);
  return map;
}

function canBuild(letters, word) {
  const available = counts(letters);
  for (const [letter, needed] of counts(word)) {
    if ((available.get(letter) ?? 0) < needed) return false;
  }
  return true;
}

function commonEnough(word) {
  if (BLOCKED.has(word)) return false;
  if (word.length === 2) return TWO_LETTER.has(word);
  const position = rank.get(word);
  return position !== undefined && position <= MAX_RANK[word.length];
}

/** Every allowed word that can be built from the base letters, shortest first. */
function buildSubwords(base) {
  const found = [];
  for (const word of dictionary) {
    if (word === base || word.length < 2 || word.length > 7) continue;
    if (!commonEnough(word)) continue;
    if (!canBuild(base, word)) continue;
    found.push(word);
  }
  // Most common first inside each length. Ties break alphabetically so a rerun is stable.
  found.sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9) || a.localeCompare(b));
  return found;
}

/** Pick a pack of exactly `size` words for one difficulty and duration. */
function pickPack(base, subwords, level, seconds) {
  const size = PACK_SIZES[level][seconds];
  const byLength = new Map();
  for (const word of subwords) {
    if (!byLength.has(word.length)) byLength.set(word.length, []);
    byLength.get(word.length).push(word);
  }
  const chosen = [base]; // the grand prize is always in the pack
  const used = new Set(chosen);
  const target = new Map(Object.entries(QUOTAS[level][seconds]).map(([length, count]) => [Number(length), count]));
  const take = (length, count) => {
    const pool = byLength.get(length) ?? [];
    let added = 0;
    for (const word of pool) {
      if (added >= count) break;
      if (used.has(word)) continue;
      used.add(word);
      chosen.push(word);
      added += 1;
    }
    return added;
  };
  let missing = size - chosen.length;
  // First pass: the stated mix.
  for (const length of [2, 3, 4, 5, 6]) {
    const want = Math.min(target.get(length) ?? 0, missing);
    if (!want) continue;
    missing -= take(length, want);
  }
  // Second pass: top up from the difficulty's preferred neighbour lengths.
  for (const length of FALLBACK[level]) {
    if (missing <= 0) break;
    missing -= take(length, missing);
  }
  if (missing > 0) return null;
  const order = new Map([[7, 0], [6, 1], [5, 2], [4, 3], [3, 4], [2, 5]]);
  return chosen.sort((a, b) => (order.get(a.length) ?? 9) - (order.get(b.length) ?? 9) || a.localeCompare(b));
}

const puzzles = [];
const skipped = [];
for (const base of baseWords) {
  const subwords = buildSubwords(base);
  const packs = {};
  let packCount = 0;
  for (const level of LEVELS) {
    packs[level] = {};
    for (const seconds of DURATIONS) {
      const pack = pickPack(base, subwords, level, seconds);
      if (!pack) continue;
      packs[level][String(seconds)] = pack;
      packCount += 1;
    }
  }
  if (!packCount) {
    skipped.push({ base, reason: `only ${subwords.length} common subwords` });
    continue;
  }
  // `words` is the union of the packs, kept as a simple searchable record of the
  // round's vocabulary without repeating every candidate the game never asks for.
  const packed = [...new Set(Object.values(packs).flatMap((level) => Object.values(level).flat()))].sort();
  puzzles.push({
    letters: base.split('').sort().join(''),
    base_word: base,
    words: packed,
    packs,
  });
}

puzzles.sort((a, b) => a.base_word.localeCompare(b.base_word));

await mkdir(seedDir, { recursive: true });
await writeFile(path.join(seedDir, 'word_puzzles.json'), `${JSON.stringify(puzzles, null, 2)}\n`);

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const json = (value) => `${quote(JSON.stringify(value))}::jsonb`;
const lines = [
  '-- Generated by scripts/build-word-puzzles.mjs. Do not edit by hand.',
  '-- Apply supabase/migrations/202610190001_word_wheel.sql first, then run this once.',
  'BEGIN;',
  'INSERT INTO public.word_puzzles (letters, base_word, words, packs) VALUES',
  puzzles.map((puzzle) => `  (${quote(puzzle.letters)}, ${quote(puzzle.base_word)}, ARRAY[${puzzle.words.map(quote).join(',')}]::text[], ${json(puzzle.packs)})`).join(',\n'),
  'ON CONFLICT (base_word) DO UPDATE SET',
  '  letters = EXCLUDED.letters, words = EXCLUDED.words, packs = EXCLUDED.packs;',
  'COMMIT;',
  '',
];
await writeFile(path.join(seedDir, 'word_puzzles.sql'), lines.join('\n'));

console.log(`Word Wheel: ${puzzles.length} puzzles written from ${baseWords.length} base words.`);
for (const level of LEVELS) {
  console.log(`  ${level.padEnd(6)} ${DURATIONS.map((seconds) => `${seconds}s=${puzzles.filter((p) => p.packs[level]?.[seconds]).length}`).join('  ')}`);
}
if (skipped.length) console.log(`Skipped ${skipped.length} base words: ${skipped.map((item) => item.base).join(', ')}`);
