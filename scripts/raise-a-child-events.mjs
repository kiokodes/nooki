#!/usr/bin/env node
// The owner's event pipeline for Raise a Child.
//
// The owner writes the moments; this script makes sure only well-formed ones can reach
// the table, and that importing a batch twice cannot duplicate or quietly overwrite
// anything. It is the only thing that writes `event_templates`, and it always writes
// with active = false unless `--activate` is passed deliberately.
//
// Commands (all of them work without a database except import/activate/deactivate/coverage):
//
//   node scripts/raise-a-child-events.mjs validate <file.json> [--json]
//   node scripts/raise-a-child-events.mjs import   <file.json> [--activate] [--dry-run]
//   node scripts/raise-a-child-events.mjs activate   (--batch=batch-03 | --slugs=a,b)
//   node scripts/raise-a-child-events.mjs deactivate (--batch=batch-03 | --slugs=a,b)
//   node scripts/raise-a-child-events.mjs coverage   [--batch=batch-03] [--thin=3]
//
// Environment for the database commands:
//   SUPABASE_URL                https://<project>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   the service role key. Never the anon key, never in the app.
//
// `npm run events:import -- ./batch-03.json` is the same as the import command above.

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

// ---------------------------------------------------------------------------------
// The rules. docs/EVENT_CONTENT_SPEC.md is the human version of this list.
// ---------------------------------------------------------------------------------

export const CATEGORIES = ['home', 'school', 'friends', 'health', 'money', 'values', 'fun'];
export const TONES = ['warm', 'funny', 'gentle', 'honest', 'bittersweet'];
export const MOODS = ['content', 'safe', 'proud', 'thoughtful', 'delighted', 'quiet', 'brave', 'shy', 'curious', 'tender', 'restless'];

/** Every trait a parent may pick. Mirrors trait_catalog where kind = 'parent'. */
export const PARENT_TRAITS = ['patient', 'funny', 'strict', 'adventurous', 'anxious', 'creative', 'calm', 'curious', 'warm', 'organised'];

/** Every trait a child can carry. Mirrors trait_catalog where kind = 'child'. */
export const CHILD_TRAITS = ['kind', 'stubborn', 'shy', 'brave', 'playful', 'thoughtful', 'honest', 'gentle', 'messy', 'proud', 'restless'];

export const LIMITS = {
  slug: 64,
  title: 80,
  setupText: 220,
  outcomeText: 260,
  label: 60,
  choicesMin: 2,
  choicesMax: 4,
  ageMin: 0,
  ageMax: 17,
};

export const AGE_BANDS = [
  ['0-3', 0, 3],
  ['4-6', 4, 6],
  ['7-9', 7, 9],
  ['10-12', 10, 12],
  ['13-15', 13, 15],
  ['16-17', 16, 17],
];

/**
 * Words that mean a batch needs a human read before it goes anywhere near a family.
 * This is a screen, not a censor: the spec carries the full list of hard exclusions.
 */
const EXCLUDED_TOPICS = [
  ['death', /\b(dies?|died|death|funeral|kill(s|ed)?|passed away)\b/i],
  ['serious injury', /\b(coma|hospital|ambulance|broken (arm|leg|bone)|concussion|surgery)\b/i],
  ['abuse or neglect', /\b(abuse[sd]?|neglect(s|ed)?|hit(s|ting)? (the|a) child|bruise[sd]?)\b/i],
  ['abandonment', /\b(abandon(s|ed)?|left (the child|them) behind|gave (them|the child) up)\b/i],
  ['sexual content', /\b(sex|sexual|naked|nude|kiss(ing)? a (boy|girl)friend)\b/i],
  ['substances', /\b(drunk(en)?|drinking|alcohol|smok(e|ing)|vap(e|ing)|drugs?)\b/i],
  ['self-harm', /\b(self-harm|hurt (him|her|them)self|suicide|cutting)\b/i],
  ['bullying left unresolved', /\b(bully|bullied|bullies)\b/i],
];

const slugPattern = /^[a-z0-9][a-z0-9-]{2,63}$/;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const wordTokens = (value) => text(value).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

