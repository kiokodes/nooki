import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

test('everyday check-ins: private current snapshots, validated writes, acknowledgements, expiry and unpair cleanup', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
  } });
  let backend;
  try {
    const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
    backend = await installTestBackend(supabase);
    const auth = await server.ssrLoadModule('/src/lib/authService.ts');
    const service = await server.ssrLoadModule('/src/lib/everydayStatusService.ts');
    async function signup(name) {
      const { user } = await auth.signUpWithEmail(`${name}@example.com`, 'password');
      await auth.saveOnboardingProfile(user.id, { name, location: null, timezone: 'UTC' });
      return user;
    }
    const alice = await signup('alice');
    const { couple } = await auth.createCouple(alice.id, '2020-02-14');
    const bob = await signup('bob');
    await auth.joinCoupleWithCode(bob.id, couple.invite_code);
    await service.saveEverydayStatus('Calm', 'Working', 'Thinking of you', 12);
    let [row] = await service.fetchEverydayStatuses(couple.id);
    assert.equal(row.user_id, bob.id);
    await assert.rejects(() => service.acknowledgeEverydayStatus(row));
    await assert.rejects(() => service.saveEverydayStatus('', '', ' ', 12));
    await assert.rejects(() => service.saveEverydayStatus('Invalid mood', '', '', 12));
    await assert.rejects(() => service.saveEverydayStatus('Calm', '', 'x'.repeat(121), 12));
    await assert.rejects(() => service.saveEverydayStatus('Calm', '', '', 24));
    assert((await supabase.from('everyday_status').update({ note: 'tampered' }).eq('user_id', bob.id)).error);
    await signup('carol');
    assert.deepEqual(await service.fetchEverydayStatuses(couple.id), []);
    await assert.rejects(() => service.acknowledgeEverydayStatus(row));
    await auth.signInWithEmail('alice@example.com', 'password');
    assert.equal((await service.fetchEverydayStatuses(couple.id)).length, 1);
    await service.acknowledgeEverydayStatus(row);
    assert((await service.fetchEverydayStatuses(couple.id))[0].acknowledged_at);
    await service.clearEverydayStatus(); // Clearing my day never clears my partner's.
    assert.equal((await service.fetchEverydayStatuses(couple.id)).length, 1);
    await auth.signInWithEmail('bob@example.com', 'password');
    await service.saveEverydayStatus('', '', 'A fresh note', 1);
    const [fresh] = await service.fetchEverydayStatuses(couple.id);
    assert.equal(fresh.acknowledged_at, null);
    assert.equal(fresh.note, 'A fresh note');
    await auth.signInWithEmail('alice@example.com', 'password');
    await assert.rejects(() => service.acknowledgeEverydayStatus(row));
    await backend.query("UPDATE public.everyday_status SET expires_at=now()-interval '1 second' WHERE user_id=$1", [bob.id]);
    await auth.signInWithEmail('alice@example.com', 'password');
    assert.deepEqual(await service.fetchEverydayStatuses(couple.id), []);
    await assert.rejects(() => service.acknowledgeEverydayStatus(fresh));
    await auth.signInWithEmail('bob@example.com', 'password');
    await service.saveEverydayStatus('Happy', '', '', 4);
    await service.clearEverydayStatus();
    assert.deepEqual(await service.fetchEverydayStatuses(couple.id), []);
    await service.saveEverydayStatus('Happy', '', '', 12);
    await backend.query('DELETE FROM public.couples WHERE id=$1', [couple.id]);
    assert.equal((await backend.query('SELECT * FROM public.everyday_status')).rows.length, 0);
    // Existing projects may safely rerun the migration.
    const { readFile } = await import('node:fs/promises');
    await backend.exec(await readFile(new URL('../supabase/migrations/202610180005_everyday_status.sql', import.meta.url), 'utf8'));
  } finally { await backend?.close(); await server.close(); }
});
