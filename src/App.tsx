import React, { useState, useEffect, useCallback } from 'react';
import {
  MessageCircle,
  Image as ImageIcon,
  Home as HomeIcon,
  MessageSquare,
  Gamepad2,
  Sparkles,
} from 'lucide-react';
import { tokens } from './tokens/designTokens';
import { supabaseConfigurationError } from './lib/supabaseClient';
import { AuthView } from './components/auth/AuthView';
import { OnboardingView } from './components/auth/OnboardingView';
import { PairingView } from './components/auth/PairingView';
import { CoupleHeader } from './components/common/CoupleHeader';
import { SplashScreen, SPLASH_DURATION_MS } from './components/common/SplashScreen';
import { HomeView } from './components/home/HomeView';
import { ChatView } from './components/chat/ChatView';
import { DiscussView } from './components/discuss/DiscussView';
import { CalendarModal } from './components/calendar/CalendarModal';
import { useCoupleEvents } from './hooks/useCoupleEvents';
import { useChat } from './hooks/useChat';
import { useDiscuss } from './hooks/useDiscuss';
import { DangerSettingsModal } from './components/common/DangerSettingsModal';
import { useCouplePresence } from './hooks/useCouplePresence';
import {
  getCurrentAuthUser,
  fetchProfile,
  fetchCouple,
  signOutUser,
  type AuthUser,
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
    comingSoonSubtitle: 'Private questions you answer together',
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

const viewportStyle: React.CSSProperties = {
  width: '100%',
  height: '100dvh',
  backgroundColor: tokens.colors.bgDesktop,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: tokens.typography.fontFamily,
  overflow: 'hidden',
};

const shellStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: '390px',
  height: '100%',
  maxHeight: '844px',
  backgroundColor: tokens.colors.bgCanvas,
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: tokens.shadows.card,
  borderRadius: '36px',
  overflow: 'hidden',
};