/** How alike two strings are, 0 to 1: shared words over all words. Deliberately blunt. */
export function similarity(a, b) {
  const left = new Set(wordTokens(a));
  const right = new Set(wordTokens(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

export function ageBand(age) {
  const band = AGE_BANDS.find(([, low, high]) => age >= low && age <= high);
  return band ? band[0] : 'unknown';
}

/** Reads and checks the master file's shape. Returns { events, problems }. */
export function parseEventsFile(raw, source = 'events') {
  const problems = [];
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    return { events: [], problems: [{ slug: '—', field: 'file', message: `Not valid JSON: ${error.message}` }] };
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.events) ? parsed.events : null;
  if (!list) {
    return {
      events: [],
      problems: [{ slug: '—', field: 'file', message: `${source} must be a JSON array of events, or { "events": [...] }.` }],
    };
  }
  return { events: list, problems };
}

/**
 * Every rule that can be checked mechanically. `knownChildTraits` can be widened by the
 * owner (a new row in trait_catalog) by passing extra names in.
 */
export function validateEvents(events, { knownChildTraits = CHILD_TRAITS, knownParentTraits = PARENT_TRAITS } = {}) {
  const problems = [];
  const add = (slug, field, message) => problems.push({ slug: slug || '—', field, message });
  const seenSlugs = new Map();

  events.forEach((event, index) => {
    const where = `event[${index}]`;
    if (!isPlainObject(event)) {
      add(where, 'event', 'Each event must be an object.');
      return;
    }
    const slug = text(event.slug);
    if (!slug) add(where, 'slug', 'Missing slug.');
    else if (!slugPattern.test(slug)) add(slug, 'slug', 'Use 3–64 lowercase letters, digits and dashes, starting with a letter or digit.');
    else if (seenSlugs.has(slug)) add(slug, 'slug', `Duplicate slug: also on ${seenSlugs.get(slug)}.`);
    else seenSlugs.set(slug, where);

    const minAge = event.min_age;
    const maxAge = event.max_age;
    if (!Number.isInteger(minAge) || minAge < LIMITS.ageMin || minAge > LIMITS.ageMax) {
      add(slug, 'min_age', `min_age must be a whole number between ${LIMITS.ageMin} and ${LIMITS.ageMax}.`);
    }
    if (!Number.isInteger(maxAge) || maxAge < LIMITS.ageMin || maxAge > LIMITS.ageMax) {
      add(slug, 'max_age', `max_age must be a whole number between ${LIMITS.ageMin} and ${LIMITS.ageMax}.`);
    }
    if (Number.isInteger(minAge) && Number.isInteger(maxAge) && minAge > maxAge) {
      add(slug, 'max_age', 'min_age must not be greater than max_age.');
    }

    if (!CATEGORIES.includes(text(event.category))) {
      add(slug, 'category', `category must be one of: ${CATEGORIES.join(', ')}.`);
    }

    if (event.tone != null && !TONES.includes(text(event.tone))) {
      add(slug, 'tone', `tone must be one of: ${TONES.join(', ')} (or left out).`);
    }

    const title = text(event.title);
    if (!title) add(slug, 'title', 'Missing title.');
    else if (title.length > LIMITS.title) add(slug, 'title', `Title is ${title.length} characters; the limit is ${LIMITS.title}.`);

    const setup = text(event.setup_text);
    if (!setup) add(slug, 'setup_text', 'Missing setup_text.');
    else if (setup.length > LIMITS.setupText) add(slug, 'setup_text', `setup_text is ${setup.length} characters; the limit is ${LIMITS.setupText}.`);

    for (const field of ['required_trait_tags', 'excluded_trait_tags']) {
      const tags = event[field];
      if (tags == null) continue;
      if (!Array.isArray(tags)) {
        add(slug, field, `${field} must be an array of trait names (or left out).`);
        continue;
      }
      for (const tag of tags) {
        const name = text(tag);
        if (!knownParentTraits.includes(name) && !knownChildTraits.includes(name)) {
          add(slug, field, `Unknown trait tag "${tag}". Known traits: ${[...knownParentTraits, ...knownChildTraits].join(', ')}.`);
        }
      }
      if (Array.isArray(event.required_trait_tags) && Array.isArray(event.excluded_trait_tags)) {
        const both = event.required_trait_tags.filter((tag) => event.excluded_trait_tags.includes(tag));
        if (both.length) add(slug, field, `The same trait is both required and excluded: ${both.join(', ')}.`);
      }
    }

    const choices = event.choices;
    if (!Array.isArray(choices)) {
      add(slug, 'choices', 'choices must be an array of 2 to 4 options.');
    } else {
      if (choices.length < LIMITS.choicesMin || choices.length > LIMITS.choicesMax) {
        add(slug, 'choices', `${choices.length} choice(s) given; the card needs ${LIMITS.choicesMin} to ${LIMITS.choicesMax}.`);
      }
      const labels = new Set();
      choices.forEach((choice, choiceIndex) => {
        const at = `choices[${choiceIndex}]`;
        if (!isPlainObject(choice)) {
          add(slug, at, 'Each choice must be an object.');
          return;
        }
        const label = text(choice.label);
        if (!label) add(slug, `${at}.label`, 'Missing label.');
        else if (label.length > LIMITS.label) add(slug, `${at}.label`, `Label is ${label.length} characters; the limit is ${LIMITS.label}.`);
        else if (labels.has(label.toLowerCase())) add(slug, `${at}.label`, `Two choices share the label "${label}".`);
        else labels.add(label.toLowerCase());

        const outcome = text(choice.outcome_text);
        if (!outcome) add(slug, `${at}.outcome_text`, 'Missing outcome_text.');
        else if (outcome.length > LIMITS.outcomeText) add(slug, `${at}.outcome_text`, `outcome_text is ${outcome.length} characters; the limit is ${LIMITS.outcomeText}.`);

        const effects = choice.effects;
        if (effects == null) return;
        if (!isPlainObject(effects)) {
          add(slug, `${at}.effects`, 'effects must be an object (or left out).');
          return;
        }
        if (effects.mood != null && !MOODS.includes(text(effects.mood))) {
          add(slug, `${at}.effects.mood`, `mood must be one of: ${MOODS.join(', ')} (or left out).`);
        }
        if (effects.bond != null) {
          const bond = effects.bond;
          if (!Number.isInteger(bond) || bond < -2 || bond > 2) {
            add(slug, `${at}.effects.bond`, 'effects.bond must be a whole number from -2 to 2.');
          }
        }
        if (effects.traits != null) {
          if (!isPlainObject(effects.traits)) {
            add(slug, `${at}.effects.traits`, 'effects.traits must be an object of trait: weight.');
          } else {
            for (const [trait, weight] of Object.entries(effects.traits)) {
              if (!knownChildTraits.includes(trait)) {
                add(slug, `${at}.effects.traits.${trait}`, `Unknown child trait "${trait}". Known: ${knownChildTraits.join(', ')}.`);
              }
              if (!Number.isInteger(weight) || weight < -2 || weight > 2) {
                add(slug, `${at}.effects.traits.${trait}`, 'A trait weight must be a whole number from -2 to 2.');
              }
            }
          }
        }
      });
    }

    // The hard exclusions, where they can be spotted by word.
    const haystack = [event.title, event.setup_text, ...(Array.isArray(choices) ? choices.flatMap((choice) => [choice?.label, choice?.outcome_text]) : [])]
      .filter(Boolean).join(' ');
    for (const [topic, pattern] of EXCLUDED_TOPICS) {
      if (pattern.test(haystack)) {
        add(slug, 'content', `Mentions ${topic}, which the spec excludes. Rewrite it or leave it out.`);
      }
    }
  });

  // Near-duplicates: two cards that would feel like the same moment.
  const valid = events.filter(isPlainObject);
  for (let i = 0; i < valid.length; i += 1) {
    for (let j = i + 1; j < valid.length; j += 1) {
      const a = valid[i];
      const b = valid[j];
      if (text(a.slug) && text(a.slug) === text(b.slug)) continue;
      const titleScore = similarity(a.title, b.title);
      const setupScore = similarity(a.setup_text, b.setup_text);
      if (titleScore >= 0.8) {
        add(text(a.slug), 'title', `Near-duplicate title of "${text(b.slug)}" (${Math.round(titleScore * 100)}% the same words).`);
      } else if (setupScore >= 0.8) {
        add(text(a.slug), 'setup_text', `Near-duplicate setup_text of "${text(b.slug)}" (${Math.round(setupScore * 100)}% the same words).`);
      }
    }
  }

  return problems;
}

/** Counts by age band and category — the shape the owner reads after every batch. */
export function summarise(events) {
  const byBand = Object.fromEntries(AGE_BANDS.map(([label]) => [label, 0]));
  const byCategory = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  for (const event of events) {
    if (!Number.isInteger(event?.min_age) || !Number.isInteger(event?.max_age)) continue;
    for (let age = event.min_age; age <= event.max_age; age += 1) byBand[ageBand(age)] += 1;
    const category = text(event?.category);
    if (category in byCategory) byCategory[category] += 1;
  }
  return { total: events.length, byBand, byCategory };
}

/**
 * What is actually switched on, and where it is thin. An age band with fewer than
 * `thin` active events will run dry fast, so it is flagged rather than silently played.
 */
export function coverageReport(rows, { thin = 3 } = {}) {
  const active = rows.filter((row) => row.active !== false);
  const bands = AGE_BANDS.map(([label, low, high]) => {
    const inBand = active.filter((row) => row.min_age <= high && row.max_age >= low);
    const categories = Object.fromEntries(CATEGORIES.map((category) => [
      category,
      inBand.filter((row) => row.category === category).length,
    ]));
    const missing = CATEGORIES.filter((category) => categories[category] === 0);
    return {
      band: label,
      count: inBand.length,
      categories,
      missingCategories: missing,
      thin: inBand.length < thin,
    };
  });
  return {
    totalActive: active.length,
    totalRows: rows.length,
    thinSpots: bands.filter((band) => band.thin).map((band) => `${band.band} (${band.count} active)`),
    bands,
  };
}

// ---------------------------------------------------------------------------------
// Database work. Only ever reached from the CLI, never from a test.
// ---------------------------------------------------------------------------------

function requireEnv() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (the service role key) to use this command.');
  }
  return { url: url.replace(/\/$/, ''), key };
}

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const { url, key } = requireEnv();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${payload}`);
  return payload ? JSON.parse(payload) : null;
}

/** Rows exactly as the table wants them, with the defaults the spec promises. */
export function toRows(events, { activate = false, batch = null } = {}) {
  return events.map((event) => ({
    slug: text(event.slug),
    min_age: event.min_age,
    max_age: event.max_age,
    category: text(event.category),
    required_trait_tags: Array.isArray(event.required_trait_tags) ? event.required_trait_tags : [],
    excluded_trait_tags: Array.isArray(event.excluded_trait_tags) ? event.excluded_trait_tags : [],
    title: text(event.title),
    setup_text: text(event.setup_text),
    choices: event.choices,
    tone: event.tone == null ? null : text(event.tone),
    active: activate ? true : false,
    batch: batch ?? (event.batch == null ? null : text(event.batch)),
  }));
}

export async function importEvents(events, { activate = false, dryRun = false, batch = null } = {}) {
  const rows = toRows(events, { activate, batch });
  if (dryRun) return { rows, written: 0 };
  // Upsert on slug: re-running a batch updates those rows and touches nothing else.
  await rest('event_templates?on_conflict=slug', {
    method: 'POST',
    body: rows,
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
  return { rows, written: rows.length };
}

export async function setActive({ batch = null, slugs = [], active }) {
  const filter = batch
    ? `batch=eq.${encodeURIComponent(batch)}`
    : `slug=in.(${slugs.map((slug) => encodeURIComponent(slug)).join(',')})`;
  if (!batch && slugs.length === 0) throw new Error('Pass --batch=<name> or --slugs=one,two.');
  await rest(`event_templates?${filter}`, {
    method: 'PATCH',
    body: { active },
    prefer: 'return=minimal',
  });
  return { batch, slugs, active };
}

export async function fetchRows() {
  return (await rest('event_templates?select=slug,min_age,max_age,category,active,batch,title')) || [];
}

// ---------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0];
const flags = new Map();
const positional = [];
for (const arg of args.slice(1)) {
  if (arg.startsWith('--')) {
    const [key, value] = arg.slice(2).split('=');
    flags.set(key, value ?? true);
  } else {
    positional.push(arg);
  }
}

function printProblems(problems) {
  for (const problem of problems) {
    console.error(`  • ${problem.slug} — ${problem.field}: ${problem.message}`);
  }
}

function printSummary(summary) {
  console.log(`  ${summary.total} event(s), by age band:`);
  console.log(`    ${Object.entries(summary.byBand).map(([band, count]) => `${band}: ${count}`).join('  ')}`);
  console.log(`  by category:`);
  console.log(`    ${Object.entries(summary.byCategory).map(([category, count]) => `${category}: ${count}`).join('  ')}`);
}

async function loadFile(path) {
  if (!path) throw new Error('Pass the events file, e.g. npm run events:validate -- ./batch-03.json');
  const raw = await readFile(path, 'utf8');
  const { events, problems } = parseEventsFile(raw, basename(path));
  return { events, problems: [...problems, ...validateEvents(events)] };
}

async function main() {
  if (!command || ['--help', '-h', 'help'].includes(command)) {
    console.log('validate <file> | import <file> [--activate] [--dry-run] | activate | deactivate | coverage');
    return;
  }

  if (command === 'validate') {
    const { events, problems } = await loadFile(positional[0]);
    if (flags.get('json')) {
      console.log(JSON.stringify({ problems, summary: summarise(events) }, null, 2));
    } else {
      console.log(`Validating ${positional[0]}:`);
      printSummary(summarise(events));
      if (problems.length) {
        console.error(`\n${problems.length} problem(s):`);
        printProblems(problems);
      } else {
        console.log('\nNo problems. Nothing has been written to the database.');
      }
    }
    process.exitCode = problems.length ? 1 : 0;
    return;
  }

  if (command === 'import') {
    const { events, problems } = await loadFile(positional[0]);
    const activate = Boolean(flags.get('activate'));
    const dryRun = Boolean(flags.get('dry-run'));
    printSummary(summarise(events));
    if (problems.length) {
      console.error(`\nRefusing to import: ${problems.length} problem(s). Nothing was written.`);
      printProblems(problems);
      process.exitCode = 1;
      return;
    }
    if (!activate) console.log('\nImporting with active = false. Pass --activate when the batch has been read.');
    if (dryRun) {
      console.log('Dry run: validated only, nothing written.');
      return;
    }
    const { written } = await importEvents(events, { activate, batch: flags.get('batch') || null });
    console.log(`Upserted ${written} event(s) by slug. Re-running this batch is safe.`);
    return;
  }

  if (command === 'activate' || command === 'deactivate') {
    const batch = flags.get('batch') || null;
    const slugs = flags.get('slugs') ? String(flags.get('slugs')).split(',').map((slug) => slug.trim()).filter(Boolean) : [];
    const result = await setActive({ batch, slugs, active: command === 'activate' });
    console.log(`${command === 'activate' ? 'Activated' : 'Deactivated'} ${result.batch ? `batch ${result.batch}` : `${result.slugs.length} slug(s)`}.`);
    return;
  }

  if (command === 'coverage') {
    const rows = await fetchRows();
    const scoped = flags.get('batch') ? rows.filter((row) => row.batch === flags.get('batch')) : rows;
    const report = coverageReport(scoped, { thin: Number(flags.get('thin') || 3) });
    console.log(`${report.totalActive} active of ${report.totalRows} event(s).`);
    for (const band of report.bands) {
      console.log(`  ${band.band.padEnd(6)} ${String(band.count).padStart(3)} active${band.thin ? '  ← thin' : ''}`);
      console.log(`         ${Object.entries(band.categories).map(([category, count]) => `${category}:${count}`).join(' ')}`);
      if (band.missingCategories.length) console.log(`         missing: ${band.missingCategories.join(', ')}`);
    }
    if (report.thinSpots.length) console.log(`\nThin spots: ${report.thinSpots.join(', ')}. Add a batch before families reach them.`);
    return;
  }

  throw new Error(`Unknown command "${command}". Try validate, import, activate, deactivate or coverage.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
