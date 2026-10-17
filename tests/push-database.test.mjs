import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

/**
 * Web push, database side, against a real Postgres.
 *
 * The table is an address book of browsers, and the things that matter about it are the
 * ones that would quietly misroute a notification: a device must belong to exactly one
 * signed-in account, nobody may read or silence a partner's device, `couple_id` must come
 * from the caller's own profile rather than from the phone, and a device that is gone
 * (app deleted, account deleted, couple ended) must leave nothing behind that the sender
 * could keep posting to.
 */
test('push subscriptions: devices belong to one account, move with the profile, and clean up', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
  } });
  let backend;
  try {
    const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
    backend = await installTestBackend(supabase);
    const auth = await server.ssrLoadModule('/src/lib/authService.ts');

    // Two plausible browser endpoints (the real ones are long capability URLs).
    const deviceA = 'https://fcm.googleapis.com/fcm/send/device-a-0000000000001';
    const deviceB = 'https://updates.push.services.mozilla.com/wpush/v2/device-b';
    const deviceAnon = 'https://web.push.apple.com/QG9vay1kZXZpY2UtdW5wYWlyZWQ';

    const a = (await auth.signUpWithEmail('ana@test.com', 'password')).user;
    await auth.saveOnboardingProfile(a.id, { name: 'Ana', location: null, timezone: 'Africa/Lagos' });
    const b = (await auth.signUpWithEmail('ben@test.com', 'password')).user;
    await auth.saveOnboardingProfile(b.id, { name: 'Ben', location: null, timezone: 'Europe/London' });
    const c = (await auth.signUpWithEmail('cara@test.com', 'password')).user;
    await auth.saveOnboardingProfile(c.id, { name: 'Cara', location: null, timezone: 'UTC' });
    const login = (who, password = 'password') => auth.signInWithEmail(who, password);
    const register = (endpoint, p256dh = 'BPKEY-p256dh-aaaa', authKey = 'authkey-bbbb') => supabase.rpc('register_push_subscription', {
      p_endpoint: endpoint, p_p256dh: p256dh, p_auth: authKey,
    });

    // --- Registering a device is an account's own business ---------------------------------
    await login('ana@test.com');
    const registered = await register(deviceA);
    assert.ok(registered.data, `a signed-in account can claim its own browser: ${registered.error?.message}`);
    assert(!registered.error);
    const mine = await supabase.from('push_subscriptions').select('*');
    assert.equal(mine.data.length, 1, 'exactly one device so far');
    assert.equal(mine.data[0].user_id, a.id);
    assert.equal(mine.data[0].couple_id, null, 'an unpaired account has no couple to be notified with');
    assert.equal(mine.data[0].endpoint, deviceA);
    assert.equal(mine.data[0].created_at, mine.data[0].updated_at, 'a fresh row starts consistent');

    // --- A second account cannot see it, silence it, or read the endpoint list -------------
    await login('ben@test.com');
    assert.deepEqual((await supabase.from('push_subscriptions').select('*')).data, [], 'nobody sees another account\'s devices');
    const silenced = await supabase.rpc('release_push_subscription', { p_endpoint: deviceA });
    assert.equal(silenced.data, false, 'and cannot mute the other account\'s phone');
    await login('ana@test.com');
    assert.equal((await supabase.from('push_subscriptions').select('*')).data.length, 1, 'Ana\'s device survived the attempt');

    // --- The address book follows the couple, and the couple comes from the profile --------
    const { couple } = await auth.createCouple(a.id, '2020-01-01');
    await register(deviceA);                                   // same browser, re-subscribing
    assert.equal((await supabase.from('push_subscriptions').select('*')).data.length, 1, 're-subscribing updates one row, it does not add a device');
    assert.equal((await supabase.from('push_subscriptions').select('*')).data[0].couple_id, couple.id, 'the couple is read from the profile at registration time');

    await login('ben@test.com');
    await auth.joinCoupleWithCode(b.id, couple.invite_code);
    await register(deviceB);
    const both = await backend.query(`SELECT user_id, couple_id FROM public.push_subscriptions WHERE user_id = $1`, [b.id]);
    assert.equal(both.rows.length, 1);
    assert.equal(both.rows[0].couple_id, couple.id, 'a joined partner is reachable on the couple they joined');

    // The function is what the sender reads; this is the query it runs for the recipient.
    const recipients = await backend.query(
      `SELECT endpoint FROM public.push_subscriptions WHERE user_id = $1 ORDER BY endpoint`,
      [b.id],
    );
    assert.deepEqual(recipients.rows.map((row) => row.endpoint), [deviceB], 'the sender finds exactly the partner\'s devices');

    // The phone never chooses the couple: the phone is not trusted with it.
    await login('ben@test.com');
    const forced = await supabase.rpc('register_push_subscription', {
      p_endpoint: deviceB, p_p256dh: 'BFORCED', p_auth: 'forced-a', p_couple_id: couple.id,
    });
    assert(forced.error, 'an unknown parameter is refused rather than silently ignored');
    assert.equal(
      (await backend.query('SELECT couple_id FROM public.push_subscriptions WHERE endpoint = $1', [deviceB])).rows[0].couple_id,
      couple.id,
      'and the stored row is untouched',
    );

    // Moving couples moves the row: a device must never keep announcing the old relationship.
    await backend.exec(`UPDATE public.profiles SET couple_id = NULL WHERE id = '${a.id}'`);
    await login('ana@test.com');
    await register(deviceA);
    assert.equal((await supabase.from('push_subscriptions').select('*')).data[0].couple_id, null, 'the couple is re-read on every re-subscribe');

    // --- Bad input is refused with a sentence, and stored nowhere -------------------------
    for (const [endpoint, p256dh, authKey, why] of [
      ['', 'BPKEY', 'authkey', 'an empty endpoint'],
      ['http://insecure.example.com/push', 'BPKEY', 'authkey', 'a non-HTTPS endpoint'],
      [deviceA, '', 'authkey', 'a missing p256dh key'],
      [deviceA, 'BPKEY', '', 'a missing auth key'],
      [deviceA, 'x'.repeat(400), 'authkey', 'an oversized key'],
    ]) {
      const result = await register(endpoint, p256dh, authKey);
      assert(result.error, `${why} is refused`);
      assert.match(result.error.message, /not valid/i);
    }
    assert.equal((await backend.query('SELECT count(*)::int AS n FROM public.push_subscriptions')).rows[0].n, 2, 'nothing invalid was stored');

    // --- Signing out lets every device of that account go, and only that account\'s --------
    await login('ana@test.com');   // back to holding this phone as Ana, with RLS in force
    const released = await supabase.rpc('release_my_push_subscriptions');
    assert.equal(released.data, 1, 'one of Ana\'s devices was let go');
    assert.deepEqual((await supabase.from('push_subscriptions').select('*')).data, [], 'and none is left');
    await login('ben@test.com');
    assert.equal((await supabase.from('push_subscriptions').select('*')).data.length, 1, 'Ben\'s device is untouched');

    // --- An unpaired account is simply unreachable, not an error ---------------------------
    await login('cara@test.com');
    // (Owner-level checks above leave the session as the table owner; signing in again is
    // what puts the app's own role and its row-level security back in the way.)
    const unpaired = await register(deviceAnon);
    assert.ok(unpaired.data, 'an account with no partner can still switch notifications on');
    assert.equal((await supabase.from('push_subscriptions').select('*')).data[0].couple_id, null);

    // --- Deleting the account, and ending the couple, take the address with them -----------
    await login('ben@test.com');
    await backend.exec(`DELETE FROM public.couples WHERE id = '${couple.id}'`);
    await backend.exec(`DELETE FROM public.profiles WHERE id = '${a.id}'`);
    const left = await backend.query('SELECT endpoint FROM public.push_subscriptions ORDER BY endpoint');
    assert.deepEqual(left.rows.map((row) => row.endpoint), [deviceAnon],
      'a device of a deleted account and of an ended couple is gone; only the unpaired account remains');

    // --- Privileges: nothing anonymous, and no direct UPDATE -------------------------------
    const privileges = (await backend.query(`
      SELECT has_table_privilege('anon', 'public.push_subscriptions', 'SELECT') AS anon_select,
             has_table_privilege('anon', 'public.push_subscriptions', 'INSERT') AS anon_insert,
             has_table_privilege('anon', 'public.push_subscriptions', 'DELETE') AS anon_delete,
             has_table_privilege('authenticated', 'public.push_subscriptions', 'SELECT') AS user_select,
             has_function_privilege('anon', 'public.register_push_subscription(text,text,text)', 'EXECUTE') AS anon_register,
             has_function_privilege('authenticated', 'public.register_push_subscription(text,text,text)', 'EXECUTE') AS user_register
    `)).rows[0];
    assert.equal(privileges.anon_select, false, 'anon cannot read the device table');
    assert.equal(privileges.anon_insert, false);
    assert.equal(privileges.anon_delete, false);
    assert.equal(privileges.anon_register, false, 'anon cannot claim a device either');
    assert.equal(privileges.user_select, true);
    assert.equal(privileges.user_register, true);

    // --- Safe to rerun on a live project: a re-applied migration leaves devices alone ------
    const migration = await readFile(new URL('../supabase/migrations/202610150015_web_push.sql', import.meta.url), 'utf8');
    await backend.exec(migration);
    await backend.exec(migration);
    assert.deepEqual(
      (await backend.query('SELECT endpoint FROM public.push_subscriptions ORDER BY endpoint')).rows.map((row) => row.endpoint),
      [deviceAnon],
      'rerunning the migration preserves the address book',
    );
  } finally {
    await backend?.close();
    await server.close();
  }
});

