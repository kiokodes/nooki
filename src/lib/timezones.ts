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
