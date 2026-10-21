import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const readSource = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

/** A realistic VAPID public key: an uncompressed P-256 point, base64url, 87 characters. */
const vapidKeyPair = () => {
  const bytes = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]);
  return bytes.toString('base64url');
};

test('push service: which platforms can subscribe, and what each one needs', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
  } });
  try {
    const push = await server.ssrLoadModule('/src/lib/pushService.ts');
    const config = await server.ssrLoadModule('/src/lib/pushConfig.mjs');

    // --- The platform rules, in one ordered function ---------------------------------------
    const android = { hasServiceWorker: true, hasPushManager: true, hasNotification: true, installed: false, isIos: false };
    const iosTab = { ...android, isIos: true };
    const iosInstalled = { ...iosTab, installed: true };
    assert.equal(push.describePushSupport(android, 'default'), 'ready', 'an Android/desktop tab can subscribe without installing');
    assert.equal(push.describePushSupport(iosTab, 'default'), 'needs-install', 'an iOS tab cannot, and is told to install first');
    assert.equal(push.describePushSupport(iosInstalled, 'default'), 'ready', 'a Home Screen app can');
    assert.equal(push.describePushSupport(iosInstalled, 'denied'), 'blocked', 'a refused permission is named as such');
    assert.equal(push.describePushSupport(android, 'denied'), 'blocked');
    assert.equal(push.describePushSupport({ ...android, hasPushManager: false }, 'default'), 'unsupported', 'no Push API means no switch at all');
    assert.equal(push.describePushSupport({ ...android, hasServiceWorker: false }, 'default'), 'unsupported');
    // An iOS tab without the install step is told what to do about it, not that it is impossible.
    assert.equal(push.describePushSupport({ ...iosTab, hasPushManager: false }, 'default'), 'needs-install');

    // --- What this browser reports about itself -------------------------------------------
    const SavedWindow = globalThis.window;
    const SavedNavigator = globalThis.navigator;
    try {
      assert.deepEqual(
        push.detectPushEnvironment().hasServiceWorker,
        false,
        'with no window at all (a build step, a test) nothing claims to be subscribed',
      );
      globalThis.window = { matchMedia: () => ({ matches: false }), Notification: { permission: 'default' } };
      const plain = push.detectPushEnvironment();
      assert.equal(plain.hasPushManager, false, 'no PushManager on the window means no subscription');
      assert.equal(plain.installed, false);
      globalThis.window = {
        matchMedia: () => ({ matches: true }),
        PushManager: function PushManager() {},
        Notification: { permission: 'granted' },
      };
      const standalone = push.detectPushEnvironment();
      assert.equal(standalone.hasPushManager, true);
      assert.equal(standalone.installed, true, 'display-mode: standalone is what Add to Home Screen produces');

      // iPhone: the iOS report is either the user agent or a report that the user agent lies.
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15', maxTouchPoints: 5, standalone: true },
      });
      assert.equal(push.detectPushEnvironment().isIos, true, 'an iPhone user agent is an iPhone');
      assert.equal(push.detectPushEnvironment().installed, true, 'navigator.standalone is the iOS install flag');
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', maxTouchPoints: 5, standalone: false },
      });
      assert.equal(push.detectPushEnvironment().isIos, true, 'an iPadOS 13+ "Macintosh" with touch points is an iPad');
    } finally {
      if (SavedWindow === undefined) delete globalThis.window; else globalThis.window = SavedWindow;
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: SavedNavigator });
    }

    // --- The public key: shape only, and never mistaking half a keypair for the wrong half
    const publicKey = vapidKeyPair();
    assert.equal(config.validateVapidPublicKey(publicKey), null);
    assert.match(config.validateVapidPublicKey(''), /VITE_VAPID_PUBLIC_KEY/, 'a missing key explains what to set');
    assert.match(config.VAPID_PUBLIC_KEY_HELP, /Never put the private key here/, 'and says which half must never be here');
    assert.match(config.validateVapidPublicKey(Buffer.alloc(32, 3).toString('base64url')), /public half/, 'a 43-character key is private-key sized and refused');
    assert.match(config.validateVapidPublicKey('not a key at all'), /public half/);
    assert.match(config.validateVapidPublicKey(`${publicKey} ${publicKey}`), /public half/);
    assert.equal(config.hasVapidPublicKey(publicKey), true);
    assert.equal(config.hasVapidPublicKey('   '), false);

    // The buffer, not the string: Safari and older Chromium refuse the raw base64url form.
    const decoded = config.decodeVapidPublicKey(publicKey);
    assert.equal(decoded.length, 65);
    assert.equal(decoded[0], 4, 'an uncompressed P-256 point starts with 0x04');
    assert.equal(decoded[1], 7);
    assert.ok(decoded instanceof Uint8Array, 'pushManager.subscribe wants bytes');

    assert.equal(config.isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc'), true);
    assert.equal(config.isPushEndpoint('http://fcm.googleapis.com/fcm/send/abc'), false);
    assert.equal(config.isPushEndpoint(''), false);

    // --- Why it failed, in words a phone can act on ----------------------------------------
    const notAllowed = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    assert.match(push.describePushError(notAllowed), /blocked for Nooki/, 'a refusal points at settings, not at a retry');
    assert.match(push.describePushError(Object.assign(new Error('x'), { name: 'InvalidStateError' })), /VITE_VAPID_PUBLIC_KEY/, 'a key mismatch points at the owner');
    assert.match(push.describePushError(Object.assign(new Error('x'), { name: 'SecurityError' })), /HTTPS/);
    assert.match(push.describePushError(new Error('Something specific happened')), /Something specific happened/);

    // --- The deep link a notification carries -----------------------------------------------
    try {
      globalThis.window = {
        location: { href: 'https://nooki.test/?nooki=games&keep=1' },
        history: { state: null, replaceState(_state, _title, url) { globalThis.window.location.href = `https://nooki.test${url}`; } },
      };
      assert.equal(push.takePushDeepLink(), 'games', 'the tab is read from the URL');
      assert.equal(globalThis.window.location.href, 'https://nooki.test/?keep=1', 'and consumed, so a reload does not jump again');
      globalThis.window.location.href = 'https://nooki.test/?nooki=';
      assert.equal(push.takePushDeepLink(), null, 'an empty value opens nothing');
      globalThis.window.location.href = 'https://nooki.test/?nooki=banking';
      assert.equal(push.takePushDeepLink(), null, 'and an unknown tab is ignored rather than followed');
      globalThis.window.location.href = 'https://nooki.test/chat';
      assert.equal(push.takePushDeepLink(), null, 'an ordinary visit has no deep link');
      assert.equal(push.takePushDeepLink('https://nooki.test/?nooki=together'), 'together');
      assert.equal(push.takePushDeepLink('https://nooki.test/?nooki=media'), 'together',
        'a notification sent before the rename still opens Together');
      globalThis.window.location.href = 'https://nooki.test/?nooki=together&keep=1';
      assert.equal(push.takePushDeepLink(), 'together');
      assert.equal(globalThis.window.location.href, 'https://nooki.test/?keep=1', 'the Together tab deep link is consumed once');
    } finally {
      delete globalThis.window;
    }

    // --- The service worker's message, and the deep-link tabs the app accepts ---------------
    assert.equal(push.isPushOpenTabMessage({ type: 'nooki-open-tab', tab: 'chat' }), true);
    assert.equal(push.isPushOpenTabMessage({ type: 'nooki-open-tab', tab: 'together' }), true);
    assert.equal(push.isPushOpenTabMessage({ type: 'nooki-open-tab' }), false, 'the message must name a recognized destination tab');
    assert.equal(push.isPushOpenTabMessage({ type: 'nooki-badge', count: 1 }), false);
    assert.equal(push.isPushOpenTabMessage(null), false);
    assert.deepEqual([...push.PUSH_DEEP_LINK_TABS], ['chat', 'together', 'home', 'discuss', 'games']);
    assert.equal(push.NOOKI_SERVICE_WORKER_URL, '/nooki-sw.js', 'the worker is served from public/, outside the bundler');
    assert.equal(push.NOOKI_SERVICE_WORKER_SCOPE, '/', 'and covers the whole app');
  } finally {
    await server.close();
  }
});

