import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

// The waiting taps are counted on the reader's own calendar day, so pin the process
// timezone to make "today" and "yesterday" deterministic.
process.env.TZ = 'UTC';

const DAY_MS = 86_400_000;

/** One row of `miss_you_taps`, as the app reads it. */
const tapRow = (overrides = {}) => ({
  id: 'row',
  couple_id: 'couple',
  sender_id: 'sender',
  tap_date: '2026-10-16',
  tap_count: 1,
  delivered_count: 0,
  delivered_at: null,
  created_at: '2026-10-16T09:00:00.000Z',
  updated_at: '2026-10-16T09:00:00.000Z',
  ...overrides,
});

test('miss you: only the taps still waiting are counted, and the wording follows them', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const {
      batchKey, formatMissYouMessage, pendingBatch, tapDateKey, waitingTaps,
    } = await server.ssrLoadModule('/src/lib/missYou.ts');

    // The tap day is the sender's own calendar day, never a UTC guess.
    assert.equal(tapDateKey(new Date(2026, 9, 16, 23, 59)), '2026-10-16');
    assert.equal(tapDateKey(new Date(2026, 9, 17, 0, 1)), '2026-10-17');

    // What is waiting: taps the partner has not been shown, and only those.
    assert.equal(waitingTaps([]), 0);
    assert.equal(waitingTaps([tapRow({ tap_count: 3, delivered_count: 3 })]), 0, 'received taps are not waiting');
    assert.equal(waitingTaps([
      tapRow({ tap_count: 4, delivered_count: 1 }),
      tapRow({ tap_date: '2026-10-15', tap_count: 2, delivered_count: 0 }),
    ]), 5, 'a long weekend of taps adds up');

    // Nothing waiting is nothing to open.
    assert.equal(pendingBatch([tapRow({ tap_count: 2, delivered_count: 2 })], '2026-10-16'), null);

    // Three taps today, nothing received yet: one batch, and it is all today.
    const today = pendingBatch([tapRow({ tap_count: 3, delivered_count: 0 })], '2026-10-16');
    assert.deepEqual(today, { count: 3, dayTotal: 3, allToday: true, lastDate: '2026-10-16' });
    assert.equal(formatMissYouMessage('Jayo', today), 'Jayo missed you 3 times today');

    // A single tap is a soft hello, with no number in it.
    const once = pendingBatch([tapRow({ tap_count: 1 })], '2026-10-16');
    assert.equal(formatMissYouMessage('Jayo', once), 'Hi, Jayo missed you');

    // Part of today was already opened: the wait is added up, not the day.
    const again = pendingBatch([tapRow({ tap_count: 5, delivered_count: 3 })], '2026-10-16');
    assert.deepEqual(again, { count: 2, dayTotal: 5, allToday: true, lastDate: '2026-10-16' });
    assert.equal(formatMissYouMessage('Jayo', again), 'Jayo missed you 2 more times today');

    // Taps left over from yesterday lose the "today" claim rather than lying about it.
    const acrossDays = pendingBatch([
      tapRow({ tap_date: '2026-10-15', tap_count: 2, delivered_count: 0 }),
      tapRow({ tap_date: '2026-10-16', tap_count: 1, delivered_count: 0 }),
    ], '2026-10-16');
    assert.deepEqual(acrossDays, { count: 3, dayTotal: 3, allToday: false, lastDate: '2026-10-16' });
    assert.equal(formatMissYouMessage('Jayo', acrossDays), 'Jayo missed you 3 times');

    // A nameless account still reads as a sentence.
    assert.equal(formatMissYouMessage('   ', once), 'Hi, Your partner missed you');

    // The same count twice on one day is not the same batch: what is already received
    // separates them, so the heart can greet again after a reset.
    const first = batchKey('sender', { count: 3, dayTotal: 3, allToday: true, lastDate: '2026-10-16' });
    const later = batchKey('sender', { count: 3, dayTotal: 6, allToday: true, lastDate: '2026-10-16' });
    const otherDay = batchKey('sender', { count: 3, dayTotal: 3, allToday: true, lastDate: '2026-10-17' });
    assert.notEqual(first, later, 'a second batch of the same size is a new batch');
    assert.notEqual(first, otherDay, 'and so is the same count on another day');
    assert.equal(first, batchKey('sender', { count: 3, dayTotal: 3, allToday: true, lastDate: '2026-10-16' }));
  } finally {
    await server.close();
  }
});

