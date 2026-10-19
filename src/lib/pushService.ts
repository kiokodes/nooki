import { requireSupabase } from './supabaseClient';
import { describeDatabaseError } from './authService';
import { decodeVapidPublicKey, validateVapidPublicKey } from './pushConfig.mjs';

/**
 * Web Push transport for this browser.
 *
 * The whole feature is standard Web Push: the browser hands over a `PushSubscription`
 * (an endpoint plus its own public keys), we keep it in `push_subscriptions`, and the
 * `send-push` Edge Function encrypts a small payload to it and signs it with Nooki's
 * VAPID keypair. No notification service, SDK or account is involved anywhere — the
 * browser's own push service (FCM, Mozilla autopush, Apple) is the relay, exactly as it
 * is for every native app.
 *
 * What lives here is only the browser half: asking for permission (always from a tap —
 * Safari refuses a cold prompt), subscribing, and telling the database which device
 * belongs to which account. Nothing here ever sends a notification; that is the Edge
 * Function's job, because it needs the service key that must never reach a phone.
 *
 * One platform rule shapes the UI: on iPhone and iPad the Push API only exists for an
 * app added to the Home Screen. A Safari tab cannot subscribe at any API level, which is
 * why `describePushSupport` reports `needs-install` there and the settings card explains
 * Share → Add to Home Screen instead of showing a switch that could not work.
 */

/** Served from `public/`, so it stays outside the bundler and keeps root scope. */
export const NOOKI_SERVICE_WORKER_URL = '/nooki-sw.js';
export const NOOKI_SERVICE_WORKER_SCOPE = '/';

/** `/?nooki=chat` — the deep link a tapped notification carries. */
export const PUSH_DEEP_LINK_PARAM = 'nooki';

/** The tabs a notification may open. Anything else is ignored, not followed. */
export const PUSH_DEEP_LINK_TABS = ['chat', 'together', 'home', 'discuss', 'games'] as const;
export type PushDeepLinkTab = (typeof PUSH_DEEP_LINK_TABS)[number];

/** `media` is the Together tab's old name: deep links already sent keep working. */
const LEGACY_DEEP_LINK_TABS: Record<string, PushDeepLinkTab> = { media: 'together' };

/** What this browser can do, before permission enters the picture. */
export interface PushEnvironment {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  /** Launched from the Home Screen / Dock rather than living in a tab. */
  installed: boolean;
  isIos: boolean;
}

export type PushSupport = 'unsupported' | 'needs-install' | 'blocked' | 'ready';

export function vapidPublicKey(): string {
  return import.meta.env.VITE_VAPID_PUBLIC_KEY || '';
}

/**
 * Null when the app may try to subscribe. A missing or malformed key only switches the
 * feature off — the rest of Nooki (chat, Discuss, books, games) is unaffected, and the
 * settings card says so rather than showing a switch that cannot work.
 */
export function pushConfigurationError(): string | null {
  return validateVapidPublicKey(vapidPublicKey());
}

export function detectPushEnvironment(): PushEnvironment {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { hasServiceWorker: false, hasPushManager: false, hasNotification: false, installed: false, isIos: false };
  }
  const userAgent = navigator.userAgent || '';
  return {
    hasServiceWorker: 'serviceWorker' in navigator,
    // PushManager is absent from every browser that cannot subscribe at all, iOS tabs
    // included — so it is the honest test for "can this thing receive push".
    hasPushManager: typeof (window as { PushManager?: unknown }).PushManager !== 'undefined',
    hasNotification: typeof (window as { Notification?: unknown }).Notification !== 'undefined',
    // Add to Home Screen / Add to Dock, not a bookmark: `display-mode: standalone` covers
    // Android and desktop, `navigator.standalone` is how iOS reports it.
    installed: window.matchMedia?.('(display-mode: standalone)').matches === true
      || (navigator as { standalone?: boolean }).standalone === true,
    // iPadOS 13+ reports itself as a Mac, so touch points are the tell.
    isIos: /iPad|iPhone|iPod/.test(userAgent)
      || (userAgent.includes('Macintosh') && (navigator.maxTouchPoints ?? 0) > 1),
  };
}

/**
 * The one place the platform rules are written down. Ordered, because the first true
 * answer is the one the user needs: an old browser is unsupported before it is anything
 * else, an iPhone tab needs the Home Screen before permission matters at all, and a
 * blocked permission is only relevant once the API actually exists.
 */
