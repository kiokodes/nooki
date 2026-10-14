import React from 'react';
import { nookiTokens } from '../../tokens/designTokens';
import { StoryBadge } from '../common/StoryBadge';

interface ScreenHeaderProps {
  title: string;
  subtitle?: string;
  badge?: string;
  badgeVariant?: 'peach' | 'green' | 'lavender' | 'sage' | 'honey';
  partnerStatus?: string;
  rightAction?: React.ReactNode;
}

export const ScreenHeader: React.FC<ScreenHeaderProps> = ({
  title,
  subtitle,
  badge,
  badgeVariant = 'peach',
  partnerStatus,
  rightAction,
}) => {
  return (
    <header
      style={{
        padding: '12px 20px 16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <h1
            style={{
              fontSize: '1.45rem',
              fontWeight: 900,
              fontFamily: nookiTokens.typography.fontHeading,
              color: nookiTokens.colors.textPrimary,
              letterSpacing: '-0.02em',
              margin: 0,
            }}
          >
            {title}
          </h1>
          {badge && <StoryBadge label={badge} variant={badgeVariant} />}
        </div>
        {rightAction}
      </div>

      {(subtitle || partnerStatus) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '0.85rem',
            color: nookiTokens.colors.textSecondary,
          }}
        >
          {partnerStatus && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                fontWeight: 600,
              }}
            >
              <span
                style={{
                  width: '8px',
                  height: '8px',
                  borderRadius: '50%',
                  backgroundColor: nookiTokens.colors.greenPrimary,
                  boxShadow: '0 0 6px rgba(136, 201, 153, 0.8)',
                }}
              />
              {partnerStatus}
            </span>
          )}
          {partnerStatus && subtitle && <span>•</span>}
          {subtitle && <span>{subtitle}</span>}
        </div>
      )}
    </header>
  );
};
