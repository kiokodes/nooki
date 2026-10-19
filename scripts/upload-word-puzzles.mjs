#!/usr/bin/env node
/**
 * Upload the generated Word Wheel puzzle bank to Supabase.
 *
 * This script runs on your machine, never in the browser. It needs a service-role
 * key because the puzzle tables are private and not writable by clients:
 *
 *   SUPABASE_URL=https://YOUR-PROJECT.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   npm run upload:word-puzzles
 *
 * Or copy supabase/seed/word_puzzles.sql into the Supabase SQL Editor. Both paths
 * write the same rows; base_word is the stable key, so rerunning is safe.
 */
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error(
    'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-side only) before uploading.\n'
    + 'You can also run supabase/seed/word_puzzles.sql in the Supabase SQL Editor.',
  );
  process.exit(1);
}

const path = new URL('../supabase/seed/word_puzzles.json', import.meta.url);
const puzzles = JSON.parse(await readFile(path, 'utf8'));
if (!Array.isArray(puzzles) || !puzzles.length) {
  console.error('No puzzles found. Run `npm run build:word-puzzles` first.');
  process.exit(1);
}

const client = createClient(url, key, { auth: { persistSession: false } });
const { data, error } = await client
  .from('word_puzzles')
  .upsert(puzzles, { onConflict: 'base_word' })
  .select('id');
if (error) {
  console.error(`Upload failed: ${error.message}`);
  process.exit(1);
}
console.log(`Uploaded ${data?.length ?? puzzles.length} Word Wheel puzzles.`);
