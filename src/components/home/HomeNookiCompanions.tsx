import React, { useEffect, useRef, useState } from 'react';
import { NookiPair } from '../common/NookiPair';
import { COMPANION_ASSETS } from '../../lib/companionAssets';
import type { CompanionExpression, HomeNookiCompanionsProps } from '../../types/companions';

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
const EXPRESSION_ORDER: CompanionExpression[] = [
  'happy',
  'affectionate',
  'laughing',
  'shy',
  'surprised',
];

const TOGETHER_EXPRESSIONS: CompanionExpression[] = ['affectionate', 'laughing', 'happy'];
const PARTNER_AWAY_EXPRESSIONS: CompanionExpression[] = ['happy', 'shy'];

function safeExpression(expression: string): CompanionExpression {
  const candidate = expression as CompanionExpression;
  return EXPRESSION_ORDER.includes(candidate) ? candidate : 'happy';
}

const AMBIENT_WEIGHTS: Record<'together' | 'partner-away', Partial<Record<CompanionExpression, number>>> = {
  together: { affectionate: 45, laughing: 35, happy: 20 },
  'partner-away': { happy: 75, shy: 25 },
};

function pickNextAmbient(current: CompanionExpression, partnerOnline: boolean): CompanionExpression {
  // Keep the mood pool in step with live partner presence rather than drifting blindly.
  const mode = partnerOnline ? 'together' : 'partner-away';
  const expressions = partnerOnline ? TOGETHER_EXPRESSIONS : PARTNER_AWAY_EXPRESSIONS;
  const weights = AMBIENT_WEIGHTS[mode];
  const pool = expressions.filter((expression) => expression !== current);
  const total = pool.reduce((sum, expression) => sum + (weights[expression] ?? 10), 0);
  let r = Math.random() * total;
  for (const expression of pool) {
    r -= weights[expression] ?? 10;
    if (r <= 0) return expression;
  }
  return pool[0] ?? (partnerOnline ? 'affectionate' : 'happy');
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
  partnerOnline = false,
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
  // When ambient is true we crossfade between presence-aware expressions:
  // affectionate/laughing/happy together, or happy/shy while the partner is away.
  // The whole stack still breathes with the same 5s idle.
  // Timers respect shouldAnimate / prefersReducedMotion / visibility.
  const [displayExpr, setDisplayExpr] = useState<CompanionExpression>(() => safeExpression(expression));
  const [overlayExpr, setOverlayExpr] = useState<CompanionExpression>(displayExpr);
  const [isFading, setIsFading] = useState(false);
  const requestedExpression = safeExpression(expression);
  const requestedExpressionRef = useRef<CompanionExpression>(requestedExpression);

  // Snap static art to its prop, and crossfade to a new context expression when
  // live presence changes while the ambient theatre is running.
  useEffect(() => {
    if (!ambient) {
      requestedExpressionRef.current = requestedExpression;
      setDisplayExpr(requestedExpression);
      setOverlayExpr(requestedExpression);
      setIsFading(false);
      return;
    }

    if (requestedExpressionRef.current === requestedExpression) return;
    requestedExpressionRef.current = requestedExpression;
    setOverlayExpr(requestedExpression);
    setIsFading(true);
    const fadeId = window.setTimeout(() => {
      setDisplayExpr(requestedExpression);
      setIsFading(false);
    }, 420); // 380ms CSS crossfade + 40ms grace

    return () => window.clearTimeout(fadeId);
  }, [requestedExpression, ambient]);

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
      const next = pickNextAmbient(displayExpr, partnerOnline);
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
  }, [ambient, shouldAnimate, prefersReducedMotion, renderAnimation, displayExpr, partnerOnline]);

  // When paused / hidden / reduced-motion, snap the theatre closed
  useEffect(() => {
    if (!shouldAnimate && isFading) setIsFading(false);
  }, [shouldAnimate, isFading]);

  return (
    <div
      data-component="home-nooki-companions"
      data-companions-active={shouldAnimate ? 'true' : 'false'}
      data-partner-online={partnerOnline ? 'true' : 'false'}
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
        // Ambient living theatre — watch-only. Same breathing wrapper; the
        // expression pool follows partner presence. Nothing is clickable.
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
