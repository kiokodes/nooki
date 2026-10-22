#!/usr/bin/env node
/**
 * Seed the Truth or Dare prompt bank for owner review. Uses the server-only service key
 * and inserts every row as inactive. Existing rows are deliberately left unchanged:
 * an owner can review/activate content, then safely rerun this script later.
 *
 *   SUPABASE_URL=https://<project>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<server-only-key> \
 *   npm run seed:truth-or-dare
 *
 * `npm run seed:truth-or-dare -- --validate-only` checks all source files without
 * connecting to Supabase. Never use the service key in the browser or commit it.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

const themes = ['random', 'flirty', 'spicy'];
const types = ['truth', 'dare'];
const modes = new Set(['text', 'voice', 'video_call', 'solo']);
const sourceDirectory = new URL('../supabase/seed/truth-or-dare/', import.meta.url);
const validateOnly = process.argv.includes('--validate-only');

function stableId(theme, type, text) {
  const digest = createHash('md5').update(text.trim().toLowerCase()).digest('hex').slice(0, 24);
  return `tod_${theme}_${type}_${digest}`;
}

function contentWords(text) {
  const stop = new Set('a an the on in of to and or you your me my we our us what which how is do does would could can if when then one with for it that this as are be at from about while into only both each tell say send write text call private video voice note partner choose want feel feels kind something thing like'.split(' '));
  return new Set((text.toLowerCase().match(/[a-z']+/g) || []).filter((word) => !stop.has(word)));
}

function checkNearDuplicates(rows) {
  // Compare meaningful words, not shared words such as "tell me" or "on a call".
  // The data set is small enough for a simple transparent pairwise check.
  const words = rows.map(({ text }) => contentWords(text));
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      if (rows[i].theme !== rows[j].theme || rows[i].type !== rows[j].type) continue;
      const left = words[i];
      const right = words[j];
      let overlap = 0;
      for (const word of left) if (right.has(word)) overlap += 1;
      const similarity = overlap / Math.max(1, new Set([...left, ...right]).size);
      if (similarity > 0.67) {
        throw new Error(`Near-duplicate prompts (${similarity.toFixed(2)}): “${rows[i].text}” / “${rows[j].text}”`);
      }
    }
  }
}

async function loadPrompts() {
  const all = [];
  for (const theme of themes) {
    for (const type of types) {
      const path = new URL(`${theme}_${type}.json`, sourceDirectory);
      const groups = JSON.parse(await readFile(path, 'utf8'));
      if (!Array.isArray(groups) || groups.length !== 5) {
        throw new Error(`${theme}_${type}.json must contain five intensity groups.`);
      }
      const byIntensity = new Map(groups.map((group) => [group.intensity, group]));
      for (let intensity = 1; intensity <= 5; intensity += 1) {
        const group = byIntensity.get(intensity);
        if (!group || !Array.isArray(group.prompts) || group.prompts.length !== 24) {
          throw new Error(`${theme}/${type} needs 24 prompts at intensity ${intensity}.`);
        }
        if (!modes.has(group.mode) || !Array.isArray(group.tags) || group.tags.length === 0) {
          throw new Error(`${theme}/${type} intensity ${intensity} has invalid tags or mode.`);
        }
        for (const rawText of group.prompts) {
          const text = typeof rawText === 'string' ? rawText.trim() : '';
          const limit = type === 'truth' ? 199 : 279;
          if (!text || Array.from(text).length > limit) {
            throw new Error(`${theme}/${type} prompt must be 1–${limit} characters: ${text}`);
          }
          all.push({
            id: stableId(theme, type, text),
            type,
            theme,
            intensity,
            text,
            tags: [...new Set(group.tags.map((tag) => String(tag).trim()).filter(Boolean))],
            mode: group.mode,
            active: false,
          });
        }
      }
    }
  }

  if (all.length !== 720) throw new Error(`Expected 720 prompts; found ${all.length}.`);
  const ids = new Set(all.map((row) => row.id));
  const texts = new Set(all.map((row) => `${row.theme}/${row.type}/${row.text.toLowerCase()}`));
  if (ids.size !== all.length || texts.size !== all.length) throw new Error('Duplicate Truth or Dare prompt found.');
  for (const theme of themes) {
    for (const type of types) {
      const bucket = all.filter((row) => row.theme === theme && row.type === type);
      if (bucket.length !== 120) throw new Error(`${theme}/${type} has ${bucket.length} prompts, not 120.`);
      for (let intensity = 1; intensity <= 5; intensity += 1) {
        const count = bucket.filter((row) => row.intensity === intensity).length;
        if (count !== 24) throw new Error(`${theme}/${type} intensity ${intensity} has ${count} prompts, not 24.`);
      }
    }
  }
  checkNearDuplicates(all);
  return all;
}

const prompts = await loadPrompts();
const bucketCounts = Object.fromEntries(
  themes.flatMap((theme) => types.map((type) => [`${theme}/${type}`, prompts.filter((row) => row.theme === theme && row.type === type).length])),
);

if (validateOnly) {
  console.log(`Validated ${prompts.length} prompts: ${Object.entries(bucketCounts).map(([bucket, count]) => `${bucket} ${count}`).join(', ')}.`);
  process.exit(0);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-side only) before seeding.');
  process.exit(1);
}

const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
for (let offset = 0; offset < prompts.length; offset += 100) {
  const batch = prompts.slice(offset, offset + 100);
  const { error } = await client.from('tod_prompts').upsert(batch, {
    onConflict: 'id',
    ignoreDuplicates: true,
  });
  if (error) {
    console.error(`Seed failed at prompt ${offset + 1}: ${error.message}`);
    process.exit(1);
  }
}
console.log(`Submitted ${prompts.length} inactive prompts. Existing rows and reviewed active flags were left unchanged.`);
console.log(Object.entries(bucketCounts).map(([bucket, count]) => `  ${bucket}: ${count}`).join('\n'));
