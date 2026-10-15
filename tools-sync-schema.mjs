import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
execSync('git checkout -- supabase/schema.sql', { cwd: process.argv[2] });
const root = process.argv[2];
const migration = await readFile(`${root}/supabase/migrations/202610150012_tetris_duel.sql`, 'utf8');
const body = migration.slice(migration.indexOf('BEGIN;')).trimEnd();
const header = [
  '-- ============================================================================',
  '-- 15c. The Tetris duel: five minutes each, same pieces, two ways to settle it.',
  '-- Mirrors supabase/migrations/202610150012_tetris_duel.sql for brand-new projects.',
  '-- A run is the piece sequence the database dealt plus the taps the phone reported, and',
  '-- `tetris_replay` walks those through the same rules as src/lib/tetris.ts — so the score',
  '-- is never something a phone can claim. The rules come from',
  '-- github.com/KPaccarizi/_Tetris_Game, and the three places this parts company with that',
  '-- repo are listed in src/lib/tetris.ts. Leaving a live run forfeits the duel.',
  '-- ============================================================================',
  '',
  '',
].join('\n');
let schema = await readFile(`${root}/supabase/schema.sql`, 'utf8');
const anchor = '-- ============================================================================\n-- 16. Shared books ("Read together")';
if (!schema.includes(anchor)) throw new Error('anchor not found');
schema = schema.replace(anchor, () => `${header}${body}\n\n${anchor}`);
await writeFile(`${root}/supabase/schema.sql`, schema);
console.log('schema.sql re-synced');
