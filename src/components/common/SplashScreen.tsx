import React from 'react';
import { tokens } from '../../tokens/designTokens';

/** Total splash screen duration in milliseconds — extended to show the full animation. */
export const SPLASH_DURATION_MS = 1500;

export interface SplashScreenProps {
  /**
   * Called when the racing dots have actually finished their run (the green dot is
   * last across the track). Parents use this as the primary "the animation was seen"
   * signal and keep a plain timer only as a fallback — CSS animations do not end at
   * all for reduced-motion users, and their clock can run ahead of the first painted
   * frame on a busy phone, so a wall-clock timer alone can dismiss the splash before
   * the race was ever visible on mobile.
   */
  onAnimationComplete?: () => void;
}

/**
 * Splash screen (~1.5s) displaying the simple "Nooki" wordmark and the two
 * signature pink and green dots racing from one side of the screen to the other.
 */
export const SplashScreen: React.FC<SplashScreenProps> = ({ onAnimationComplete }) => (
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

    {/* Full-width race track where the pink and green dots race from left to right.
        The dots are moved with compositor-driven transforms (see index.css), never
        with `left`: a phone's main thread is busy mounting the app and loading the
        session while the splash is up, and a layout-driven race can burn through its
        timeline unpainted. Horizontal position is owned by the stylesheet, so the
        keyframes, the container-relative distances and the reduced-motion resting
        place all live in one spot. */}
    <div
      data-splash-track
      className="nooki-splash-track"
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
        onAnimationEnd={onAnimationComplete}
        style={{
          position: 'absolute',
          top: '12px',
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
