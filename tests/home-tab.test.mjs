import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

// The everyday counter is measured on the reader's own calendar day, so pin the process
// timezone to make "day offset" assertions deterministic.
process.env.TZ = 'UTC';

const HOUR_MS = 3_600_000;

test('couple time helpers: YMD duration, partner clock and last-seen labels', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const {
      getTogetherDuration, formatTogetherDuration, getPartnerClock, formatDayOffset,
      formatLastSeen, getInitial,
    } = await server.ssrLoadModule('/src/lib/coupleTime.ts');

    assert.equal(new Date('2026-10-15T03:42:00Z').getHours(), 3, 'test process must run in UTC');

    // Whole calendar years, months and days from the anniversary date.
    assert.deepEqual(getTogetherDuration('2020-02-14', new Date(2026, 9, 15)),
      { years: 6, months: 8, days: 1, isFuture: false });
    assert.deepEqual(getTogetherDuration('2024-10-15', new Date(2026, 9, 15)),
      { years: 2, months: 0, days: 0, isFuture: false });
    // Borrowing from a shorter month must never produce a negative day count.
    assert.deepEqual(getTogetherDuration('2020-01-31', new Date(2020, 2, 1)),
      { years: 0, months: 1, days: 1, isFuture: false });
    assert.deepEqual(getTogetherDuration('2024-02-29', new Date(2025, 2, 1)),
      { years: 1, months: 0, days: 1, isFuture: false });
    // A future anniversary counts down rather than going negative.
    assert.deepEqual(getTogetherDuration('2026-11-05', new Date(2026, 9, 15)),
      { years: 0, months: 0, days: 21, isFuture: true });
    // Missing or impossible dates degrade to zeroes instead of throwing.
    const empty = { years: 0, months: 0, days: 0, isFuture: false };
    assert.deepEqual(getTogetherDuration(null, new Date(2026, 9, 15)), empty);
    assert.deepEqual(getTogetherDuration('not-a-date', new Date(2026, 9, 15)), empty);
    assert.deepEqual(getTogetherDuration('2026-02-30', new Date(2026, 9, 15)), empty);

    assert.equal(formatTogetherDuration({ years: 2, months: 1, days: 4, isFuture: false }), '2Y 1M 4D');
    assert.equal(formatTogetherDuration(getTogetherDuration('2020-02-14', new Date(2026, 9, 15))), '6Y 8M 1D');

    // The clock belongs to the partner's timezone, never the reader's.
    assert.deepEqual(getPartnerClock('America/New_York', new Date(Date.UTC(2026, 9, 15, 3, 42))),
      { time: '11:42 PM', dayOffset: -1 });
    assert.deepEqual(getPartnerClock('Asia/Tokyo', new Date(Date.UTC(2026, 9, 15, 3, 42))),
      { time: '12:42 PM', dayOffset: 0 });
    assert.deepEqual(getPartnerClock('Africa/Lagos', new Date(Date.UTC(2026, 9, 15, 22, 42))),
      { time: '11:42 PM', dayOffset: 0 });
    assert.equal(getPartnerClock('Not/AZone', new Date()), null);
    assert.equal(getPartnerClock(null, new Date()), null);
    assert.equal(getPartnerClock(undefined, new Date()), null);

    assert.equal(formatDayOffset(-1), 'yesterday');
    assert.equal(formatDayOffset(0), null);
    assert.equal(formatDayOffset(1), 'tomorrow');

    const now = new Date(Date.UTC(2026, 9, 15, 12, 0, 0));
    assert.equal(formatLastSeen(new Date(now.getTime() - 30_000).toISOString(), now), 'Last seen just now');
    assert.equal(formatLastSeen(new Date(now.getTime() - 5 * 60_000).toISOString(), now), 'Last seen 5m ago');
    assert.equal(formatLastSeen(new Date(now.getTime() - 3 * HOUR_MS).toISOString(), now), 'Last seen 3h ago');
    assert.equal(formatLastSeen(new Date(now.getTime() - 2 * 24 * HOUR_MS).toISOString(), now), 'Last seen 2d ago');
    assert.equal(formatLastSeen(new Date(now.getTime() - 10 * 24 * HOUR_MS).toISOString(), now), 'Last seen 5 Oct');
    assert.equal(formatLastSeen(new Date(now.getTime() + 5_000).toISOString(), now), 'Last seen just now');
    assert.equal(formatLastSeen(null, now), 'Offline');
    assert.equal(formatLastSeen('rubbish', now), 'Offline');

    assert.equal(getInitial('Bob'), 'B');
    assert.equal(getInitial('  ana '), 'A');
    assert.equal(getInitial(''), '?');
  } finally {
    await server.close();
  }
});