test('verify.sql sends the owner to the web-push migration when the device table is missing', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
  } });
  let backend;
  try {
    const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
    backend = await installTestBackend(supabase);
    const verification = await readFile(new URL('../supabase/verify.sql', import.meta.url), 'utf8');

    // A project that has every other release but has never run the push migration.
    await backend.exec('DROP TABLE public.push_subscriptions');
    await assert.rejects(backend.exec(verification), /202610150015_web_push\.sql/,
      'the preflight names the missing push migration');
    await backend.rollback();

    // The table comes back, but without the RPCs the browser uses to claim a device.
    await backend.exec(await readFile(new URL('../supabase/migrations/202610150015_web_push.sql', import.meta.url), 'utf8'));
    await backend.exec('DROP FUNCTION public.register_push_subscription(text, text, text)');
    await assert.rejects(backend.exec(verification), /register_push_subscription/,
      'a half-applied push migration is caught too');
    await backend.rollback();

    await backend.exec(await readFile(new URL('../supabase/migrations/202610150015_web_push.sql', import.meta.url), 'utf8'));
    const results = await backend.exec(verification);
    assert(JSON.stringify(results).includes('PASS'), 'verify.sql passes once the push migration is applied');
  } finally {
    await backend?.close();
    await server.close();
  }
});