test('push settings card: one screen per platform, and a switch only where it can work', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://nooki.test/' });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'FormData', 'localStorage']) {
    globalThis[key] = dom.window[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
  } });
  const root = createRoot(document.getElementById('root'));
  // The settings modal imports authService, which starts the Supabase auth client's own
  // refresh timer. It has to be disposed or the test process never exits (the database
  // helper does the same thing for the same reason).
  const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
  const calls = [];
  const state = (overrides = {}) => ({
    support: 'ready',
    enabled: false,
    busy: false,
    error: null,
    configurationError: null,
    enable: async () => { calls.push('enable'); },
    disable: async () => { calls.push('disable'); },
    clearError: () => {},
    ...overrides,
  });
  try {
    const { PushNotificationsCard } = await server.ssrLoadModule('/src/components/common/PushNotificationsCard.tsx');
    const render = async (overrides) => {
      await act(async () => {
        root.render(React.createElement(PushNotificationsCard, { state: state(overrides) }));
      });
      const card = document.querySelector('[data-push-card]');
      assert(card, 'the card renders');
      return card;
    };

    // A browser that can subscribe gets a real switch — and the tap is what asks permission.
    let card = await render();
    assert.equal(card.getAttribute('data-push-support'), 'ready');
    assert.equal(card.getAttribute('data-push-enabled'), 'false');
    assert.match(card.textContent, /Off on this device/, 'the card says where the switch stands');
    const toggle = card.querySelector('[role="switch"]');
    assert(toggle, 'there is a switch');
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    await act(async () => { toggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    assert.deepEqual(calls, ['enable'], 'turning it on goes through the hook, which is where the permission prompt lives');

    // Already on: the switch reflects it, and switching it off is this device only.
    card = await render({ enabled: true });
    assert.equal(card.getAttribute('data-push-enabled'), 'true');
    assert.equal(card.querySelector('[role="switch"]').getAttribute('aria-checked'), 'true');
    assert.match(card.textContent, /On this device/, 'and the card says so');
    await act(async () => {
      card.querySelector('[role="switch"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    assert.deepEqual(calls, ['enable', 'disable']);

    // iPhone in a Safari tab: no switch at all — the API does not exist there — and the two
    // steps that actually produce one.
    card = await render({ support: 'needs-install' });
    assert.equal(card.querySelector('[role="switch"]'), null, 'no switch is offered where it could not work');
    assert.match(card.textContent, /Add to Home Screen/, 'the card explains the install step');
    assert.match(card.textContent, /Share/, 'including where the button is');
    assert.match(card.textContent, /Safari tab cannot receive them/, 'and why it is needed');

    // A remembered "no": point at the setting, do not ask again.
    card = await render({ support: 'blocked' });
    assert.equal(card.querySelector('[role="switch"]'), null);
    assert.match(card.textContent, /blocked/i);
    assert.match(card.textContent, /Notifications → Nooki/, 'the exact place to undo it');

    // An old browser still gets an honest sentence rather than a broken switch.
    card = await render({ support: 'unsupported' });
    assert.equal(card.querySelector('[role="switch"]'), null);
    assert.match(card.textContent, /cannot receive notifications/i);

    // The deployment is unfinished: the owner's note names the variable, not the user's mistake.
    card = await render({ configurationError: 'Push notifications are off: set VITE_VAPID_PUBLIC_KEY…' });
    assert(card.querySelector('[data-push-owner-note]'), 'the owner-only note is shown');
    assert.match(card.textContent, /VITE_VAPID_PUBLIC_KEY/);
    assert.match(card.textContent, /send-push/, 'and names the function that has to be deployed with it');

    // A failed attempt is reported in place, and the card stays usable.
    card = await render({ error: 'Notifications are blocked for Nooki.' });
    assert.match(card.querySelector('[data-push-error]').textContent, /blocked for Nooki/);
    assert(card.querySelector('[role="switch"]'), 'the switch is still there to try again');

    // The settings modal is where a couple actually finds it.
    const { DangerSettingsModal } = await server.ssrLoadModule('/src/components/common/DangerSettingsModal.tsx');
    await act(async () => {
      root.render(React.createElement(DangerSettingsModal, {
        userId: 'user-a',
        couple: { id: 'couple-1', invite_code: 'ABC123', anniversary_date: '2020-01-01', created_at: '2020-01-01T00:00:00Z', breakup_requested_by: null, breakup_requested_at: null },
        profile: { id: 'user-a', couple_id: 'couple-1', name: 'Ana', timezone: 'Africa/Lagos', country_code: 'NG', country_name: 'Nigeria', state_code: 'RI', state_name: 'Rivers', city_name: 'Port Harcourt', city_key: 'ng/ri/port-harcourt', location_updated_at: '2026-01-01T00:00:00Z', last_seen_at: '2026-01-01T00:00:00Z', created_at: '2020-01-01T00:00:00Z' },
        onLocationSaved: () => {},
        partner: { id: 'user-b', couple_id: 'couple-1', name: 'Ben', timezone: 'Europe/London', country_code: 'GB', country_name: 'United Kingdom', state_code: 'ENG', state_name: 'England', city_name: 'London', city_key: 'gb/eng/london', location_updated_at: '2026-01-01T00:00:00Z', last_seen_at: '2026-01-01T00:00:00Z', created_at: '2020-01-01T00:00:00Z' },
        adultQuestionsEnabled: false,
        partnerAdultQuestionsEnabled: false,
        adultQuestionsSaving: false,
        onToggleAdultQuestions: async () => {},
        pushNotifications: state(),
        onClose: () => {},
        onCoupleEnded: () => {},
        onSignOut: () => {},
      }));
    });
    assert(document.querySelector('[data-push-card]'), 'Couple Settings carries the notification switch');
    assert.match(document.body.textContent, /Notifications/);
  } finally {
    await act(() => root.unmount());
    await supabase.auth.dispose();
    await server.close();
    dom.window.close();
  }
});

test('push plumbing: manifest, icons, worker and app wiring are all in place', () => {
  // --- Installable identity: without a standalone manifest there is no icon to add, and on
  // iOS no Home Screen app means no Push API at all.
  const manifest = JSON.parse(readSource('../public/manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone', 'iOS treats the site as a web app only in standalone display');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.theme_color, '#FAF6EE', 'the app uses its own cream, not a browser default');
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ['192x192', '512x512']);
  assert(manifest.icons.every((icon) => icon.type === 'image/png' && icon.purpose === 'any'));

  const indexHtml = readSource('../index.html');
  assert(indexHtml.includes('rel="manifest" href="/manifest.webmanifest"'), 'the manifest is linked');
  assert(indexHtml.includes('rel="apple-touch-icon" href="/icons/apple-touch-icon.png"'), 'iOS reads its own icon tag, not the manifest');
  assert(indexHtml.includes('name="apple-mobile-web-app-capable" content="yes"'), 'and its own install flag');
  assert(indexHtml.includes('name="theme-color" content="#FAF6EE"'));

  // --- The icons themselves: real PNGs at the sizes claimed above -------------------------
  const pngSize = (relative) => {
    const file = readFileSync(new URL(relative, import.meta.url));
    assert.equal(file.subarray(1, 4).toString('ascii'), 'PNG', `${relative} is a PNG`);
    return [file.readUInt32BE(16), file.readUInt32BE(20)];
  };
  assert.deepEqual(pngSize('../public/icons/icon-192.png'), [192, 192]);
  assert.deepEqual(pngSize('../public/icons/icon-512.png'), [512, 512]);
  assert.deepEqual(pngSize('../public/icons/apple-touch-icon.png'), [180, 180]);
  // Android draws the small status-bar icon as a mask, so it is a white-on-transparent silhouette.
  assert.deepEqual(pngSize('../public/icons/badge-72.png'), [72, 72]);
  const badge = readFileSync(new URL('../public/icons/badge-72.png', import.meta.url));
  assert.equal(badge[25], 6, 'the badge carries an alpha channel for the mask');

  // --- The worker: push, tap, badge — and deliberately no fetch handler -------------------
  const worker = readSource('../public/nooki-sw.js');
  assert(worker.includes("addEventListener('push'"), 'the worker handles pushes');
  assert(worker.includes("addEventListener('notificationclick'"), 'and taps on them');
  assert(worker.includes("addEventListener('message'"), 'and the badge message from the app');
  assert(worker.includes('showNotification'), 'a push always shows something (userVisibleOnly)');
  assert(worker.includes('setAppBadge') || worker.includes('clearAppBadge'), 'the icon badge is set from the worker');
  assert(worker.includes('TABS.includes(tab)'), 'a tab from a notification is validated before it is followed');
  assert(worker.includes("const LEGACY_TABS = { media: 'together' }"),
    'a notification sent before the rename still opens Together');
  assert(worker.includes('clients.matchAll'), 'an already-open Nooki is focused instead of a second one opened');
  assert(worker.includes('nooki-open-tab'), 'and it tells that window which tab to show');
  assert(!worker.includes('sessionOf'), 'Together-time session deep links are no longer sent by the worker');
  assert(!worker.includes("addEventListener('fetch'"), 'the worker caches nothing: no fetch handler, no stale shell');

  // --- App wiring: registering the worker, following the deep link, clearing the badge ----
  const main = readSource('../src/main.tsx');
  assert(main.includes('registerNookiServiceWorker()'), 'the worker is registered at boot, so a push lands with the app closed');
  assert(main.includes('const pushStartTab = takePushDeepLink()'), 'a notification tapped while the app was closed is read before the first render');
  assert(main.includes('<App initialTab={pushStartTab} />'), 'a notification opens a tab without a Together-time session deep link');
  const app = readSource('../src/App.tsx');
  assert(app.includes('usePushNotifications({'), 'the app owns this device\'s push state');
  assert(app.includes('useState<TabKey>(initialTab ?? \'home\')'), 'the tab a notification asked for is the app\'s initial tab');
  assert(app.includes('isPushOpenTabMessage'), 'a notification tapped while it was open switches tab by message');
  assert(app.includes('requestTabRef.current'), 'through requestTab, so leaving a live duel still asks first');
  assert(app.includes('setPushBadge(pushBadge)'), 'the icon badge is kept in step with the app');
  assert(app.includes('? 0 : chat.unreadCount'), 'including clearing it where the messages are actually read');
  assert(app.includes('releaseAllPushSubscriptions()'), 'signing out makes the account unreachable on this device');
  assert(app.includes('pushNotifications={push}'), 'and the settings modal shows the switch');
  const service = readSource('../src/lib/pushService.ts');
  assert(service.includes("rpc('register_push_subscription'"), 'the browser claims its device through the RPC');
  assert(service.includes("rpc('release_push_subscription'"), 'and lets it go the same way');
  assert(service.includes("rpc('release_my_push_subscriptions'"), 'signing out releases every device of the account');
  assert(service.includes('userVisibleOnly: true'), 'a push must always show a notification');
  assert(service.includes('applicationServerKey: decodeVapidPublicKey'), 'the key is passed as bytes');
  assert(service.includes('import.meta.env.VITE_VAPID_PUBLIC_KEY'), 'the public key comes from the build, not from the code');
  assert(!/VAPID_PRIVATE/.test(service + app + main + worker), 'no private key material anywhere in the app');
});

test('push sending: the Edge Function exists, is documented, and never leaks the private key', () => {
  const fn = readSource('../supabase/functions/send-push/index.ts');
  assert(fn.includes("from 'npm:web-push@3.6.7'") || fn.includes('npm:web-push'), 'the standard Web Push library does the encryption and signing');
  assert(fn.includes('setVapidDetails'), 'signed with the project\'s own VAPID keypair');
  assert(fn.includes("requiredSecret('VAPID_PRIVATE_KEY')"), 'the private key is read from the function secrets');
  assert(!/VAPID_PRIVATE_KEY\s*[:=]\s*['"]/.test(fn), 'and is never written into the file');
  assert(fn.includes('SUPABASE_SERVICE_ROLE_KEY'), 'the service key is what lets it read a partner\'s devices');
  assert(fn.includes('PUSH_WEBHOOK_SECRET'), 'callers must present the webhook secret when the owner sets one');
  assert(fn.includes(".neq('id', senderId)"), 'nobody is notified of their own message');
  assert(fn.includes('count: unread'), 'the icon badge comes from the exact count (head: true puts it in `count`, not `data`)');
  assert(fn.includes("requiredSecret('SUPABASE_SECRET_KEY')"), 'and it works on projects that use the new secret key names');
  assert(fn.includes("payload.table !== 'messages'"), 'only new messages trigger it');
  assert(fn.includes('handleEpistle'), 'a sealed letter knocks on the partner’s phone');
  assert(fn.includes('handleMissYou'), 'a first waiting tap knocks too');
  assert(fn.includes("payload.table !== 'miss_you_taps'"), 'the miss-you table is a watched table');
  assert(fn.includes('nooki-miss-you-'), 'taps of one day share a tag, so a re-knock replaces the old one');
  assert(fn.includes('Misses you'), 'the tap says what it is');
  assert(fn.includes("'not the first waiting tap'"), 'later taps and the opening itself stay silent');
  assert(fn.includes('status === 404 || status === 410'), 'a device that is gone is deleted, not retried forever');
  assert(fn.includes("tab: 'chat'"), 'the notification deep links into the chat');
  assert(!fn.includes('TogetherTimeReminder'), 'the scheduled date-night reminder path is removed');
  assert(!fn.includes('together_time_sessions'), 'the push handler no longer watches the removed scheduling table');

  const config = readSource('../supabase/config.toml');
  assert(config.includes('[functions.send-push]'), 'the function\'s gateway settings travel with the code');
  assert(config.includes('verify_jwt = false'), 'the webhook calls it with a service key, so the function does its own auth check');
});

test('push runbook: the letters’ trigger sends a real payload, and miss-yous have their webhook', () => {
  const readme = readSource('../README.md');
  // The function skips any body without `table`/`record`, so the runbook's trigger SQL
  // must build the webhook-shaped body around the sealed row — an empty body would be
  // silence, however correctly the function itself is written.
  assert(readme.includes('notify_epistle_sealed'), 'the letters’ knock is built in a wrapper function');
  assert(readme.includes('row_to_json(NEW)'), '…sending the sealed row itself, not an empty body');
  assert(readme.includes('row_to_json(OLD)'), '…with the unsealed row beside it, so the moment of sealing is provable');
  assert(readme.includes('Table `miss_you_taps`'), 'miss-yous have their own dashboard webhook step');
  assert(readme.includes('202610210002_miss_you_push.sql'), '…and the grant migration that lets the sender read the taps');
});
