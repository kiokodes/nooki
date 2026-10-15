import React, { useEffect, useState } from 'react';
import { NookiPair } from '../common/NookiPair';
import { COMPANION_ASSETS } from '../../lib/companionAssets';
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
const AMBIENT_WEIGHTS: Record<string, number> = {
  happy: 35,
  affectionate: 25,
  laughing: 15,
  shy: 15,
  surprised: 10,
};

const EXPRESSION_ORDER: Array<import('../../types/companions').CompanionExpression> = [
  'happy',
  'affectionate',
  'laughing',
  'shy',
  'surprised',
];

function pickNextAmbient(current: string): import('../../types/companions').CompanionExpression {
  // Weighted pick among the 4 not-current, so they never freeze on one frame
  const pool = EXPRESSION_ORDER.filter((e) => e !== current);
  const total = pool.reduce((sum, e) => sum + (AMBIENT_WEIGHTS[e] ?? 10), 0);
  let r = Math.random() * total;
  for (const e of pool) {
    r -= AMBIENT_WEIGHTS[e] ?? 10;
    if (r <= 0) return e;
  }
  return pool[0] ?? 'happy';
}

function dwellFor(expression: string): number {
  // Cozy pacing: surprise is a brief pop, laughing is a short giggle, the rest linger
  if (expression === 'surprised') return 2200 + Math.random() * 1300; // 2.2–3.5s
  if (expression === 'laughing') return 3000 + Math.random() * 1500; // 3–4.5s
  if (expression === 'shy') return 3800 + Math.random() * 1800; // 3.8–5.6s
  return 4200 + Math.random() * 2600; // happy / affectionate: 4.2–6.8s
}

export const HomeNookiCompanions: React.FC<HomeNookiCompanionsProps> = ({
  expression = 'happy',
  paused = false,
  ambient = false,
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

  // --- Ambient living theatre (watch-only) -------------------------------
  // When ambient is true we softly crossfade between the five flattened
  // pair illustrations. The whole stack still breathes with the same
  // 5s idle, but the expression itself drifts so the box feels alive.
  // Timers respect shouldAnimate / prefersReducedMotion / visibility.
  const [displayExpr, setDisplayExpr] = useState<import('../../types/companions').CompanionExpression>(
    () => (EXPRESSION_ORDER.includes(expression as any) ? (expression as any) : 'happy'),
  );
  const [overlayExpr, setOverlayExpr] = useState<import('../../types/companions').CompanionExpression>(displayExpr);
  const [isFading, setIsFading] = useState(false);

  // Keep ambient start in sync if the caller changes the initial expression
  // while ambient is off. When ambient is on we let the theatre run.
  useEffect(() => {
    if (!ambient) {
      const safe = EXPRESSION_ORDER.includes(expression as any) ? (expression as any) : 'happy';
      setDisplayExpr(safe);
      setOverlayExpr(safe);
      setIsFading(false);
    }
  }, [expression, ambient]);

  // Pre-warm the five images so crossfades never flash
  useEffect(() => {
    if (!ambient || typeof window === 'undefined' || prefersReducedMotion) return;
    Object.values(COMPANION_ASSETS).forEach((src) => {
      const img = new window.Image();
      img.src = src;
    });
  }, [ambient, prefersReducedMotion]);

  useEffect(() => {
    if (!ambient || !shouldAnimate || prefersReducedMotion) return;
    if (renderAnimation) return; // slot takes over

    // Dwell on the current display, then crossfade to a new expression
    const dwellMs = dwellFor(displayExpr) + (Math.random() * 600 - 300); // ±300ms jitter
    let dwellId: number | undefined;
    let triggerId: number | undefined;
    let fadeId: number | undefined;

    dwellId = window.setTimeout(() => {
      const next = pickNextAmbient(displayExpr);
      setOverlayExpr(next);
      // Next frame so the browser sees overlay at 0 before we fade to 1
      triggerId = window.setTimeout(() => setIsFading(true), 20);
      fadeId = window.setTimeout(() => {
        setDisplayExpr(next);
        setIsFading(false);
      }, 420); // 380ms CSS + 40ms grace
    }, dwellMs);

    return () => {
      if (dwellId !== undefined) window.clearTimeout(dwellId);
      if (triggerId !== undefined) window.clearTimeout(triggerId);
      if (fadeId !== undefined) window.clearTimeout(fadeId);
    };
  }, [ambient, shouldAnimate, prefersReducedMotion, renderAnimation, displayExpr]);

  // When paused / hidden / reduced-motion, snap the theatre closed
  useEffect(() => {
    if (!shouldAnimate && isFading) setIsFading(false);
  }, [shouldAnimate, isFading]);

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
      ) : ambient && !prefersReducedMotion ? (
        // Ambient living theatre — watch-only. Same breathing wrapper so
        // existing tests for .nooki-companions-idle / .nooki-companions-art
        // keep passing, but the inside crossfades between the five flattened
        // illustrations on a cozy dwell. Nothing is clickable.
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
            <div
              className="nooki-living-stack"
              data-living="true"
              data-fading={isFading ? 'true' : 'false'}
              style={{
                position: 'relative',
                width: '100%',
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <div
                className="nooki-living-layer nooki-living-base"
                data-layer="base"
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: isFading ? 0 : 1,
                }}
              >
                <NookiPair
                  expression={displayExpr}
                  decorative={true}
                  style={{
                    width: '100%',
                    height: '100%',
                    maxHeight: '100%',
                    maxWidth: '100%',
                  }}
                />
              </div>
              <div
                className="nooki-living-layer nooki-living-overlay"
                data-layer="overlay"
                data-fading={isFading ? 'true' : 'false'}
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: isFading ? 1 : 0,
                }}
              >
                <NookiPair
                  expression={overlayExpr}
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
          </div>
        </div>
      ) : (
        // Single static expression (used by tests and when ambient is off)
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
