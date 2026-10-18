import { EverydayStatusCards } from './components/home/EverydayStatusCards';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  MessageCircle,
  Image as ImageIcon,
  Home as HomeIcon,
  MessageSquare,
  Gamepad2,
} from 'lucide-react';
import { tokens } from './tokens/designTokens';
import { supabaseConfigurationError } from './lib/supabaseClient';
import { AuthView } from './components/auth/AuthView';
import { OnboardingView } from './components/auth/OnboardingView';
import { PairingView } from './components/auth/PairingView';
import { CoupleHeader } from './components/common/CoupleHeader';
import { SplashScreen, SPLASH_DURATION_MS } from './components/common/SplashScreen';
import { bootRaceElapsedMs } from './lib/bootRace';
import { GamesView } from './components/games/GamesView';
import { DuelLeaveDialog } from './components/games/DuelLeaveDialog';
import { useGames } from './hooks/useGames';
import { HomeView } from './components/home/HomeView';
import { DailyDecisionModal } from './components/home/DailyDecisionModal';
import { MissYouReveal } from './components/home/MissYouReveal';
import { ChatView } from './components/chat/ChatView';
import { DiscussView } from './components/discuss/DiscussView';
import { CalendarModal } from './components/calendar/CalendarModal';
import { TogetherView } from './components/together/TogetherView';
import { ReaderView, type ShareHighlightInput } from './components/together/ReaderView';
import { useCoupleEvents } from './hooks/useCoupleEvents';
import { useChat } from './hooks/useChat';
import { useDiscuss, type SessionDetail } from './hooks/useDiscuss';
import { useBooks } from './hooks/useBooks';
import { useVisits } from './hooks/useVisits';
import { useSomedayList } from './hooks/useSomedayList';
import { DangerSettingsModal } from './components/common/DangerSettingsModal';
import { useCouplePresence } from './hooks/useCouplePresence';
import { useMissYou } from './hooks/useMissYou';
import { useCouplePhoto } from './hooks/useCouplePhoto';
import { useDailyDecision } from './hooks/useDailyDecision';
import { usePushNotifications } from './hooks/usePushNotifications';
import { VisitPlanningModal } from './components/together/VisitPlanningModal';
import {
  PUSH_DEEP_LINK_TABS,
  isPushOpenTabMessage,
  releaseAllPushSubscriptions,
  setPushBadge,
} from './lib/pushService';
import {
  getCurrentAuthUser,
  fetchProfile,
  fetchCouple,
  signOutUser,
  type AuthUser,
} from './lib/authService';
import type { Profile, Couple, DailyDecisionQuestion, SomedayItem } from './types/database';

type TabKey = 'chat' | 'together' | 'home' | 'discuss' | 'games';

interface TabConfig {
  key: TabKey;
  label: string;
  icon: React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
  isCenter?: boolean;
  comingSoonSubtitle: string;
  accentColor: string;
  accentSoft: string;
}

/**
 * The bottom navigation, left to right: Chat, Together, Home (the raised centre
 * button), Discuss, Games. This is the same order the push deep links accept
 * (`PUSH_DEEP_LINK_TABS`) and the one the design preview shows, so a tapped
 * notification and the bar on screen always agree about where a tab sits.
 */
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
    key: 'together',
    label: 'Together',
    icon: ImageIcon,
    comingSoonSubtitle: 'Shared books, visits & someday list',
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

interface AppProps {
  /**
   * The tab a tapped notification asked for, read once from `/?nooki=…` before the first
   * render (see main.tsx). Starting here rather than in an effect means the app opens
   * straight onto the chat instead of painting Home first.
   */
  initialTab?: TabKey | null;
}

