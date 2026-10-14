import React, { useState, useEffect } from 'react';
import {
  MessageCircle,
  Image as ImageIcon,
  Home as HomeIcon,
  MessageSquare,
  Gamepad2,
  Sparkles,
  Settings,
} from 'lucide-react';
import { tokens } from './tokens/designTokens';
import { AuthView } from './components/auth/AuthView';
import { OnboardingView } from './components/auth/OnboardingView';
import { PairingView } from './components/auth/PairingView';
import { DangerSettingsModal } from './components/common/DangerSettingsModal';
import {
  getCurrentAuthUser,
  fetchProfile,
  fetchCouple,
  signOutUser,
  type MockUser,
} from './lib/authService';
import type { Profile, Couple } from './types/database';

type TabKey = 'chat' | 'media' | 'home' | 'discuss' | 'games';

interface TabConfig {
  key: TabKey;
  label: string;
  icon: React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
  isCenter?: boolean;
  comingSoonSubtitle: string;
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
  // Navigation & Modal State
  const [activeTab, setActiveTab] = useState<TabKey>('home');
  const [showSettings, setShowSettings] = useState(false);

  // Auth & Pairing State
  const [loading, setLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState<MockUser | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [couple, setCouple] = useState<Couple | null>(null);
  const [partner, setPartner] = useState<Profile | null>(null);

  const loadUserData = async () => {
    try {
      const user = await getCurrentAuthUser();
      if (!user) {
        setCurrentUser(null);
        setProfile(null);
        setCouple(null);
        setPartner(null);
        setLoading(false);
        return;
      }

      setCurrentUser(user);
      const userProfile = await fetchProfile(user.id);
      setProfile(userProfile);

      if (userProfile?.couple_id) {
        const coupleInfo = await fetchCouple(userProfile.couple_id);
        if (coupleInfo) {
          setCouple(coupleInfo.couple);
          setPartner(coupleInfo.partner);
        } else {
          setCouple(null);
          setPartner(null);
        }
      } else {
        setCouple(null);
        setPartner(null);
      }
    } catch (err) {
      console.error('Error loading session', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUserData();
  }, []);

  // Poll for partner joining when waiting in couple
  useEffect(() => {
    if (!currentUser || !couple || partner) return;
    const interval = setInterval(async () => {
      const info = await fetchCouple(couple.id);
      if (info && info.partner) {
        setPartner(info.partner);
        setCouple(info.couple);
      }
    }, 2500);
    return () => clearInterval(interval);
  }, [currentUser, couple, partner]);

  const handleSignOut = async () => {
    await signOutUser();
    setShowSettings(false);
    loadUserData();
  };

  // 1. Loading screen
  if (loading) {
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
        <div style={{ color: tokens.colors.textSecondary, fontWeight: 700, fontSize: '0.95rem' }}>
          Loading Nooki...
        </div>
      </div>
    );
  }

  // 2. Authentication View (Sign Up / Sign In with Email & Password)
  if (!currentUser) {
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
          <AuthView onSuccess={loadUserData} />
        </main>
      </div>
    );
  }

  // 3. Onboarding View (Collect First Name, Timezone auto-detected & editable)
  if (!profile || !profile.name) {
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
          <OnboardingView userId={currentUser.id} onComplete={loadUserData} />
        </main>
      </div>
    );
  }

  // 4. Pairing View (Lock app until both partners have joined)
  // Shows Create/Join flow or friendly waiting screen with 6-char code
  const isCoupleComplete = Boolean(couple && partner);

  if (!isCoupleComplete) {
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
          <header
            style={{
              padding: '20px 24px 0 24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ fontSize: '1.2rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
              Nooki
            </span>
            <button
              onClick={handleSignOut}
              style={{
                background: 'none',
                border: 'none',
                color: tokens.colors.textMuted,
                fontSize: '0.8rem',
                cursor: 'pointer',
                fontFamily: tokens.typography.fontFamily,
              }}
            >
              Sign Out
            </button>
          </header>

          <PairingView
            userId={currentUser.id}
            userName={profile.name}
            couple={couple}
            onPairSuccess={loadUserData}
          />
        </main>
      </div>
    );
  }

  // 5. Unlocked Couple App (Both partners joined)
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
        {/* Couple Brand Header */}
        <header
          style={{
            padding: '20px 22px 10px 22px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span
                style={{
                  fontSize: '1.15rem',
                  fontWeight: 800,
                  color: tokens.colors.textPrimary,
                  letterSpacing: '-0.02em',
                }}
              >
                {profile.name} &amp; {partner?.name}
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
            {couple?.anniversary_date && (
              <span style={{ fontSize: '0.74rem', color: tokens.colors.textMuted }}>
                Together since {couple.anniversary_date}
              </span>
            )}
          </div>

          <button
            onClick={() => setShowSettings(true)}
            aria-label="Settings"
            style={{
              width: '36px',
              height: '36px',
              borderRadius: tokens.radii.full,
              backgroundColor: tokens.colors.bgSurface,
              border: `1px solid ${tokens.colors.borderSubtle}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: tokens.colors.textSecondary,
              boxShadow: tokens.shadows.subtle,
            }}
          >
            <Settings size={17} />
          </button>
        </header>

        {/* Minimalist, airy tab content */}
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
          <div
            style={{
              width: '100%',
              backgroundColor: tokens.colors.bgSurface,
              borderRadius: tokens.radii.card,
              padding: '40px 26px',
              boxShadow: tokens.shadows.card,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '16px',
            }}
          >
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 16px',
                borderRadius: tokens.radii.pill,
                backgroundColor: currentTab.accentSoft,
                color: currentTab.accentColor,
                fontSize: '0.78rem',
                fontWeight: 700,
              }}
            >
              <Sparkles size={13} />
              <span>{isHome ? 'Paired Nook Unlocked' : 'Coming Soon'}</span>
            </div>

            <h1
              style={{
                fontSize: '1.9rem',
                fontWeight: 800,
                color: tokens.colors.textPrimary,
                margin: 0,
                letterSpacing: '-0.02em',
              }}
            >
              {currentTab.label}
            </h1>

            <p
              style={{
                fontSize: '0.9rem',
                color: tokens.colors.textSecondary,
                lineHeight: 1.6,
                maxWidth: '260px',
                margin: 0,
              }}
            >
              {isHome
                ? `You and ${partner?.name} are connected in Our Nook! Features are coming soon.`
                : `${currentTab.comingSoonSubtitle}. Stay tuned!`}
            </p>

            {/* Couple details pill on Home screen */}
            {isHome && couple && (
              <div
                style={{
                  marginTop: '6px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  fontSize: '0.76rem',
                  color: tokens.colors.textMuted,
                }}
              >
                <span>🌍 {partner?.name}'s Timezone: {partner?.timezone}</span>
                <span>📅 Anniversary: {couple.anniversary_date} (Locked)</span>
              </div>
            )}
          </div>
        </section>

        {/* Bottom Navigation with 5 tabs */}
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
                <span style={{ fontSize: '0.72rem', fontWeight: isActive ? 700 : 500 }}>
                  {tab.label}
                </span>
              </button>
            );
          })}
        </nav>

        {/* Danger Zone Settings Modal (Sign Out & Mutual Breakup Option) */}
        {showSettings && couple && (
          <DangerSettingsModal
            userId={currentUser.id}
            couple={couple}
            partner={partner}
            onClose={() => setShowSettings(false)}
            onCoupleEnded={() => {
              setShowSettings(false);
              loadUserData();
            }}
            onSignOut={handleSignOut}
          />
        )}
      </main>
    </div>
  );
};

export default App;
