import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const themes = ['random', 'flirty', 'spicy'];
const types = ['truth', 'dare'];

test('Truth or Dare seed has 120 inactive-review prompts in every bucket, balanced across intensity', async () => {
  let total = 0;
  const seen = new Set();
  for (const theme of themes) {
    for (const type of types) {
      const path = new URL(`../supabase/seed/truth-or-dare/${theme}_${type}.json`, import.meta.url);
      const groups = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(groups.length, 5);
      assert.deepEqual(groups.map((group) => group.intensity), [1, 2, 3, 4, 5]);
      for (const group of groups) {
        assert.equal(group.prompts.length, 24, `${theme}/${type} intensity ${group.intensity}`);
        assert.ok(['text', 'voice', 'video_call', 'solo'].includes(group.mode));
        assert.ok(Array.isArray(group.tags) && group.tags.length > 0);
        for (const text of group.prompts) {
          assert.ok(text.trim().length > 0);
          assert.ok(Array.from(text).length < (type === 'truth' ? 200 : 280));
          const key = `${theme}/${type}/${text.toLowerCase()}`;
          assert.equal(seen.has(key), false, `duplicate prompt: ${text}`);
          seen.add(key);
          total += 1;
        }
      }
    }
  }
  assert.equal(total, 720);
  const validation = spawnSync(process.execPath, ['scripts/seed-truth-or-dare.mjs', '--validate-only'], { encoding: 'utf8' });
  assert.equal(validation.status, 0, validation.stderr || validation.stdout);
  assert.match(validation.stdout, /random\/truth 120/);
  assert.match(validation.stdout, /flirty\/dare 120/);
  assert.match(validation.stdout, /spicy\/truth 120/);
});
