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

    // The clock belongs to the partner's timezone, never the reader's, and carries their weekday.
    assert.deepEqual(getPartnerClock('America/New_York', new Date(Date.UTC(2026, 9, 15, 3, 42))),
      { time: '11:42 PM', weekday: 'Wed' });
    assert.deepEqual(getPartnerClock('Asia/Tokyo', new Date(Date.UTC(2026, 9, 15, 3, 42))),
      { time: '12:42 PM', weekday: 'Thu' });
    assert.deepEqual(getPartnerClock('Africa/Lagos', new Date(Date.UTC(2026, 9, 15, 22, 42))),
      { time: '11:42 PM', weekday: 'Thu' });
    assert.equal(formatPartnerClock({ time: '5:14 PM', weekday: 'Tue' }), '5:14 PM Tue');
    assert.equal(getInitial('Bob'), 'B');
    assert.equal(getInitial('  ana '), 'A');
    assert.equal(getInitial(''), '?');
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

test('global header: live counter, presence ticker and partner clock', async () => {
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
    await auth.saveOnboardingProfile(alice.id, { name: 'Alice', location: null, timezone: 'Africa/Lagos' });
    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, { name: 'Bob', location: null, timezone: 'Pacific/Auckland' });
    const { couple } = await auth.createCouple(bob.id, '2020-02-14');
    // Bob closed the app two hours ago; the Home tab must read that back from the database.
    const bobLastSeen = new Date(Date.now() - 2 * HOUR_MS).toISOString();
    await supabase.from('profiles').update({ last_seen_at: bobLastSeen }).eq('id', bob.id);
    await auth.signInWithEmail('alice@example.com', 'password');
    await auth.joinCoupleWithCode(alice.id, couple.invite_code);
    await backend.query(
      `INSERT INTO public.daily_decision_questions (question, option_a, option_b, option_c)
       VALUES ($1, $2, $3, $4)`,
      ['What should we plan together?', 'Cook dinner', 'Watch a film', 'Take a walk'],
    );
    await auth.signInWithEmail('alice@example.com', 'password');

    // Realtime presence without a socket, mirroring the real channel API. Every
    // channel topic is recorded; presence specifics only apply to the presence
    // channel (the couple picture frame opens its own couple-scoped channel too).
    const presence = { state: {}, tracked: [], topic: null, key: null, handlers: [], status: null };
    const topics = [];
    const checkInChannels = new Set();
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
      async send() { return 'ok'; },
      async unsubscribe() { return 'ok'; },
    };
    supabase.channel = (topic, options) => {
      topics.push(topic);
      // Home-only check-ins may unsubscribe on navigation; the global presence
      // channel must not. Give these their own identity instead of conflating them.
      if (topic.startsWith('everyday:')) {
        const channel = { on: () => channel, subscribe: () => channel };
        checkInChannels.add(channel);
        return channel;
      }
      if (options?.config?.presence) {
        presence.topic = topic;
        presence.key = options.config.presence.key ?? null;
      }
      return fakeChannel;
    };
    supabase.removeChannel = async (channel) => { if (!checkInChannels.has(channel)) removedChannels += 1; return 'ok'; };

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

    const { SPLASH_DURATION_MS } = await server.ssrLoadModule('/src/components/common/SplashScreen.tsx');
    assert(SPLASH_DURATION_MS <= 1500, 'splash screen duration');

    const { default: App } = await server.ssrLoadModule('/src/App.tsx');
    await act(async () => { root.render(React.createElement(App)); });

    // 0. Splash screen renders initially with the Nooki wordmark and racing pink & green dots, then finishes in < 0.5s.
    const splash = document.querySelector('[data-screen="splash"]');
    assert(splash, 'the splash screen renders immediately on launch');
    assert.equal(splash.querySelector('[data-splash-wordmark]')?.textContent, 'Nooki', 'the splash screen shows the simple Nooki wordmark');
    assert(splash.querySelector('[data-splash-dot="pink"]'), 'the splash screen includes the racing pink dot');
    assert(splash.querySelector('[data-splash-dot="green"]'), 'the splash screen includes the racing green dot');

    await waitFor(() => body().includes('Together for'), 'the unlocked app should render once the splash and couple load complete');
    assert.equal(document.querySelector('[data-screen="splash"]'), null, 'the splash screen dismisses after under 0.5 seconds');

    const homeBadge = () => document.querySelector('[data-nav-badge="home"]');
    const homeTabButton = () => document.querySelector('[data-nav-tab="home"]');
    await waitFor(() => homeBadge()?.textContent.trim() === '1', 'an unanswered daily decision badges Home');
    assert.equal(homeTabButton().getAttribute('aria-label'), "Home, today's decision waiting for you");
    // Navigating away or simply visiting Home never counts as answering.
    await act(async () => { document.querySelector('[data-nav-tab="media"]').click(); });
    assert(homeBadge(), 'the reminder remains visible on another tab');
    await act(async () => { homeTabButton().click(); });
    assert(homeBadge(), 'visiting Home does not clear the reminder');

    // 1. Global header: names, the live YMD counter, the partner clock and an offline dot.
    const expectedDuration = coupleTime.formatTogetherDuration(
      coupleTime.getTogetherDuration(couple.anniversary_date, new Date()),
    );
    const appHeader = () => document.querySelector('header');
    assert(appHeader(), 'the global header renders on the unlocked app');
    const initials = appHeader().querySelector('[data-couple-initials]');
    assert(initials, 'the header shows the couple as initials');
    assert.equal(initials.textContent, 'A & B', 'initials keep the header compact');
    assert.equal(initials.getAttribute('aria-label'), 'Alice and Bob', 'the full names stay available to screen readers');
    assert.equal(appHeader().textContent.includes('Alice & Bob'), false, 'full names no longer sit in the header');
    assert(appHeader().textContent.includes(`Together for ${expectedDuration}`),
      `expected "Together for ${expectedDuration}" in the header`);
    // Overly long names cannot stretch the header: only their first letters are shown.
    assert.equal(coupleTime.getInitial('Alexandra the Great'), 'A');
    assert(/Together for \d+Y \d+M \d+D/.test(appHeader().textContent),
      'the header counter is shown as years, months and days');
    assert(!appHeader().textContent.includes('Together since'), 'the since-date is replaced by the live counter');
    assert(appHeader().textContent.includes('Sam') === false, 'no sample-data names leak into the app');

    const dot = () => document.querySelector('[data-presence]');
    assert(dot(), 'the header has a presence dot');
    assert.equal(dot().parentElement.textContent.includes('A & B'), true, 'the dot sits with the couple initials');
    assert.equal(dot().previousElementSibling.getAttribute('data-couple-initials'), 'A & B',
      'the dot sits right beside the initials');
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

    // 2. The Home tab shows Today, today's decision and the reserved bottom scene area.
    const shell = document.querySelector('main.nooki-shell');
    assert(shell, 'the app renders inside the responsive .nooki-shell container');
    assert.equal(shell.style.width, '100%', 'the app shell uses fluid 100% width instead of a fixed pixel width');
    const home = document.querySelector('[data-screen="home"]');
    assert(home, 'the Home tab renders as the default screen');
    assert(home.querySelector('[data-card="today"]'), 'the Today card is on the Home tab');
    assert(document.querySelector('[data-modal="calendar"]') === null, 'the calendar starts closed');
    assert.equal(body().includes('This phone'), false, 'the old partner-status card is gone');
    assert.equal(body().includes('Partner status'), false, 'no leftover status card');

    assert.equal(home.querySelector('[data-card="daily-game"]'), null, 'the retired Daily game card is absent');

    const dailyDecisionCard = home.querySelector('[data-card="daily-decision"]');
    assert(dailyDecisionCard, 'the daily decision is the only daily Home card');
    const decisionCardCopy = dailyDecisionCard.textContent.replace(/\u2019/g, "'").trim();
    assert.equal(decisionCardCopy, "Today's decisionPlay", 'the card shows only its eyebrow and Play button');
    const openDecisionButton = dailyDecisionCard.querySelector('[data-action="play-daily-decision"]');
    assert(openDecisionButton, 'the Daily decision card has a Play button');
    await act(async () => { openDecisionButton.click(); });
    const decisionModal = () => document.querySelector('[data-modal="daily-decision"]');
    await waitFor(() => decisionModal()?.querySelector('[data-decision-question]'), 'today’s uploaded decision should load');
    assert.equal(decisionModal().querySelector('[data-decision-question]').textContent, 'What should we plan together?');
    assert.equal(decisionModal().querySelectorAll('[data-decision-option]').length, 3, 'the question has exactly three choices');
    assert(homeBadge(), 'opening the decision does not clear its badge');
    assert.match(decisionModal().querySelector('[data-decision-status]').textContent, /Neither answer is revealed/);
    await act(async () => {
      decisionModal().querySelector('[data-decision-option="2"] input').click();
    });
    const submitDecision = decisionModal().querySelector('[data-action="submit-daily-decision"]');
    assert.equal(submitDecision.disabled, false, 'a single choice can be submitted privately');
    assert(homeBadge(), 'selecting an option without saving still leaves the decision pending');
    await act(async () => { submitDecision.click(); });
    await waitFor(() => decisionModal().querySelector('[data-decision-status]').textContent.includes('Your choice stays private'),
      'the first choice is saved privately while the partner waits');
    assert.equal(decisionModal().querySelector('[data-decision-reveal]'), null, 'the partner answer is still hidden');
    await waitFor(() => homeBadge() === null, 'saving your own choice clears the Home badge');
    assert.equal(homeTabButton().getAttribute('aria-label'), 'Home',
      'waiting for the partner does not badge a decision you have already answered');

    // Take to chat shares the exact prompt and all three options so the couple can deliberate.
    await act(async () => { decisionModal().querySelector('[data-action="take-decision-to-chat"]').click(); });
    await waitFor(() => document.querySelector('[data-screen="chat"]'), 'Take to chat opens the shared conversation');
    await waitFor(() => body().includes('What should we plan together?'), 'the decision prompt is sent to Chat');
    assert(body().includes('1. Cook dinner') && body().includes('2. Watch a film') && body().includes('3. Take a walk'),
      'the chat message carries all three options');
    await act(async () => { document.querySelector('button[aria-label="Home"]').click(); });

    // The shared nook stays at the bottom of Home, with its caption pinned to the top-right.
    const currentHome = document.querySelector('[data-screen="home"]');
    assert(currentHome, 'the Home tab is visible again after closing the daily decision');
    const sceneArea = currentHome.querySelector('[data-scene-placeholder]');
    assert(sceneArea, 'the Home tab includes the shared Nooki scene');
    assert.equal(currentHome.lastElementChild, sceneArea, 'the shared nook stays at the bottom of the Home screen');
    const nookCaption = sceneArea.querySelector('[data-nooki-caption]');
    assert.equal(nookCaption?.textContent.trim(), 'Our little nook');
    assert.equal(nookCaption?.style.top, '10px');
    assert.equal(nookCaption?.style.right, '12px');
    assert.equal(sceneArea.dataset.partnerOnline, 'false', 'starts with the partner marked away');
    const nookFrame = sceneArea.querySelector('[data-component="nook-photo-frame"]');
    assert(nookFrame, 'the nook holds the couple picture frame');
    assert.equal(nookFrame.dataset.hasPhoto, 'false', 'the frame starts by inviting the couple to upload a picture');
    assert.equal(
      nookFrame.querySelector('button[data-nooki-frame-button]')?.getAttribute('aria-label'),
      'Upload your couple picture',
      'the empty frame prompts the upload',
    );
    assert(sceneArea.style.borderRadius, 'the shared nook is rounded');
    assert.equal(sceneArea.style.flexDirection, 'column', 'the photo grows below the caption row');
    assert.equal(sceneArea.style.paddingTop, '44px', 'the photo leaves the caption and miss-you control clear');
    assert.equal(sceneArea.style.paddingBottom, '8px', 'only a small gap remains above navigation');
    assert.equal(nookFrame.style.flexGrow, '1', 'the photo fills the remaining nook height');

    // Presence: tracked on the couple channel, keyed by the signed-in account.
    assert.equal(presence.topic, `nooki-couple-${couple.id}`, 'presence stays scoped to the couple');
    assert.equal(presence.key, alice.id, 'presence is keyed by the current account');
    assert.equal(presence.status, 'SUBSCRIBED');
    assert(
      topics.includes(`nooki-couple-photo-${couple.id}`),
      'the picture frame keeps its own couple-scoped realtime channel',
    );
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
    assert.equal(sceneArea.dataset.partnerOnline, 'true', 'the Home nook receives live partner availability');
    assert(
      sceneArea.querySelector('[data-component="nook-photo-frame"]'),
      'the framed couple picture keeps standing in the nook while presence changes',
    );

    // Partner leaves: the ticker greys out and re-reads the freshest database timestamp.
    const bobLeftAt = new Date(Date.now() - 7 * 60_000).toISOString();
    await auth.signInWithEmail('bob@example.com', 'password');
    await supabase.from('profiles').update({ last_seen_at: bobLeftAt }).eq('id', bob.id);
    await auth.signInWithEmail('alice@example.com', 'password');
    presence.state = { [alice.id]: [{ user_id: alice.id }] };
    await emitPresenceSync();
    assert.equal(dot().dataset.presence, 'offline');
    assert.equal(dot().style.backgroundColor, offlineDotColor, 'the ticker greys back out');
    assert.equal(sceneArea.dataset.partnerOnline, 'false', 'the Home nook returns to partner-away mode');
    assert(
      sceneArea.querySelector('[data-component="nook-photo-frame"]'),
      'the framed couple picture is unaffected by presence coming and going',
    );
    await waitFor(() => dot().getAttribute('aria-label').includes('Last seen 7m ago'),
      'leaving the app re-reads the stored last_seen_at');

    // Presence survives browsing other tabs: it is owned by the app, not the Home tab.
    const mediaTab = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Media'));
    await act(async () => { mediaTab.click(); });
    assert(body().includes('Read together'), 'the Media tab now opens the shared books shelf');
    assert(dot(), 'the header ticker stays visible on every tab');
    assert.equal(removedChannels, 0, 'the presence channel is not torn down on tab switches');

    // The Chat tab is a real feature now: it opens the couple's conversation.
    const chatTab = [...document.querySelectorAll('button')].find((item) => item.getAttribute('aria-label')?.startsWith('Chat'));
    await act(async () => { chatTab.click(); });
    assert(document.querySelector('[data-screen="chat"]'), 'the Chat tab opens the chat');
    assert(dot(), 'the header ticker stays visible on the chat tab too');
    assert.equal(removedChannels, 0, 'the chat channel is not torn down on tab switches');
    const homeTab = [...document.querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === 'Home');
    assert(homeTab, 'the Home tab is the centre tab');
    await act(async () => { homeTab.click(); });
    await waitFor(() => document.querySelector('[data-card="today"]') !== null, 'the Home tab comes back');
    assert.equal(dot().dataset.presence, 'offline');
  } finally {
    await act(() => root.unmount());
    await server.close();
    await supabase.auth.dispose();
    await backend?.close();
    dom.window.close();
  }
});
