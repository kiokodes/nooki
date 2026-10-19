/*
 * Nooki's service worker — the browser end of Web Push, and nothing else.
 *
 * It is deliberately tiny and state-free:
 *   * no fetch handler, so it never caches or serves anything (the app keeps deploying
 *     fresh from Vercel, and a stale shell can never come from inside here);
 *   * no IndexedDB, no imported chunk, no build step — it is served as-is from `public/`
 *     and lives at the root scope so it covers the whole app;
 *   * its only jobs are to show the notification a push carries, to set the app-icon
 *     badge, and to open the right tab when one is tapped.
 *
 * On iOS this file only ever runs for an app added to the Home Screen; on Android,
 * desktop Chrome/Edge and Firefox it runs for an ordinary tab too. See "Push
 * notifications" in the README for what each platform requires.
 */

const DEFAULT_TAB = 'chat';
const TABS = ['chat', 'home', 'discuss', 'games', 'together'];

/** `media` is the Together tab's old name: notifications already delivered keep working. */
const LEGACY_TABS = { media: 'together' };

/** A known tab name, or null for anything else a sender might put in a payload. */
function normalizeTab(value) {
  const tab = LEGACY_TABS[value] || value;
  return TABS.includes(tab) ? tab : null;
}

const ICON_URL = '/icons/icon-192.png';
const BADGE_ICON_URL = '/icons/badge-72.png';

// A new worker takes over without waiting for every Nooki tab to close, and claims the
// tabs that are already open — so a phone that had the app open before this deploy can
// still receive its first notification.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/** The push payload, however it arrived: JSON from `send-push`, or anything at all. */
function readPayload(data) {
  if (!data) return {};
  try {
    const parsed = data.json();
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Not JSON: fall through to the plain-text body, which is what other senders use.
  }
  try {
    return { body: data.text() };
  } catch {
    return {};
  }
}

function tabOf(payload) {
  return (typeof payload.tab === 'string' && normalizeTab(payload.tab)) || DEFAULT_TAB;
}

/** `/chat` is the deep link the app reads on boot, so a cold open lands on the tab too. */
function urlOf(payload, tab) {
  const value = typeof payload.url === 'string' && payload.url.startsWith('/') ? payload.url : `/?nooki=${tab}`;
  try {
    return new URL(value, self.location.origin).href;
  } catch {
    return new URL(`/?nooki=${tab}`, self.location.origin).href;
  }
}

/** A scheduled Together-time notification may deep-link to the exact activity. */
function sessionOf(payload) {
  if (typeof payload.sessionId === 'string' && payload.sessionId) return payload.sessionId;
  try {
    return new URL(urlOf(payload, tabOf(payload))).searchParams.get('session') || null;
  } catch {
    return null;
  }
}

/**
 * The unread count on the app icon (Badging API). Chromium and Safari both implement it
 * in the worker, and both throw when the platform has no badge concept — neither the
 * notification nor the push must fail because of a decoration.
 */
async function setAppBadge(count) {
  const badge = self.navigator;
  if (!badge) return;
  try {
    if (count > 0 && typeof badge.setAppBadge === 'function') await badge.setAppBadge(count);
    else if (typeof badge.clearAppBadge === 'function') await badge.clearAppBadge();
  } catch {
    // No badge support: the notification is still shown.
  }
}

self.addEventListener('push', (event) => {
  const payload = readPayload(event.data);
  const tab = tabOf(payload);
  const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title : 'Nooki';
  const body = typeof payload.body === 'string' ? payload.body : 'You have a new message.';
  // One bubble per message: a tag replaces an unread notification for the *same* message
  // (a re-send) but never collapses two different ones, which a shared tag would.
  const tag = typeof payload.tag === 'string' && payload.tag.trim() ? payload.tag : 'nooki-message';
  const badge = Number.isFinite(Number(payload.badge)) ? Math.max(0, Math.floor(Number(payload.badge))) : null;

  event.waitUntil(Promise.allSettled([
    self.registration.showNotification(title, {
      body,
      tag,
      icon: ICON_URL,
      badge: BADGE_ICON_URL,
      // Tapping has to know where to go, and it has to survive the notification being
      // read on a different day than it was sent.
      data: { url: urlOf(payload, tab), tab, sessionId: sessionOf(payload) },
      // iOS ignores `timestamp`; Android shows it under the content when present.
      timestamp: Date.now(),
    }),
    badge === null ? Promise.resolve() : setAppBadge(badge),
  ]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const tab = normalizeTab(data.tab) || DEFAULT_TAB;
  const target = typeof data.url === 'string'
    ? data.url
    : new URL(`/?nooki=${tab}`, self.location.origin).href;

  event.waitUntil((async () => {
    // Prefer the Nooki that is already open — a second copy of the app would be a second
    // Realtime socket, and on iOS a duplicate window rather than a tab. A tap that opens
    // nothing is the worst outcome, so any failure here falls through to opening the app.
    try {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientList) {
        let clientUrl;
        try {
          clientUrl = new URL(client.url);
        } catch {
          continue;
        }
        if (clientUrl.origin !== self.location.origin) continue;
        await client.focus();
        // The window is already loaded, so the tab is switched by message rather than by
        // navigation: nothing reloads, and the splash is not replayed.
        client.postMessage({ type: 'nooki-open-tab', tab, sessionId: typeof data.sessionId === 'string' ? data.sessionId : null });
        return;
      }
    } catch {
      // No client list (an older browser): fall through and open a window instead.
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

/** The app tells the worker when the badge should change (chat opened, messages read). */
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'nooki-badge') return;
  const count = Number(data.count);
  event.waitUntil(setAppBadge(Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0));
});
