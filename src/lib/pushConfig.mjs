// Shared by the browser and the build preflight. Never print key values in errors.

/**
 * The public half of the VAPID keypair. It is a public key in the strict sense — it is
 * handed to the browser, which passes it to its own push service so that service can
 * check that a notification really came from Nooki. Only the *private* half signs
 * anything, and that one never leaves the `send-push` Edge Function secret.
 */
export const VAPID_PUBLIC_KEY_HELP =
  'VITE_VAPID_PUBLIC_KEY must be the public half of the VAPID keypair (run `npx web-push generate-vapid-keys`): a base64url string of about 87 characters. Never put the private key here.';

/** A browser push subscription's endpoint, as the RPC accepts it. */
const ENDPOINT_PATTERN = /^https:\/\//;

/**
 * Returns null when the key could plausibly be a VAPID public key, otherwise a sentence
 * the owner can act on. Deliberately shape-only: the real proof is a browser subscribing,
 * which this file cannot see. Length is bounded rather than exact because a key is
 * base64url (87 characters unpadded for an uncompressed P-256 point) and tools differ on
 * whether they keep the padding.
 */
export function validateVapidPublicKey(key) {
  const value = (key || '').trim();
  if (!value) {
    return 'Push notifications are off: set VITE_VAPID_PUBLIC_KEY to the public half of the VAPID keypair.';
  }
  if (!/^[A-Za-z0-9_-]{80,100}={0,2}$/.test(value)) return VAPID_PUBLIC_KEY_HELP;
  return null;
}

/** True when a key is present and merely needs the shape check. */
export function hasVapidPublicKey(key) {
  return Boolean((key || '').trim());
}

/**
 * The base64url string as bytes, which is what `pushManager.subscribe` wants: Safari and
 * older Chromium builds refuse the raw string, and every browser accepts the buffer.
 */
export function decodeVapidPublicKey(key) {
  const value = (key || '').trim().replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(value);
  // Backed by a plain ArrayBuffer: `applicationServerKey` accepts a BufferSource, and a
  // SharedArrayBuffer-backed view is not one.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The shape check the database applies, mirrored so the app fails with a sentence first. */
export function isPushEndpoint(value) {
  return ENDPOINT_PATTERN.test((value || '').trim());
}
