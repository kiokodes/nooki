import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

test('Together time is removed from the app and database; no reminder sweep remains', async () => {
  const server = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
    },
  });
  let backend;
  try {
    const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
    backend = await installTestBackend(supabase);
    const { rows } = await backend.query(`
      SELECT to_regclass('public.together_time_sessions') AS sessions,
             to_regprocedure('public.claim_due_together_time_reminders()') AS reminders,
             to_regclass('public.someday_item_votes') AS votes
    `);
    assert.equal(rows[0].sessions, null);
    assert.equal(rows[0].reminders, null);
    assert.equal(rows[0].votes, null);

    const { TogetherView } = await server.ssrLoadModule('/src/components/together/TogetherView.tsx');
    assert.equal(typeof TogetherView, 'function');
    const togetherSource = await server.transformRequest('/src/components/together/TogetherView.tsx');
    assert(!togetherSource.code.includes('Together time'));
    assert(!togetherSource.code.includes('Make private'));
    assert(!togetherSource.code.includes('I want this'));
  } finally {
    await backend?.close();
    await server.close();
  }
});
