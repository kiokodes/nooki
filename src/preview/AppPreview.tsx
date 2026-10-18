import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Gamepad2,
  Heart,
  Home as HomeIcon,
  Image as ImageIcon,
  MessageCircle,
  MessageSquare,
} from 'lucide-react';
import { tokens } from '../tokens/designTokens';
import { CoupleHeader } from '../components/common/CoupleHeader';
import { PreviewSnake } from './PreviewSnake';
import { PreviewTetris } from './PreviewTetris';
import { ChessDuel } from '../components/games/ChessDuel';
import { LastDuelRow, OngoingGames } from '../components/games/OngoingGames';
import { SplashScreen, SPLASH_DURATION_MS } from '../components/common/SplashScreen';
import { HomeView } from '../components/home/HomeView';
import { MissYouReveal } from '../components/home/MissYouReveal';
import { ChatView } from '../components/chat/ChatView';
import { CalendarModal } from '../components/calendar/CalendarModal';
import { DangerSettingsModal } from '../components/common/DangerSettingsModal';
import type { PushNotificationsState } from '../hooks/usePushNotifications';
import type { MissYouBatch } from '../lib/missYou';
import type { ChatEntry, Couple, Profile, CoupleEvent, RepeatFrequency } from '../types/database';

/**
 * Design preview for the Nooki surfaces, served by the dev server at /preview.html.
 *
 * It exists so the Home tab and the Chat tab can be reviewed without a Supabase project
 * or two live accounts. It runs on static sample data, never contacts the backend, and is
 * not part of the production build (`npm run build` only builds index.html).
 *
 * The Chat tab is driven by the real `ChatView` component with an in-memory transcript:
 * sending, day separators, receipts, the typing indicator and the unread badge all behave
 * like the app, with the partner's side simulated by the buttons above the phone.
 */

interface Preset {
  label: string;
  anniversary: string;
}

const NOW = new Date().toISOString();
/** Static sample row: the partner closed the app 42 minutes ago. */
const PARTNER_LAST_SEEN = new Date(Date.now() - 42 * 60_000).toISOString();

