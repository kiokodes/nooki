import React, { useState } from 'react';
import type { CompanionExpression, NookiPairProps } from '../../types/companions';
import { COMPANION_ASSETS, COMPANION_ALTS } from '../../lib/companionAssets';

/**
 * NookiPair — Reusable character illustration renderer implementing component-contract.json.
 *
 * Rules:
 * 1. Accepts the 5 expressions, defaulting and falling back safely to 'happy'.
 * 2. Enforces 1:1 aspect ratio and object-fit: contain so heads/puffs/feet are never cropped or stretched.
 * 3. Keeps pointer-events disabled so decorative artwork never intercepts clicks or touch gestures.
 * 4. Excluded from screen readers when decorative={true} (default).
 */
export const NookiPair: React.FC<NookiPairProps> = ({
  expression = 'happy',
  width,
  height,
  decorative = true,
  accessibleLabel,
  className,
  style,
}) => {
  const [loadError, setLoadError] = useState(false);

  // Validate expression key; fall back to 'happy' if unknown
  const validExpression: CompanionExpression =
    expression in COMPANION_ASSETS ? expression : 'happy';

  const assetSrc = loadError
    ? COMPANION_ASSETS.happy
    : COMPANION_ASSETS[validExpression];

  const altText = decorative
    ? ''
    : (accessibleLabel || COMPANION_ALTS[validExpression]);

  const resolvedWidth = typeof width === 'number' ? `${width}px` : width;
  const resolvedHeight = typeof height === 'number' ? `${height}px` : height;

  return (
    <img
      src={assetSrc}
      alt={altText}
      role={decorative ? 'presentation' : 'img'}
      aria-hidden={decorative ? true : undefined}
      onError={() => {
        if (!loadError && validExpression !== 'happy') {
          setLoadError(true);
        }
      }}
      className={className}
      data-expression={validExpression}
      data-nooki-pair
      style={{
        display: 'block',
        aspectRatio: '1 / 1',
        objectFit: 'contain',
        width: resolvedWidth || '100%',
        height: resolvedHeight || '100%',
        maxWidth: '100%',
        maxHeight: '100%',
        pointerEvents: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        ...style,
      }}
    />
  );
};

export default NookiPair;
