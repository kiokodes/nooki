/**
 * The splash race is started in two places — by the boot splash in index.html, before the
 * bundle exists, and by the React splash once it does — but it should be *seen* once.
 *
 * On a phone the boot splash is up for as long as the bundle takes to download and parse,
 * which is the slow part of a launch. Replaying the whole race after that (the old
 * behaviour) showed the race twice: the splash appeared to stutter, and the app arrived a
 * full race later than it needed to. index.html records when the boot race began, the app
 * reads it once before the first render, and SplashScreen starts its own copy of the race
 * that far in (a negative `animation-delay`), so the run carries on rather than restarting.
 */

/** The name index.html leaves on `window`. Keep the two in step (a test guards it). */
export const BOOT_RACE_MARKER = '__nookiBootRace';

export interface BootRaceMarker {
  /** When the boot splash race got its first frame, on that page's own clock. */
  startedAt: number;
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Milliseconds of the race that have already been on screen.
 *
 * Zero when the marker is absent — the design preview, the tests, or an index.html served
 * from a cache older than the marker — and zero already means "play the whole race", so no
 * caller needs a special case for it.
 */
export function bootRaceElapsedMs(): number {
  const marker = (globalThis as unknown as Record<string, unknown>)[BOOT_RACE_MARKER] as BootRaceMarker | undefined;
  const startedAt = marker?.startedAt;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return 0;
  return Math.max(0, now() - startedAt);
}
