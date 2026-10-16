import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

/**
 * What a launch costs before the couple sees their own tab.
 *
 * `fetchCouple` is the last thing between the splash and the app — it hands over the couple
 * and the partner on the other side of it — and the pairing screen calls it every couple of
 * seconds while waiting for a partner to arrive. It used to be three round trips asked for
 * one after another (a session check, the couple, the partner), which a phone on a slow
 * connection pays for in full. This guards the two things that were done about it: the
 * caller's own id is no longer looked up twice, and the two rows are fetched together.
 *
 * A fake transport is enough here — the shape of the traffic is the whole point, and it is
 * what a real Supabase client would see on the wire.
 */

/** A stand-in query builder: chainable, thenable, and it records when it is asked for. */
function fakeQuery(timeline, label, { table, filters }, result) {
  const builder = {
    select: () => builder,
    eq: (column, value) => { filters.eq.push([column, value]); return builder; },
    neq: (column, value) => { filters.neq.push([column, value]); return builder; },
    order: () => builder,
    limit: () => builder,
    maybeSingle: () => builder,
    // Supabase's builder is a thenable: this is the point at which a round trip starts.
    then: (onFulfilled, onRejected) => {
      timeline.push(`start:${table}`);
      return new Promise((resolve) => {
        setTimeout(() => {
          timeline.push(`end:${table}`);
          resolve(result);
        }, 5);
      }).then(onFulfilled, onRejected);
    },
  };
  return builder;
}

test('launch path: the couple and the partner are one trip’s worth of waiting, not three', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
  } });
  try {
    const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
    const { fetchCouple } = await server.ssrLoadModule('/src/lib/authService.ts');

    const coupleRow = { id: 'couple-1', invite_code: 'ABC123', anniversary_date: '2020-01-01' };
    const partnerRow = { id: 'user-b', couple_id: 'couple-1', name: 'Ben' };
    const timeline = [];
    const couple = { filters: { eq: [], neq: [] } };
    const partner = { filters: { eq: [], neq: [] } };
    let authChecks = 0;

    supabase.auth.getSession = async () => { authChecks += 1; return { data: { session: { user: { id: 'user-a' } } }, error: null }; };
    supabase.auth.getUser = async () => { authChecks += 1; return { data: { user: { id: 'user-a' } }, error: null }; };
    supabase.from = (table) => (table === 'couples'
      ? fakeQuery(timeline, 'couples', { table, filters: couple.filters }, { data: coupleRow, error: null })
      : fakeQuery(timeline, 'profiles', { table, filters: partner.filters }, { data: partnerRow, error: null }));

    // --- The caller already knows who it is: no session round trip, both rows at once -----
    const info = await fetchCouple('couple-1', 'user-a');
    assert.deepEqual(info, { couple: coupleRow, partner: partnerRow }, 'the couple and the partner come back together');
    assert.equal(authChecks, 0, 'the id it was handed is used as-is: no second session or auth check');
    assert.deepEqual(timeline, ['start:couples', 'start:profiles', 'end:couples', 'end:profiles'],
      'two trips, both in flight before either lands: the launch waits on one hop, not two');

    // --- The partner row is the *other* account, and the couple is the one asked for ------
    assert.deepEqual(couple.filters.eq, [['id', 'couple-1']], 'the couple row is looked up by id');
    assert.deepEqual(partner.filters.eq, [['couple_id', 'couple-1']], 'the partner is looked up through the couple');
    assert.deepEqual(partner.filters.neq, [['id', 'user-a']], 'and is never the caller themselves');

    // --- Called with one argument (the pairing flow), it still resolves the viewer itself --
    authChecks = 0;
    timeline.length = 0;
    const viaSession = await fetchCouple('couple-1');
    assert.deepEqual(viaSession, { couple: coupleRow, partner: partnerRow }, 'the single-argument call still works');
    assert.equal(authChecks, 2, 'reading the session it was not given: a session read, and the auth check that validates it');
    assert.deepEqual(timeline, ['start:couples', 'start:profiles', 'end:couples', 'end:profiles'],
      'and the rows are still fetched together');

    // --- A couple that is gone is still reported as gone, not as an error ------------------
    supabase.from = () => fakeQuery([], 'couples', { table: 'couples', filters: { eq: [], neq: [] } }, { data: null, error: null });
    assert.equal(await fetchCouple('couple-gone', 'user-a'), null, 'no couple row reads as null, as before');

    // --- A failure keeps its message: the app shows it instead of the auth screen ---------
    supabase.from = () => fakeQuery([], 'couples', { table: 'couples', filters: { eq: [], neq: [] } }, { data: null, error: { message: 'relation "public.couples" does not exist' } });
    await assert.rejects(fetchCouple('couple-1', 'user-a'), /does not exist/, 'the database message survives');

    // --- Nobody to fetch as: the same sentence the old code gave --------------------------
    supabase.auth.getSession = async () => ({ data: { session: null }, error: null });
    supabase.auth.getUser = async () => ({ data: { user: null }, error: null });
    await assert.rejects(fetchCouple('couple-1'), /Please sign in again/, 'an unauthenticated lookup says what to do');

    // --- And the app hands over the id it already has -------------------------------------
    const { readFileSync } = await import('node:fs');
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    assert(app.includes('fetchCouple(userProfile.couple_id, user.id)'), 'the launch path passes the signed-in id');
    assert(app.includes('fetchCouple(couple.id, currentUser.id)'), 'and so does the pairing poll');
  } finally {
    await server.close();
  }
});
