import React from 'react';
import type { CSSProperties } from 'react';
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
  /**
   * How much of the race has already been on screen, from the boot splash in index.html
   * (see `bootRaceElapsedMs` in src/lib/bootRace.ts). The race started there, before the
   * bundle existed, and is carried on here rather than played a second time: on a phone the
   * boot splash covers the slow part of a launch, so a replay used to add a whole race to
   * every start. Omitted (0) wherever there was no boot splash — the design preview, the
   * tests — and the whole race plays.
   */
  elapsedMs?: number;
}

/** The one custom property the race is offset by: a negative `animation-delay`, in the
    stylesheet's own terms (see `.nooki-splash-runner` in src/index.css). */
type SplashTrackStyle = CSSProperties & { '--nooki-race-delay'?: string };

/**
 * Splash screen (~1.5s) displaying the simple "Nooki" wordmark and the two
 * signature pink and green dots racing from one side of the screen to the other.
 */
export const SplashScreen: React.FC<SplashScreenProps> = ({ onAnimationComplete, elapsedMs = 0 }) => {
  // Past SPLASH_DURATION_MS the race is over and the splash is only waiting for the last of
  // the session to load, so the dots hold their finishing pose instead of running backwards.
  const headStart = Math.min(Math.max(elapsedMs, 0), SPLASH_DURATION_MS);

  return (
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

      {/* Full-width race track where the pink and green dots race from left to right. Each
          dot rides a full-width runner whose horizontal position lives entirely in the
          stylesheet, so the keyframes, the track-relative distances and the reduced-motion
          resting place all stay in one spot (and the same run is mirrored by the boot splash
          in index.html). The track carries the head start, which the runners inherit. */}
      <div
        data-splash-track
        className="nooki-splash-track"
        aria-hidden="true"
        style={{ '--nooki-race-delay': `-${headStart}ms` } as SplashTrackStyle}
      >
        <span data-splash-dot="pink" className="nooki-splash-runner nooki-splash-runner--pink">
          <span className="nooki-splash-dot nooki-splash-dot--pink" />
        </span>
        <span
          data-splash-dot="green"
          className="nooki-splash-runner nooki-splash-runner--green"
          onAnimationEnd={onAnimationComplete}
        >
          <span className="nooki-splash-dot nooki-splash-dot--green" />
        </span>
      </div>

      {/* Only ever seen when the session load outlasts the race: a quiet line rather than a
          wordmark sitting frozen on a phone that is still talking to the backend. */}
      <span data-splash-waiting className="nooki-splash-waiting">
        Waking up your nook…
      </span>
    </section>
  );
};

export default SplashScreen;
