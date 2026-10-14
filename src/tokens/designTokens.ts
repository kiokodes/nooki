/**
 * Nooki Design System Tokens
 * Mobile-first couples app for long-distance partners
 * Style: warm, playful, cozy, storybook-like
 */

export const nookiTokens = {
  colors: {
    // Canvas & backgrounds (warm cream palette)
    bgCanvas: '#FAF6EE',         // Warm parchment / cream backdrop
    bgDesktop: '#EFE7DA',        // Slightly darker cream for desktop backdrop wrapper
    bgSurface: '#FFFDF9',        // Pure warm ivory card background
    bgSurfaceAlt: '#F5EFE4',     // Muted cream container
    bgSurfaceSubtle: '#FBF8F2',  // Ultra-soft highlight background
    bgOverlay: 'rgba(56, 44, 38, 0.45)', // Warm cocoa semi-transparent overlay

    // Primary Brand Duo (Blush Peach & Pastel Mint Green)
    peachPrimary: '#FF9E88',     // Warm blush peach primary
    peachSoft: '#FFD6CC',        // Soft peach background / tint
    peachDeep: '#E87D64',        // Deep peach hover / active / emphasis
    peachSurface: '#FFF1ED',     // Delicate peach tint for badges & pills

    greenPrimary: '#88C999',     // Friendly pastel mint green primary
    greenSoft: '#D4EEDC',        // Soft pastel green tint
    greenDeep: '#65A877',        // Grounded sage-mint accent
    greenSurface: '#EDF8F1',     // Delicate pastel green wash

    // Storybook Accents (Soft Lavender & Sage)
    lavenderPrimary: '#C3B1E1',  // Soft storybook lavender
    lavenderSoft: '#EBE4F6',     // Lavender mist
    lavenderDeep: '#957FB8',     // Dusky violet accent
    lavenderSurface: '#F6F2FC',  // Lavender card/pill wash

    sagePrimary: '#A3B899',      // Cozy dried sage
    sageSoft: '#DFE7DA',         // Pale sage mist
    sageDeep: '#728867',         // Forest sage
    sageSurface: '#F3F6F1',      // Light sage surface

    // Warm Sunny & Honey Accents (Nook bits / currency / sparkles)
    honeyPrimary: '#F6C26A',     // Nookies / Nook Bits currency gold
    honeySoft: '#FCE7C2',        // Soft butter tint
    honeyDeep: '#D89938',        // Amber gold

    // Typography & Ink (warm cocoa tones instead of harsh black)
    textPrimary: '#3A2E2B',      // Warm espresso cocoa
    textSecondary: '#6B5E59',    // Soft warm taupe
    textMuted: '#9B8E88',        // Muted dusty cocoa
    textLight: '#FFFDF9',        // Ivory text on dark/vibrant pills
    textOnPeach: '#4A2218',      // Contrast text for peach elements
    textOnGreen: '#1C3D24',      // Contrast text for green elements

    // Borders & Dividers
    borderSubtle: '#EFE5D5',     // Soft biscuit border
    borderMedium: '#E2D3BE',     // Outlined card border
    borderWarm: '#F5CDBC',       // Peach-tinted stroke
  },

  radii: {
    xs: '8px',
    sm: '12px',
    md: '16px',
    lg: '22px',
    xl: '28px',
    card: '28px',                // Large corner radius for cozy cards
    cardLg: '34px',              // Storybook Hero card radius
    pill: '9999px',              // Signature pill-shaped buttons
    full: '50%',
  },

  shadows: {
    // Soft, warm, diffused shadows
    subtle: '0 2px 8px rgba(92, 64, 51, 0.04)',
    soft: '0 8px 24px rgba(92, 64, 51, 0.07)',
    card: '0 12px 32px -4px rgba(92, 64, 51, 0.08), 0 2px 6px rgba(92, 64, 51, 0.04)',
    float: '0 18px 38px -6px rgba(92, 64, 51, 0.12), 0 4px 12px rgba(92, 64, 51, 0.06)',
    glowPeach: '0 10px 26px rgba(255, 158, 136, 0.45)',
    glowGreen: '0 10px 26px rgba(136, 201, 153, 0.45)',
    glowLavender: '0 10px 26px rgba(195, 177, 225, 0.45)',
    navBar: '0 -10px 30px rgba(78, 56, 44, 0.06), 0 -1px 2px rgba(78, 56, 44, 0.02)',
    insetSoft: 'inset 0 2px 4px rgba(92, 64, 51, 0.04)',
  },

  spacing: {
    xxs: '4px',
    xs: '8px',
    sm: '12px',
    md: '16px',
    lg: '20px',
    xl: '24px',
    xxl: '32px',
    xxxl: '40px',
  },

  typography: {
    fontFamily: "'Nunito', 'Quicksand', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontHeading: "'Quicksand', 'Nunito', sans-serif",
  },

  transitions: {
    snappy: 'all 0.18s cubic-bezier(0.34, 1.56, 0.64, 1)',
    bouncy: 'all 0.28s cubic-bezier(0.34, 1.45, 0.7, 1)',
    smooth: 'all 0.25s ease-out',
  },
} as const;

export type NookiTokens = typeof nookiTokens;
