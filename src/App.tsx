import React, { useState } from 'react';
import {
  MessageCircle,
  Image as ImageIcon,
  Home as HomeIcon,
  MessageSquare,
  Gamepad2,
  Sparkles,
} from 'lucide-react';
import { tokens } from './tokens/designTokens';

type TabKey = 'chat' | 'media' | 'home' | 'discuss' | 'games';

interface TabConfig {
  key: TabKey;
  label: string;
  icon: React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
  isCenter?: boolean;
  comingSoonSubtitle?: string;
  accentColor: string;
  accentSoft: string;
}

const TABS: TabConfig[] = [
  {
    key: 'chat',
    label: 'Chat',
    icon: MessageCircle,
    comingSoonSubtitle: 'Heartbeat nooks & whisper messages',
    accentColor: tokens.colors.primaryPinkDeep,
    accentSoft: tokens.colors.primaryPinkSoft,
  },
  {
    key: 'media',
    label: 'Media',
    icon: ImageIcon,
    comingSoonSubtitle: 'Synced music, shared books & scrapbooks',
    accentColor: tokens.colors.primaryGreenDeep,
    accentSoft: tokens.colors.primaryGreenSoft,
  },
  {
    key: 'home',
    label: 'Home',
    icon: HomeIcon,
    isCenter: true,
    comingSoonSubtitle: 'Our shared couple space & daily questions',
    accentColor: tokens.colors.primaryPinkDeep,
    accentSoft: tokens.colors.primaryPinkSoft,
  },
  {
    key: 'discuss',
    label: 'Discuss',
    icon: MessageSquare,
    comingSoonSubtitle: 'The Square public board & prompt decks',
    accentColor: tokens.colors.accentSageDeep,
    accentSoft: tokens.colors.accentSageSoft,
  },
  {
    key: 'games',
    label: 'Games',
    icon: Gamepad2,
    comingSoonSubtitle: 'Mini-games & chibi room decoration drops',
    accentColor: tokens.colors.accentLavenderDeep,
    accentSoft: tokens.colors.accentLavenderSoft,
  },
];

