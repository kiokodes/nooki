import React, { useEffect, useState } from 'react';
import { NookiPair } from '../common/NookiPair';
import type { HomeNookiCompanionsProps } from '../../types/companions';

/**
 * HomeNookiCompanions — A quiet, affectionate home-screen companion presence.
 *
 * Placed in the reserved slot immediately above the bottom navigation.
 * Features:
 * - Adult-chibi partners sharing a cozy moment: bald/pink + afro-puff/green.
 * - Restrained whole-illustration idle effect (5s ease-in-out, 1.5px vertical, ~1% scale, anchored at feet).
 * - Pauses automatically when tab/window is hidden or when prefers-reduced-motion is enabled.
 * - Decouples layout from rendering so a future finished animation loop can be dropped in cleanly.
 * - Keeps decorative artwork out of hit-testing and accessibility focus.
 */
export const HomeNookiCompanions: React.FC<HomeNookiCompanionsProps> = ({
  expression = 'happy',
  paused = false,
  renderAnimation,
  className,
  style,
}) => {
  // Respect platform's reduced-motion setting
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  // Track document visibility to pause animation off-screen
  const [isDocumentVisible, setIsDocumentVisible] = useState(() => {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Listen to prefers-reduced-motion changes if supported
    let motionMedia: MediaQueryList | null = null;
    let handleMotionChange: ((e: MediaQueryListEvent) => void) | null = null;

    if (typeof window.matchMedia === 'function') {
      motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
      handleMotionChange = (e: MediaQueryListEvent) => {
        setPrefersReducedMotion(e.matches);
      };
      motionMedia.addEventListener?.('change', handleMotionChange);
    }

    // Listen to visibility changes (e.g. tab switches, lock screen, backgrounding)
    const handleVisibilityChange = () => {
      setIsDocumentVisible(document.visibilityState !== 'hidden');
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      if (motionMedia && handleMotionChange) {
        motionMedia.removeEventListener?.('change', handleMotionChange);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, []);

  const shouldAnimate = !prefersReducedMotion && isDocumentVisible && !paused;

  return (
    <div
      data-component="home-nooki-companions"
      data-companions-active={shouldAnimate ? 'true' : 'false'}
      role="presentation"
      aria-hidden="true"
      className={className}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
        position: 'relative',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        ...style,
      }}
    >
      {renderAnimation && !prefersReducedMotion ? (
        // Extension slot for future finished transparent animation loop
        renderAnimation({
          isPaused: !shouldAnimate,
          prefersReducedMotion,
        })
      ) : (
        // Current usable version: static pair with restrained whole-illustration idle
        <div
          className={`nooki-companions-wrapper ${shouldAnimate ? 'nooki-companions-idle' : 'nooki-companions-paused'}`}
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            maxHeight: '180px',
            aspectRatio: '1 / 1',
          }}
        >
          <div
            className="nooki-companions-art"
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transformOrigin: '50% 83.5%', // Anchored at feet (based on manifest bounds y=0.835)
              animationPlayState: shouldAnimate ? 'running' : 'paused',
            }}
          >
            <NookiPair
              expression={expression}
              decorative={true}
              style={{
                width: '100%',
                height: '100%',
                maxHeight: '100%',
                maxWidth: '100%',
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default HomeNookiCompanions;
