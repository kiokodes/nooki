import React, { useState } from 'react';
import { nookiTokens } from './tokens/designTokens';
import { PhoneStatusBar } from './components/layout/PhoneStatusBar';
import { BottomNavigation } from './components/layout/BottomNavigation';
import type { TabId } from './components/layout/BottomNavigation';
import { ScreenHeader } from './components/common/ScreenHeader';

// Screens
import { HomeScreen } from './screens/HomeScreen';
import { ChatScreen } from './screens/ChatScreen';
import { MediaScreen } from './screens/MediaScreen';
import { DiscussScreen } from './screens/DiscussScreen';
import { GamesScreen } from './screens/GamesScreen';
import { SlidersHorizontal, Sparkles } from 'lucide-react';

export const App: React.FC = () => {
  // Default to 'home' tab (center, highlighted, opens by default)
  const [activeTab, setActiveTab] = useState<TabId>('home');
  const [showTokensInspector, setShowTokensInspector] = useState(false);

  // Screen Title & Subtitle mapping
  const getHeaderProps = () => {
    switch (activeTab) {
      case 'home':
        return {
          title: 'Our Nook',
          subtitle: 'Milo & Chloe',
          partnerStatus: 'Chloe is awake',
          badge: 'Together 412 Days',
          badgeVariant: 'peach' as const,
        };
      case 'chat':
        return {
          title: 'Nook Chat',
          subtitle: 'Direct heartbeat & whisper channel',
          partnerStatus: 'Active now',
          badge: 'Online',
          badgeVariant: 'green' as const,
        };
      case 'media':
        return {
          title: 'Shared Media',
          subtitle: 'Music, audio notes & photo memories',
          badge: 'Keepsakes',
          badgeVariant: 'green' as const,
        };
      case 'discuss':
        return {
          title: 'The Square',
          subtitle: 'Public Nook & couple prompt decks',
          badge: 'Community',
          badgeVariant: 'sage' as const,
        };
      case 'games':
        return {
          title: 'Mini-Games',
          subtitle: 'Play, draw & unlock Nookies decor',
          badge: 'Playful',
          badgeVariant: 'lavender' as const,
        };
    }
  };

  const renderActiveScreen = () => {
    switch (activeTab) {
      case 'home':
        return <HomeScreen />;
      case 'chat':
        return <ChatScreen />;
      case 'media':
        return <MediaScreen />;
      case 'discuss':
        return <DiscussScreen />;
      case 'games':
        return <GamesScreen />;
    }
  };

  const headerProps = getHeaderProps();

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        backgroundColor: nookiTokens.colors.bgDesktop,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px 10px',
        fontFamily: nookiTokens.typography.fontFamily,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Quick Design System Tokens Drawer Toggle */}
      <button
        onClick={() => setShowTokensInspector(!showTokensInspector)}
        title="View Design Tokens"
        style={{
          position: 'fixed',
          top: '18px',
          right: '18px',
          backgroundColor: '#FFFDF9',
          border: `1px solid ${nookiTokens.colors.borderSubtle}`,
          borderRadius: nookiTokens.radii.pill,
          padding: '8px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '0.82rem',
          fontWeight: 800,
          color: nookiTokens.colors.textPrimary,
          boxShadow: nookiTokens.shadows.soft,
          cursor: 'pointer',
          zIndex: 200,
          transition: 'all 0.2s ease',
        }}
      >
        <SlidersHorizontal size={15} color={nookiTokens.colors.peachDeep} />
        <span>Design Tokens {showTokensInspector ? '✕' : ''}</span>
      </button>

      {/* Centered Phone Shell: Designed specifically for 390px phone screens */}
      <main
        style={{
          width: '390px',
          maxWidth: '100%',
          height: '844px',
          maxHeight: '96vh',
          backgroundColor: nookiTokens.colors.bgCanvas,
          borderRadius: '44px',
          boxShadow: '0 25px 60px -15px rgba(66, 44, 34, 0.2), 0 0 0 10px #302521, 0 0 0 12px rgba(255, 255, 255, 0.15)',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Status Bar */}
        <PhoneStatusBar />

        {/* Dynamic Screen Header */}
        <ScreenHeader
          title={headerProps.title}
          subtitle={headerProps.subtitle}
          partnerStatus={headerProps.partnerStatus}
          badge={headerProps.badge}
          badgeVariant={headerProps.badgeVariant}
          rightAction={
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '50%',
                backgroundColor: nookiTokens.colors.peachSurface,
                border: `1px solid ${nookiTokens.colors.peachSoft}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: nookiTokens.colors.peachDeep,
                fontSize: '1rem',
                cursor: 'pointer',
              }}
              title="Couple Settings"
            >
              👫
            </div>
          }
        />

        {/* Scrollable Screen Content Area */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '4px 18px 20px 18px',
          }}
        >
          {renderActiveScreen()}
        </div>

        {/* Bottom Navigation with 5 tabs: Chat, Media, Home (highlighted), Discuss, Games */}
        <BottomNavigation activeTab={activeTab} onTabChange={setActiveTab} />
      </main>

      {/* Floating Design Token Inspector Modal/Card */}
      {showTokensInspector && (
        <div
          style={{
            position: 'fixed',
            top: '70px',
            right: '18px',
            width: '320px',
            maxHeight: '80vh',
            overflowY: 'auto',
            backgroundColor: '#FFFDF9',
            borderRadius: '24px',
            padding: '20px',
            boxShadow: nookiTokens.shadows.float,
            border: `1.5px solid ${nookiTokens.colors.borderSubtle}`,
            zIndex: 300,
            fontSize: '0.82rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '12px' }}>
            <Sparkles size={16} color={nookiTokens.colors.peachDeep} />
            <h4 style={{ margin: 0, fontWeight: 900, fontSize: '0.95rem' }}>
              Nooki Design Tokens
            </h4>
          </div>
          <p style={{ color: nookiTokens.colors.textMuted, fontSize: '0.76rem', marginBottom: '14px' }}>
            Central design tokens defined in <code>/src/tokens/designTokens.ts</code>. Change values there to restyle the whole app.
          </p>

          <div style={{ marginBottom: '16px' }}>
            <strong style={{ fontSize: '0.78rem', color: nookiTokens.colors.textSecondary }}>
              PALETTE &amp; TOKENS
            </strong>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
              {[
                { name: 'Canvas (Cream)', val: nookiTokens.colors.bgCanvas },
                { name: 'Peach Primary', val: nookiTokens.colors.peachPrimary },
                { name: 'Peach Soft', val: nookiTokens.colors.peachSoft },
                { name: 'Green Primary', val: nookiTokens.colors.greenPrimary },
                { name: 'Green Soft', val: nookiTokens.colors.greenSoft },
                { name: 'Lavender Primary', val: nookiTokens.colors.lavenderPrimary },
                { name: 'Sage Primary', val: nookiTokens.colors.sagePrimary },
                { name: 'Honey Currency', val: nookiTokens.colors.honeyPrimary },
                { name: 'Cocoa Text', val: nookiTokens.colors.textPrimary },
              ].map((token) => (
                <div key={token.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div
                      style={{
                        width: '16px',
                        height: '16px',
                        borderRadius: '6px',
                        backgroundColor: token.val,
                        border: '1px solid rgba(0,0,0,0.1)',
                      }}
                    />
                    <span>{token.name}</span>
                  </div>
                  <code style={{ fontSize: '0.72rem', color: nookiTokens.colors.textMuted }}>{token.val}</code>
                </div>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <strong style={{ fontSize: '0.78rem', color: nookiTokens.colors.textSecondary }}>
              STORYBOOK RADII
            </strong>
            <div style={{ marginTop: '6px', color: nookiTokens.colors.textSecondary, fontSize: '0.76rem' }}>
              • Cards: <code>{nookiTokens.radii.card}</code><br />
              • Hero Card: <code>{nookiTokens.radii.cardLg}</code><br />
              • Buttons: <code>{nookiTokens.radii.pill}</code>
            </div>
          </div>

          <div>
            <strong style={{ fontSize: '0.78rem', color: nookiTokens.colors.textSecondary }}>
              NOOKI LEXICON
            </strong>
            <div style={{ marginTop: '6px', color: nookiTokens.colors.textSecondary, fontSize: '0.76rem', lineHeight: 1.5 }}>
              • <strong>Our Nook:</strong> The shared couple world<br />
              • <strong>To Nook:</strong> Sending love vibrations<br />
              • <strong>The Daily Nook:</strong> Daily prompt sync<br />
              • <strong>The Square:</strong> Public discussion board<br />
              • <strong>Nookies:</strong> Mini-game & decor currency
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