export const App: React.FC = () => {
  // Center Home opens by default
  const [activeTab, setActiveTab] = useState<TabKey>('home');

  const currentTab = TABS.find((t) => t.key === activeTab)!;
  const isHome = activeTab === 'home';

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        backgroundColor: tokens.colors.bgDesktop,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: tokens.typography.fontFamily,
      }}
    >
      {/* 390px mobile-first phone screen column */}
      <main
        style={{
          width: '390px',
          height: '100%',
          maxHeight: '844px',
          backgroundColor: tokens.colors.bgCanvas,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: tokens.shadows.card,
          borderRadius: '36px',
          overflow: 'hidden',
        }}
      >
        {/* Simple airy top brand header */}
        <header
          style={{
            padding: '24px 24px 12px 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span
              style={{
                fontSize: '1.25rem',
                fontWeight: 700,
                color: tokens.colors.textPrimary,
                letterSpacing: '-0.02em',
              }}
            >
              Nooki
            </span>
            <span
              style={{
                width: '6px',
                height: '6px',
                borderRadius: tokens.radii.full,
                backgroundColor: tokens.colors.primaryPink,
              }}
            />
          </div>

          <span
            style={{
              fontSize: '0.75rem',
              fontWeight: 600,
              color: tokens.colors.textMuted,
              backgroundColor: tokens.colors.bgSurface,
              padding: '6px 14px',
              borderRadius: tokens.radii.pill,
              boxShadow: tokens.shadows.subtle,
            }}
          >
            Light Mode
          </span>
        </header>

        {/* Minimalist, spacious placeholder screen */}
        <section
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0 28px',
            textAlign: 'center',
          }}
        >
          {/* Card with large corner radius and soft shadow */}
          <div
            style={{
              width: '100%',
              backgroundColor: tokens.colors.bgSurface,
              borderRadius: tokens.radii.card,
              padding: '44px 28px',
              boxShadow: tokens.shadows.card,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '16px',
            }}
          >
            {/* Pill-shaped badge showing tab accent */}
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 16px',
                borderRadius: tokens.radii.pill,
                backgroundColor: currentTab.accentSoft,
                color: currentTab.accentColor,
                fontSize: '0.8rem',
                fontWeight: 700,
              }}
            >
              <Sparkles size={14} />
              <span>{isHome ? 'Welcome Home' : 'Coming Soon'}</span>
            </div>

            {/* Screen Name */}
            <h1
              style={{
                fontSize: '1.9rem',
                fontWeight: 700,
                color: tokens.colors.textPrimary,
                margin: 0,
                letterSpacing: '-0.02em',
              }}
            >
              {currentTab.label}
            </h1>

            {/* Spacey, airy subtitle message */}
            <p
              style={{
                fontSize: '0.92rem',
                color: tokens.colors.textSecondary,
                lineHeight: 1.6,
                maxWidth: '260px',
                margin: 0,
              }}
            >
              {isHome
                ? 'Your cozy shared nook for long-distance partners. Features coming soon!'
                : `${currentTab.comingSoonSubtitle}. Stay tuned!`}
            </p>

            {/* Reusable Pill Button demonstration */}
            <button
              type="button"
              style={{
                marginTop: '12px',
                padding: '12px 28px',
                borderRadius: tokens.radii.pill,
                backgroundColor: isHome
                  ? tokens.colors.primaryPink
                  : tokens.colors.primaryGreen,
                color: isHome ? tokens.colors.textWhite : tokens.colors.textPrimary,
                border: 'none',
                fontWeight: 700,
                fontSize: '0.88rem',
                fontFamily: tokens.typography.fontFamily,
                cursor: 'pointer',
                boxShadow: isHome
                  ? tokens.shadows.highlightPink
                  : tokens.shadows.subtle,
                transition: 'transform 0.15s ease',
              }}
            >
              {isHome ? 'Explore Design Tokens' : 'Notify When Ready'}
            </button>
          </div>
        </section>

        {/* Bottom navigation bar with 5 tabs */}
        <nav
          role="navigation"
          aria-label="Main Navigation"
          style={{
            height: '76px',
            backgroundColor: tokens.colors.bgSurface,
            boxShadow: tokens.shadows.navBar,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-around',
            padding: '0 8px 12px 8px',
            zIndex: 10,
          }}
        >
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;

            // Center tab: Home (icon: Home, larger, highlighted, opens by default)
            if (tab.isCenter) {
              return (
                <div
                  key={tab.key}
                  style={{
                    position: 'relative',
                    top: '-14px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    cursor: 'pointer',
                  }}
                  onClick={() => setActiveTab(tab.key)}
                >
                  <button
                    type="button"
                    aria-label="Home"
                    style={{
                      width: '54px',
                      height: '54px',
                      borderRadius: tokens.radii.full,
                      backgroundColor: tokens.colors.primaryPink,
                      border: `4px solid ${tokens.colors.bgSurface}`,
                      boxShadow: tokens.shadows.highlightPink,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: tokens.colors.textWhite,
                      cursor: 'pointer',
                      outline: 'none',
                      transform: isActive ? 'scale(1.05)' : 'scale(1)',
                      transition: 'transform 0.2s ease',
                    }}
                  >
                    <Icon size={24} strokeWidth={2.4} />
                  </button>
                  <span
                    style={{
                      fontSize: '0.72rem',
                      fontWeight: isActive ? 700 : 600,
                      color: isActive
                        ? tokens.colors.primaryPinkDeep
                        : tokens.colors.textMuted,
                      marginTop: '2px',
                    }}
                  >
                    {tab.label}
                  </span>
                </div>
              );
            }

            // Normal tabs: Chat, Media, Discuss, Games
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                aria-label={tab.label}
                style={{
                  background: 'none',
                  border: 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '4px',
                  cursor: 'pointer',
                  padding: '8px 12px',
                  outline: 'none',
                  color: isActive
                    ? tokens.colors.textPrimary
                    : tokens.colors.textMuted,
                  transition: 'color 0.15s ease',
                }}
              >
                <div
                  style={{
                    width: '32px',
                    height: '28px',
                    borderRadius: tokens.radii.sm,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: isActive ? tab.accentSoft : 'transparent',
                    color: isActive ? tab.accentColor : tokens.colors.textMuted,
                    transition: 'all 0.2s ease',
                  }}
                >
                  <Icon size={20} strokeWidth={isActive ? 2.4 : 2} />
                </div>
                <span
                  style={{
                    fontSize: '0.72rem',
                    fontWeight: isActive ? 700 : 500,
                  }}
                >
                  {tab.label}
                </span>
              </button>
            );
          })}
        </nav>
      </main>
    </div>
  );
};

export default App;
