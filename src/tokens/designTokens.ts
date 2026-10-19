/**
 * Nooki Design System Tokens
 * Mobile-first couples app for long-distance partners
 * Style: warm, playful, cozy, storybook-like, airy, and spacious
 * Light mode only
 */

export const tokens = {
  colors: {
    // Canvas & backgrounds (warm cream palette)
    bgCanvas: '#FAF6EE',         // Warm cream page background
    bgDesktop: '#F1EBE1',        // Centered wrapper background on desktop
    bgSurface: '#FFFFFF',        // Clean warm white card surface
    bgSurfaceSubtle: '#FBF8F3',  // Subtle secondary tint

    // Primary Brand Duo (Blush baby pink & pastel green)
    primaryPink: '#F9A8D4',      // Soft blush baby pink
    primaryPinkSoft: '#FCE7F3',  // Light baby pink wash
    primaryPinkDeep: '#EC4899',  // Accent baby pink

    primaryGreen: '#A7F3D0',     // Gentle pastel mint green
    primaryGreenSoft: '#ECFDF5', // Pale pastel green wash
    primaryGreenDeep: '#059669', // Grounded green accent

    // Storybook Accents (Soft Lavender & Sage)
    accentLavender: '#DDD6FE',  // Soft storybook lavender
    accentLavenderSoft: '#F5F3FF',
    accentLavenderDeep: '#7C3AED',

    accentSage: '#CBD5C0',      // Soft muted sage
    accentSageSoft: '#F4F7F2',
    accentSageDeep: '#5F7154',

    // Typography & Ink (warm, soft contrast - no harsh solid blacks)
    textPrimary: '#372E29',     // Warm espresso cocoa
    textSecondary: '#7A6E65',   // Gentle warm taupe
    textMuted: '#A89E96',       // Airy muted text
    textWhite: '#FFFFFF',

    // Borders
    borderSubtle: '#F0E8DC',
    borderSoft: '#E6DCCF',
  },

  radii: {
    sm: '12px',
    md: '18px',
    lg: '24px',
    card: '32px',               // Large corner radius for cards
    pill: '9999px',             // Pill-shaped buttons & badges
    full: '50%',
  },

  shadows: {
    // Soft, diffused storybook shadows
    subtle: '0 4px 14px rgba(78, 56, 44, 0.04)',
    soft: '0 10px 25px rgba(78, 56, 44, 0.06)',
    card: '0 12px 30px rgba(78, 56, 44, 0.05)',
    navBar: '0 -8px 24px rgba(78, 56, 44, 0.05)',
    highlightPink: '0 10px 22px rgba(249, 168, 212, 0.45)',
    modal: '0 24px 60px rgba(78, 56, 44, 0.24)',
  },

  spacing: {
    xs: '8px',
    sm: '12px',
    md: '16px',
    lg: '24px',
    xl: '32px',
    xxl: '48px',
  },

  typography: {
    fontFamily: "'Quicksand', 'Nunito', -apple-system, BlinkMacSystemFont, sans-serif",
  },
} as const;

export type DesignTokens = typeof tokens;
