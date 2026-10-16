import { useCallback, useEffect, useState } from 'react';
import {
  currentPushSubscription,
  describePushSupport,
  detectPushEnvironment,
  disablePushNotifications,
  enablePushNotifications,
  pushConfigurationError,
  refreshPushRegistration,
  type PushSupport,
} from '../lib/pushService';

export interface PushNotificationsState {
  /** What this browser can do, before permission enters the picture. */
  support: PushSupport;
  /** This device is subscribed *and* the database knows about it for this account. */
  enabled: boolean;
  /** A request is in flight: permission prompt, subscribe, or release. */
  busy: boolean;
  /** Why it could not be turned on, in a sentence worth reading on a phone. */
  error: string | null;
  /**
   * The deployment itself is not finished (no VAPID public key): only the app owner can
   * fix it, so this is shown as-is rather than as a user mistake.
   */
  configurationError: string | null;
  /** Turn notifications on for this device. Must be called from a tap. */
  enable: () => Promise<void>;
  /** Turn notifications off for this device, leaving other devices alone. */
  disable: () => Promise<void>;
  clearError: () => void;
}

interface UsePushNotificationsOptions {
  /** The signed-in account, or null before sign-in. */
  userId: string | null;
  /** The couple whose messages would be announced, or null while unpaired. */
  coupleId: string | null;
}

/** What the browser can do right now, read without touching any React state. */
function readSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  const permission: NotificationPermission | 'unsupported' = typeof window.Notification !== 'undefined'
    ? window.Notification.permission
    : 'unsupported';
  return describePushSupport(detectPushEnvironment(), permission);
}

/**
 * This device's push state, owned by the app rather than by the settings modal: the
 * answer decides whether the home-screen icon is badged, and the deep link a notification
 * carries is read before the first render.
 *
 * Nothing here asks for permission on load. Safari ignores a prompt that did not come
 * from a tap, and Android users deserve to see the switch before the OS dialog.
 */
export function usePushNotifications({ userId, coupleId }: UsePushNotificationsOptions): PushNotificationsState {
  const scope = userId && coupleId ? `${userId}:${coupleId}` : null;
  // Only the app owner can fix a missing key, and it is baked in at build time, so it is
  // read straight out of the environment on every render rather than held as state.
  const configurationError = pushConfigurationError();

  // What this browser can do, read once during the first render. The two things that can
  // change it — a Home Screen install and a permission decision — both need the app
  // relaunched before they take effect on iOS, and both then re-mount this.
  const [support, setSupport] = useState<PushSupport>(readSupport);

  // Whether the database knows this device for *this* account, tagged with the account it
  // was verified for: switching couple, or signing out, must never leave the switch reading
  // "on" while nothing would actually arrive.
  const [verified, setVerified] = useState<{ scope: string; enabled: boolean } | null>(null);
  const enabled = Boolean(scope && verified?.scope === scope && verified.enabled);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A browser subscription can outlive the database row (a cleared table, a sign-out that
  // deliberately kept it) and can point at a couple that has since changed. Re-claiming it
  // on load is what keeps a phone that already said yes reachable without asking again.
  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    void (async () => {
      try {
        if (!(await currentPushSubscription())) {
          if (!cancelled) setVerified({ scope, enabled: false });
          return;
        }
        const stored = await refreshPushRegistration();
        if (!cancelled) setVerified({ scope, enabled: stored });
      } catch {
        // A device that cannot be checked is simply shown as off; the switch retries.
        if (!cancelled) setVerified({ scope, enabled: false });
      }
    })();
    return () => { cancelled = true; };
  }, [scope]);

  const enable = useCallback(async () => {
    if (!scope) return;
    setBusy(true);
    setError(null);
    try {
      await enablePushNotifications();
      setVerified({ scope, enabled: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Notifications could not be turned on. Please try again.');
      // A refusal is usually a decision the browser remembers; re-read it so the card can
      // say "blocked in settings" instead of offering the same switch again.
      setSupport(readSupport());
    } finally {
      setBusy(false);
    }
  }, [scope]);

  const disable = useCallback(async () => {
    if (!scope) return;
    setBusy(true);
    setError(null);
    try {
      await disablePushNotifications();
      setVerified({ scope, enabled: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Notifications could not be turned off. Please try again.');
    } finally {
      setBusy(false);
    }
  }, [scope]);

  const clearError = useCallback(() => setError(null), []);

  return { support, enabled, busy, error, configurationError, enable, disable, clearError };
}
