import React from 'react';
import { BellRing } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import type { PushNotificationsState } from '../../hooks/usePushNotifications';

interface PushNotificationsCardProps {
  /** This device's push state: what the browser can do, and whether it is on. */
  state: PushNotificationsState;
}

/**
 * The one place notifications are switched on, and the only place the platform rules are
 * explained in words rather than hidden behind a switch that could not work.
 *
 * Everything it shows comes from `state.support`:
 *
 * - `ready`          — a normal switch. The tap is also what asks for permission: Safari
 *                      ignores a cold prompt, so the prompt has to be a consequence of
 *                      this button, never of opening the app.
 * - `needs-install`  — iPhone/iPad in a browser tab. No switch: the Push API does not
 *                      exist there, so the card walks through Share → Add to Home Screen.
 * - `blocked`        — the browser remembers a "no" (or the OS does). The card says where
 *                      to undo it instead of re-asking, which would return the same "no".
 * - `unsupported`    — no service worker (an old browser, or a private window). Nooki
 *                      still works; it just cannot reach a locked phone.
 */
export const PushNotificationsCard: React.FC<PushNotificationsCardProps> = ({ state }) => {
  const { support, enabled, busy, error, configurationError } = state;
  const on = enabled && support === 'ready';

  const switchButton = (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={on ? 'Turn off notifications on this device' : 'Turn on notifications on this device'}
      disabled={busy}
      onClick={() => { void (on ? state.disable() : state.enable()); }}
      style={{
        width: '52px',
        height: '30px',
        borderRadius: tokens.radii.pill,
        border: `1.5px solid ${on ? tokens.colors.primaryPinkDeep : tokens.colors.borderSoft}`,
        backgroundColor: on ? tokens.colors.primaryPink : tokens.colors.bgSurface,
        position: 'relative',
        cursor: busy ? 'not-allowed' : 'pointer',
        opacity: busy ? 0.6 : 1,
        flexShrink: 0,
        padding: 0,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: '2px',
          left: on ? '24px' : '2px',
          width: '22px',
          height: '22px',
          borderRadius: tokens.radii.full,
          backgroundColor: tokens.colors.textWhite,
          boxShadow: tokens.shadows.subtle,
          transition: 'left 0.18s ease',
        }}
      />
    </button>
  );

  return (
    <div
      data-push-card
      data-push-support={support}
      data-push-enabled={on ? 'true' : 'false'}
      style={{
        border: `1.5px solid ${tokens.colors.borderSubtle}`,
        backgroundColor: tokens.colors.bgSurfaceSubtle,
        borderRadius: tokens.radii.lg,
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <BellRing size={15} color={tokens.colors.primaryPinkDeep} />
        <span style={{ fontSize: '0.86rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
          Notifications
        </span>
      </div>

      {configurationError && support !== 'unsupported' ? (
        <p data-push-owner-note style={{ fontSize: '0.76rem', color: tokens.colors.textSecondary, margin: 0, lineHeight: 1.5 }}>
          Not switched on for this Nooki yet. Ask the app owner to set <strong>VITE_VAPID_PUBLIC_KEY</strong> and
          deploy the <strong>send-push</strong> function — everything else in the app works without it.
        </p>
      ) : support === 'ready' ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
          <span style={{ fontSize: '0.76rem', fontWeight: 700, color: on ? tokens.colors.primaryGreenDeep : tokens.colors.textSecondary }}>
            {busy ? 'Just a moment…' : on ? 'On this device' : 'Off on this device'}
          </span>
          {switchButton}
        </div>
      ) : support === 'needs-install' ? (
        <>
          <p style={{ fontSize: '0.76rem', color: tokens.colors.textSecondary, margin: 0, lineHeight: 1.5 }}>
            On iPhone and iPad, notifications can only reach Nooki once it lives on your Home Screen —
            a Safari tab cannot receive them at all. Two steps, once:
          </p>
          <ol style={{ margin: 0, paddingLeft: '18px', fontSize: '0.76rem', color: tokens.colors.textSecondary, lineHeight: 1.6 }}>
            <li>In Safari, tap <strong>Share</strong> (the square with the arrow) and choose <strong>Add to Home Screen</strong>.</li>
            <li>Open Nooki from its new icon, then come back to this screen and turn notifications on.</li>
          </ol>
        </>
      ) : support === 'blocked' ? (
        <p style={{ fontSize: '0.76rem', color: tokens.colors.textSecondary, margin: 0, lineHeight: 1.5 }}>
          Notifications are blocked for Nooki on this device, so nothing can be sent until you allow them
          again: on iPhone, <strong>Settings → Notifications → Nooki</strong>; in a browser, the padlock or
          site-settings menu for this page.
        </p>
      ) : (
        <p style={{ fontSize: '0.76rem', color: tokens.colors.textSecondary, margin: 0, lineHeight: 1.5 }}>
          This browser cannot receive notifications — Nooki still shows every message in the app, and
          nothing else changes. A phone added to the Home Screen, or another browser, can be switched on here.
        </p>
      )}

      {error && (
        <span role="alert" data-push-error style={{ fontSize: '0.76rem', color: '#B91C1C', fontWeight: 700 }}>
          {error}
        </span>
      )}
    </div>
  );
};