test('miss you: taps are counted per sender and per day, and receiving is the reset', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
  } });
  let backend;
  try {
    const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
    backend = await installTestBackend(supabase);
    const auth = await server.ssrLoadModule('/src/lib/authService.ts');
    const missYou = await server.ssrLoadModule('/src/lib/missYou.ts');
    const migration = await readFile(new URL('../supabase/migrations/202610150016_miss_you.sql', import.meta.url), 'utf8');

    const ana = (await auth.signUpWithEmail('ana@test.com', 'password')).user;
    await auth.saveOnboardingProfile(ana.id, { name: 'Ana', location: null, timezone: 'Africa/Lagos' });
    const ben = (await auth.signUpWithEmail('ben@test.com', 'password')).user;
    await auth.saveOnboardingProfile(ben.id, { name: 'Ben', location: null, timezone: 'Europe/London' });
    const cara = (await auth.signUpWithEmail('cara@test.com', 'password')).user;
    await auth.saveOnboardingProfile(cara.id, { name: 'Cara', location: null, timezone: 'UTC' });
    await auth.signInWithEmail('ana@test.com', 'password');
    const { couple } = await auth.createCouple(ana.id, '2020-02-14');
    await auth.signInWithEmail('ben@test.com', 'password');
    await auth.joinCoupleWithCode(ben.id, couple.invite_code);

    const today = missYou.tapDateKey();
    const yesterday = missYou.tapDateKey(new Date(Date.now() - DAY_MS));
    const tap = (day = today) => supabase.rpc('record_miss_you_tap', { p_tap_date: day });
    const receive = (senderId) => supabase.rpc('receive_miss_you_taps', { p_sender_id: senderId });

    // --- Ana is alone in the app, so she taps -------------------------------------------
    await auth.signInWithEmail('ana@test.com', 'password');
    assert.equal((await tap()).data, 1, 'the first tap is counted and one is waiting');
    assert.equal((await tap()).data, 2);
    assert.equal((await tap()).data, 3, 'the button is told the truth after every tap');
    const rows = await backend.query('SELECT sender_id, tap_date, tap_count, delivered_count FROM public.miss_you_taps');
    assert.equal(rows.rows.length, 1, 'a day of tapping is one row, not a pile of them');
    assert.equal(rows.rows[0].sender_id, ana.id, 'the row belongs to the account that tapped');
    assert.equal(rows.rows[0].tap_count, 3);
    assert.equal(rows.rows[0].delivered_count, 0, 'nothing has been received yet');
    assert.equal(rows.rows[0].tap_date.toISOString().slice(0, 10), today, 'recorded on the sender\'s own day');

    // The day comes from the phone, so a wrong clock is refused rather than stored.
    const wild = await tap('2020-01-01');
    assert(wild.error, 'a tap from months away is refused');
    assert.match(wild.error.message, /not valid/i);
    const tomorrow = await tap(missYou.tapDateKey(new Date(Date.now() + DAY_MS)));
    assert(!tomorrow.error, 'a phone a day ahead of UTC is still believed');
    await backend.query('DELETE FROM public.miss_you_taps WHERE tap_date <> $1', [today]);
    await auth.signInWithEmail('ana@test.com', 'password');

    // --- Ben opens Nooki, and the taps are handed over once ------------------------------
    await auth.signInWithEmail('ben@test.com', 'password');
    const seen = await supabase.from('miss_you_taps').select('*');
    assert.equal(seen.data.length, 1, 'the partner sees the couple\'s taps');
    assert.equal(seen.data[0].tap_date, today);

    const opened = await receive(ana.id);
    assert.deepEqual(
      opened.data.map((row) => [row.tap_date, row.tap_count, row.newly_delivered]),
      [[today, 3, 3]],
      'the whole day comes back with its total, so the wording can count it',
    );
    assert.deepEqual((await receive(ana.id)).data, [], 'and it is never handed over twice');

    // Receiving is the reset — and only the waiting part of the day is cleared.
    const after = await backend.query('SELECT tap_count, delivered_count, delivered_at FROM public.miss_you_taps');
    assert.equal(after.rows[0].tap_count, 3, 'the day\'s taps are still counted');
    assert.equal(after.rows[0].delivered_count, 3, 'and they have been received');
    assert(after.rows[0].delivered_at, 'with the moment they were received');

    // The next tap after receiving starts again from one.
    await auth.signInWithEmail('ana@test.com', 'password');
    assert.equal((await tap()).data, 1, 'the count resets once the partner has received it');
    await auth.signInWithEmail('ben@test.com', 'password');
    const second = await receive(ana.id);
    assert.deepEqual(
      second.data.map((row) => [row.tap_count, row.newly_delivered]),
      [[4, 1]],
      'the day still knows about four taps, one of them new',
    );

    // --- Taps left over from another day arrive together, without the "today" claim ------
    await auth.signInWithEmail('ana@test.com', 'password');
    await tap(yesterday);
    await tap(yesterday);
    await auth.signInWithEmail('ben@test.com', 'password');
    const waiting = await supabase.from('miss_you_taps').select('*');
    const batch = missYou.pendingBatch(waiting.data, today);
    assert.equal(batch.count, 2, 'only what is waiting is counted');
    assert.equal(batch.allToday, false, 'a batch from yesterday is not "today"');
    assert.equal(batch.lastDate, yesterday);
    assert.equal(missYou.formatMissYouMessage('Ana', batch), 'Ana missed you 2 times');

    // --- Nobody else ----------------------------------------------------------------
    await auth.signInWithEmail('cara@test.com', 'password');
    assert.deepEqual((await supabase.from('miss_you_taps').select('*')).data, [], 'a third account sees no taps');
    const stolen = await receive(ana.id);
    assert(stolen.error, 'and cannot open another couple\'s taps, whoever they name as the sender');
    assert.match(stolen.error.message, /pair with your partner/i);

    // The counts belong to the functions: a phone cannot write the table itself.
    const forged = await supabase.from('miss_you_taps').insert({ couple_id: couple.id, sender_id: cara.id, tap_date: today });
    assert(forged.error, 'a tap cannot be invented directly');
    const erased = await supabase.from('miss_you_taps').update({ delivered_count: 99 }).eq('couple_id', couple.id);
    assert(erased.error, 'and a batch cannot be marked received without being shown');

    // Your own taps are not a message to you.
    await auth.signInWithEmail('ana@test.com', 'password');
    const own = await receive(ana.id);
    assert(own.error, 'you cannot open your own taps');
    assert.match(own.error.message, /not your partner/i);

    // --- Rerunnable, and the preflight names it -----------------------------------------
    await backend.exec(migration);
    assert.equal(
      (await backend.query('SELECT count(*)::int AS n FROM public.miss_you_taps')).rows[0].n,
      2,
      'rerunning the migration keeps the counts',
    );
    const verification = await readFile(new URL('../supabase/verify.sql', import.meta.url), 'utf8');
    await backend.exec('DROP TABLE public.miss_you_taps');
    await assert.rejects(backend.exec(verification), /202610150016_miss_you\.sql/,
      'the preflight sends the owner to the miss-you migration');
    await backend.rollback();
    await backend.exec(migration);
    await backend.exec('DROP FUNCTION public.record_miss_you_tap(date)');
    await assert.rejects(backend.exec(verification), /record_miss_you_tap/,
      'a half-applied miss-you migration is caught too');
    await backend.rollback();
    await backend.exec(migration);
    assert(JSON.stringify(await backend.exec(verification)).includes('PASS'),
      'verify.sql passes once the miss-you migration is applied');

    // --- Ending the couple takes the taps with it ---------------------------------------
    await auth.signInWithEmail('ana@test.com', 'password');
    await auth.requestOrConfirmBreakup();
    await auth.signInWithEmail('ben@test.com', 'password');
    await auth.requestOrConfirmBreakup();
    assert.equal(
      (await backend.query('SELECT count(*)::int AS n FROM public.miss_you_taps')).rows[0].n,
      0,
      'nothing is left behind for a couple that has ended',
    );
  } finally {
    await backend?.close();
    await server.close();
  }
});

