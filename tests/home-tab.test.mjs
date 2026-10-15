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
      getTogetherDuration, formatTogetherDuration, getPartnerClock, formatPartnerClock,
      formatLastSeen,
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

    // The clock belongs to the partner's timezone, never the reader's, and carries their weekday.
    assert.deepEqual(getPartnerClock('America/New_York', new Date(Date.UTC(2026, 9, 15, 3, 42))),
      { time: '11:42 PM', weekday: 'Wed' });
    assert.deepEqual(getPartnerClock('Asia/Tokyo', new Date(Date.UTC(2026, 9, 15, 3, 42))),
      { time: '12:42 PM', weekday: 'Thu' });
    assert.deepEqual(getPartnerClock('Africa/Lagos', new Date(Date.UTC(2026, 9, 15, 22, 42))),
      { time: '11:42 PM', weekday: 'Thu' });
    assert.equal(formatPartnerClock({ time: '5:14 PM', weekday: 'Tue' }), '5:14 PM Tue');
    assert.equal(getPartnerClock('Not/AZone', new Date()), null);
    assert.equal(getPartnerClock(null, new Date()), null);
    assert.equal(getPartnerClock(undefined, new Date()), null);

    const now = new Date(Date.UTC(2026, 9, 15, 12, 0, 0));
    assert.equal(formatLastSeen(new Date(now.getTime() - 30_000).toISOString(), now), 'Last seen just now');
    assert.equal(formatLastSeen(new Date(now.getTime() - 5 * 60_000).toISOString(), now), 'Last seen 5m ago');
    assert.equal(formatLastSeen(new Date(now.getTime() - 3 * HOUR_MS).toISOString(), now), 'Last seen 3h ago');
    assert.equal(formatLastSeen(new Date(now.getTime() - 2 * 24 * HOUR_MS).toISOString(), now), 'Last seen 2d ago');
    assert.equal(formatLastSeen(new Date(now.getTime() - 10 * 24 * HOUR_MS).toISOString(), now), 'Last seen 5 Oct');
    assert.equal(formatLastSeen(new Date(now.getTime() + 5_000).toISOString(), now), 'Last seen just now');
    assert.equal(formatLastSeen(null, now), 'Offline');
    assert.equal(formatLastSeen('rubbish', now), 'Offline');
  } finally {
    await server.close();
  }
});