function dateKeyFromToday(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * A timestamp earlier today, whatever the hour: sample messages must always land on
 * "Today" so the preview looks the same at 00:05 and at 23:55.
 */
function earlierTodayIso(minutesAgo: number): string {
  const dayStart = new Date();
  dayStart.setHours(0, 1, 0, 0);
  const candidate = new Date(Date.now() - minutesAgo * 60_000);
  return (candidate > dayStart ? candidate : dayStart).toISOString();
}

/**
 * A timestamp on the calendar day before today, whatever the hour the preview is opened.
 *
 * "Yesterday" cannot be written as 24 hours ago: at 00:30 that lands two calendar days back,
 * the transcript grows a weekday heading (and an extra divider), and the sample looked
 * different depending on when it was opened. Anchoring to the day before keeps the preview
 * identical at 00:05 and at 23:55.
 */
function yesterdayIso(hour: number): string {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  date.setHours(hour, 0, 0, 0);
  return date.toISOString();
}

const sampleEvent = (
  id: string,
  title: string,
  date: string,
  repeat_frequency: RepeatFrequency = 'none',
): CoupleEvent => ({
  id,
  couple_id: 'preview-couple',
  created_by: 'preview-sam',
  title,
  event_date: date,
  repeat_frequency,
  created_at: NOW,
  updated_at: NOW,
});

const STARTING_EVENTS: CoupleEvent[] = [
  sampleEvent('e1', 'Movie night', dateKeyFromToday(0), 'weekly'),
  sampleEvent('e2', 'Ana flies in ✈️', dateKeyFromToday(1)),
  sampleEvent('e3', 'Sam’s birthday', dateKeyFromToday(23), 'yearly'),
  sampleEvent('e4', 'Rent due together', dateKeyFromToday(4), 'monthly'),
];

const PRESETS: Preset[] = [
  { label: 'Together for 2Y 1M 4D', anniversary: '2024-09-11' },
  { label: 'Anniversary today', anniversary: new Date().toISOString().slice(0, 10) },
  { label: 'Long distance (6Y 8M 1D)', anniversary: '2020-02-14' },
];

type PreviewTab = 'home' | 'chat' | 'games';

interface PreviewMessage extends ChatEntry {
  /** The name shown nowhere but useful when reading this file. */
  author: 'sam' | 'ana';
}

/** A transcript that already spans two days, so the day separators are visible. */
const STARTING_MESSAGES: PreviewMessage[] = [
  {
    id: 'm1',
    couple_id: 'preview-couple',
    sender_id: 'preview-ana',
    content: 'Slept badly, thinking of you. 🌙',
    type: 'text',
    session_id: null,
    reply_to_id: null,
    highlight_id: null,
    created_at: yesterdayIso(7),
    read_at: yesterdayIso(8),
    edited_at: null,
    delivery: 'read',
    author: 'ana',
  },
  {
    id: 'm2',
    couple_id: 'preview-couple',
    sender_id: 'preview-sam',
    content: 'Same here. Call me when you wake up?',
    type: 'text',
    session_id: null,
    reply_to_id: null,
    highlight_id: null,
    created_at: yesterdayIso(9),
    read_at: yesterdayIso(10),
    edited_at: null,
    delivery: 'read',
    author: 'sam',
  },
  {
    id: 'm3',
    couple_id: 'preview-couple',
    sender_id: 'preview-ana',
    content: 'Made your favourite tea ☕️\nWish you were at the table.',
    type: 'text',
    session_id: null,
    reply_to_id: null,
    highlight_id: null,
    created_at: earlierTodayIso(90),
    read_at: null,
    edited_at: null,
    delivery: 'sent',
    author: 'ana',
  },
  {
    id: 'm4',
    couple_id: 'preview-couple',
    sender_id: 'preview-sam',
    content: 'Miss you ❤️',
    type: 'text',
    session_id: null,
    reply_to_id: null,
    highlight_id: null,
    created_at: earlierTodayIso(60),
    read_at: earlierTodayIso(45),
    edited_at: earlierTodayIso(58),
    delivery: 'read',
    author: 'sam',
  },
  {
    id: 'm5',
    couple_id: 'preview-couple',
    sender_id: null,
    content: 'Prompt of the day: what made you smile today?',
    type: 'question',
    session_id: null,
    reply_to_id: null,
    highlight_id: null,
    created_at: earlierTodayIso(30),
    read_at: null,
    edited_at: null,
    delivery: 'sent',
    author: 'ana',
  },
  // A "Say more" message from the Discuss tab: the bubble quotes its question above it.
  {
    id: 'm6',
    couple_id: 'preview-couple',
    sender_id: 'preview-sam',
    content: 'Beach, always. The sea air fixes everything. 🌊',
    type: 'text',
    session_id: 'preview-session-1',
    reply_to_id: null,
    highlight_id: null,
    created_at: earlierTodayIso(10),
    read_at: null,
    edited_at: null,
    delivery: 'sent',
    author: 'sam',
  },
  // A swipe-to-reply: the partner's bubble quotes the message it answers.
  {
    id: 'm7',
    couple_id: 'preview-couple',
    sender_id: 'preview-ana',
    content: 'Santorini it is 💙 Booking tonight.',
    type: 'text',
    session_id: null,
    reply_to_id: 'm6',
    highlight_id: null,
    created_at: earlierTodayIso(5),
    read_at: null,
    edited_at: null,
    delivery: 'sent',
    author: 'ana',
  },
];

/** The Discuss question the quoted preview bubble grew out of. */
const PREVIEW_SESSION_QUESTIONS: Record<string, { text: string; category: string }> = {
  'preview-session-1': { text: 'Beach holiday or city break?', category: 'fun' },
};

export const AppPreview = () => {
  const [preset, setPreset] = useState(PRESETS[0]);
  const [partnerOnline, setPartnerOnline] = useState(true);
  const [showCalendar, setShowCalendar] = useState(false);
  const [showSplash, setShowSplash] = useState(true);
  const [tab, setTab] = useState<PreviewTab>('home');
  // Which duel the Games tab is showing: the preview has both, one at a time.
  const [previewGame, setPreviewGame] = useState<'snake' | 'tetris'>('tetris');
  const [events, setEvents] = useState<CoupleEvent[]>(STARTING_EVENTS);
  const [messages, setMessages] = useState<PreviewMessage[]>(STARTING_MESSAGES);
  const [partnerTyping, setPartnerTyping] = useState(false);
  // Couple Settings is the real sheet over sample state. It is the longest surface in the
  // app — sign-out, the 18+ gate, the notification card and the danger zone — so being able
  // to open it here is how the panel's scrolling gets looked at on a small screen.
  const [showSettings, setShowSettings] = useState(false);
  // The "I miss you" button, and the heart it becomes on the other phone. Both are driven
  // by the real components; the count here is the preview's own, never a backend's.
  const [missYouTaps, setMissYouTaps] = useState(0);
  const [missYouReveal, setMissYouReveal] = useState<MissYouBatch | null>(null);
  const [adultEnabled, setAdultEnabled] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  // "Update location" edits this phone's place, so the sheet can be looked at after a
  // change: null means the preset's Lagos is still what is on screen.
  const [savedProfile, setSavedProfile] = useState<Profile | null>(null);
  const timersRef = useRef<number[]>([]);

  // Fallback dismissal only: the splash itself reports when its race has finished
  // (see SplashScreen), so a phone that paints late still sees the whole run. This
  // timer covers reduced-motion readers, whose dots never animate or end.
  useEffect(() => {
    if (!showSplash) return;
    const timer = setTimeout(() => setShowSplash(false), SPLASH_DURATION_MS);
    return () => clearTimeout(timer);
  }, [showSplash]);

  useEffect(() => () => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
  }, []);

  const later = useCallback((delay: number, run: () => void) => {
    timersRef.current.push(window.setTimeout(run, delay));
  }, []);

  const couple: Couple = {
    id: 'preview-couple',
    invite_code: '7K4MZ9',
    anniversary_date: preset.anniversary,
    created_at: NOW,
    breakup_requested_by: null,
    breakup_requested_at: null,
  };
  // Partner 1 owns this phone; partner 2 is the person at the other end of the distance.
  const presetProfile: Profile = {
    id: 'preview-sam',
    couple_id: couple.id,
    name: 'Sam',
    timezone: 'Africa/Lagos',
    // The place each of them is: what settles the clock, and what the marketplace will
    // open on (Ana's city, because the gift would be going to her).
    country_code: 'NG',
    country_name: 'Nigeria',
    state_code: 'LA',
    state_name: 'Lagos',
    city_name: 'Lagos',
    city_key: 'ng/la/lagos',
    location_updated_at: NOW,
    last_seen_at: NOW,
    created_at: NOW,
  };
  const profile = savedProfile ?? presetProfile;
  const partner: Profile = {
    id: 'preview-ana',
    couple_id: couple.id,
    name: 'Ana',
    timezone: 'America/Los_Angeles',
    country_code: 'US',
    country_name: 'United States',
    state_code: 'CA',
    state_name: 'California',
    city_name: 'Los Angeles',
    city_key: 'us/ca/los-angeles',
    location_updated_at: NOW,
    last_seen_at: PARTNER_LAST_SEEN,
    created_at: NOW,
  };

  // The unread badge counts the partner's unseen messages — the same rule the app uses.
  const unread = messages.filter((message) => message.author === 'ana' && !message.read_at).length;

  // Opening the chat reads them, exactly like stepping into the tab on a phone.
  const openChat = useCallback(() => {
    setTab('chat');
    setMessages((current) => current.map((message) => (
      message.author === 'ana' && !message.read_at
        ? { ...message, read_at: new Date().toISOString(), delivery: 'read' }
        : message
    )));
  }, []);

  const sendAsSam = useCallback((content: string, sessionId: string | null = null, replyToId: string | null = null) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    const id = `preview-${Date.now()}`;
    const mine: PreviewMessage = {
      id,
      couple_id: couple.id,
      sender_id: profile.id,
      content: trimmed,
      type: 'text',
      session_id: sessionId,
      reply_to_id: replyToId,
      highlight_id: null,
      created_at: new Date().toISOString(),
      read_at: null,
      edited_at: null,
      delivery: 'sending',
      author: 'sam',
    };
    setMessages((current) => [...current, mine]);
    // The round trip, then Ana reading it: one check, then two.
    later(700, () => setMessages((current) => current.map((message) => (
      message.id === id ? { ...message, delivery: 'sent' } : message
    ))));
    later(2_600, () => setMessages((current) => current.map((message) => (
      message.id === id ? { ...message, delivery: 'read', read_at: new Date().toISOString() } : message
    ))));
  }, [couple.id, later, profile.id]);

  const receiveFromAna = useCallback(() => {
    setPartnerTyping(false);
    // A message that lands while the chat is open is read on arrival, like the app.
    const readAt = tab === 'chat' ? new Date().toISOString() : null;
    setMessages((current) => [...current, {
      id: `preview-ana-${Date.now()}`,
      couple_id: couple.id,
      sender_id: partner.id,
      content: 'Just sent you a voice note length text 😅 Thinking of our trip.',
      type: 'text' as const,
      session_id: null,
      reply_to_id: null,
      highlight_id: null,
      created_at: new Date().toISOString(),
      read_at: readAt,
      edited_at: null,
      delivery: 'sent' as const,
      author: 'ana' as const,
    }]);
  }, [couple.id, partner.id, tab]);

  const readAsAna = useCallback(() => {
    setMessages((current) => current.map((message) => (
      message.author === 'sam' && !message.read_at
        ? { ...message, read_at: new Date().toISOString(), delivery: 'read' }
        : message
    )));
  }, []);

  // The edit from the action menu: same timestamp rule the database applies.
  const editAsSam = useCallback((messageId: string, content: string) => {
    setMessages((current) => current.map((message) => (
      message.id === messageId && message.author === 'sam'
        ? { ...message, content, edited_at: new Date().toISOString() }
        : message
    )));
  }, []);

  // This page has no service worker, no permission prompt and no database, so the
  // notification card is shown in the state a capable browser would report, with a switch
  // that flips locally. The danger-zone buttons still call the real services, which say
  // plainly that this page has no backend behind it.
  const previewPush: PushNotificationsState = {
    support: 'ready',
    enabled: pushEnabled,
    busy: false,
    error: null,
    configurationError: null,
    enable: async () => { setPushEnabled(true); },
    disable: async () => { setPushEnabled(false); },
    clearError: () => {},
  };

  const controlStyle = (active: boolean): CSSProperties => ({
    padding: '5px 12px',
    borderRadius: tokens.radii.pill,
    border: `1.5px solid ${active ? tokens.colors.primaryPink : tokens.colors.borderSoft}`,
    backgroundColor: active ? tokens.colors.primaryPinkSoft : tokens.colors.bgSurface,
    color: active ? tokens.colors.primaryPinkDeep : tokens.colors.textSecondary,
    fontFamily: tokens.typography.fontFamily,
    fontSize: '0.74rem',
    fontWeight: 700,
    cursor: 'pointer',
  });

  const navItemStyle = (active: boolean): CSSProperties => ({
    background: 'none',
    border: 'none',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '2px',
    cursor: 'pointer',
    padding: '6px 10px',
    outline: 'none',
    fontFamily: tokens.typography.fontFamily,
    fontSize: '0.68rem',
    fontWeight: active ? 700 : 500,
    color: active ? tokens.colors.textPrimary : tokens.colors.textMuted,
  });

  return (
    <div
      className="nooki-viewport"
      style={{
        width: '100%',
        height: '100dvh',
        backgroundColor: tokens.colors.bgDesktop,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '10px',
        padding: '12px 0',
        fontFamily: tokens.typography.fontFamily,
        overflow: 'hidden',
      }}
    >
      <div
        className="nooki-preview-controls"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px',
          justifyContent: 'center',
          padding: '0 12px',
          flexShrink: 0,
          maxWidth: '720px',
        }}
      >
        {PRESETS.map((item) => (
          <button key={item.label} type="button" style={controlStyle(item === preset)} onClick={() => setPreset(item)}>
            {item.label}
          </button>
        ))}
        <button type="button" style={controlStyle(false)} onClick={() => setPartnerOnline((value) => !value)}>
          {partnerOnline ? 'Partner is online → show last seen' : 'Partner is away → show online'}
        </button>
        <button type="button" style={controlStyle(partnerTyping)} onClick={() => setPartnerTyping((value) => !value)}>
          {partnerTyping ? 'Ana is typing… (tap to stop)' : 'Make Ana type…'}
        </button>
        <button type="button" style={controlStyle(false)} onClick={receiveFromAna}>
          Ana sends a message
        </button>
        <button type="button" style={controlStyle(false)} onClick={readAsAna}>
          Ana reads your messages
        </button>
        <button type="button" style={controlStyle(showSplash)} onClick={() => setShowSplash(true)}>
          Replay splash
        </button>
        <button type="button" style={controlStyle(missYouTaps > 0)} onClick={() => setMissYouTaps(0)}>
          {missYouTaps > 0 ? `Reset the ${missYouTaps} miss-you taps` : 'I miss you (tap it in the nook)'}
        </button>
        <button
          type="button"
          style={controlStyle(Boolean(missYouReveal))}
          onClick={() => setMissYouReveal({
            count: Math.max(1, missYouTaps),
            dayTotal: Math.max(1, missYouTaps),
            allToday: true,
            lastDate: new Date().toISOString().slice(0, 10),
          })}
        >
          {`Ana missed you ${missYouTaps > 1 ? `${missYouTaps} times today` : 'once'}`}
        </button>
        <button type="button" style={controlStyle(showSettings)} onClick={() => setShowSettings(true)}>
          Couple Settings
        </button>
      </div>

      <main
        className="nooki-shell"
        style={{
          width: '100%',
          maxWidth: '390px',
          flex: 1,
          minHeight: 0,
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
        {showSplash ? (
          <SplashScreen onAnimationComplete={() => setShowSplash(false)} />
        ) : (
          <>
            {/* The real header component, so the preview can never drift from the app. */}
            <CoupleHeader
              profile={profile}
              partner={partner}
              couple={couple}
              partnerOnline={partnerOnline}
              onOpenSettings={() => setShowSettings(true)}
            />

            {tab === 'games' ? (
              /* The Games tab head — the real eyebrow, the real swipeable Ongoing games
                 card and the real Last duel row, fed sample matches — and below it the
                 duels played out on this page: same boards, same rules, no backend.
                 A toggle rather than two tabs — the preview is a page, not an app. */
              <section style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 18px 24px' }}>
                <header style={{ margin: '6px 0 16px' }}>
                  <span className="games-eyebrow">A little lovers rivalry</span>
                  <h1 style={{ fontSize: '1.6rem', margin: '6px 0 0', color: tokens.colors.textPrimary }}>Play together</h1>
                </header>
                <OngoingGames
                  slides={[
                    { id: 'sample-tetris', name: 'Tetris Duel', statusLine: 'Your turn · With your partner →' },
                    { id: 'sample-chess', name: 'Chess', statusLine: 'Your turn · With your partner →' },
                    { id: 'sample-snake', name: 'Snake Duel', statusLine: 'With your partner →' },
                  ]}
                  onOpen={() => {}}
                />
                <LastDuelRow name="Tetris Duel" outcome="You won · You 4100 — 900 Ana →" onOpen={() => {}} />
                <ChessDuel partnerName={partner.name} />
                <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', marginTop: '12px' }}>
                  {(['snake', 'tetris'] as const).map((game) => (
                    <button
                      key={game}
                      type="button"
                      aria-pressed={previewGame === game}
                      onClick={() => setPreviewGame(game)}
                      data-preview-game={game}
                      style={{
                        font: 'inherit',
                        fontSize: '0.8rem',
                        fontWeight: 700,
                        border: 'none',
                        borderRadius: '14px',
                        padding: '9px 14px',
                        cursor: 'pointer',
                        backgroundColor: previewGame === game ? tokens.colors.primaryPink : tokens.colors.accentLavenderSoft,
                        color: tokens.colors.textPrimary,
                      }}
                    >
                      {game === 'tetris' ? '🧱 Tetris Duel' : '🐍 Snake Duel'}
                    </button>
                  ))}
                </div>
                {previewGame === 'tetris'
                  ? <PreviewTetris partnerName={partner.name} />
                  : <PreviewSnake partnerName={partner.name} />}
              </section>
            ) : tab === 'home' ? (
              <HomeView
                events={events}
                anniversaryDate={couple.anniversary_date}
                eventsLoading={false}
                eventsError={null}
                onOpenCalendar={() => setShowCalendar(true)}
                partnerOnline={partnerOnline}
                missYou={{
                  visible: !partnerOnline,
                  sentCount: missYouTaps,
                  partnerName: partner.name,
                  error: null,
                  onTap: () => setMissYouTaps((value) => value + 1),
                }}
              />
            ) : (
              /* The real chat: sending, receipts, typing and day separators all work. */
              <ChatView
                messages={messages}
                currentUserId={profile.id}
                partnerName={partner.name}
                partnerOnline={partnerOnline}
                partnerLastSeenAt={partner.last_seen_at}
                partnerTyping={partnerTyping}
                loading={false}
                error={null}
                onSend={sendAsSam}
                onTyping={() => {}}
                onStopTyping={() => {}}
                onEditMessage={editAsSam}
                onRetry={(entryId) => setMessages((current) => current.filter((message) => message.id !== entryId))}
                onDismissError={() => {}}
                questionBySessionId={PREVIEW_SESSION_QUESTIONS}
                onOpenQuestion={() => {}}
              />
            )}

            {/* The big heart Ana's taps become on Sam's phone, over whatever tab is open. */}
            {missYouReveal && (
              <MissYouReveal
                batch={missYouReveal}
                senderName={partner.name}
                onDismiss={() => setMissYouReveal(null)}
              />
            )}

            {showCalendar && (
              <CalendarModal
                partnerName={partner.name}
                events={events}
                anniversaryDate={couple.anniversary_date}
                saving={false}
                onAddEvent={async (input) => {
                  setEvents((current) => [...current, sampleEvent(`preview-${current.length + 10}`, input.title, input.date, input.repeatFrequency)]);
                }}
                onEditEvent={async (eventId, input) => {
                  setEvents((current) => current.map((event) => (
                    event.id === eventId
                      ? { ...event, title: input.title, event_date: input.date, repeat_frequency: input.repeatFrequency }
                      : event
                  )));
                }}
                onDeleteEvent={async (eventId) => {
                  setEvents((current) => current.filter((event) => event.id !== eventId));
                }}
                onClose={() => setShowCalendar(false)}
              />
            )}

            {showSettings && (
              <DangerSettingsModal
                userId={profile.id}
                couple={couple}
                profile={profile}
                partner={partner}
                onLocationSaved={setSavedProfile}
                adultQuestionsEnabled={adultEnabled}
                partnerAdultQuestionsEnabled={false}
                adultQuestionsSaving={false}
                onToggleAdultQuestions={async (enabled) => { setAdultEnabled(enabled); }}
                pushNotifications={previewPush}
                onClose={() => setShowSettings(false)}
                onCoupleEnded={() => setShowSettings(false)}
                onSignOut={() => setShowSettings(false)}
              />
            )}

            <nav
              aria-label="Preview navigation"
              style={{
                height: '64px',
                flexShrink: 0,
                backgroundColor: tokens.colors.bgSurface,
                boxShadow: tokens.shadows.navBar,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-around',
                padding: '0 8px calc(6px + env(safe-area-inset-bottom, 0px)) 8px',
              }}
            >
              {/* Chat, Home and Games are live in this preview; Discuss stays inert. */}
              <button
                type="button"
                aria-label={unread ? `Chat, ${unread} unread ${unread === 1 ? 'message' : 'messages'}` : 'Chat'}
                onClick={openChat}
                style={navItemStyle(tab === 'chat')}
              >
                <span
                  style={{
                    position: 'relative',
                    width: '30px',
                    height: '26px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: tokens.radii.sm,
                    backgroundColor: tab === 'chat' ? tokens.colors.primaryPinkSoft : 'transparent',
                    color: tab === 'chat' ? tokens.colors.primaryPinkDeep : tokens.colors.textMuted,
                  }}
                >
                  <MessageCircle size={19} />
                  {unread > 0 && (
                    <span className="nooki-nav-badge" data-nav-badge="chat">{unread}</span>
                  )}
                </span>
                Chat
              </button>

              {[
                { label: 'Media', Icon: ImageIcon, tint: tokens.colors.primaryGreenSoft, ink: tokens.colors.primaryGreenDeep },
              ].map(({ label, Icon, tint, ink }) => (
                <span key={label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px', color: tokens.colors.textMuted }}>
                  <span style={{ width: '30px', height: '26px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: tokens.radii.sm, backgroundColor: tint, color: ink }}>
                    <Icon size={19} />
                  </span>
                  <span style={{ fontSize: '0.68rem', fontWeight: 500 }}>{label}</span>
                </span>
              ))}

              <button type="button" aria-label="Home" onClick={() => setTab('home')} style={{ ...navItemStyle(tab === 'home'), position: 'relative', top: '-10px', gap: '1px' }}>
                <span
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
                  }}
                >
                  <HomeIcon size={21} strokeWidth={2.4} />
                </span>
                <span style={{ color: tokens.colors.primaryPinkDeep, fontWeight: 700 }}>Home</span>
              </button>

              {[
                { label: 'Discuss', Icon: MessageSquare, tint: tokens.colors.accentSageSoft, ink: tokens.colors.accentSageDeep },
              ].map(({ label, Icon, tint, ink }) => (
                <span key={label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px', color: tokens.colors.textMuted }}>
                  <span style={{ width: '30px', height: '26px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: tokens.radii.sm, backgroundColor: tint, color: ink }}>
                    <Icon size={19} />
                  </span>
                  <span style={{ fontSize: '0.68rem', fontWeight: 500 }}>{label}</span>
                </span>
              ))}

              <button
                type="button"
                aria-label="Games"
                onClick={() => setTab('games')}
                style={navItemStyle(tab === 'games')}
              >
                <span
                  style={{
                    width: '30px',
                    height: '26px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: tokens.radii.sm,
                    backgroundColor: tab === 'games' ? tokens.colors.accentLavenderSoft : 'transparent',
                    color: tab === 'games' ? tokens.colors.accentLavenderDeep : tokens.colors.textMuted,
                  }}
                >
                  <Gamepad2 size={19} />
                </span>
                Games
              </button>
            </nav>
          </>
        )}
      </main>

      <p
        className="nooki-preview-caption"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          margin: 0,
          fontSize: '0.74rem',
          color: tokens.colors.textMuted,
          flexShrink: 0,
          textAlign: 'center',
        }}
      >
        <Heart size={13} fill={tokens.colors.primaryPink} strokeWidth={1.5} />
        {tab === 'chat'
          ? 'Chat preview · sample conversation only · send a message, or make Ana type and reply'
          : tab === 'games'
            ? (previewGame === 'tetris'
              ? 'Tetris Duel preview · played out on this page, no backend · the real duel is scored by the database'
              : 'Snake Duel preview · played out on this page, no backend · the real duel is scored by the database')
            : 'Home preview · sample data only · tap the calendar icon, or switch to Chat below'}
      </p>
    </div>
  );
};

export default AppPreview;
;
