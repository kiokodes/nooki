import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import {
  coverageReport,
  parseEventsFile,
  summarise,
  toRows,
  validateEvents,
} from '../scripts/raise-a-child-events.mjs';

const run = promisify(execFile);
const fixturePath = new URL('./fixtures/raise-a-child-events.json', import.meta.url).pathname;
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));

const good = () => JSON.parse(JSON.stringify(fixture[0]));
const errorsFor = (events) => validateEvents(events).map((problem) => `${problem.field}: ${problem.message}`);

test('the shipped fixture validates cleanly', () => {
  const { events, problems } = parseEventsFile(fixture, 'fixture');
  assert.deepEqual(problems, []);
  assert.equal(events.length, 8);
  assert.deepEqual(validateEvents(events), []);
});

test('a file of the wrong shape is refused before anything else happens', () => {
  const { problems } = parseEventsFile('{ "nope": true }', 'batch.json');
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /JSON array of events/);
  assert.match(parseEventsFile('not json')[0]?.message ?? parseEventsFile('not json').problems[0].message, /Not valid JSON/);
});

test('every required field is named in the problems, with the slug', () => {
  const event = good();
  delete event.title;
  delete event.choices;
  const problems = validateEvents([event]);
  assert.ok(problems.some((problem) => problem.slug === 'test-broken-vase' && problem.field === 'title'));
  assert.ok(problems.some((problem) => problem.slug === 'test-broken-vase' && problem.field === 'choices'));
});

test('age bands must be whole years inside 0–17 and in the right order', () => {
  const negative = { ...good(), slug: 'negative-age', min_age: -1 };
  const tooOld = { ...good(), slug: 'too-old', max_age: 18 };
  const backwards = { ...good(), slug: 'backwards', min_age: 9, max_age: 5 };
  const fractional = { ...good(), slug: 'fractional', min_age: 3.5 };
  const problems = errorsFor([negative, tooOld, backwards, fractional]);
  assert.ok(problems.some((line) => line.startsWith('min_age') && line.includes('whole number')));
  assert.ok(problems.some((line) => line.startsWith('max_age') && line.includes('whole number')));
  assert.ok(problems.some((line) => line.includes('must not be greater')));
});

test('category and tone are closed lists', () => {
  const problems = errorsFor([{ ...good(), category: 'holidays', tone: 'silly' }]);
  assert.ok(problems.some((line) => line.startsWith('category')));
  assert.ok(problems.some((line) => line.startsWith('tone')));
});

test('choice count, labels and outcome text are checked', () => {
  const oneChoice = { ...good(), slug: 'one-choice', choices: [good().choices[0]] };
  const fiveChoices = { ...good(), slug: 'five-choices', choices: Array.from({ length: 5 }, (_, i) => ({ ...good().choices[0], label: `Option ${i}` })) };
  const duplicateLabel = { ...good(), slug: 'dupe-label', choices: [good().choices[0], { ...good().choices[1], label: good().choices[0].label }] };
  const longOutcome = {
    ...good(),
    slug: 'long-outcome',
    choices: [{ ...good().choices[0], outcome_text: 'x'.repeat(261) }],
  };
  const problems = errorsFor([oneChoice, fiveChoices, duplicateLabel, longOutcome]);
  assert.ok(problems.some((line) => line.includes('1 choice(s) given')));
  assert.ok(problems.some((line) => line.includes('5 choice(s) given')));
  assert.ok(problems.some((line) => line.includes('share the label')));
  assert.ok(problems.some((line) => line.includes('the limit is 260')));
});

test('setup_text and titles have character limits', () => {
  const problems = errorsFor([{ ...good(), title: 't'.repeat(81), setup_text: 's'.repeat(221) }]);
  assert.ok(problems.some((line) => line.startsWith('title') && line.includes('the limit is 80')));
  assert.ok(problems.some((line) => line.startsWith('setup_text') && line.includes('the limit is 220')));
});

test('effect keys and ranges are checked against the child trait list', () => {
  const unknownTrait = { ...good(), slug: 'unknown-trait', choices: [{ ...good().choices[0], effects: { traits: { sporty: 1 } } }] };
  const badWeight = { ...good(), slug: 'bad-weight', choices: [{ ...good().choices[0], effects: { traits: { kind: 3 } } }] };
  const badBond = { ...good(), slug: 'bad-bond', choices: [{ ...good().choices[0], effects: { bond: 5 } }] };
  const badMood = { ...good(), slug: 'bad-mood', choices: [{ ...good().choices[0], effects: { mood: 'smug' } }] };
  const problems = errorsFor([unknownTrait, badWeight, badBond, badMood]);
  assert.ok(problems.some((line) => line.includes('Unknown child trait "sporty"')));
  assert.ok(problems.some((line) => line.includes('trait weight must be a whole number from -2 to 2')));
  assert.ok(problems.some((line) => line.includes('effects.bond must be a whole number')));
  assert.ok(problems.some((line) => line.includes('effects.mood')));
});

