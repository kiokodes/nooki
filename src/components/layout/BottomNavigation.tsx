import React from 'react';
import {
  MessageCircleHeart,
  Image as ImageIcon,
  Heart,
  MessagesSquare,
  Sparkles,
} from 'lucide-react';
import { nookiTokens } from '../../tokens/designTokens';

export type TabId = 'chat' | 'media' | 'home' | 'discuss' | 'games';

interface TabItem {
  id: TabId;
  label: string;
  icon: React.ComponentType<{ size?: number; color?: string; strokeWidth?: number; fill?: string }>;
  isCenter?: boolean;
}

export const TABS: TabItem[] = [
  { id: 'chat', label: 'Chat', icon: MessageCircleHeart },
  { id: 'media', label: 'Media', icon: ImageIcon },
  { id: 'home', label: 'Home', icon: Heart, isCenter: true },
  { id: 'discuss', label: 'Discuss', icon: MessagesSquare },
  { id: 'games', label: 'Games', icon: Sparkles },
];

interface BottomNavigationProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

export const BottomNavigation: React.FC<BottomNavigationProps> = ({
  activeTab,
  onTabChange,
}) => {
  return (
    <nav
      role="navigation"
      aria-label="Main Navigation"
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: '78px',
        backgroundColor: '#FFFDF9',
        borderTop: `1px solid ${nookiTokens.colors.borderSubtle}`,
        boxShadow: nookiTokens.shadows.navBar,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-around',
        padding: '0 8px 10px 8px',
        zIndex: 100,
        borderBottomLeftRadius: '36px',
        borderBottomRightRadius: '36px',
      }}
    >
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.id;

        // Center highlighted Tab ("Home")
        if (tab.isCenter) {
          return (
            <div
              key={tab.id}
              style={{
                position: 'relative',
                top: '-16px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                cursor: 'pointer',
              }}
              onClick={() => onTabChange(tab.id)}
            >
              <button
                type="button"
                aria-label="Our Nook Home"
                aria-current={isActive ? 'page' : undefined}
                style={{
                  width: '58px',
                  height: '58px',
                  borderRadius: '50%',
                  background: isActive
                    ? `linear-gradient(135deg, #FFAE9B 0%, ${nookiTokens.colors.peachPrimary} 100%)`
                    : `linear-gradient(135deg, #FFD0C5 0%, #FFB6A4 100%)`,
                  border: '4px solid #FFFDF9',
                  boxShadow: isActive
                    ? '0 12px 24px rgba(255, 158, 136, 0.48), 0 3px 8px rgba(92, 64, 51, 0.08)'
                    : '0 8px 18px rgba(92, 64, 51, 0.1)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  transform: isActive ? 'scale(1.05)' : 'scale(1)',
                  transition: 'all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)',
                  color: '#FFFFFF',
                  outline: 'none',
                }}
              >
                <Icon
                  size={26}
                  color="#FFFDF9"
                  strokeWidth={2.4}
                  fill={isActive ? '#FFFDF9' : 'rgba(255, 253, 249, 0.5)'}
                />
              </button>

              <span
                style={{
                  marginTop: '4px',
                  fontSize: '0.74rem',
                  fontWeight: isActive ? 800 : 600,
                  color: isActive
                    ? nookiTokens.colors.peachDeep
                    : nookiTokens.colors.textMuted,
                  letterSpacing: '0.01em',
                  transition: 'color 0.2s ease',
                }}
              >
                {tab.label}
              </span>

              {/* Tiny active storybook dot indicator */}
              {isActive && (
                <div
                  style={{
                    width: '4px',
                    height: '4px',
                    borderRadius: '50%',
                    backgroundColor: nookiTokens.colors.peachDeep,
                    marginTop: '2px',
                  }}
                />
              )}
            </div>
          );
        }

        // Regular 4 navigation tabs
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            aria-label={tab.label}
            aria-current={isActive ? 'page' : undefined}
            style={{
              background: 'transparent',
              border: 'none',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '4px',
              padding: '6px 12px',
              cursor: 'pointer',
              color: isActive
                ? nookiTokens.colors.textPrimary
                : nookiTokens.colors.textMuted,
              transition: 'all 0.2s ease',
              borderRadius: '16px',
              outline: 'none',
              minWidth: '56px',
            }}
          >
            <div
              style={{
                width: '38px',
                height: '32px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '18px',
                backgroundColor: isActive
                  ? tab.id === 'games'
                    ? nookiTokens.colors.lavenderSurface
                    : tab.id === 'discuss'
                    ? nookiTokens.colors.sageSurface
                    : tab.id === 'media'
                    ? nookiTokens.colors.greenSurface
                    : nookiTokens.colors.peachSurface
                  : 'transparent',
                transition: 'all 0.25s cubic-bezier(0.34, 1.4, 0.7, 1)',
                transform: isActive ? 'scale(1.08)' : 'scale(1)',
              }}
            >
              <Icon
                size={22}
                strokeWidth={isActive ? 2.5 : 2}
                color={
                  isActive
                    ? tab.id === 'games'
                      ? nookiTokens.colors.lavenderDeep
                      : tab.id === 'discuss'
                      ? nookiTokens.colors.sageDeep
                      : tab.id === 'media'
                      ? nookiTokens.colors.greenDeep
                      : nookiTokens.colors.peachDeep
                    : nookiTokens.colors.textMuted
                }
              />
            </div>

            <span
              style={{
                fontSize: '0.72rem',
                fontWeight: isActive ? 800 : 600,
                color: isActive
                  ? nookiTokens.colors.textPrimary
                  : nookiTokens.colors.textMuted,
                letterSpacing: '0.01em',
              }}
            >
              {tab.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
};
