import React from 'react';
import { nookiTokens } from '../../tokens/designTokens';

interface StoryCardProps {
  children: React.ReactNode;
  variant?: 'surface' | 'peach' | 'green' | 'lavender' | 'sage';
  hasBorder?: boolean;
  style?: React.CSSProperties;
  className?: string;
  onClick?: () => void;
}

export const StoryCard: React.FC<StoryCardProps> = ({
  children,
  variant = 'surface',
  hasBorder = true,
  style,
  className = '',
  onClick,
}) => {
  const getBg = () => {
    switch (variant) {
      case 'peach':
        return nookiTokens.colors.peachSurface;
      case 'green':
        return nookiTokens.colors.greenSurface;
      case 'lavender':
        return nookiTokens.colors.lavenderSurface;
      case 'sage':
        return nookiTokens.colors.sageSurface;
      case 'surface':
      default:
        return nookiTokens.colors.bgSurface;
    }
  };

  const getBorderColor = () => {
    if (!hasBorder) return 'transparent';
    switch (variant) {
      case 'peach':
        return nookiTokens.colors.borderWarm;
      case 'green':
        return '#CCE8D4';
      case 'lavender':
        return '#DFD4F2';
      case 'sage':
        return '#D4DEC9';
      default:
        return nookiTokens.colors.borderSubtle;
    }
  };

  return (
    <div
      className={`nooki-card ${className}`}
      onClick={onClick}
      style={{
        backgroundColor: getBg(),
        borderRadius: nookiTokens.radii.card,
        boxShadow: nookiTokens.shadows.card,
        border: `1px solid ${getBorderColor()}`,
        padding: '20px',
        transition: 'all 0.25s cubic-bezier(0.34, 1.45, 0.7, 1)',
        cursor: onClick ? 'pointer' : 'default',
        ...style,
      }}
    >
      {children}
    </div>
  );
};