test('global header: live counter, presence ticker and partner clock; Home stays blank', async () => {
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
    await waitFor(() => body().includes('Together for'), 'the unlocked app should render once the couple is loaded');

    // 1. Global header: names, the live YMD counter, the partner clock and an offline dot.
    const expectedDuration = coupleTime.formatTogetherDuration(
      coupleTime.getTogetherDuration(couple.anniversary_date, new Date()),
    );
    const appHeader = () => document.querySelector('header');
    assert(appHeader(), 'the global header renders on the unlocked app');
    assert(appHeader().textContent.includes('Alice & Bob'), 'the header names both partners');
    assert(appHeader().textContent.includes(`Together for ${expectedDuration}`),
      `expected "Together for ${expectedDuration}" in the header`);
    assert(/Together for \d+Y \d+M \d+D/.test(appHeader().textContent),
      'the header counter is shown as years, months and days');
    assert(!appHeader().textContent.includes('Together since'), 'the since-date is replaced by the live counter');
    assert(appHeader().textContent.includes('Sam') === false, 'no sample-data names leak into the app');

    const dot = () => document.querySelector('[data-presence]');
    assert(dot(), 'the header has a presence dot');
    assert.equal(dot().parentElement.textContent.includes('Alice & Bob'), true, 'the dot sits with the couple names');
    assert.equal(dot().previousElementSibling.textContent.trim(), 'Alice & Bob',
      'the dot sits right beside the partner name');
    assert.equal(dot().dataset.presence, 'offline', 'an away partner greys the ticker out');
    assert(dot().getAttribute('aria-label').includes('Last seen 2h ago'),
      'the grey dot still knows when they were last around');
    const offlineDotColor = dot().style.backgroundColor;

    // The partner's own time and weekday sit beside the dot — never the reader's clock.
    const bobClock = coupleTime.getPartnerClock('Pacific/Auckland', new Date());
    const aliceClock = coupleTime.getPartnerClock('Africa/Lagos', new Date());
    assert.equal(dot().nextElementSibling.textContent, `${bobClock.time} ${bobClock.weekday}`,
      'the partner clock reads "5:14 PM Tue" style beside the dot');
    assert(appHeader().textContent.includes(bobClock.weekday), 'the partner weekday is shown');
    assert(!appHeader().textContent.includes(`${aliceClock.time} ${aliceClock.weekday}`),
      'the reader never sees their own time');

    // 2. The Home tab is intentionally blank for now.
    const home = document.querySelector('[data-screen="home"]');
    assert(home, 'the Home tab renders as the default screen');
    assert.equal(home.textContent.trim(), '', 'the Home tab holds no cards yet');
    assert.equal(body().includes('This phone'), false, 'the old partner-status card is gone');
    assert.equal(body().includes("for Bob"), false, 'the old partner-clock card is gone');

    // Presence: tracked on the couple channel, keyed by the signed-in account.
    assert.equal(presence.topic, `nooki-couple-${couple.id}`, 'presence stays scoped to the couple');
    assert.equal(presence.key, alice.id, 'presence is keyed by the current account');
    assert.equal(presence.status, 'SUBSCRIBED');
    assert.equal(presence.tracked[0]?.user_id, alice.id, 'the app announces this account as present');

    // The heartbeat keeps this account's last_seen_at fresh for the partner's screen.
    const aliceProfile = await auth.fetchProfile(alice.id);
    assert(Math.abs(Date.now() - new Date(aliceProfile.last_seen_at).getTime()) < 60_000,
      'last_seen_at is refreshed while the app is open');

    // Partner joins the channel: the ticker turns green beside the name.
    presence.state = { [alice.id]: [{ user_id: alice.id }], [bob.id]: [{ user_id: bob.id }] };
    await emitPresenceSync();
    assert.equal(dot().dataset.presence, 'online');
    assert.notEqual(dot().style.backgroundColor, offlineDotColor, 'an online partner turns the ticker green');
    assert(dot().getAttribute('aria-label').includes('is online'), 'the online dot announces itself');

    // Partner leaves: the ticker greys out and re-reads the freshest database timestamp.
    const bobLeftAt = new Date(Date.now() - 7 * 60_000).toISOString();
    await auth.signInWithEmail('bob@example.com', 'password');
    await supabase.from('profiles').update({ last_seen_at: bobLeftAt }).eq('id', bob.id);
    await auth.signInWithEmail('alice@example.com', 'password');
    presence.state = { [alice.id]: [{ user_id: alice.id }] };
    await emitPresenceSync();
    assert.equal(dot().dataset.presence, 'offline');
    assert.equal(dot().style.backgroundColor, offlineDotColor, 'the ticker greys back out');
    await waitFor(() => dot().getAttribute('aria-label').includes('Last seen 7m ago'),
      'leaving the app re-reads the stored last_seen_at');

    // Presence survives browsing other tabs: it is owned by the app, not the Home tab.
    const chatTab = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Chat'));
    await act(async () => { chatTab.click(); });
    assert(body().includes('Coming Soon'), 'other tabs stay as placeholders');
    assert(dot(), 'the header ticker stays visible on every tab');
    assert.equal(removedChannels, 0, 'the presence channel is not torn down on tab switches');
    const homeTab = [...document.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === 'Home');
    assert(homeTab, 'the Home tab is the centre tab');
    await act(async () => { homeTab.click(); });
    await waitFor(() => document.querySelector('[data-screen="home"]') !== null, 'the Home tab comes back');
    assert.equal(dot().dataset.presence, 'offline');
  } finally {
    await act(() => root.unmount());
    await server.close();
    await supabase.auth.dispose();
    await backend?.close();
    dom.window.close();
  }
});