export const App: React.FC<AppProps> = ({ initialTab = null }) => {
  // Navigation & Modal State
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab ?? 'home');
  // A tab the couple asked for while a ranked snake run was live: the run cannot be
  // paused, so leaving the Games tab is a forfeit and they get asked first.
  const [pendingTab, setPendingTab] = useState<TabKey | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  // The daily decision is a sheet over Home; the page stays mounted behind it.
  const [showDailyDecision, setShowDailyDecision] = useState(false);
  // The calendar is a modal over whatever tab is open, never a page of its own.
  const [showCalendar, setShowCalendar] = useState(false);
  // Visit planning modal for the Together tab
  const [showVisitPlanning, setShowVisitPlanning] = useState(false);
  // A someday idea waiting for the visit being planned: when the visit is saved,
  // the idea joins it straight away ("Add to our next visit" with no visit yet).
  const [somedayItemForVisit, setSomedayItemForVisit] = useState<string | null>(null);
  // A message is only "read" while the Chat tab is on screen *and* the app is awake.
  const [appVisible, setAppVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');

  // Auth & Pairing State
  const [loading, setLoading] = useState(true);
  const [splashDone, setSplashDone] = useState(false);
  // How much of the splash race the boot splash in index.html already showed before this
  // bundle ran, read once at the first render (see lib/bootRace.ts). The splash carries that
  // same run on instead of replaying it, and the fallback dismissal below only waits out the
  // remainder — on a phone the boot splash covers the slow part of a launch, so replaying the
  // race there used to add a whole extra run to every start.
  const [bootRaceElapsed] = useState(bootRaceElapsedMs);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [couple, setCouple] = useState<Couple | null>(null);
  const [partner, setPartner] = useState<Profile | null>(null);

  // The bridge between Discuss and Chat: "Say more" carries a revealed question into
  // the composer, and the quoted question on a bubble carries its session back. Both
  // ends are tagged with the couple they belong to, so nothing outlives the account.
  const [chatContextStored, setChatContextStored] = useState<{ coupleId: string; sessionId: string; questionText: string } | null>(null);
  const [focusSessionStored, setFocusSessionStored] = useState<{ coupleId: string; id: string; nonce: number } | null>(null);
  const focusNonce = useRef(0);

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
  const sendChatMessage = chat.send;

  // The Discuss question engine sits at app level too, so a question the partner asks
  // still badges its tab while this phone is somewhere else.
  const games = useGames(couple?.id ?? null, currentUser?.id ?? null);

  /**
   * Every way out of the Games tab goes through here. A live duel run — snake or Tetris —
   * has no pause and no second chance, so a tab change while one is on screen is a forfeit,
   * and the couple is asked before it happens — with the run still going behind the
   * question.
   */
  const requestTab = useCallback((key: TabKey) => {
    if (key === activeTab) return;
    if (activeTab === 'games' && games.duelLive && games.match) setPendingTab(key);
    else setActiveTab(key);
  }, [activeTab, games.duelLive, games.match]);

  // Read through a ref so the service-worker listener registered once on mount always
  // calls the current requestTab (it closes over the live duel and the active tab).
  const requestTabRef = useRef(requestTab);
  useEffect(() => { requestTabRef.current = requestTab; }, [requestTab]);

  const discuss = useDiscuss({
    coupleId: couple?.id ?? null,
    userId: currentUser?.id ?? null,
  });

  // The Together tab's "Read together" shelf: one book in play, both partners' places in
  // it, and the highlights that reach the chat. App-level for the same reason as the
  // chat — a partner's highlight lands while this phone is somewhere else.
  const books = useBooks({
    coupleId: couple?.id ?? null,
    userId: currentUser?.id ?? null,
    partnerId: partner?.id ?? null,
  });

  // Visits for the Together tab: next visit countdown and planning
  const visits = useVisits(couple?.id ?? null, currentUser?.id ?? null);

  // Someday list for the Together tab: shared list of things to experience together
  const somedayList = useSomedayList(couple?.id ?? null, currentUser?.id ?? null);

  // This device's notification switch, and the deep link a tapped notification carries.
  // App-level like the chat: the home-screen badge is cleared from here, and a
  // notification tapped while the app is closed lands on the right tab on first paint.
  const push = usePushNotifications({
    userId: currentUser?.id ?? null,
    coupleId: couple?.id ?? null,
  });
  const dailyDecision = useDailyDecision({
    userId: currentUser?.id ?? null,
    coupleId: couple?.id ?? null,
  });

  // A reminder belongs to this account, not to the partner who may still be deciding.
  // No loaded question (including an empty/exhausted pool) means nothing is pending.
  const pendingDailyDecision = dailyDecision.question !== null && dailyDecision.my_choice === null;

  // The full-screen reader is a layer over whatever tab is open (Chat jumps come
  // straight here too). Tagged with the couple so nothing outlives the account.
  const [readerStored, setReaderStored] = useState<{
    coupleId: string;
    bookId: string;
    jump: 'partner' | { location: string } | null;
    nonce: number;
  } | null>(null);
  const readerNonce = useRef(0);

  const openReader = useCallback((bookId: string, jump: 'partner' | { location: string } | null = null) => {
    if (!couple) return;
    readerNonce.current += 1;
    setReaderStored({ coupleId: couple.id, bookId, jump, nonce: readerNonce.current });
  }, [couple]);

  // Same list, looked up the way the chat needs it: which question did this session ask?
  const questionBySessionId = useMemo(
    () => Object.fromEntries(
      discuss.sessions
        .filter((detail) => detail.question !== null)
        .map((detail) => [
          detail.session.id,
          { text: detail.question!.text, category: detail.question!.category },
        ]),
    ),
    [discuss.sessions],
  );

  // What each shared highlight quoted, for the chat's quote cards. The quote comes
  // from the highlight row — even after the book is deleted (book_id then reads null)
  // so the words stay in the chat and only the jump away is gone.
  const highlightById = useMemo(() => {
    const titleByBookId = Object.fromEntries(books.books.map((book) => [book.id, book.title]));
    return Object.fromEntries(books.highlights.map((highlight) => [highlight.id, {
      quote_text: highlight.quote_text,
      book_id: highlight.book_id,
      book_title: highlight.book_id ? titleByBookId[highlight.book_id] ?? null : null,
    }]));
  }, [books.books, books.highlights]);

  // The quote card on a bubble: open the reader and jump to the passage. A deleted
  // book's card is disabled in the chat, so this only ever runs for a live one.
  const handleOpenHighlight = useCallback((highlightId: string) => {
    if (!couple) return;
    const highlight = books.highlights.find((item) => item.id === highlightId);
    if (!highlight?.book_id) return;
    const book = books.books.find((item) => item.id === highlight.book_id);
    if (!book) return;
    openReader(book.id, { location: highlight.location });
  }, [books.books, books.highlights, couple, openReader]);

  // "Say more" under the revealed answers: switch to the chat with the question attached.
  const handleSayMore = useCallback((detail: SessionDetail) => {
    setChatContextStored({
      coupleId: detail.session.couple_id,
      sessionId: detail.session.id,
      questionText: detail.question?.text ?? '',
    });
    setActiveTab('chat');
  }, []);

  // "Take to chat" shares the prompt and all three choices as a normal message, so both
  // partners have the exact decision in their transcript to deliberate on.
  const handleTakeDecisionToChat = useCallback(async (question: DailyDecisionQuestion) => {
    const content = [
      `Today’s decision: ${question.question}`,
      '',
      ...question.options.map((option, index) => `${index + 1}. ${option}`),
      '',
      'What do you think?',
    ].join('\n');
    await sendChatMessage(content);
    setShowDailyDecision(false);
    setActiveTab('chat');
  }, [sendChatMessage]);

  // The quote on a linked bubble: jump back to that question and its answers.
  const handleOpenQuestion = useCallback((sessionId: string) => {
    if (!couple) return;
    focusNonce.current += 1;
    setFocusSessionStored({ coupleId: couple.id, id: sessionId, nonce: focusNonce.current });
    setActiveTab('discuss');
  }, [couple]);

  // Highlight & share: the margin note first, then the chat message that quotes it.
  // With no comment the message carries the quote itself, so the transcript always
  // holds the words even if the book later goes away. If the chat copy fails after
  // the highlight landed, that is not worth retrying a highlight for: the passage is
  // saved and painted, and useChat has already recorded the failed message in the
  // transcript ("Not sent — tap to retry").
  const addHighlight = books.addHighlight;
  const handleShareHighlight = useCallback(async (bookId: string, input: ShareHighlightInput, comment: string) => {
    const highlight = await addHighlight({
      bookId,
      location: input.location,
      quoteText: input.quoteText,
      rects: input.rects,
    });
    try {
      await sendChatMessage(comment.trim() || input.quoteText.trim(), 'text', null, null, highlight.id);
    } catch {
      // Saved already; the transcript keeps the failure visible on the Chat tab.
    }
  }, [addHighlight, sendChatMessage]);

  // Valid only while the couple that made them is the one on this phone.
  const chatContext = chatContextStored && couple?.id === chatContextStored.coupleId
    ? { sessionId: chatContextStored.sessionId, questionText: chatContextStored.questionText }
    : null;
  const readerTarget = readerStored && couple?.id === readerStored.coupleId
    ? readerStored
    : null;
  const focusSession = focusSessionStored && couple?.id === focusSessionStored.coupleId
    ? { id: focusSessionStored.id, nonce: focusSessionStored.nonce }
    : null;

  const { partnerOnline } = useCouplePresence({
    coupleId: couple?.id ?? null,
    userId: currentUser?.id ?? null,
    partnerId: partner?.id ?? null,
    onPartnerProfile: setPartner,
  });

  // "I miss you": the corner button while the partner is away, and the big heart their taps
  // become when this phone is the one coming back. It only runs on the unlocked app (past
  // the splash, couple and partner in hand) and never while the app is hidden, so nothing
  // is opened unseen.
  const missYou = useMissYou({
    coupleId: couple?.id ?? null,
    userId: currentUser?.id ?? null,
    partnerId: partner?.id ?? null,
    partnerOnline,
    active: appVisible && !loading && splashDone && Boolean(couple && partner && currentUser),
  });

  // The couple's framed picture for the Home nook: one photo per couple, standing
  // on both phones, kept live by the couple_photo realtime channel.
  const couplePhoto = useCouplePhoto({
    coupleId: couple?.id ?? null,
    userId: currentUser?.id ?? null,
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
        // The user id is already in hand, so the fetch does not have to ask for it again.
        const coupleInfo = await fetchCouple(userProfile.couple_id, user.id);
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

  // The splash is dismissed by the race itself (SplashScreen reports the green dot's
  // animationend); this timer is only the fallback for browsers where that event can
  // never arrive (reduced-motion readers get no animation, so no animationend). Even
  // the fallback must not start counting until the splash has actually been painted:
  // on a phone the main thread can still be mounting the app when a plain mount timer
  // starts, so the 1.5s would elapse before the first visible frame and the race would
  // be gone before it was ever seen. Waiting for two animation frames guarantees at
  // least one presented splash frame before the countdown begins — and a splash opened
  // in a background tab simply waits there until it is brought to the front and seen.
  // The countdown is what is left of the race after the boot splash's head start, so a
  // launch is never two races long. The frame scheduling mirrors SnakeBoard: jsdom has
  // no requestAnimationFrame.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let firstFrame = 0;
    let secondFrame = 0;
    const remaining = Math.max(0, SPLASH_DURATION_MS - bootRaceElapsed);
    const startCountdown = () => {
      if (!cancelled) timer = setTimeout(() => setSplashDone(true), remaining);
    };
    if (typeof requestAnimationFrame === 'function') {
      firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(startCountdown);
      });
    } else {
      timer = setTimeout(startCountdown, 0);
    }
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(firstFrame);
        cancelAnimationFrame(secondFrame);
      }
    };
  }, [bootRaceElapsed]);

  useEffect(() => {
    const onVisibilityChange = () => setAppVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  // The app is usually already open when a notification is tapped (the service worker
  // focuses this window rather than opening a second copy), and a focused window does not
  // reload — so it switches tabs by message. Through requestTab, so leaving a live duel
  // still asks before forfeiting it.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onServiceWorkerMessage = (event: MessageEvent) => {
      if (!isPushOpenTabMessage(event.data)) return;
      const { tab } = event.data;
      if ((PUSH_DEEP_LINK_TABS as readonly string[]).includes(tab)) {
        requestTabRef.current(tab as TabKey);
      }
    };
    navigator.serviceWorker.addEventListener('message', onServiceWorkerMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onServiceWorkerMessage);
  }, []);

  // The home-screen icon shows the same number as the Chat tab badge, and drops to nothing
  // the moment those messages are actually read (the chat on screen and the app awake — the
  // same condition that stamps read receipts). While the app is closed nothing here runs:
  // the service worker is the only thing that touches the badge then, using the count the
  // sender put in the payload.
  const pushBadge = push.enabled
    ? (activeTab === 'chat' && appVisible ? 0 : chat.unreadCount)
    : null;
  useEffect(() => {
    if (pushBadge === null) return;
    void setPushBadge(pushBadge);
  }, [pushBadge]);

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
        const info = await fetchCouple(couple.id, currentUser.id);
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
      // This phone stops being reachable the moment it signs out, though the browser keeps
      // its own push subscription so signing back in is one tap rather than a new prompt.
      await releaseAllPushSubscriptions();
      await signOutUser();
      setShowSettings(false);
      await loadUserData();
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : 'Sign out failed. Please try again.');
    }
  };

  const handleAddSomedayItemToVisit = async (item: SomedayItem) => {
    if (visits.visit) {
      await somedayList.attachToVisit(item, visits.visit.id);
      return;
    }
    // No visit yet: plan one, then pin this idea to it once it is saved.
    setSomedayItemForVisit(item.id);
    setShowVisitPlanning(true);
  };

  const handleRemoveSomedayItemFromVisit = async (item: SomedayItem) => {
    await somedayList.attachToVisit(item, null);
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

  // 1. Splash screen (~1.5s: simple Nooki wordmark + racing green & pink dots).
  // It leaves when the race has actually finished on screen (or the painted-frame
  // fallback timer above fires), never merely because wall-clock time passed unseen.
  // The run started in index.html's boot splash, so it is handed the head start.
  if (loading || !splashDone) {
    return (
      <div className="nooki-viewport" style={viewportStyle}>
        <main className="nooki-shell" style={shellStyle}>
          <SplashScreen elapsedMs={bootRaceElapsed} onAnimationComplete={() => setSplashDone(true)} />
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
  const isHome = activeTab === 'home';
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

        {/* Chat tab: the couple's live conversation.
            Together tab: shared books, visits & someday list, with the full-screen
            reader opening over whatever tab is active.
            Home tab: Today card, today's shared decision and the reserved animated scene area.
            Discuss tab: the question engine over the imported library.
            Games tab: mini-games and chibi room decoration.
            (Listed in the bottom navigation's order, left to right; the checks below
            keep Chat as the fall-through so an unknown tab still lands somewhere safe.) */}
        {isDiscuss ? (
          <DiscussView
            discuss={discuss}
            userId={currentUser.id}
            userName={profile.name}
            partnerName={partner.name}
            onOpenSettings={() => setShowSettings(true)}
            focusSession={focusSession}
            onSayMore={handleSayMore}
          />
        ) : activeTab === 'games' ? (
          <GamesView games={games} userId={currentUser.id} partnerName={partner.name} />
        ) : isHome ? (
          <HomeView
            everyday={<EverydayStatusCards coupleId={couple.id} userId={currentUser.id} partnerId={partner.id} partnerName={partner.name} onMessage={() => { setChatContextStored(null); setActiveTab('chat'); }} />}
            events={calendar.events}
            anniversaryDate={couple.anniversary_date}
            eventsLoading={calendar.loading}
            eventsError={calendar.error}
            onOpenCalendar={() => setShowCalendar(true)}
            partnerOnline={partnerOnline}
            onOpenDailyDecision={() => setShowDailyDecision(true)}
            photo={{
              src: couplePhoto.url,
              uploading: couplePhoto.busy,
              error: couplePhoto.error,
              onUpload: (file) => { void couplePhoto.upload(file); },
            }}
            missYou={{
              visible: missYou.available,
              sentCount: missYou.sentCount,
              partnerName: partner.name,
              error: missYou.error,
              onTap: () => { void missYou.tap(); },
            }}
          />
        ) : activeTab === 'together' ? (
          <TogetherView
            state={books}
            userId={currentUser.id}
            userName={profile.name}
            partnerName={partner.name}
            onOpenReader={(bookId) => openReader(bookId)}
            visit={visits.visit}
            onPlanVisit={() => setShowVisitPlanning(true)}
            onViewVisitPlans={() => {
              // For now, just open the planning modal to edit
              setShowVisitPlanning(true);
            }}
            somedayItems={somedayList.items}
            somedayError={somedayList.error}
            onAddSomedayItem={somedayList.addItem}
            onUpdateSomedayItem={somedayList.updateItem}
            onToggleSomedayItem={somedayList.toggleItem}
            onDeleteSomedayItem={somedayList.deleteItem}
            onReorderSomedayItems={somedayList.reorderItems}
            onAddSomedayItemToVisit={handleAddSomedayItemToVisit}
            onRemoveSomedayItemFromVisit={handleRemoveSomedayItemFromVisit}
            onPlanSomedayItemVisit={(item) => {
              setSomedayItemForVisit(item.id);
              setShowVisitPlanning(true);
            }}
          />
        ) : (
          <ChatView
            messages={chat.messages}
            currentUserId={currentUser.id}
            partnerName={partner.name}
            partnerOnline={partnerOnline}
            partnerLastSeenAt={partner.last_seen_at}
            partnerTyping={chat.partnerTyping}
            loading={chat.loading}
            error={chat.error}
            onSend={(content, sessionId, replyToId) => chat.send(content, 'text', sessionId, replyToId)}
            onTyping={chat.notifyTyping}
            onStopTyping={chat.notifyStoppedTyping}
            onEditMessage={chat.edit}
            onRetry={chat.retry}
            onDismissError={chat.clearError}
            questionBySessionId={questionBySessionId}
            questionContext={chatContext}
            onClearQuestionContext={() => setChatContextStored(null)}
            onOpenQuestion={handleOpenQuestion}
            highlightById={highlightById}
            onOpenHighlight={handleOpenHighlight}
          />
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
                  onClick={() => requestTab(tab.key)}
                >
                  <button
                    type="button"
                    data-nav-tab="home"
                    aria-label={pendingDailyDecision ? "Home, today's decision waiting for you" : 'Home'}
                    style={{
                      position: 'relative',
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
                    {pendingDailyDecision && (
                      <span className="nooki-nav-badge" data-nav-badge="home" aria-hidden="true">
                        1
                      </span>
                    )}
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
            // Discuss and matches waiting on this phone on Games; all show as the
            // same small count.
            const tabBadge = tab.key === 'chat'
              ? chat.unreadCount
              : tab.key === 'discuss'
                ? discuss.pendingCount
                : tab.key === 'games'
                  ? games.pendingCount
                  : 0;
            const badgeWords = tab.key === 'discuss'
              ? `${tabBadge} question${tabBadge === 1 ? '' : 's'} waiting`
              : tab.key === 'games'
                ? `${tabBadge} game${tabBadge === 1 ? '' : 's'} waiting for you`
                : `${tabBadge} unread ${tabBadge === 1 ? 'message' : 'messages'}`;

            return (
              <button
                key={tab.key}
                type="button"
                data-nav-tab={tab.key}
                onClick={() => requestTab(tab.key)}
                aria-label={tabBadge ? `${tab.label}, ${badgeWords}` : tab.label}
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
                  {tabBadge > 0 && (
                    <span className="nooki-nav-badge" data-nav-badge={tab.key} aria-hidden="true">
                      {tabBadge > 99 ? '99+' : tabBadge}
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

        {/* The big heart: the taps the partner left behind while this phone was away,
            opened over whatever tab the app came back to. Marks them received on mount,
            so it greets once and then it is gone. */}
        {missYou.reveal && (
          <MissYouReveal
            batch={missYou.reveal}
            senderName={partner.name}
            onDismiss={missYou.dismissReveal}
          />
        )}

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

        {/* Today's private choices and their reveal, in a sheet over Home. */}
        {showDailyDecision && (
          <DailyDecisionModal
            state={dailyDecision}
            userName={profile.name}
            partnerName={partner.name}
            onTakeToChat={handleTakeDecisionToChat}
            onClose={() => setShowDailyDecision(false)}
          />
        )}

        {/* The full-screen reader over whatever tab is open (Chat jumps land here). */}
        {readerTarget && (() => {
          const book = books.books.find((item) => item.id === readerTarget.bookId);
          if (!book) return null;
          return (
            <ReaderView
              key={`${book.id}-${readerTarget.nonce}`}
              book={book}
              userId={currentUser.id}
              userName={profile.name}
              partnerName={partner.name}
              myProgress={books.progress.find((item) => item.book_id === book.id && item.user_id === currentUser.id) ?? null}
              partnerProgress={books.progress.find((item) => item.book_id === book.id && item.user_id !== currentUser.id) ?? null}
              highlights={books.highlights.filter((item) => item.book_id === book.id)}
              initialJump={readerTarget.jump}
              onSaveProgress={(location, percent) => { void books.saveProgress(book.id, location, percent).catch(() => {}); }}
              onShareHighlight={(input, comment) => handleShareHighlight(book.id, input, comment)}
              onLeave={async () => { await books.leave(book.id); }}
              onFinish={async () => { await books.finish(book.id); }}
              onClose={() => setReaderStored(null)}
            />
          );
        })()}

        {/* Visit Planning Modal for Together tab */}
        {showVisitPlanning && couple && (
          <VisitPlanningModal
            isOpen={showVisitPlanning}
            onClose={() => {
              setShowVisitPlanning(false);
              // Cancelling the planner leaves the idea right where it was.
              setSomedayItemForVisit(null);
            }}
            onSave={async (startDate, endDate, location, timezone, isTentative) => {
              try {
                if (visits.visit) {
                  // Update existing visit
                  await visits.updateVisit(visits.visit.id, {
                    start_date: startDate,
                    end_date: endDate,
                    location,
                    timezone: timezone ?? 'UTC',
                    is_tentative: isTentative,
                  });
                } else {
                  // Create new visit, then let the idea that asked for one join it.
                  const created = await visits.planVisit(startDate, endDate, location, timezone, isTentative);
                  if (somedayItemForVisit) {
                    const item = somedayList.items.find((entry) => entry.id === somedayItemForVisit);
                    if (item) await somedayList.attachToVisit(item, created.id);
                    setSomedayItemForVisit(null);
                  }
                }
              } catch {
                // The modal shows the save error beside the form.
              }
            }}
            existingVisit={visits.visit}
            userTimezone={profile?.timezone || 'UTC'}
            partnerName={partner.name}
          />
        )}

        {/* Danger Zone Settings Modal (Sign Out & Mutual Breakup Option) */}
        {showSettings && couple && (
          <DangerSettingsModal
            userId={currentUser.id}
            couple={couple}
            profile={profile}
            partner={partner}
            onLocationSaved={setProfile}
            adultQuestionsEnabled={discuss.myAdultEnabled}
            partnerAdultQuestionsEnabled={discuss.partnerAdultEnabled}
            adultQuestionsSaving={discuss.adultSaving}
            onToggleAdultQuestions={(enabled) => discuss.setAdultEnabled(enabled).then(() => undefined)}
            pushNotifications={push}
            onClose={() => setShowSettings(false)}
            onCoupleEnded={() => {
              setShowSettings(false);
              loadUserData();
            }}
            onSignOut={handleSignOut}
          />
        )}

        {/* Leaving the Games tab in the middle of a ranked duel run: asked here, over the
            board, which keeps running while the question is on screen. */}
        {pendingTab && games.match && (
          <DuelLeaveDialog
            runLabel={games.duelLive === 'tetris' ? 'your Tetris run' : 'your run'}
            partnerName={partner.name}
            busy={games.busy}
            onKeepPlaying={() => setPendingTab(null)}
            onForfeit={() => {
              const target = pendingTab;
              const matchId = games.match?.id;
              setPendingTab(null);
              if (matchId) void games.forfeitSnake(matchId);
              setActiveTab(target);
            }}
          />
        )}
      </main>
    </div>
  );
};

export default App;
