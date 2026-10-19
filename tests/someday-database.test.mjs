import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

// The someday list's rules live in the database: both partners share an ordered task
// list, and visit links stay couple-scoped. Notes remain legacy storage only.
test('someday list: shared order, legacy notes, visit links, and third-account isolation', async () => {
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
    const someday = await server.ssrLoadModule('/src/lib/somedayService.ts');

    // --- Pure helpers ---------------------------------------------------------------
    assert.equal(someday.cleanSomedayText('  Try that restaurant  '), 'Try that restaurant');
    assert.throws(() => someday.cleanSomedayText('   '), /task title/);
    assert.throws(() => someday.cleanSomedayText('x'.repeat(501)), /500 characters/);

    const make = (id, sort_order, completed = false, visit_id = null) => ({
      id,
      couple_id: 'c1',
      text: id,
      details: null,
      sort_order,
      visit_id,
      completed,
      completed_at: completed ? '2026-01-01T00:00:00Z' : null,
      created_by: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    });
    assert.deepEqual(
      someday.sortSomedayItems([make('b', 2), make('a', 0), make('c', 1)]).map((item) => item.id),
      ['a', 'c', 'b'],
      'the stored order wins',
    );
    assert.equal(someday.nextSomedaySortOrder([make('a', 0), make('b', -2)]), 1, 'new tasks append after the current order');
    assert.equal(someday.nextSomedaySortOrder([]), 0);
    assert.deepEqual(
      someday.moveSomedayItem([make('a', 0), make('b', 1), make('c', 2)], 'a', 2).map((item) => item.id),
      ['b', 'c', 'a'],
    );
    assert.deepEqual(
      someday.moveSomedayItem([make('a', 0), make('b', 1), make('c', 2)], 'c', 0).map((item) => item.id),
      ['c', 'a', 'b'],
    );
    assert.deepEqual(
      someday.somedayItemsForVisit([
        make('a', 0, false, 'v1'),
        make('b', 1, false, 'v2'),
        make('c', 2, false, 'v1'),
      ], 'v1').map((item) => item.id),
      ['a', 'c'],
    );

    // --- Alice and Bob share a list; Carol is a third account ------------------------
    const alice = (await auth.signUpWithEmail('alice@example.com', 'password')).user;
    await auth.saveOnboardingProfile(alice.id, { name: 'Alice', location: null, timezone: 'Africa/Lagos' });
    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, { name: 'Bob', location: null, timezone: 'Pacific/Auckland' });
    const { couple } = await auth.createCouple(bob.id, '2020-02-14');
    await auth.signInWithEmail('alice@example.com', 'password');
    await auth.joinCoupleWithCode(alice.id, couple.invite_code);
    const carol = (await auth.signUpWithEmail('carol@example.com', 'password')).user;
    await auth.saveOnboardingProfile(carol.id, { name: 'Carol', location: null, timezone: 'UTC' });

    await auth.signInWithEmail('alice@example.com', 'password');
    const { data: visit, error: visitError } = await supabase
      .from('visits')
      .insert({
        couple_id: couple.id,
        start_date: '2026-12-24',
        end_date: '2026-12-28',
        location: 'Lagos',
        timezone: 'Africa/Lagos',
        is_tentative: false,
        created_by: alice.id,
      })
      .select()
      .single();
    assert.equal(visitError, null);
    assert.ok(visit?.id);

    const add = async (text, sort_order, details = null) => {
      const { data, error } = await supabase
        .from('someday_items')
        .insert({
          couple_id: couple.id,
          text,
          details,
          sort_order,
          completed: false,
          created_by: alice.id,
        })
        .select()
        .single();
      assert.equal(error, null);
      return data;
    };

    const restaurant = await add('Try that restaurant', -2);
    const beach = await add('Sunset at the beach', -1, 'Pack the camera and a blanket.');
    const market = await add('Walk the Sunday market', 0);

    // The visible list follows sort_order, with the notes kept exactly as written.
    let { data: listed } = await supabase
      .from('someday_items')
      .select('*')
      .eq('couple_id', couple.id)
      .order('sort_order', { ascending: true });
    assert.deepEqual(listed.map((item) => item.text), [
      'Try that restaurant',
      'Sunset at the beach',
      'Walk the Sunday market',
    ]);
    assert.equal(listed[1].details, 'Pack the camera and a blanket.');
    assert.equal(listed[0].details, null);

    // --- Notes have a hard 1,000-character ceiling ----------------------------------
    await assert.rejects(
      (async () => {
        const { error } = await supabase.from('someday_items').insert({
          couple_id: couple.id,
          text: 'Too much',
          details: 'x'.repeat(1001),
          sort_order: 1,
          completed: false,
          created_by: alice.id,
        });
        if (error) throw new Error(error.message);
      })(),
      /check constraint|someday_details_length_check/i,
    );

    // --- Drag order is written in one call ------------------------------------------
    const { error: reorderError } = await supabase.rpc('reorder_someday_items', {
      p_ids: [market.id, restaurant.id, beach.id],
    });
    assert.equal(reorderError, null);
    ({ data: listed } = await supabase
      .from('someday_items')
      .select('*')
      .eq('couple_id', couple.id)
      .order('sort_order', { ascending: true }));
    assert.deepEqual(listed.map((item) => item.text), [
      'Walk the Sunday market',
      'Try that restaurant',
      'Sunset at the beach',
    ]);
    assert.deepEqual(listed.map((item) => item.sort_order), [0, 1, 2]);

    {
      const { error } = await supabase.rpc('reorder_someday_items', {
        p_ids: [market.id, market.id],
      });
      assert.match(error?.message || '', /only appear once/);
    }

    // --- "Add to our next visit" ----------------------------------------------------
    const { error: pinError } = await supabase
      .from('someday_items')
      .update({ visit_id: visit.id, updated_at: new Date().toISOString() })
      .eq('id', beach.id);
    assert.equal(pinError, null);
    const { data: pinned } = await supabase
      .from('someday_items')
      .select('*')
      .eq('id', beach.id)
      .single();
    assert.equal(pinned.visit_id, visit.id);

    // A visit from another couple can never be linked, even straight into the table.
    const { rows: otherCouples } = await backend.query(
      "INSERT INTO public.couples (invite_code) VALUES ('ZZZZZZ') RETURNING id",
    );
    const { rows: otherVisits } = await backend.query(
      "INSERT INTO public.visits (couple_id, start_date, timezone) VALUES ($1, '2027-01-01', 'UTC') RETURNING id",
      [otherCouples[0].id],
    );
    await assert.rejects(
      backend.query('UPDATE public.someday_items SET visit_id = $1 WHERE id = $2', [
        otherVisits[0].id,
        beach.id,
      ]),
      /not part of your plans/,
    );

    await auth.signInWithEmail('alice@example.com', 'password');
    await supabase.from('visits').insert({
      couple_id: couple.id,
      start_date: '2027-02-01',
      end_date: null,
      location: null,
      timezone: 'UTC',
      is_tentative: true,
      created_by: alice.id,
    });

    // Deleting the visit keeps the idea and puts it back on the someday list.
    const { error: deleteVisitError } = await supabase.from('visits').delete().eq('id', visit.id);
    assert.equal(deleteVisitError, null);
    const { data: unpinned } = await supabase
      .from('someday_items')
      .select('*')
      .eq('id', beach.id)
      .single();
    assert.equal(unpinned.visit_id, null);

    // --- Carol can see nothing and cannot reorder this list -------------------------
    await auth.signInWithEmail('carol@example.com', 'password');
    const { data: carolRows } = await supabase
      .from('someday_items')
      .select('*')
      .eq('couple_id', couple.id);
    assert.deepEqual(carolRows, []);
    {
      const { error } = await supabase.rpc('reorder_someday_items', {
        p_ids: [market.id, restaurant.id, beach.id],
      });
      assert.match(error?.message || '', /Pair with your partner first|not yours/);
    }

    // The RPC is not callable by anonymous users either.
    await backend.resetRole();
    const { rows: grants } = await backend.query(
      `SELECT has_function_privilege('anon', 'public.reorder_someday_items(uuid[])', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.reorder_someday_items(uuid[])', 'EXECUTE') AS member`,
    );
    assert.equal(grants[0].anon, false);
    assert.equal(grants[0].member, true);

    // Finally, both partners see the reordered list; the second visit remains.
    await auth.signInWithEmail('bob@example.com', 'password');
    const { data: bobRows } = await supabase
      .from('someday_items')
      .select('*')
      .eq('couple_id', couple.id)
      .order('sort_order', { ascending: true });
    assert.deepEqual(bobRows.map((item) => item.text), [
      'Walk the Sunday market',
      'Try that restaurant',
      'Sunset at the beach',
    ]);

    // --- The cleanup migration is rerunnable; it leaves the list public to both partners.
    const migration = await readFile(
      new URL('../supabase/migrations/202610190007_someday_notebook_and_remove_together_time.sql', import.meta.url),
      'utf8',
    );
    await backend.exec(migration);
    const { rows: afterRerun } = await backend.query(
      'SELECT details, sort_order, visit_id FROM public.someday_items WHERE id = $1',
      [beach.id],
    );
    assert.equal(afterRerun[0].sort_order, 2, 'rerunning the migration keeps the saved order');
    assert.equal(afterRerun[0].details, 'Pack the camera and a blanket.');
    const verification = await readFile(new URL('../supabase/verify.sql', import.meta.url), 'utf8');
    assert(JSON.stringify(await backend.exec(verification)).includes('PASS'),
      'verify.sql passes with visits and the someday list installed');
  } finally {
    await backend?.close();
    await server.close();
  }
});
