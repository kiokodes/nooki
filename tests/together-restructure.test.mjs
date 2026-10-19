import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

// These feature guarantees belong to PostgreSQL, not just to the UI. The in-memory
// Supabase adapter loads schema.sql (including the new migration) into real PGlite/RLS.
test('Together restructure: visit wishes, checklist, the shared notebook, and memory rules', async () => {
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

    const alice = (await auth.signUpWithEmail('alice@example.com', 'password')).user;
    await auth.saveOnboardingProfile(alice.id, { name: 'Alice', location: null, timezone: 'Africa/Lagos' });
    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, { name: 'Bob', location: null, timezone: 'Africa/Lagos' });
    const { couple } = await auth.createCouple(bob.id, '2020-02-14');
    await auth.signInWithEmail('alice@example.com', 'password');
    await auth.joinCoupleWithCode(alice.id, couple.invite_code);
    const outsider = (await auth.signUpWithEmail('outsider@example.com', 'password')).user;
    await auth.saveOnboardingProfile(outsider.id, { name: 'Outsider', location: null, timezone: 'UTC' });
    await auth.signInWithEmail('alice@example.com', 'password');

    const { data: visit, error: visitError } = await supabase.from('visits').insert({
      couple_id: couple.id, start_date: '2099-05-01', end_date: '2099-05-02',
      location: 'Lagos', timezone: 'Africa/Lagos', is_tentative: false, created_by: alice.id,
    }).select().single();
    assert.equal(visitError, null);

    // A wish is visible to its author only; the second answer reveals both rows at once.
    const firstWish = await supabase.from('visit_wishes').insert({
      couple_id: couple.id, visit_id: visit.id, user_id: alice.id, wish: 'A quiet breakfast together',
    });
    assert.equal(firstWish.error, null);
    await auth.signInWithEmail('bob@example.com', 'password');
    const { data: beforeReveal, error: beforeRevealError } = await supabase.from('visit_wishes').select('*').eq('visit_id', visit.id);
    assert.equal(beforeRevealError, null);
    assert.deepEqual(beforeReveal, [], 'the partner cannot read the first answer');
    const secondWish = await supabase.from('visit_wishes').insert({
      couple_id: couple.id, visit_id: visit.id, user_id: bob.id, wish: 'A long walk by the water',
    });
    assert.equal(secondWish.error, null);
    const { data: afterReveal } = await supabase.from('visit_wishes').select('*').eq('visit_id', visit.id);
    assert.equal(afterReveal.length, 2);
    const { data: revealed } = await supabase.rpc('visit_wishes_are_revealed', { p_visit_id: visit.id });
    assert.equal(revealed, true);

    // Either partner can add/check a checklist item, but its owner must be in the couple.
    await auth.signInWithEmail('alice@example.com', 'password');
    const checklist = await supabase.from('visit_checklist_items').insert({
      couple_id: couple.id, visit_id: visit.id, text: 'Book the train',
      assigned_to: bob.id, created_by: alice.id,
    }).select().single();
    assert.equal(checklist.error, null);
    const wrongOwner = await supabase.from('visit_checklist_items').insert({
      couple_id: couple.id, visit_id: visit.id, text: 'Outsider item',
      assigned_to: outsider.id, created_by: alice.id,
    });
    assert(wrongOwner.error, 'an unpaired account cannot own a checklist item');
    const immutableChecklist = await supabase.from('visit_checklist_items').update({ visit_id: '00000000-0000-4000-8000-000000000001' }).eq('id', checklist.data.id);
    assert(immutableChecklist.error, 'a checklist item cannot be moved to a different visit');
    await auth.signInWithEmail('bob@example.com', 'password');
    const checkOff = await supabase.from('visit_checklist_items').update({ completed: true }).eq('id', checklist.data.id);
    assert.equal(checkOff.error, null);

    // Notebook tasks are always visible to both partners, with no privacy or vote table.
    await auth.signInWithEmail('alice@example.com', 'password');
    const task = await supabase.from('someday_items').insert({
      couple_id: couple.id, text: 'Visit the night market', sort_order: 0, completed: false, created_by: alice.id,
    }).select().single();
    assert.equal(task.error, null);
    const secondTask = await supabase.from('someday_items').insert({
      couple_id: couple.id, text: 'Plan a surprise', sort_order: 1, completed: false, created_by: alice.id,
    }).select().single();
    assert.equal(secondTask.error, null);
    await auth.signInWithEmail('bob@example.com', 'password');
    const { data: visibleTasks } = await supabase.from('someday_items').select('*').eq('couple_id', couple.id);
    assert.deepEqual(new Set(visibleTasks.map((item) => item.id)), new Set([task.data.id, secondTask.data.id]));
    const deleteByPartner = await supabase.from('someday_items').delete().eq('id', task.data.id);
    assert.equal(deleteByPartner.error, null, 'either partner can remove a task directly');
    assert.equal((await supabase.from('someday_items').select('*').eq('id', task.data.id)).data.length, 0);
    await auth.signInWithEmail('alice@example.com', 'password');
    const noVisibility = await backend.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='someday_items' AND column_name='visibility'");
    assert.equal(noVisibility.rows.length, 0, 'private visibility is removed from the notebook schema');
    const noTogetherTime = await backend.query("SELECT to_regclass('public.together_time_sessions') AS table_name");
    assert.equal(noTogetherTime.rows[0].table_name, null, 'Together time is removed from the database');

    const attach = await supabase.from('someday_items').update({ visit_id: visit.id, visit_date: '2099-05-02' }).eq('id', secondTask.data.id);
    assert.equal(attach.error, null);
    const wrongDay = await supabase.from('someday_items').update({ visit_date: '2099-05-03' }).eq('id', secondTask.data.id);
    assert.match(wrongDay.error?.message || '', /Choose a day inside this visit/);

    // A finished visit accepts each partner's own photo path and one line, and reveals
    // both entries to the couple; a current visit cannot be memorialized yet.
    const { data: pastVisit, error: pastVisitError } = await supabase.from('visits').insert({
      couple_id: couple.id, start_date: '2020-05-01', end_date: '2020-05-02',
      location: 'Abuja', timezone: 'Africa/Lagos', created_by: alice.id,
    }).select().single();
    assert.equal(pastVisitError, null);
    const memory = await supabase.from('visit_memory_entries').insert({
      couple_id: couple.id, visit_id: pastVisit.id, user_id: alice.id,
      photo_path: `memories/${couple.id}/${alice.id}/${pastVisit.id}/photo-one.jpg`,
      note: 'We laughed until the café closed.',
    }).select().single();
    assert.equal(memory.error, null);
    const invalidPath = await supabase.from('visit_memory_entries').insert({
      couple_id: couple.id, visit_id: pastVisit.id, user_id: alice.id,
      photo_path: `memories/${couple.id}/${alice.id}/wrong-visit/photo.jpg`, note: 'Not the visit path',
    });
    assert.match(invalidPath.error?.message || '', /Choose a photo/);
    const currentMemory = await supabase.from('visit_memory_entries').insert({
      couple_id: couple.id, visit_id: visit.id, user_id: alice.id,
      photo_path: `memories/${couple.id}/${alice.id}/${visit.id}/photo.jpg`, note: 'Too soon',
    });
    assert.match(currentMemory.error?.message || '', /Save this memory after your visit ends/);
    await auth.signInWithEmail('bob@example.com', 'password');
    const partnerMemory = await supabase.from('visit_memory_entries').insert({
      couple_id: couple.id, visit_id: pastVisit.id, user_id: bob.id,
      photo_path: `memories/${couple.id}/${bob.id}/${pastVisit.id}/photo-two.webp`, note: 'The walk home in the rain.',
    });
    assert.equal(partnerMemory.error, null);
    const { data: timeline } = await supabase.from('visit_memory_entries').select('*').eq('visit_id', pastVisit.id);
    assert.equal(timeline.length, 2);


  } finally {
    await backend?.close();
    await server.close();
  }
});
