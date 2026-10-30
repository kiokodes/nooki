import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { validateEvents, toRows } from '../scripts/raise-a-child-events.mjs';

const migration = await readFile(new URL('../supabase/migrations/202610300005_raise_child_decision_memory.sql', import.meta.url), 'utf8');

async function database() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE public.family_moments (family_id uuid, event_slug text, status text, chosen_choice smallint, category text);
    CREATE TABLE public.event_templates (
      slug text primary key, min_age smallint, max_age smallint, category text, active boolean,
      required_trait_tags text[] default '{}', excluded_trait_tags text[] default '{}', choices jsonb
    );
  `);
  await db.exec(migration);
  await db.exec(`
    INSERT INTO event_templates(slug,min_age,max_age,category,active,required_trait_tags,choices,required_decisions) VALUES
    ('past',0,2,'home',false,'{}','[{"label":"One"},{"label":"Two"}]','[]'),
    ('follow',4,6,'home',true,ARRAY['patient'],'[{"label":"A"},{"label":"B"}]','[{"event_slug":"past","choice":1}]');
  `);
  return db;
}
const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
async function pick(db, family, age, wide = false, traits = false) {
  return (await db.query('SELECT public.raise_child_pick_event($1,$2::smallint,$3::text[],$4,$5) AS slug', [family, age, [], wide, traits])).rows[0].slug;
}

test('follow-ups require the actual resolved choice in the same family even in every fallback', async () => {
  const db = await database();
  try {
    assert.equal(await pick(db, a, 4, true), null);
    await db.query("INSERT INTO family_moments VALUES ($1,'past','open',1,'home')", [a]);
    assert.equal(await pick(db, a, 4, true), null);
    await db.query("UPDATE family_moments SET status='resolved', chosen_choice=2 WHERE family_id=$1", [a]);
    assert.equal(await pick(db, a, 4, true), null);
    await db.query('UPDATE family_moments SET chosen_choice=1 WHERE family_id=$1', [a]);
    assert.equal(await pick(db, b, 4, true), null, 'another family cannot inherit this memory');
    assert.equal(await pick(db, a, 3, true), null, 'memory cards never widen their age range');
    assert.equal(await pick(db, a, 4, false, true), null, 'trait match is applied');
    assert.equal(await pick(db, a, 4, false, false), 'follow', 'decision survives trait fallback');
    await db.exec(`INSERT INTO event_templates(slug,min_age,max_age,category,active,choices) VALUES ('general',4,6,'school',true,'[{"label":"A"},{"label":"B"}]')`);
    assert.equal(await pick(db, a, 3, true, false), null, 'general cards also stay inside their actual age range');
    await db.exec("UPDATE event_templates SET active=false WHERE slug='general'");
    await db.query("INSERT INTO family_moments VALUES ($1,'follow','resolved',1,'home')", [a]);
    assert.equal(await pick(db, a, 4, true), null, 'a family never repeats a moment');
  } finally { await db.close(); }
});

test('published choice order and labels cannot silently change a memory', async () => {
  const db = await database();
  try {
    await assert.rejects(db.exec(`UPDATE event_templates SET choices='[{"label":"Two"},{"label":"One"}]' WHERE slug='past'`), /Cannot change choice/);
    await db.exec(`UPDATE event_templates SET choices='[{"label":"One","outcome_text":"Edited"},{"label":"Two"}]' WHERE slug='past'`);
  } finally { await db.close(); }
});

test('content validator and importer preserve strict prerequisites', () => {
  const event = { slug:'test-follow', min_age:4, max_age:6, category:'home', title:'A card', setup_text:'A scene.', choices:[{label:'One',outcome_text:'One.'},{label:'Two',outcome_text:'Two.'}], required_decisions:[{event_slug:'test-past',choice:1}] };
  assert.deepEqual(validateEvents([event]), []);
  assert.deepEqual(toRows([event])[0].required_decisions, event.required_decisions);
  assert.ok(validateEvents([{...event, required_decisions:[{event_slug:'test-past',choice:0}]}]).some(x => x.field === 'required_decisions'));
  assert.ok(validateEvents([{...event, required_decisions:[{event_slug:'test-follow',choice:1}]}]).some(x => x.field === 'required_decisions'));
  assert.ok(validateEvents([{...event, required_decisions:[{event_slug:'test-past',choice:1},{event_slug:'test-past',choice:2}]}]).some(x => x.field === 'required_decisions'));
});

test('published content references real earlier choices', async () => {
  const dir = new URL('../supabase/seed/raise-a-child/', import.meta.url);
  const files = (await readdir(dir)).filter(name => name.endsWith('.json'));
  const events = (await Promise.all(files.map(async name => JSON.parse(await readFile(new URL(name, dir), 'utf8'))))).flat();
  const bySlug = new Map(events.map(event => [event.slug, event]));
  assert.deepEqual(validateEvents(events), []);
  for (const event of events) for (const requirement of event.required_decisions ?? []) {
    const source = bySlug.get(requirement.event_slug);
    assert.ok(source, `${event.slug} requires a missing event`);
    assert.ok(requirement.choice <= source.choices.length, `${event.slug} requires a missing choice`);
    assert.ok(source.min_age < event.min_age, `${event.slug} must follow an earlier-age event`);
  }
});

test('older scene database limit permits detail without widening young scenes', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE public.event_templates (min_age smallint, setup_text text NOT NULL CONSTRAINT event_templates_setup_text_check CHECK (char_length(btrim(setup_text)) BETWEEN 1 AND 220));`);
    await db.exec(await readFile(new URL('../supabase/migrations/202610300006_raise_child_older_scenes.sql', import.meta.url), 'utf8'));
    await db.query('INSERT INTO public.event_templates VALUES ($1,$2)', [10, 'x'.repeat(480)]);
    await assert.rejects(db.query('INSERT INTO public.event_templates VALUES ($1,$2)', [10, 'x'.repeat(481)]));
    await assert.rejects(db.query('INSERT INTO public.event_templates VALUES ($1,$2)', [9, 'x'.repeat(221)]));
  } finally { await db.close(); }
});