export function describePushSupport(
  environment: PushEnvironment,
  permission: NotificationPermission | 'unsupported',
): PushSupport {
  if (!environment.hasServiceWorker) return 'unsupported';
  if (environment.isIos && !environment.installed) return 'needs-install';
  if (!environment.hasPushManager || !environment.hasNotification) return 'unsupported';
  if (permission === 'denied') return 'blocked';
  return 'ready';
}

/** Turns the browser's own refusals into something worth reading on a phone. */
export function describePushError(error: unknown): string {
  const name = (error as { name?: string })?.name;
  const message = error instanceof Error ? error.message : '';
  if (name === 'NotAllowedError' || /denied|permission/i.test(message)) {
    return 'Notifications are blocked for Nooki. Turn them back on in your browser or phone settings, then try again.';
  }
  if (name === 'AbortError') {
    return 'This browser could not set up notifications. If Nooki is open in a private window, try a normal one.';
  }
  if (name === 'InvalidStateError' || name === 'InvalidAccessError') {
    return 'This browser refused the Nooki notification key. Ask the app owner to check VITE_VAPID_PUBLIC_KEY.';
  }
  if (name === 'SecurityError') {
    return 'Notifications need the app served over HTTPS.';
  }
  return message || 'Notifications could not be turned on. Please try again.';
}

/** Registered once per page load; never rejects twice on the same session. */
let registrationPromise: Promise<ServiceWorkerRegistration> | null = null;

export function nookiServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return Promise.reject(new Error('This browser cannot receive notifications.'));
  }
  if (!registrationPromise) {
    registrationPromise = navigator.serviceWorker
      .register(NOOKI_SERVICE_WORKER_URL, { scope: NOOKI_SERVICE_WORKER_SCOPE })
      .then(() => navigator.serviceWorker.ready)
      .catch((error: unknown) => {
        registrationPromise = null;
        throw new Error(describePushError(error));
      });
  }
  return registrationPromise;
}

/**
 * Boot-time registration, called from `main.tsx`. The worker itself caches nothing — it
 * exists to receive pushes and open the right tab — so registering it in development too
 * is harmless, and it means a push that arrives while the app is closed still lands.
 */
export function registerNookiServiceWorker(): void {
  void nookiServiceWorker().catch(() => {
    // No service worker means no push on this browser; the app itself is unaffected.
  });
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration(NOOKI_SERVICE_WORKER_SCOPE);
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

function subscriptionKeys(subscription: PushSubscription): { endpoint: string; p256dh: string; auth: string } {
  const json = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  const endpoint = json.endpoint || subscription.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    throw new Error('This browser returned an incomplete notification subscription. Please try again.');
  }
  return { endpoint, p256dh, auth };
}

/**
 * Keeps the row pointing at this account's *current* couple, whatever changed since: the
 * RPC reads the couple from the caller's own profile, so a phone that has moved (or been
 * paired again) can never leave the address book aimed at the old one.
 */
async function storeSubscription(subscription: PushSubscription): Promise<void> {
  const { endpoint, p256dh, auth } = subscriptionKeys(subscription);
  const { data, error } = await requireSupabase().rpc('register_push_subscription', {
    p_endpoint: endpoint,
    p_p256dh: p256dh,
    p_auth: auth,
  });
  if (error) throw new Error(describeDatabaseError(error));
  if (!data) throw new Error('This device could not be added to your notifications. Please try again.');
}

/**
 * Turn notifications on for this device. Must be called from a real tap: Safari ignores a
 * permission request that did not come from user activation, and Android shows the prompt
 * at the moment of the tap.
 */
export async function enablePushNotifications(): Promise<void> {
  const configurationError = pushConfigurationError();
  if (configurationError) throw new Error(configurationError);
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') {
    throw new Error('This browser cannot receive notifications.');
  }

  const registration = await nookiServiceWorker();
  const permission = await window.Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'Notifications are blocked for Nooki. Turn them back on in your browser or phone settings, then try again.'
      : 'Nooki needs your permission before it can send notifications.');
  }

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    try {
      subscription = await registration.pushManager.subscribe({
        // A push must always show something: a silent one would be a background data
        // channel, which is not what this feature is for.
        userVisibleOnly: true,
        applicationServerKey: decodeVapidPublicKey(vapidPublicKey()),
      });
    } catch (error) {
      throw new Error(describePushError(error));
    }
  }
  await storeSubscription(subscription);
}