export const App: React.FC = () => {
  // Navigation & Modal State
  const [activeTab, setActiveTab] = useState<TabKey>('home');
  const [showSettings, setShowSettings] = useState(false);
  // The calendar is a modal over whatever tab is open, never a page of its own.
  const [showCalendar, setShowCalendar] = useState(false);
  // A message is only "read" while the Chat tab is on screen *and* the app is awake.
  const [appVisible, setAppVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');

  // Auth & Pairing State
  const [loading, setLoading] = useState(true);
  const [splashDone, setSplashDone] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [couple, setCouple] = useState<Couple | null>(null);
  const [partner, setPartner] = useState<Profile | null>(null);

  // Presence runs for the whole unlocked app (not just the Home tab) so a partner
  // is still shown as online while this phone is browsing another tab.
  // One shared calendar for the Today card and the calendar modal.
  const calendar = useCoupleEvents({
    coupleId: couple?.id ?? null,
    userId: currentUser?.id ?? null,
  });

  // The chat lives at app level too: messages keep arriving (and the tab keeps its
  // unread badge) while the couple browses Home, Media or Games.
  const chat = useChat({
    coupleId: couple?.id ?? null,
    userId: currentUser?.id ?? null,
    partnerId: partner?.id ?? null,
    active: activeTab === 'chat' && appVisible,
  });

  // The Discuss question engine sits at app level too, so a question the partner asks
  // still badges its tab while this phone is somewhere else.
  const discuss = useDiscuss({
    coupleId: couple?.id ?? null,
    userId: currentUser?.id ?? null,
  });

  const { partnerOnline } = useCouplePresence({
    coupleId: couple?.id ?? null,
    userId: currentUser?.id ?? null,
    partnerId: partner?.id ?? null,
    onPartnerProfile: setPartner,
  });

  const loadUserData = useCallback(async () => {
    try {
      const user = await getCurrentAuthUser();
      setSessionError(null);
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
      setSessionError(err instanceof Error ? err.message : 'Unable to load your account. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setSplashDone(true), SPLASH_DURATION_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => setAppVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  useEffect(() => {
    // Defer the external session load so StrictMode's discarded mount does not start a duplicate request.
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void loadUserData(); });
    return () => { cancelled = true; };
  }, [loadUserData]);

  // Poll for partner joining when waiting in couple
  useEffect(() => {
    if (!currentUser || !couple || partner) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const info = await fetchCouple(couple.id);
        if (!cancelled && info && info.partner) {
          setPartner(info.partner);
          setCouple(info.couple);
        }
      } catch (err) {
        if (!cancelled) setSessionError(err instanceof Error ? err.message : 'Could not check your connection.');
      }
    }, 2500);
    return () => { cancelled = true; clearInterval(interval); };
  }, [currentUser, couple, partner]);

  const handleSignOut = async () => {
    try {
      await signOutUser();
      setShowSettings(false);
      await loadUserData();
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : 'Sign out failed. Please try again.');
    }
  };

  // Backend failures are not missing profiles and must never silently restart onboarding.
  if (sessionError) {
    return (
      <main style={{ maxWidth: '420px', margin: '24px', padding: '28px', borderRadius: tokens.radii.card, background: tokens.colors.bgSurface }}>
        <h1 style={{ fontSize: '1.4rem', marginBottom: '12px' }}>Unable to connect to Nooki</h1>
        <p role="alert" style={{ color: tokens.colors.textSecondary, marginBottom: '16px' }}>{sessionError}</p>
        <p style={{ fontSize: '0.85rem', marginBottom: '16px' }}>Check your connection. If this continues, the app owner should verify the Supabase settings and database migrations.</p>
        <button type="button" onClick={loadUserData}>Try again</button>
        {!supabaseConfigurationError && <button type="button" onClick={handleSignOut} style={{ marginLeft: '12px' }}>Sign out</button>}
      </main>
    );
  }

  // 1. Splash screen (< 0.5s: simple Nooki wordmark + racing green & pink dots)
  if (loading || !splashDone) {
    return (
      <div className="nooki-viewport" style={viewportStyle}>
        <main className="nooki-shell" style={shellStyle}>
          <SplashScreen />
        </main>
      </div>
    );
  }

  // 2. Authentication View (Sign Up / Sign In with Email & Password)
  if (!currentUser) {
    return (
      <div className="nooki-viewport" style={viewportStyle}>
        <main className="nooki-shell" style={shellStyle}>
          <AuthView onSuccess={loadUserData} />
        </main>
      </div>
    );
  }

  // 3. Onboarding View (Collect First Name, Timezone auto-detected & editable)
  if (!profile || !profile.name) {
    return (
      <div className="nooki-viewport" style={viewportStyle}>
        <main className="nooki-shell" style={shellStyle}>
          <OnboardingView userId={currentUser.id} onComplete={loadUserData} />
        </main>
      </div>
    );
  }

  // 4. Pairing View (Lock app until both partners have joined)
  // Shows Create/Join flow or friendly waiting screen with 6-char code
  if (!couple || !partner) {
    return (
      <div className="nooki-viewport" style={viewportStyle}>
        <main className="nooki-shell" style={{ ...shellStyle, overflowY: 'auto' }}>
          <header
            style={{
              padding: '16px 20px 0 20px',
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
  const isChat = activeTab === 'chat';
  const isDiscuss = activeTab === 'discuss';

  return (
    <div className="nooki-viewport" style={viewportStyle}>
      <main className="nooki-shell" style={shellStyle}>
        {/* Global couple header: names, presence ticker, partner clock and together counter */}
        <CoupleHeader
          profile={profile}
          partner={partner}
          couple={couple}
          partnerOnline={partnerOnline}
          onOpenSettings={() => setShowSettings(true)}
        />

        {/* Home tab: Today card, daily game card and reserved animated scene area.
            Chat tab: the couple's live conversation.
            Discuss tab: the question engine over the imported library.
            Media and Games stay as airy placeholders. */}
        {isDiscuss ? (
          <DiscussView
            discuss={discuss}
            userId={currentUser.id}
            userName={profile.name}
            partnerName={partner.name}
            onOpenSettings={() => setShowSettings(true)}
          />
        ) : isHome ? (
          <HomeView
            events={calendar.events}
            anniversaryDate={couple.anniversary_date}
            eventsLoading={calendar.loading}
            eventsError={calendar.error}
            onOpenCalendar={() => setShowCalendar(true)}
            userName={profile.name}
            partnerName={partner.name}
          />
        ) : isChat ? (
          <ChatView
            messages={chat.messages}
            currentUserId={currentUser.id}
            partnerName={partner.name}
            partnerOnline={partnerOnline}
            partnerLastSeenAt={partner.last_seen_at}
            partnerTyping={chat.partnerTyping}
            loading={chat.loading}
            error={chat.error}
            onSend={chat.send}
            onTyping={chat.notifyTyping}
            onStopTyping={chat.notifyStoppedTyping}
            onRetry={chat.retry}
            onDismissError={chat.clearError}
          />
        ) : (
          <section
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 24px',
              textAlign: 'center',
            }}
          >
            <div
              style={{
                width: '100%',
                backgroundColor: tokens.colors.bgSurface,
                borderRadius: tokens.radii.card,
                padding: '32px 24px',
                boxShadow: tokens.shadows.card,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '14px',
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
                <span>Coming Soon</span>
              </div>

              <h1
                style={{
                  fontSize: '1.75rem',
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
                  fontSize: '0.88rem',
                  color: tokens.colors.textSecondary,
                  lineHeight: 1.5,
                  maxWidth: '250px',
                  margin: 0,
                }}
              >
                {`${currentTab.comingSoonSubtitle}. Stay tuned!`}
              </p>
            </div>
          </section>
        )}

        {/* Bottom Navigation with 5 tabs */}
        <nav
          role="navigation"
          aria-label="Main Navigation"
          style={{
            height: '64px',
            flexShrink: 0,
            backgroundColor: tokens.colors.bgSurface,
            boxShadow: tokens.shadows.navBar,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-around',
            padding: '0 8px calc(6px + env(safe-area-inset-bottom, 0px)) 8px',
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
                    top: '-10px',
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
                      width: '48px',
                      height: '48px',
                      borderRadius: tokens.radii.full,
                      backgroundColor: tokens.colors.primaryPink,
                      border: `3.5px solid ${tokens.colors.bgSurface}`,
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
                    <Icon size={21} strokeWidth={2.4} />
                  </button>
                  <span
                    style={{
                      fontSize: '0.68rem',
                      fontWeight: isActive ? 700 : 600,
                      color: isActive
                        ? tokens.colors.primaryPinkDeep
                        : tokens.colors.textMuted,
                      marginTop: '1px',
                    }}
                  >
                    {tab.label}
                  </span>
                </div>
              );
            }

            // Unread messages are announced on the Chat tab, unanswered questions on
            // Discuss; both show as the same small count.
            const unreadBadge = tab.key === 'chat'
              ? chat.unreadCount
              : tab.key === 'discuss'
                ? discuss.pendingCount
                : 0;
            const badgeWords = tab.key === 'discuss'
              ? `${unreadBadge} question${unreadBadge === 1 ? '' : 's'} waiting`
              : `${unreadBadge} unread ${unreadBadge === 1 ? 'message' : 'messages'}`;

            return (
              <button
                key={tab.key}
                type="button"
                data-nav-tab={tab.key}
                onClick={() => setActiveTab(tab.key)}
                aria-label={unreadBadge ? `${tab.label}, ${badgeWords}` : tab.label}
                style={{
                  background: 'none',
                  border: 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '2px',
                  cursor: 'pointer',
                  padding: '6px 10px',
                  outline: 'none',
                  color: isActive
                    ? tokens.colors.textPrimary
                    : tokens.colors.textMuted,
                  transition: 'color 0.15s ease',
                }}
              >
                <div
                  style={{
                    position: 'relative',
                    width: '30px',
                    height: '26px',
                    borderRadius: tokens.radii.sm,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: isActive ? tab.accentSoft : 'transparent',
                    color: isActive ? tab.accentColor : tokens.colors.textMuted,
                    transition: 'all 0.2s ease',
                  }}
                >
                  <Icon size={19} strokeWidth={isActive ? 2.4 : 2} />
                  {unreadBadge > 0 && (
                    <span className="nooki-nav-badge" data-nav-badge={tab.key} aria-hidden="true">
                      {unreadBadge > 99 ? '99+' : unreadBadge}
                    </span>
                  )}
                </div>
                <span style={{ fontSize: '0.68rem', fontWeight: isActive ? 700 : 500 }}>
                  {tab.label}
                </span>
              </button>
            );
          })}
        </nav>

        {/* Full calendar, layered over the current tab */}
        {showCalendar && (
          <CalendarModal
            partnerName={partner.name}
            events={calendar.events}
            anniversaryDate={couple.anniversary_date}
            saving={calendar.saving}
            onAddEvent={calendar.addEvent}
            onEditEvent={calendar.editEvent}
            onDeleteEvent={calendar.removeEvent}
            onClose={() => setShowCalendar(false)}
          />
        )}

        {/* Danger Zone Settings Modal (Sign Out & Mutual Breakup Option) */}
        {showSettings && couple && (
          <DangerSettingsModal
            userId={currentUser.id}
            couple={couple}
            partner={partner}
            adultQuestionsEnabled={discuss.myAdultEnabled}
            partnerAdultQuestionsEnabled={discuss.partnerAdultEnabled}
            adultQuestionsSaving={discuss.busy}
            onToggleAdultQuestions={(enabled) => discuss.setAdultEnabled(enabled).then(() => undefined)}
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