test('trait tags must be known, and cannot be both required and excluded', () => {
  const unknown = { ...good(), slug: 'unknown-tag', required_trait_tags: ['loud'] };
  const contradictory = { ...good(), slug: 'contradiction', required_trait_tags: ['calm'], excluded_trait_tags: ['calm'] };
  const problems = errorsFor([unknown, contradictory]);
  assert.ok(problems.some((line) => line.includes('Unknown trait tag "loud"')));
  assert.ok(problems.some((line) => line.includes('both required and excluded')));
});

test('duplicate slugs and near-duplicate cards are caught', () => {
  const first = { ...good(), slug: 'same-slug' };
  const second = { ...good(), slug: 'same-slug', title: 'A different title entirely' };
  const titles = errorsFor([first, second]);
  assert.ok(titles.some((line) => line.includes('Duplicate slug')));

  const twin = { ...good(), slug: 'twin-a', title: 'The sandcastle' };
  const twinAgain = { ...good(), slug: 'twin-b', title: 'The sandcastle' };
  const near = validateEvents([twin, twinAgain]);
  assert.ok(near.some((problem) => problem.field === 'title' && /Near-duplicate title/.test(problem.message)));
});

test('the content exclusions are screened in words', () => {
  const cases = [
    ['the funeral', 'death'],
    ['the hospital visit', 'serious injury'],
    ['the bruise nobody explained', 'abuse or neglect'],
    ['she was bullied for a term', 'bullying left unresolved'],
    ['a drunken afternoon', 'substances'],
  ];
  for (const [line, topic] of cases) {
    const problems = validateEvents([{ ...good(), slug: 'screened', setup_text: `Mia comes home and there is ${line}.` }]);
    assert.ok(problems.some((problem) => problem.field === 'content' && problem.message.includes(topic)), `expected ${topic} to be flagged`);
  }
});

test('the batch summary counts every year in each band', () => {
  const summary = summarise(fixture);
  assert.equal(summary.total, fixture.length);
  // 3–6 counts once per age, so the 4–6 band holds more events than the file has.
  assert.ok(summary.byBand['4-6'] >= 3);
  assert.equal(summary.byCategory.health, 0);
  assert.equal(summary.byCategory.home, 2);
});

test('coverage names the thin bands and the missing categories', () => {
  const rows = [
    { slug: 'a', min_age: 3, max_age: 6, category: 'home', active: true },
    { slug: 'b', min_age: 16, max_age: 17, category: 'values', active: true },
    { slug: 'c', min_age: 3, max_age: 6, category: 'school', active: false },
  ];
  const report = coverageReport(rows, { thin: 2 });
  const young = report.bands.find((band) => band.band === '0-3');
  assert.equal(young.count, 1);
  assert.ok(young.thin);
  assert.ok(young.missingCategories.includes('health'));
  assert.deepEqual(report.thinSpots.length, report.bands.filter((band) => band.thin).length);
  assert.equal(report.totalActive, 2);
});

test('rows are written inactive unless activation is asked for, and carry batch', () => {
  const inactive = toRows([fixture[0]], { batch: 'batch-09' });
  assert.equal(inactive[0].active, false);
  assert.equal(inactive[0].batch, 'batch-09');
  assert.deepEqual(inactive[0].required_trait_tags, ['calm']);

  const active = toRows([fixture[0]], { activate: true });
  assert.equal(active[0].active, true);
  assert.equal(active[0].batch, 'test-batch');

  const missingTags = toRows([{ ...good(), required_trait_tags: undefined }]);
  assert.deepEqual(missingTags[0].required_trait_tags, []);
});

test('the CLI validates a file and reports problems without writing anything', async () => {
  const ok = await run('node', ['scripts/raise-a-child-events.mjs', 'validate', fixturePath]);
  assert.match(ok.stdout, /8 event\(s\)/);
  assert.match(ok.stdout, /No problems/);

  const broken = { ...good(), category: 'nonsense' };
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'nooki-events-'));
  const path = join(dir, 'broken.json');
  await writeFile(path, JSON.stringify([broken]));
  await assert.rejects(run('node', ['scripts/raise-a-child-events.mjs', 'validate', path]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /category must be one of/);
    return true;
  });

  await assert.rejects(run('node', ['scripts/raise-a-child-events.mjs', 'import', path]), (error) => {
    assert.match(error.stderr, /Refusing to import/);
    return true;
  });
});

test('the CLI refuses database work without credentials', async () => {
  const env = { ...process.env };
  delete env.SUPABASE_URL;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  await assert.rejects(
    run('node', ['scripts/raise-a-child-events.mjs', 'coverage'], { env }),
    (error) => {
      assert.match(error.stderr, /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/);
      return true;
    },
  );
});

test('every example in the content spec passes the same rules a real batch must', async () => {
  const doc = await readFile(new URL('../docs/EVENT_CONTENT_SPEC.md', import.meta.url), 'utf8');
  const blocks = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)]
    .map((match) => match[1])
    .filter((block) => block.includes('"slug"'));
  assert.ok(blocks.length >= 6, 'the spec carries a shape and five labelled examples');
  const events = blocks.flatMap((block) => {
    const parsed = JSON.parse(block);
    return Array.isArray(parsed) ? parsed : [parsed];
  });
  assert.deepEqual(validateEvents(events), []);
  assert.equal(summarise(events).byCategory.values > 0, true);
});
