import fallbackTimezones from './timezones.json';

export function getDetectedTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function getTimezones(detectedTimezone: string): string[] {
  // Prefer the browser's current IANA list; retain a bundled list for older browsers.
  let timezones = fallbackTimezones;
  try {
    timezones = Intl.supportedValuesOf('timeZone');
  } catch {
    // Older browsers may not support supportedValuesOf.
  }

  // UTC and detected aliases are not always included in supportedValuesOf.
  return [...new Set(['UTC', detectedTimezone, ...timezones])].sort();
}

/** Whether this browser can actually read a clock in that zone (legacy aliases count as yes). */
export function isKnownTimezone(timezone: string | null | undefined): boolean {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The offset a zone is on right now, as "UTC+1" or "UTC-05:00" — the readable half of a
 * derived timezone, so somebody who picked "Nigeria, Rivers, Port Harcourt" can see at a
 * glance that Nooki concluded Africa/Lagos, and correct it if that is wrong.
 *
 * Null when the zone is unknown here or the browser cannot name its offset: callers drop
 * the label rather than showing "GMT" nonsense.
 */
export function formatTimezoneOffset(timezone: string | null | undefined, now: Date = new Date()): string | null {
  if (!isKnownTimezone(timezone)) return null;
  for (const style of ['shortOffset', 'longOffset'] as const) {
    try {
      const part = new Intl.DateTimeFormat('en-US', { timeZone: timezone as string, timeZoneName: style })
        .formatToParts(now)
        .find((item) => item.type === 'timeZoneName')?.value;
      if (!part) continue;
      // ICU says GMT; everybody else says UTC, and the two mean the same thing here.
      return part.replace(/^GMT/, 'UTC') || null;
    } catch {
      // Try the longer spelling before giving up.
    }
  }
  return null;
}
