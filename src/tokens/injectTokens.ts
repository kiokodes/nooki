import { nookiTokens } from './designTokens';

/**
 * Injects CSS Custom Properties into document root matching nookiTokens
 * Allows pure CSS / styled components to reference tokens with standard var(--nooki-*)
 */
export function injectTokensToCSS() {
  const root = document.documentElement;

  // Colors
  Object.entries(nookiTokens.colors).forEach(([key, val]) => {
    root.style.setProperty(`--nooki-color-${toKebabCase(key)}`, val);
  });

  // Radii
  Object.entries(nookiTokens.radii).forEach(([key, val]) => {
    root.style.setProperty(`--nooki-radius-${toKebabCase(key)}`, val);
  });

  // Shadows
  Object.entries(nookiTokens.shadows).forEach(([key, val]) => {
    root.style.setProperty(`--nooki-shadow-${toKebabCase(key)}`, val);
  });

  // Spacing
  Object.entries(nookiTokens.spacing).forEach(([key, val]) => {
    root.style.setProperty(`--nooki-space-${toKebabCase(key)}`, val);
  });
}

function toKebabCase(str: string): string {
  return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}