/** Turn notifications off on this device: forget it in the database, then in the browser. */
export async function disablePushNotifications(): Promise<void> {
  const subscription = await currentPushSubscription();
  if (!subscription) return;
  const { endpoint } = subscriptionKeys(subscription);
  const { error } = await requireSupabase().rpc('release_push_subscription', { p_endpoint: endpoint });
  if (error) throw new Error(describeDatabaseError(error));
  await subscription.unsubscribe().catch(() => {
    // The row is gone, so the device is already unreachable; a browser that refuses to
    // forget its subscription will simply be re-claimed if notifications come back on.
  });
}

/**
 * Called once on load. A browser subscription can outlive the database row (a cleared
 * project, a reinstall of the row, a sign-out that kept the browser subscription), and
 * it can point at a couple that has since changed. Re-claiming it keeps a device that
 * already said yes reachable — without a browser in the foreground, and without asking
 * the user anything again.
 */
export async function refreshPushRegistration(): Promise<boolean> {
  if (pushConfigurationError()) return false;
  const subscription = await currentPushSubscription();
  if (!subscription) return false;
  try {
    await storeSubscription(subscription);
    return true;
  } catch {
    return false;
  }
}

/**
 * Signing out: unreachable immediately, without touching the browser's own subscription
 * (so signing back in is a single tap rather than a fresh permission prompt).
 *
 * This never throws. Signing out must work on a phone with no network, no configured
 * project and no service worker, so every failure here is swallowed on purpose.
 */
export async function releaseAllPushSubscriptions(): Promise<void> {
  try {
    if (pushConfigurationError()) return;
    await requireSupabase().rpc('release_my_push_subscriptions');
  } catch {
    // Best effort: a device that could not be let go is still harmless, because the next
    // sign-in re-claims it and a missed message is only a missed notification.
  }
}

/**
 * The unread count on the home-screen icon (Badging API), sent to the service worker —
 * which is where Safari and Chromium both implement `setAppBadge`, and the only part of
 * the app that is still running when the phone is locked.
 *
 * Two writers share the icon and both mean the same thing: the worker sets it from a push
 * payload while the app is closed, and the app mirrors its own unread count (dropping to
 * zero the moment the chat is read) while it is open.
 */
export async function setPushBadge(count: number): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration(NOOKI_SERVICE_WORKER_SCOPE);
    const worker = registration?.active;
    if (!worker) return;
    worker.postMessage({ type: 'nooki-badge', count: Math.max(0, Math.floor(count)) });
  } catch {
    // A badge is decoration; never let it throw into a render.
  }
}

/**
 * Reads (and consumes) the deep link a notification carries: `/?nooki=chat`. Returns the
 * tab to open, or null when the URL says nothing or names a tab that does not exist.
 * Consuming it matters — a reload must not keep jumping to the chat.
 */
export function takePushDeepLink(href?: string): PushDeepLinkTab | null {
  if (typeof window === 'undefined') return null;
  try {
    const url = new URL(href ?? window.location.href);
    const value = url.searchParams.get(PUSH_DEEP_LINK_PARAM);
    if (value === null) return null;
    url.searchParams.delete(PUSH_DEEP_LINK_PARAM);
    const cleaned = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, '', cleaned || '/');
    if ((PUSH_DEEP_LINK_TABS as readonly string[]).includes(value)) return value as PushDeepLinkTab;
    return LEGACY_DEEP_LINK_TABS[value] ?? null;
  } catch {
    return null;
  }
}

/**
 * Consumes the optional `session` parameter carried by a Together-time push. It is only
 * an opaque UUID; the app still loads the session through its normal couple-scoped RLS.
 */
export function takeTogetherTimeSessionDeepLink(href?: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const url = new URL(href ?? window.location.href);
    const value = url.searchParams.get('session');
    if (value === null) return null;
    url.searchParams.delete('session');
    const cleaned = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, '', cleaned || '/');
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** A tapped notification's `nooki-open-tab` message, once the worker focuses this window. */
export function isPushOpenTabMessage(data: unknown): data is { type: 'nooki-open-tab'; tab: PushDeepLinkTab; sessionId?: string | null } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const message = data as Record<string, unknown>;
  return message.type === 'nooki-open-tab'
    && typeof message.tab === 'string'
    && (PUSH_DEEP_LINK_TABS as readonly string[]).includes(message.tab)
    && (message.sessionId === undefined || message.sessionId === null || typeof message.sessionId === 'string');
}
