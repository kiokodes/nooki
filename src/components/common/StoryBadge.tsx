import React from 'react';
import { nookiTokens } from '../../tokens/designTokens';

interface BadgeProps {
  label: string;
  variant?: 'peach' | 'green' | 'lavender' | 'sage' | 'honey';
  icon?: React.ReactNode;
}

export const StoryBadge: React.FC<BadgeProps> = ({ label, variant = 'peach', icon }) => {
  const getStyles = () => {
    switch (variant) {
      case 'peach':
        return { bg: nookiTokens.colors.peachSurface, color: nookiTokens.colors.peachDeep, border: nookiTokens.colors.peachSoft };
      case 'green':
        return { bg: nookiTokens.colors.greenSurface, color: nookiTokens.colors.greenDeep, border: nookiTokens.colors.greenSoft };
      case 'lavender':
        return { bg: nookiTokens.colors.lavenderSurface, color: nookiTokens.colors.lavenderDeep, border: nookiTokens.colors.lavenderSoft };
      case 'sage':
        return { bg: nookiTokens.colors.sageSurface, color: nookiTokens.colors.sageDeep, border: nookiTokens.colors.sageSoft };
      case 'honey':
        return { bg: '#FFF7E6', color: nookiTokens.colors.honeyDeep, border: nookiTokens.colors.honeySoft };
    }
  };

  const s = getStyles();

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '4px 12px',
        backgroundColor: s.bg,
        color: s.color,
        border: `1px solid ${s.border}`,
        borderRadius: nookiTokens.radii.pill,
        fontSize: '0.78rem',
        fontWeight: 800,
        letterSpacing: '0.02em',
      }}
    >
      {icon}
      {label}
    </span>
  );
};
