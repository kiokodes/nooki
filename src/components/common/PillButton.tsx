import React from 'react';
import { nookiTokens } from '../../tokens/designTokens';

export type ButtonVariant = 'peach' | 'green' | 'lavender' | 'sage' | 'soft' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface PillButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

export const PillButton: React.FC<PillButtonProps> = ({
  variant = 'peach',
  size = 'md',
  icon,
  children,
  style,
  ...props
}) => {
  const getVariantStyles = (): React.CSSProperties => {
    switch (variant) {
      case 'peach':
        return {
          background: `linear-gradient(135deg, #FFAE9B 0%, ${nookiTokens.colors.peachPrimary} 100%)`,
          color: nookiTokens.colors.textLight,
          boxShadow: nookiTokens.shadows.glowPeach,
          border: 'none',
        };
      case 'green':
        return {
          background: `linear-gradient(135deg, #99D7A9 0%, ${nookiTokens.colors.greenPrimary} 100%)`,
          color: '#153A1F',
          boxShadow: nookiTokens.shadows.glowGreen,
          border: 'none',
        };
      case 'lavender':
        return {
          background: `linear-gradient(135deg, #D1C1EE 0%, ${nookiTokens.colors.lavenderPrimary} 100%)`,
          color: '#34234C',
          boxShadow: nookiTokens.shadows.glowLavender,
          border: 'none',
        };
      case 'sage':
        return {
          background: `linear-gradient(135deg, #B2C5A9 0%, ${nookiTokens.colors.sagePrimary} 100%)`,
          color: '#1F3118',
          boxShadow: '0 8px 20px rgba(163, 184, 153, 0.4)',
          border: 'none',
        };
      case 'soft':
        return {
          background: nookiTokens.colors.bgSurfaceAlt,
          color: nookiTokens.colors.textPrimary,
          border: `1px solid ${nookiTokens.colors.borderSubtle}`,
          boxShadow: nookiTokens.shadows.subtle,
        };
      case 'ghost':
        return {
          background: 'transparent',
          color: nookiTokens.colors.textSecondary,
          border: 'none',
        };
    }
  };

  const getSizeStyles = (): React.CSSProperties => {
    switch (size) {
      case 'sm':
        return { padding: '8px 16px', fontSize: '0.85rem' };
      case 'md':
        return { padding: '12px 22px', fontSize: '0.95rem' };
      case 'lg':
        return { padding: '16px 28px', fontSize: '1.05rem' };
    }
  };

  return (
    <button
      className="nooki-btn"
      style={{
        borderRadius: nookiTokens.radii.pill,
        fontFamily: nookiTokens.typography.fontFamily,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        fontWeight: 700,
        cursor: 'pointer',
        transition: 'all 0.2s cubic-bezier(0.34, 1.4, 0.65, 1)',
        ...getVariantStyles(),
        ...getSizeStyles(),
        ...style,
      }}
      {...props}
    >
      {icon && <span style={{ display: 'inline-flex', alignItems: 'center' }}>{icon}</span>}
      {children}
    </button>
  );
};