test('home tab: live together counter, partner presence and the partner clock', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
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
  const root = createRoot(document.getElementById('root'));
  let backend;
  try {
    backend = await installTestBackend(supabase);
    const auth = await server.ssrLoadModule('/src/lib/authService.ts');
    const coupleTime = await server.ssrLoadModule('/src/lib/coupleTime.ts');

    // Two accounts paired through the same RPCs the app uses.
    const alice = (await auth.signUpWithEmail('alice@example.com', 'password')).user;
    await auth.saveOnboardingProfile(alice.id, 'Alice', 'Africa/Lagos');
    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, 'Bob', 'Pacific/Auckland');
    const { couple } = await auth.createCouple(bob.id, '2020-02-14');
    // Bob closed the app two hours ago; the Home tab must read that back from the database.
    const bobLastSeen = new Date(Date.now() - 2 * HOUR_MS).toISOString();
    await supabase.from('profiles').update({ last_seen_at: bobLastSeen }).eq('id', bob.id);
    await auth.signInWithEmail('alice@example.com', 'password');
    await auth.joinCoupleWithCode(alice.id, couple.invite_code);

    // Realtime presence without a socket, mirroring the real channel API.
    const presence = { state: {}, tracked: [], topic: null, key: null, handlers: [], status: null };
    let removedChannels = 0;
    const fakeChannel = {
      presenceState: () => presence.state,
      on(type, filter, handler) {
        presence.handlers.push({ type, event: filter.event, handler });
        return fakeChannel;
      },
      subscribe(callback) {
        presence.status = 'SUBSCRIBED';
        callback('SUBSCRIBED');
        // The real client replays the current presence state on subscribe.
        for (const entry of presence.handlers.filter((item) => item.event === 'sync')) entry.handler({ event: 'sync' });
        return fakeChannel;
      },
      async track(meta) { presence.tracked.push(meta); return 'ok'; },
      async unsubscribe() { return 'ok'; },
    };
    supabase.channel = (topic, options) => {
      presence.topic = topic;
      presence.key = options?.config?.presence?.key ?? null;
      return fakeChannel;
    };
    supabase.removeChannel = async () => { removedChannels += 1; return 'ok'; };

    const body = () => document.body.textContent.replace(/\u2019/g, "'");
    const waitFor = async (predicate, message) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
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

    const { default: App } = await server.ssrLoadModule('/src/App.tsx');
    await act(async () => { root.render(React.createElement(App)); });
    await waitFor(() => body().includes('Together for'), 'the Home tab should render once the couple is loaded');

    // 1. Couple header: both names plus the live YMD counter.
    const expectedDuration = coupleTime.formatTogetherDuration(
      coupleTime.getTogetherDuration(couple.anniversary_date, new Date()),
    );
    assert(body().includes('Alice & Bob'), 'both partners are named in the couple header');
    const appHeader = document.querySelector('header');
    assert(appHeader && appHeader.textContent.includes('Alice & Bob'), 'the global header names both partners');
    assert(appHeader.textContent.includes(`Together since ${couple.anniversary_date}`),
      'the global header keeps the "Together since" line');
    assert(appHeader.textContent.includes('Sam') === false, 'no sample-data names leak into the app');
    assert(body().includes(`Together for ${expectedDuration}`), `expected "${expectedDuration}" on the Home tab`);
    assert(/Together for \d+Y \d+M \d+D/.test(body()), 'the counter is shown as years, months and days');

    // 2. Partner status: offline partner shows their stored last-seen time.
    const dot = () => document.querySelector('[data-presence]');
    assert(dot(), 'the partner row has a presence dot');
    assert.equal(dot().previousElementSibling.textContent, 'Bob', 'the dot sits right beside the partner name');
    assert.equal(dot().dataset.presence, 'offline');
    assert(body().includes('Last seen 2h ago'), 'offline partner falls back to last_seen_at');
    assert(body().includes('Alice'), 'the phone owner is partner 1');
    assert(body().includes('You'), 'the phone owner is marked as you');

    // 3. Partner's local time only — never the reader's own clock.
    const bobClock = coupleTime.getPartnerClock('Pacific/Auckland', new Date());
    const aliceClock = coupleTime.getPartnerClock('Africa/Lagos', new Date());
    assert(body().includes(`It's ${bobClock.time} for Bob`), 'the partner clock uses the partner timezone');
    assert(!body().includes(aliceClock.time), 'the reader never sees their own time');

    // Presence: tracked on the couple channel, keyed by the signed-in account.
    assert.equal(presence.topic, `nooki-couple-${couple.id}`, 'presence stays scoped to the couple');
    assert.equal(presence.key, alice.id, 'presence is keyed by the current account');
    assert.equal(presence.status, 'SUBSCRIBED');
    assert.equal(presence.tracked[0]?.user_id, alice.id, 'the app announces this account as present');

    // The heartbeat keeps this account's last_seen_at fresh for the partner's screen.
    const aliceProfile = await auth.fetchProfile(alice.id);
    assert(Math.abs(Date.now() - new Date(aliceProfile.last_seen_at).getTime()) < 60_000,
      'last_seen_at is refreshed while the app is open');

    // Partner joins the channel: the dot turns green beside the name.
    presence.state = { [alice.id]: [{ user_id: alice.id }], [bob.id]: [{ user_id: bob.id }] };
    await emitPresenceSync();
    assert.equal(dot().dataset.presence, 'online');
    assert(body().includes('Online'), 'an online partner is labelled Online');
    assert(!body().includes('Last seen'), 'an online partner hides the last-seen label');

    // Partner leaves: the label falls back to the freshest database timestamp.
    const bobLeftAt = new Date(Date.now() - 7 * 60_000).toISOString();
    await auth.signInWithEmail('bob@example.com', 'password');
    await supabase.from('profiles').update({ last_seen_at: bobLeftAt }).eq('id', bob.id);
    await auth.signInWithEmail('alice@example.com', 'password');
    presence.state = { [alice.id]: [{ user_id: alice.id }] };
    await emitPresenceSync();
    assert.equal(dot().dataset.presence, 'offline');
    await waitFor(() => body().includes('Last seen 7m ago'), 'leaving the app re-reads the stored last_seen_at');

    // Presence survives browsing other tabs: it is owned by the app, not the Home tab.
    const chatTab = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Chat'));
    await act(async () => { chatTab.click(); });
    assert(body().includes('Coming Soon'), 'other tabs stay as placeholders');
    assert.equal(document.querySelector('[data-presence]'), null);
    assert.equal(removedChannels, 0, 'the presence channel is not torn down when the Home tab unmounts');
    const homeTab = [...document.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === 'Home');
    assert(homeTab, 'the Home tab is the centre tab');
    await act(async () => { homeTab.click(); });
    await waitFor(() => body().includes('Together for'), 'the Home tab comes back');
    assert.equal(dot().dataset.presence, 'offline');
  } finally {
    await act(() => root.unmount());
    await server.close();
    await supabase.auth.dispose();
    await backend?.close();
    dom.window.close();
  }
});
