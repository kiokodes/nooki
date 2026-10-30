import React from 'react';
import { DEFAULT_LOOK, hairFor, lookColour, OUTFIT_COLOURS, SKIN_TONES } from '../../lib/raiseChildLook';
import type { ChildLook } from '../../lib/raiseChildService';

interface ChildAvatarProps {
  look?: ChildLook | null;
  age: number;
  size?: number;
  label?: string;
}

/**
 * A layered picture of the same child at every age. Small changes only: the head settles,
 * the body grows, and the hair gets a little more of a mind of its own. No state, no
 * animation, nothing to configure beyond the three choices the parents made together.
 */
export const ChildAvatar: React.FC<ChildAvatarProps> = ({ look, age, size = 96, label }) => {
  const safeAge = Math.min(18, Math.max(0, Number.isFinite(age) ? age : 0));
  const skin = lookColour(SKIN_TONES, look?.skin, DEFAULT_LOOK.skin);
  const outfit = lookColour(OUTFIT_COLOURS, look?.outfit, DEFAULT_LOOK.outfit);
  const hair = hairFor(look?.hair);
  const hairColour = look?.hair && look.hair.startsWith('#') ? look.hair : '#4A2F22';

  // A baby is mostly head; a teenager is mostly legs. The whole figure stays in frame.
  const head = 30 + Math.max(0, 6 - safeAge) * 1.6;
  const bodyHeight = 26 + safeAge * 2.1;
  const headY = 46 - head * 0.18;
  const bodyTop = headY + head * 0.86;
  const eyeY = headY + head * 0.16;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 140"
      role="img"
      aria-label={label ?? `A drawing of the child at ${safeAge}`}
      className="raise-child-avatar"
    >
      <ellipse cx="60" cy="128" rx="30" ry="5" fill="#000000" opacity="0.05" />
      {safeAge >= 4 && (
        <>
          <rect x="50" y={bodyTop + bodyHeight * 0.55} width="8" height={bodyHeight * 0.5} rx="4" fill={skin} />
          <rect x="62" y={bodyTop + bodyHeight * 0.55} width="8" height={bodyHeight * 0.5} rx="4" fill={skin} />
        </>
      )}
      <rect
        x={60 - 19}
        y={bodyTop}
        width="38"
        height={bodyHeight}
        rx={Math.min(16, bodyHeight / 2.2)}
        fill={outfit}
      />
      {safeAge >= 3 && (
        <>
          <rect x={60 - 23} y={bodyTop + 4} width="7" height={bodyHeight * 0.62} rx="3.5" fill={outfit} />
          <rect x={60 + 16} y={bodyTop + 4} width="7" height={bodyHeight * 0.62} rx="3.5" fill={outfit} />
        </>
      )}
      <circle cx="60" cy={headY} r={head / 2} fill={skin} />
      {hair === 'curls' && (
        <>
          <circle cx={60 - head * 0.36} cy={headY - head * 0.3} r={head * 0.22} fill={hairColour} />
          <circle cx={60} cy={headY - head * 0.42} r={head * 0.24} fill={hairColour} />
          <circle cx={60 + head * 0.36} cy={headY - head * 0.3} r={head * 0.22} fill={hairColour} />
        </>
      )}
      {hair === 'short' && (
        <path
          d={`M ${60 - head / 2} ${headY - head * 0.02} A ${head / 2} ${head / 2} 0 0 1 ${60 + head / 2} ${headY - head * 0.02} L ${60 + head * 0.34} ${headY - head * 0.24} Q 60 ${headY - head * 0.52} ${60 - head * 0.34} ${headY - head * 0.24} Z`}
          fill={hairColour}
        />
      )}
      {hair === 'buzz' && (
        <path
          d={`M ${60 - head / 2} ${headY} A ${head / 2} ${head / 2} 0 0 1 ${60 + head / 2} ${headY} Z`}
          fill={hairColour}
          opacity="0.92"
        />
      )}
      {hair === 'bun' && (
        <>
          <path
            d={`M ${60 - head / 2} ${headY} A ${head / 2} ${head / 2} 0 0 1 ${60 + head / 2} ${headY} L ${60 + head * 0.4} ${headY - head * 0.2} Q 60 ${headY - head * 0.5} ${60 - head * 0.4} ${headY - head * 0.2} Z`}
            fill={hairColour}
          />
          <circle cx={60 + head * 0.42} cy={headY - head * 0.48} r={head * 0.2} fill={hairColour} />
        </>
      )}
      {hair === 'braid' && (
        <>
          <path
            d={`M ${60 - head / 2} ${headY} A ${head / 2} ${head / 2} 0 0 1 ${60 + head / 2} ${headY} L ${60 + head * 0.4} ${headY - head * 0.2} Q 60 ${headY - head * 0.5} ${60 - head * 0.4} ${headY - head * 0.2} Z`}
            fill={hairColour}
          />
          <rect x={60 + head * 0.34} y={headY - head * 0.05} width={head * 0.17} height={head * 0.75} rx={head * 0.09} fill={hairColour} />
        </>
      )}
      <circle cx={60 - head * 0.17} cy={eyeY} r={Math.max(1.2, head * 0.045)} fill="#3B2A20" />
      <circle cx={60 + head * 0.17} cy={eyeY} r={Math.max(1.2, head * 0.045)} fill="#3B2A20" />
      {safeAge >= 1 && (
        <>
          <circle cx={60 - head * 0.28} cy={eyeY + head * 0.12} r={head * 0.07} fill="#F4A6B8" opacity="0.45" />
          <circle cx={60 + head * 0.28} cy={eyeY + head * 0.12} r={head * 0.07} fill="#F4A6B8" opacity="0.45" />
        </>
      )}
      {safeAge >= 2 && (
        <path
          d={`M ${60 - head * 0.1} ${eyeY + head * 0.18} Q 60 ${eyeY + head * 0.25} ${60 + head * 0.1} ${eyeY + head * 0.18}`}
          stroke="#8B5E4A"
          strokeWidth={Math.max(1, head * 0.035)}
          strokeLinecap="round"
          fill="none"
        />
      )}
    </svg>
  );
};
