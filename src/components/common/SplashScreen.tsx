import React from 'react';
import { tokens } from '../../tokens/designTokens';

/** Total splash screen duration in milliseconds — kept strictly under 0.5 seconds (500ms). */
export const SPLASH_DURATION_MS = 450;

/**
 * Fast (< 0.5s) splash screen displaying the simple "Nooki" wordmark and the two
 * signature pink and green dots racing from one side of the screen to the other.
 */
export const SplashScreen: React.FC = () => (
  <section
    data-screen="splash"
    role="status"
    aria-label="Loading Nooki"
    style={{
      flex: 1,
      width: '100%',
      height: '100%',
      backgroundColor: tokens.colors.bgCanvas,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '18px',
      overflow: 'hidden',
      userSelect: 'none',
    }}
  >
    <span
      data-splash-wordmark
      className="nooki-splash-wordmark"
      style={{
        fontSize: '2.25rem',
        fontWeight: 800,
        color: tokens.colors.textPrimary,
        letterSpacing: '-0.02em',
        lineHeight: 1.1,
      }}
    >
      Nooki
    </span>

    {/* Full-width race track where the pink and green dots race from left to right in < 0.5s */}
    <div
      data-splash-track
      aria-hidden="true"
      style={{
        position: 'relative',
        width: '100%',
        height: '24px',
        overflow: 'hidden',
      }}
    >
      <span
        data-splash-dot="pink"
        className="nooki-splash-dot nooki-splash-dot--pink"
        style={{
          position: 'absolute',
          top: '2px',
          left: '-4%',
          width: '10px',
          height: '10px',
          borderRadius: tokens.radii.full,
          backgroundColor: tokens.colors.primaryPinkDeep,
          boxShadow: '0 0 10px rgba(236, 72, 153, 0.45)',
        }}
      />
      <span
        data-splash-dot="green"
        className="nooki-splash-dot nooki-splash-dot--green"
        style={{
          position: 'absolute',
          top: '12px',
          left: '-4%',
          width: '10px',
          height: '10px',
          borderRadius: tokens.radii.full,
          backgroundColor: tokens.colors.primaryGreenDeep,
          boxShadow: '0 0 10px rgba(5, 150, 105, 0.4)',
        }}
      />
    </div>
  </section>
);

export default SplashScreen;