test('miss you: the button in the nook, and the heart it becomes on the other phone', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'FormData', 'localStorage']) {
    globalThis[key] = dom.window[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
    },
  });
  const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
  const container = document.getElementById('root');
  let root = createRoot(container);
  let backend;
  try {
    backend = await installTestBackend(supabase);
    const auth = await server.ssrLoadModule('/src/lib/authService.ts');

    // Alice and Bob, paired through the same RPCs the app uses; Bob closed his app.
    const alice = (await auth.signUpWithEmail('alice@example.com', 'password')).user;
    await auth.saveOnboardingProfile(alice.id, { name: 'Alice', location: null, timezone: 'Africa/Lagos' });
    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, { name: 'Bob', location: null, timezone: 'Pacific/Auckland' });
    await auth.signInWithEmail('bob@example.com', 'password');
    const { couple } = await auth.createCouple(bob.id, '2020-02-14');
    await auth.signInWithEmail('alice@example.com', 'password');
    await auth.joinCoupleWithCode(alice.id, couple.invite_code);

    // Realtime presence without a socket, mirroring the real channel API.
    const presence = { state: {}, tracked: [], handlers: [] };
    const fakeChannel = {
      presenceState: () => presence.state,
      on(type, filter, handler) { presence.handlers.push({ event: filter.event, handler }); return fakeChannel; },
      subscribe(callback) {
        callback('SUBSCRIBED');
        for (const entry of presence.handlers.filter((item) => item.event === 'sync')) entry.handler({ event: 'sync' });
        return fakeChannel;
      },
      async track(meta) { presence.tracked.push(meta); return 'ok'; },
      async unsubscribe() { return 'ok'; },
    };
    supabase.channel = () => fakeChannel;
    supabase.removeChannel = async () => 'ok';

    const waitFor = async (predicate, message) => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (predicate()) return;
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      }
      assert.fail(message);
    };
    const emitPresenceSync = async () => {
      await act(async () => {
        for (const entry of presence.handlers.filter((item) => item.event === 'sync')) entry.handler({ event: 'sync' });
      });
    };
    const nook = () => document.querySelector('[data-scene-placeholder]');
    const corner = () => document.querySelector('[data-miss-you="corner"]');
    const button = () => document.querySelector('[data-miss-you-button]');
    const reveal = () => document.querySelector('[data-component="miss-you-reveal"]');
    const sentence = () => document.querySelector('[data-miss-you-message]')?.textContent;
    const boot = async (message) => {
      await act(async () => { root.unmount(); });
      root = createRoot(container);
      await act(async () => { root.render(React.createElement(App)); });
      await waitFor(() => document.body.textContent.includes('Together for'), message);
    };

    const { default: App } = await server.ssrLoadModule('/src/App.tsx');
    await act(async () => { root.render(React.createElement(App)); });
    await waitFor(() => document.body.textContent.includes('Together for'), 'the unlocked app should render');

    // --- Alice is the only one in the app -----------------------------------------------
    assert(button(), 'the nook offers "I miss you" while the partner is away');
    assert(nook().contains(corner()), 'the button is inside the nook, where the companions stand');
    assert(corner().contains(button()));
    assert.equal(corner().style.position, 'absolute', 'laid over the nook rather than stacked in it');
    assert.equal(corner().style.left, '12px', 'pinned to the top-left corner of the nook');
    assert.equal(corner().style.top, '10px');
    assert(button().textContent.includes('I miss you'), 'and it says what it is');
    assert.equal(button().dataset.missYouCount, '0', 'nothing is waiting for Bob yet');
    assert.match(button().getAttribute('aria-label'), /Bob/, 'the accessible label names who the tap is for');
    assert(nook().querySelector('[data-nooki-caption]'), 'the top-right caption is untouched');

    // Three taps: instant on screen, counted in the database.
    for (let i = 0; i < 3; i += 1) await act(async () => { button().click(); });
    await waitFor(() => button().dataset.missYouCount === '3', 'the button counts the taps that are waiting');
    assert.equal(button().querySelector('[data-miss-you-badge]')?.textContent, '3', 'the count is shown, not just kept');
    assert.equal(reveal(), null, 'Alice does not get a heart for her own taps');

    const stored = await backend.query('SELECT sender_id, tap_date, tap_count, delivered_count FROM public.miss_you_taps');
    assert.equal(stored.rows.length, 1, 'the taps are one row in the database');
    assert.equal(stored.rows[0].sender_id, alice.id);
    assert.equal(stored.rows[0].tap_count, 3, 'all three were recorded, not just the last');
    assert.equal(stored.rows[0].delivered_count, 0);
    await auth.signInWithEmail('alice@example.com', 'password');

    // The button belongs to the partner who is alone: it leaves while Bob is online.
    presence.state = { [alice.id]: [{ user_id: alice.id }], [bob.id]: [{ user_id: bob.id }] };
    await emitPresenceSync();
    assert.equal(button(), null, 'no button while the partner is right there');
    presence.state = { [alice.id]: [{ user_id: alice.id }] };
    await emitPresenceSync();
    await waitFor(() => button(), 'the button comes back when they leave again');
    assert.equal(button().dataset.missYouCount, '3', 'and the taps are still waiting');

    // --- Bob opens Nooki: the heart greets him, because Alice missed him -----------------
    await auth.signInWithEmail('bob@example.com', 'password');
    // On Bob's phone Alice is the one who is away, so his own side of the nook has a button.
    presence.state = { [bob.id]: [{ user_id: bob.id }] };
    await boot('Bob\'s app should unlock');
    await waitFor(() => reveal(), 'the taps open over the load as the big heart');
    assert.equal(reveal().dataset.missYouCount, '3');
    assert.equal(reveal().getAttribute('role'), 'status', 'the greeting is announced, not just drawn');
    assert.equal(sentence(), 'Alice missed you 3 times today', 'the sentence counts the taps of the day');
    assert(reveal().querySelector('[data-miss-you-heart]'), 'with a big heart over it');
    assert.equal(reveal().style.zIndex, '45', 'layered over the tab, the navigation and any modal');

    const received = await backend.query('SELECT tap_count, delivered_count, delivered_at FROM public.miss_you_taps');
    assert.equal(received.rows[0].delivered_count, 3, 'showing it is receiving it: the reset has happened');
    assert(received.rows[0].delivered_at);
    assert.equal(received.rows[0].tap_count, 3, 'and the day\'s record is kept');
    await auth.signInWithEmail('bob@example.com', 'password');

    // Any tap closes it early; the timer above takes it away otherwise.
    await act(async () => { reveal().click(); });
    assert.equal(reveal(), null, 'the heart leaves when it is touched');

    // A single tap after that is a soft hello, and only the new one is counted.
    await auth.signInWithEmail('alice@example.com', 'password');
    await supabase.rpc('record_miss_you_tap', { p_tap_date: missYouDayKey() });
    await auth.signInWithEmail('bob@example.com', 'password');
    await boot('Bob\'s app should unlock again');
    await waitFor(() => sentence(), 'the second batch opens too');
    assert.equal(sentence(), 'Hi, Alice missed you', 'one tap is a hello, not a number');

    // Received means received: opening the app again is an ordinary load.
    await auth.signInWithEmail('bob@example.com', 'password');
    await boot('Bob\'s app should unlock a third time');
    assert.equal(reveal(), null, 'taps that have been opened do not greet a second time');
    assert(button(), 'Bob\'s own side of the nook is ready for his taps');
  } finally {
    await act(() => root.unmount());
    await backend?.close();
    await server.close();
    dom.window.close();
  }
});

/** The local day key, the same way the app words it (kept out of the module under test). */
function missYouDayKey(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
