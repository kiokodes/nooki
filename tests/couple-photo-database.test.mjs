import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

// The frame's rules live in the database, so this file is about what the database
// refuses — including with the app out of the way.
test('couple photo: one picture per couple, couple-scoped reads and writes, and the immovable row', async () => {
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
    const auth = await server.ssrLoadModule('/src/lib/authService.ts');
    const service = await server.ssrLoadModule('/src/lib/couplePhotoService.ts');

    // --- Alice and Bob share a couple; Carol is a third account ----------------------
    const alice = (await auth.signUpWithEmail('alice@example.com', 'password')).user;
    await auth.saveOnboardingProfile(alice.id, { name: 'Alice', location: null, timezone: 'Africa/Lagos' });
    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, { name: 'Bob', location: null, timezone: 'Pacific/Auckland' });
    const { couple } = await auth.createCouple(bob.id, '2020-02-14');
    await auth.signInWithEmail('alice@example.com', 'password');
    await auth.joinCoupleWithCode(alice.id, couple.invite_code);
    const carol = (await auth.signUpWithEmail('carol@example.com', 'password')).user;
    await auth.saveOnboardingProfile(carol.id, { name: 'Carol', location: null, timezone: 'UTC' });
    // Carol frames her own (pending) couple, so "another couple" exists to try to
    // move a picture into. The RPC derives the caller from the session, so she signs in.
    await auth.signInWithEmail('carol@example.com', 'password');
    const { couple: otherCouple } = await auth.createCouple(carol.id, '2024-01-01');

    // --- Framing the first picture: one row, keyed by the couple ---------------------
    await auth.signInWithEmail('alice@example.com', 'password');
    const framed = await supabase.from('couple_photo').insert({
      couple_id: couple.id,
      file_path: `photos/${couple.id}/first.jpg`,
      uploaded_by: alice.id,
    }).select();
    assert.equal(framed.error, null, 'a couple member frames the first picture');
    assert.equal(framed.data.length, 1);
    assert.equal(framed.data[0].file_path, `photos/${couple.id}/first.jpg`);

    const duplicate = await supabase.from('couple_photo').insert({
      couple_id: couple.id,
      file_path: `photos/${couple.id}/second.jpg`,
      uploaded_by: alice.id,
    }).select();
    assert(duplicate.error, 'a couple frames at most one picture — the couple id is the key');

    // --- Both partners read it; a third account sees nothing -------------------------
    await auth.signInWithEmail('bob@example.com', 'password');
    const bobRead = await supabase.from('couple_photo').select('*').eq('couple_id', couple.id).maybeSingle();
    assert.equal(bobRead.error, null);
    assert.equal(bobRead.data?.file_path, `photos/${couple.id}/first.jpg`, 'the other partner reads the framed picture');

    await auth.signInWithEmail('carol@example.com', 'password');
    const carolRead = await supabase.from('couple_photo').select('*').eq('couple_id', couple.id).maybeSingle();
    assert.equal(carolRead.data, null, 'a third account sees nothing of the picture');

    const carolWrite = await supabase.from('couple_photo').insert({
      couple_id: couple.id,
      file_path: 'photos/intruder.jpg',
      uploaded_by: carol.id,
    }).select();
    assert(carolWrite.error, 'a third account cannot frame a picture into someone else\'s couple');

    // --- Either partner may replace; the row's couple never moves --------------------
    await auth.signInWithEmail('bob@example.com', 'password');
    const replaced = await supabase.from('couple_photo')
      .update({ file_path: `photos/${couple.id}/second.jpg`, uploaded_by: bob.id })
      .eq('couple_id', couple.id)
      .select();
    assert.equal(replaced.error, null, 'either partner may replace the picture');
    assert.equal(replaced.data.length, 1);
    assert.equal(replaced.data[0].uploaded_by, bob.id, 'the replace is stamped with who framed it');

    // Through the app the policy refuses the move; past the app (here, direct SQL as
    // the backend) the trigger still refuses it: the row belongs to one couple.
    await auth.signInWithEmail('alice@example.com', 'password');
    const movedByApp = await supabase.from('couple_photo')
      .update({ couple_id: otherCouple.id })
      .eq('couple_id', couple.id)
      .select();
    assert(movedByApp.error, 'the app cannot move a framed picture to another couple');
    await assert.rejects(
      () => backend.query(
        'UPDATE public.couple_photo SET couple_id = $1 WHERE couple_id = $2',
        [otherCouple.id, couple.id],
      ),
      /one couple/,
      'even with the app out of the way, the row\'s couple never moves',
    );

    // --- The service reads the same row the frame shows -------------------------------
    await auth.signInWithEmail('alice@example.com', 'password');
    const row = await service.fetchCouplePhoto(couple.id);
    assert.equal(row?.file_path, `photos/${couple.id}/second.jpg`, 'the service reads the couple\'s one row');

    // --- Taking the picture down is a couple decision too -----------------------------
    const removed = await supabase.from('couple_photo').delete().eq('couple_id', couple.id).select();
    assert.equal(removed.error, null);
    assert.equal(removed.data.length, 1, 'a couple member takes the picture down');
    const afterRemoval = await service.fetchCouplePhoto(couple.id);
    assert.equal(afterRemoval, null, 'with no row, the frame invites the next picture again');
  } finally {
    await server.close();
  }
});
