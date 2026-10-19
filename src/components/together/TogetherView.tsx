import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Bell,
  BookOpen,
  CalendarDays,
  CalendarHeart,
  Check,
  CheckCircle2,
  Clock3,
  Gamepad2,
  Heart,
  LockKeyhole,
  MapPin,
  MessageCircle,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { MAX_BOOKS_ON_SHELF, SHELF_FULL_HELP } from '../../lib/booksService';
import { GAMES } from '../../lib/gamesService';
import type { BooksState } from '../../hooks/useBooks';
import type {
  SharedBook,
  SomedayItem,
  TogetherActivityType,
  TogetherTimeSession,
  Visit,
} from '../../types/database';

interface TogetherViewProps {
  state: BooksState;
  userId: string;
  partnerName: string;
  visit?: Visit | null;
  onPlanVisit?: () => void;
  onViewVisitPlans?: () => void;
  onOpenReader: (bookId: string) => void;
  somedayItems?: SomedayItem[];
  somedayError?: string | null;
  onAddSomedayItem?: (text: string, details?: string | null, visibility?: 'open' | 'private') => Promise<unknown>;
  onUpdateSomedayItem?: (item: SomedayItem, text: string, details: string | null, visibility?: 'open' | 'private') => Promise<void>;
  onToggleSomedayWant?: (item: SomedayItem) => Promise<void>;
  onDeleteSomedayItem?: (item: SomedayItem) => Promise<void>;
  somedaySaving?: boolean;
  togetherTimeSessions?: TogetherTimeSession[];
  togetherTimeError?: string | null;
  togetherTimeSaving?: boolean;
  timezone?: string;
  onProposeTogetherTime?: (input: { activityType: TogetherActivityType; activityId: string; activityName: string; scheduledAt: string; timezone: string }) => Promise<void>;
  onAgreeTogetherTime?: (session: TogetherTimeSession) => Promise<void>;
  onSuggestTogetherTime?: (session: TogetherTimeSession, scheduledAt: string, timezone: string) => Promise<void>;
  /** "Talk about it": carry this date into the chat so the couple can settle on a time there. */
  onTalkAboutTogetherTime?: (session: TogetherTimeSession) => Promise<void> | void;
  onUpdateTogetherTime?: (session: TogetherTimeSession, status: 'done' | 'cancelled') => Promise<void>;
  onOpenActivity?: (session: TogetherTimeSession) => void;
  initialSessionId?: string | null;
  onClearInitialSession?: () => void;
  remindersEnabled?: boolean;
}

const cardStyle: React.CSSProperties = {
  background: tokens.colors.bgSurface,
  borderRadius: tokens.radii.card,
  padding: '18px',
  boxShadow: tokens.shadows.card,
};

const buttonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '7px',
  minHeight: '42px',
  padding: '10px 16px',
  border: 'none',
  borderRadius: tokens.radii.pill,
  background: tokens.colors.primaryPinkDeep,
  color: tokens.colors.textWhite,
  fontFamily: tokens.typography.fontFamily,
  fontWeight: 800,
  fontSize: '0.83rem',
  cursor: 'pointer',
};

const secondaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: tokens.colors.bgSurfaceSubtle,
  color: tokens.colors.textSecondary,
  border: `1px solid ${tokens.colors.borderSoft}`,
};

const fieldStyle: React.CSSProperties = {
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  padding: '11px 12px',
  border: `1px solid ${tokens.colors.borderSoft}`,
  borderRadius: tokens.radii.md,
  background: tokens.colors.bgSurface,
  color: tokens.colors.textPrimary,
  fontFamily: tokens.typography.fontFamily,
  fontSize: '0.84rem',
};

function SectionHeading({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle?: string }) {
  return (
    <div style={{ margin: '4px 2px 0' }}>
      <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '7px', color: tokens.colors.textPrimary, fontSize: '1.05rem', fontWeight: 900 }}>
        <span style={{ color: tokens.colors.primaryPinkDeep, lineHeight: 0 }}>{icon}</span>{title}
      </h2>
      {subtitle && <p style={{ margin: '5px 0 0', color: tokens.colors.textMuted, fontSize: '0.78rem', lineHeight: 1.45 }}>{subtitle}</p>}
    </div>
  );
}

function dateAtNoon(date: string): Date {
  return new Date(`${date}T12:00:00`);
}

function formatDate(date: string, options: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }): string {
  const parsed = dateAtNoon(date);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString(undefined, options);
}

function formatVisitTime(visit: Visit): string {
  const start = formatDate(visit.start_date, { month: 'long', day: 'numeric', year: 'numeric' });
  if (!visit.end_date || visit.end_date === visit.start_date) return start;
  return `${start} – ${formatDate(visit.end_date, { month: 'long', day: 'numeric', year: 'numeric' })}`;
}

function formatTime(iso: string, timezone?: string): string {
  const date = new Date(iso);
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      ...(timezone ? { timeZone: timezone } : {}),
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function dateTimeLocalValue(date: Date, timezone?: string): string {
  if (!timezone) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  }
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? '00';
    return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
  } catch {
    return dateTimeLocalValue(date);
  }
}

function dateFromWallClock(value: string, timezone?: string): Date {
  if (!timezone) return new Date(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return new Date(value);
  const desired = match.slice(1).map(Number);
  const targetAsUtc = Date.UTC(desired[0], desired[1] - 1, desired[2], desired[3], desired[4]);
  let guess = targetAsUtc;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const parts = formatter.formatToParts(new Date(guess));
      const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      const actualAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute));
      const correction = targetAsUtc - actualAsUtc;
      guess += correction;
      if (correction === 0) break;
    }
    return new Date(guess);
  } catch {
    return new Date(value);
  }
}

function defaultDateTime(timezone?: string): string {
  const date = new Date();
  date.setMinutes(Math.ceil((date.getMinutes() + 30) / 15) * 15, 0, 0);
  return dateTimeLocalValue(date, timezone);
}

function SectionCard({ children, style, ...props }: React.HTMLAttributes<HTMLElement> & { children: React.ReactNode; style?: React.CSSProperties }) {
  return <article {...props} style={{ ...cardStyle, ...style }}>{children}</article>;
}

function VisitHero({ visit, onPlanVisit, onViewPlans }: { visit: Visit | null; onPlanVisit: () => void; onViewPlans: () => void }) {
  if (!visit) {
    return (
      <SectionCard data-visit-card="empty" style={{ padding: '24px 20px', border: `1px solid ${tokens.colors.primaryPinkSoft}`, background: 'linear-gradient(145deg, #fff 0%, #fff8fb 100%)' }}>
        <div style={{ width: '48px', height: '48px', borderRadius: tokens.radii.full, display: 'grid', placeItems: 'center', background: tokens.colors.primaryPinkSoft, color: tokens.colors.primaryPinkDeep }}>
          <CalendarHeart size={24} />
        </div>
        <p style={{ margin: '14px 0 5px', color: tokens.colors.primaryPinkDeep, fontSize: '0.68rem', letterSpacing: '0.09em', fontWeight: 900, textTransform: 'uppercase' }}>Your next chapter together</p>
        <h1 style={{ margin: 0, color: tokens.colors.textPrimary, fontSize: '1.45rem', lineHeight: 1.2, fontWeight: 900 }}>Pick your next visit date.</h1>
        <p style={{ margin: '9px 0 17px', color: tokens.colors.textSecondary, fontSize: '0.84rem', lineHeight: 1.5 }}>A date gives you both something real to look forward to.</p>
        <button type="button" data-action="plan-next-visit" onClick={onPlanVisit} style={{ ...buttonStyle, width: '100%', minHeight: '48px' }}>
          <CalendarDays size={17} /> Pick a date
        </button>
      </SectionCard>
    );
  }
  const start = dateAtNoon(visit.start_date);
  const today = new Date();
  const todayNoon = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12);
  const days = Math.max(0, Math.ceil((start.getTime() - todayNoon.getTime()) / 86_400_000));
  return (
    <SectionCard data-visit-card="upcoming" style={{ padding: 18, background: 'linear-gradient(150deg, #fff 0%, #fff9fb 100%)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '13px' }}>
        <div style={{ width: '54px', height: '54px', borderRadius: tokens.radii.lg, display: 'grid', placeItems: 'center', color: tokens.colors.textWhite, background: `linear-gradient(140deg, ${tokens.colors.primaryPinkDeep}, ${tokens.colors.primaryPink})`, flexShrink: 0 }}>
          <Heart size={25} fill="currentColor" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ margin: 0, color: tokens.colors.primaryPinkDeep, fontSize: '0.66rem', fontWeight: 900, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Our next visit</p>
          <h1 style={{ margin: '3px 0 0', color: tokens.colors.textPrimary, fontSize: '1.23rem', fontWeight: 900, lineHeight: 1.15 }}>
            {days === 0 ? 'It starts today' : days === 1 ? 'One more sleep' : `${days} days to go`}
          </h1>
        </div>
        <button type="button" onClick={onViewPlans} aria-label="Edit visit plan" style={{ ...secondaryButtonStyle, width: '40px', minHeight: '40px', padding: 0, flexShrink: 0 }}>
          <CalendarDays size={16} />
        </button>
      </div>
      <div style={{ marginTop: '14px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', color: tokens.colors.textSecondary, fontSize: '0.8rem', fontWeight: 700 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}><CalendarDays size={14} />{formatVisitTime(visit)}</span>
        {visit.location && <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}><MapPin size={14} />{visit.location}</span>}
        {visit.is_tentative && <span style={{ padding: '3px 8px', borderRadius: tokens.radii.pill, color: tokens.colors.accentLavenderDeep, background: tokens.colors.accentLavenderSoft, fontSize: '0.68rem' }}>Hopeful plan</span>}
      </div>
    </SectionCard>
  );
}

function readingStage(percent: number): string {
  if (percent < 15) return 'beginning';
  if (percent < 40) return 'first part';
  if (percent < 65) return 'middle';
  if (percent < 85) return 'later part';
  return 'final stretch';
}

function jointReadingSummary(myProgress: { percent: number } | null | undefined, partnerProgress: { percent: number } | null | undefined): string {
  const places = [myProgress?.percent, partnerProgress?.percent].filter((value): value is number => typeof value === 'number');
  if (places.length === 0) return 'Open it whenever you both feel like reading.';
  const sharedPlace = readingStage(places.reduce((sum, value) => sum + value, 0) / places.length);
  if (places.length === 2) return `You’re both around the ${sharedPlace} of the story. Read at your own pace—there’s no race.`;
  return `The story is around the ${sharedPlace} for one of you. The other can join whenever.`;
}

function BookShelf({ state, userId, onOpenReader }: { state: BooksState; userId: string; onOpenReader: (bookId: string) => void }) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const shelfFull = state.books.length >= MAX_BOOKS_ON_SHELF;
  const active = state.books.find((book) => book.status === 'reading') ?? state.books.find((book) => book.status === 'left') ?? state.books[0] ?? null;
  const myProgress = active ? state.progress.find((progress) => progress.book_id === active.id && progress.user_id === userId) : null;
  const partnerProgress = active ? state.progress.find((progress) => progress.book_id === active.id && progress.user_id !== userId) : null;
  const chooseFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) await state.upload(file as File & { name: string; size: number; type: string });
  };
  const upload = () => fileInput.current?.click();
  const remove = async (book: SharedBook) => {
    if (window.confirm(`Remove “${book.title}” from your shared shelf?`)) await state.remove(book);
  };
  return (
    <SectionCard data-card="read-together" data-section="read-together" style={{ padding: 15, background: 'linear-gradient(150deg, #fff 0%, #f8fff9 100%)' }}>
      <input ref={fileInput} data-upload-input type="file" accept=".epub,.pdf,application/pdf,application/epub+zip" onChange={(event) => { void chooseFile(event); }} style={{ display: 'none' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div style={{ width: '34px', height: '34px', borderRadius: tokens.radii.full, display: 'grid', placeItems: 'center', background: tokens.colors.primaryGreenSoft, color: tokens.colors.primaryGreenDeep }}><BookOpen size={17} /></div>
        <div><h3 style={{ margin: 0, color: tokens.colors.textPrimary, fontSize: '0.94rem', fontWeight: 900 }}>Read together</h3><p style={{ margin: '2px 0 0', color: tokens.colors.textMuted, fontSize: '0.68rem' }}>A shared book, at your own pace.</p></div>
      </div>
      {active ? (
        <div data-book-card={active.id} style={{ marginTop: '12px', padding: '12px', borderRadius: tokens.radii.md, background: tokens.colors.bgSurfaceSubtle }}>
          <p style={{ margin: 0, color: tokens.colors.primaryGreenDeep, fontSize: '0.64rem', letterSpacing: '0.07em', textTransform: 'uppercase', fontWeight: 900 }}>{active.status === 'finished' ? 'Finished together' : active.status === 'left' ? 'Paused together' : 'On your shared shelf'}</p>
          <p style={{ margin: '4px 0 0', color: tokens.colors.textPrimary, fontSize: '0.91rem', fontWeight: 900 }}>{active.title}</p>
          <p style={{ margin: '5px 0 0', color: tokens.colors.textSecondary, fontSize: '0.72rem', lineHeight: 1.4 }}>
            {jointReadingSummary(myProgress, partnerProgress)}
          </p>
          <button type="button" data-action="read-together" onClick={() => onOpenReader(active.id)} style={{ ...buttonStyle, width: '100%', marginTop: '10px', minHeight: '38px', padding: '8px 12px', background: tokens.colors.primaryGreenDeep }}>
            <BookOpen size={15} />{active.status === 'left' ? 'Continue reading together' : 'Open the book'}
          </button>
        </div>
      ) : (
        <div style={{ marginTop: '12px', padding: '12px', borderRadius: tokens.radii.md, background: tokens.colors.bgSurfaceSubtle }}>
          <p style={{ margin: 0, color: tokens.colors.textSecondary, fontSize: '0.74rem', lineHeight: 1.45 }}>Choose a book for a quiet shared moment—no progress bars, no pressure.</p>
        </div>
      )}
      {state.error && <p role="alert" style={{ margin: '8px 0 0', color: tokens.colors.primaryPinkDeep, fontSize: '0.7rem' }}>{state.error}</p>}
      {state.books.length > 1 && (
        <div style={{ marginTop: '9px', display: 'grid', gap: '6px' }}>
          {state.books.filter((book) => book.id !== active?.id).map((book) => (
            <div key={book.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', fontSize: '0.72rem' }}>
              <span style={{ flex: 1, color: tokens.colors.textSecondary }}>{book.title}</span>
              <button type="button" onClick={() => onOpenReader(book.id)} style={{ border: 0, background: 'none', color: tokens.colors.primaryGreenDeep, fontFamily: tokens.typography.fontFamily, fontWeight: 800, cursor: 'pointer' }}>Open</button>
              <button type="button" onClick={() => { void remove(book); }} aria-label={`Remove ${book.title}`} style={{ border: 0, background: 'none', color: tokens.colors.textMuted, cursor: 'pointer', lineHeight: 0 }}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}
      {!shelfFull && (
        <button type="button" data-upload-book disabled={state.busy} onClick={upload} style={{ ...secondaryButtonStyle, width: '100%', marginTop: '10px', minHeight: '38px', padding: '8px', color: tokens.colors.primaryGreenDeep, opacity: state.busy ? 0.55 : 1 }}>
          <Upload size={14} />{state.busy ? 'Uploading…' : active ? 'Add a book' : 'Choose a shared book'}
        </button>
      )}
      {shelfFull && <p style={{ margin: '8px 2px 0', color: tokens.colors.textMuted, fontSize: '0.66rem' }}>{SHELF_FULL_HELP}</p>}
    </SectionCard>
  );
}

function localActivityOptions(books: SharedBook[]) {
  return {
    books: books.filter((book) => book.status !== 'finished').map((book) => ({ id: book.id, name: book.title })),
    games: GAMES.map((game) => ({ id: game.id, name: game.name })),
  };
}

function TogetherTimeSection({
  sessions = [], state, userId, partnerName, onOpenReader, timezone, saving = false, error, remindersEnabled, onPropose, onAgree, onSuggest, onTalkAbout, onUpdate, onOpen,
}: {
  sessions?: TogetherTimeSession[];
  state: BooksState;
  userId: string;
  partnerName: string;
  onOpenReader: (bookId: string) => void;
  timezone?: string;
  saving?: boolean;
  error?: string | null;
  remindersEnabled?: boolean;
  onPropose?: (input: { activityType: TogetherActivityType; activityId: string; activityName: string; scheduledAt: string; timezone: string }) => Promise<void>;
  onAgree?: (session: TogetherTimeSession) => Promise<void>;
  onSuggest?: (session: TogetherTimeSession, scheduledAt: string, timezone: string) => Promise<void>;
  onTalkAbout?: (session: TogetherTimeSession) => Promise<void> | void;
  onUpdate?: (session: TogetherTimeSession, status: 'done' | 'cancelled') => Promise<void>;
  onOpen?: (session: TogetherTimeSession) => void;
}) {
  const options = useMemo(() => localActivityOptions(state.books), [state.books]);
  const firstActivity = options.books[0] ? { activityType: 'book' as const, activityId: options.books[0].id, activityName: options.books[0].name } : { activityType: 'game' as const, activityId: 'word-wheel', activityName: 'Word Wheel' };
  const [activityType, setActivityType] = useState<TogetherActivityType>(firstActivity.activityType);
  const [activityId, setActivityId] = useState(firstActivity.activityId);
  const [scheduledAt, setScheduledAt] = useState(() => defaultDateTime(timezone));
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // The one card whose "Suggest another time" picker is open, and its draft value.
  const [suggestingFor, setSuggestingFor] = useState<string | null>(null);
  const [suggestedAt, setSuggestedAt] = useState('');
  useEffect(() => {
    const newOptions = localActivityOptions(state.books);
    if (activityType === 'book' && !newOptions.books.some((book) => book.id === activityId)) {
      if (newOptions.books[0]) { setActivityType('book'); setActivityId(newOptions.books[0].id); }
      else { setActivityType('game'); setActivityId('word-wheel'); }
    }
  }, [state.books, activityType, activityId]);
  const currentOptions = activityType === 'book' ? options.books : options.games;
  const selectedActivity = currentOptions.find((option) => option.id === activityId) ?? currentOptions[0] ?? null;
  const proposed = sessions.filter((session) => session.status === 'proposed');
  const scheduled = sessions.filter((session) => session.status === 'scheduled');
  const past = sessions.filter((session) => session.status === 'done' || session.status === 'cancelled');
  // Whose suggestion the current time is. Rows from before the agreement flow have no
  // proposed_by until the migration backfills it, so fall back to the creator.
  const suggestedBy = (session: TogetherTimeSession) => session.proposed_by ?? session.created_by;
  const myTimezone = () => timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedActivity || !onPropose) return;
    const scheduleTimezone = myTimezone();
    const date = dateFromWallClock(scheduledAt, scheduleTimezone);
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
      setErrorMessage('Choose a time in the future.');
      return;
    }
    setErrorMessage(null);
    try {
      await onPropose({
        activityType,
        activityId: selectedActivity.id,
        activityName: selectedActivity.name,
        scheduledAt: date.toISOString(),
        timezone: scheduleTimezone,
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'This suggestion could not be sent.');
    }
  };
  const updateSession = async (session: TogetherTimeSession, status: 'done' | 'cancelled') => {
    if (!onUpdate) return;
    setErrorMessage(null);
    try { await onUpdate(session, status); }
    catch (error) { setErrorMessage(error instanceof Error ? error.message : 'This date could not be updated.'); }
  };
  const agreeToSession = async (session: TogetherTimeSession) => {
    if (!onAgree) return;
    setErrorMessage(null);
    try { await onAgree(session); }
    catch (error) { setErrorMessage(error instanceof Error ? error.message : 'This time could not be locked in.'); }
  };
  const openSuggest = (session: TogetherTimeSession) => {
    setErrorMessage(null);
    setSuggestedAt(dateTimeLocalValue(new Date(session.scheduled_at), myTimezone()));
    setSuggestingFor(session.id);
  };
  const submitSuggestion = async (event: React.FormEvent, session: TogetherTimeSession) => {
    event.preventDefault();
    if (!onSuggest) return;
    const suggestTimezone = myTimezone();
    const date = dateFromWallClock(suggestedAt, suggestTimezone);
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
      setErrorMessage('Choose a time in the future.');
      return;
    }
    setErrorMessage(null);
    try {
      await onSuggest(session, date.toISOString(), suggestTimezone);
      setSuggestingFor(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Your suggestion could not be sent.');
    }
  };
  const talkAboutSession = async (session: TogetherTimeSession) => {
    if (!onTalkAbout) return;
    setErrorMessage(null);
    try { await onTalkAbout(session); }
    catch (error) { setErrorMessage(error instanceof Error ? error.message : 'The chat could not be opened.'); }
  };
  // The two ways to answer a time without simply agreeing to it: take it to the chat
  // and deliberate there, or counter-suggest a time that works better.
  const renderTalkAndSuggest = (session: TogetherTimeSession) => (
    <div style={{ display: 'flex', gap: '7px', marginTop: '7px' }}>
      <button type="button" data-talk-about-together-time={session.id} onClick={() => { void talkAboutSession(session); }} style={{ ...secondaryButtonStyle, flex: 1, minHeight: '37px', padding: '8px 10px', fontSize: '0.74rem', color: tokens.colors.primaryPinkDeep }}>
        <MessageCircle size={14} />Talk about it
      </button>
      <button type="button" data-suggest-together-time={session.id} aria-expanded={suggestingFor === session.id} onClick={() => (suggestingFor === session.id ? setSuggestingFor(null) : openSuggest(session))} style={{ ...secondaryButtonStyle, flex: 1, minHeight: '37px', padding: '8px 10px', fontSize: '0.74rem' }}>
        <Clock3 size={14} />Suggest another time
      </button>
    </div>
  );
  const renderSuggestForm = (session: TogetherTimeSession) => suggestingFor === session.id && (
    <form data-suggest-time-form={session.id} onSubmit={(event) => { void submitSuggestion(event, session); }} style={{ display: 'grid', gap: '8px', marginTop: '10px', padding: '11px', borderRadius: tokens.radii.md, background: tokens.colors.bgSurfaceSubtle }}>
      <label style={{ display: 'grid', gap: '5px', color: tokens.colors.textSecondary, fontSize: '0.69rem', fontWeight: 800 }}>
        A time that works better for you
        <input type="datetime-local" aria-label={`Suggest a different time for ${session.activity_name}`} required value={suggestedAt} onChange={(event) => setSuggestedAt(event.target.value)} style={fieldStyle} />
      </label>
      <div style={{ display: 'flex', gap: '7px', alignItems: 'center' }}>
        <button type="submit" disabled={saving} style={{ ...buttonStyle, flex: 1, minHeight: '38px', padding: '8px 12px', fontSize: '0.74rem', opacity: saving ? 0.6 : 1 }}>{saving ? 'Sending…' : 'Send suggestion'}</button>
        <button type="button" onClick={() => setSuggestingFor(null)} style={{ ...secondaryButtonStyle, minHeight: '38px', padding: '8px 12px', fontSize: '0.74rem' }}>Not now</button>
      </div>
      <p style={{ margin: 0, color: tokens.colors.textMuted, fontSize: '0.66rem', lineHeight: 1.45 }}>{partnerName} will need to agree before this new time locks in.</p>
    </form>
  );
  return (
    <section data-section="together-time" style={{ display: 'grid', gap: '10px' }}>
      <SectionHeading icon={<Clock3 size={17} />} title="Together time" subtitle="Suggest a time to do something together — it only locks in once you both agree." />
      <SectionCard data-together-time-scheduler style={{ padding: 15 }}>
        <form onSubmit={(event) => { void submit(event); }} style={{ display: 'grid', gap: '10px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.2fr)', gap: '8px' }}>
            <label style={{ display: 'grid', gap: '5px', color: tokens.colors.textSecondary, fontSize: '0.69rem', fontWeight: 800 }}>
              What shall we do?
              <select aria-label="Together time activity type" value={activityType} onChange={(event) => { const value = event.target.value as TogetherActivityType; setActivityType(value); const next = value === 'book' ? options.books[0] : options.games.find((game) => game.id === activityId) || options.games[0]; if (next) setActivityId(next.id); }} style={{ ...fieldStyle, padding: '9px 8px', fontSize: '0.74rem' }}>
                <option value="book" disabled={options.books.length === 0}>Read a book</option>
                <option value="game">Play a game</option>
              </select>
            </label>
            <label style={{ display: 'grid', gap: '5px', color: tokens.colors.textSecondary, fontSize: '0.69rem', fontWeight: 800 }}>
              Pick one
              <select aria-label="Choose a book or game" value={activityId} onChange={(event) => setActivityId(event.target.value)} style={{ ...fieldStyle, padding: '9px 8px', fontSize: '0.74rem' }}>
                {currentOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
              </select>
            </label>
          </div>
          <label style={{ display: 'grid', gap: '5px', color: tokens.colors.textSecondary, fontSize: '0.69rem', fontWeight: 800 }}>
            When?
            <input type="datetime-local" required value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} style={fieldStyle} />
          </label>
          <button type="submit" disabled={saving || !selectedActivity} style={{ ...buttonStyle, width: '100%', minHeight: '44px', opacity: saving || !selectedActivity ? 0.6 : 1 }}>
            <CalendarHeart size={16} />{saving ? 'Sending your suggestion…' : 'Propose this time'}
          </button>
          <p style={{ margin: 0, color: tokens.colors.textMuted, fontSize: '0.68rem', lineHeight: 1.45 }}>
            This is a suggestion, not a fixed plan. {partnerName} can agree to it, suggest a different time, or talk it over with you in the chat — nothing is locked in until you have both said yes.
          </p>
          <p style={{ margin: 0, display: 'flex', alignItems: 'flex-start', gap: '6px', color: tokens.colors.textMuted, fontSize: '0.68rem', lineHeight: 1.45 }}>
            <Bell size={13} style={{ flexShrink: 0, marginTop: '1px' }} />
            {remindersEnabled === false ? 'Once a time is locked in, turn on notifications on both phones to get a reminder when it’s time.' : 'Once a time is locked in, both of you will get a reminder when it’s time. Turn on notifications in Settings on each phone.'}
          </p>
          {(error || errorMessage) && <p role="alert" style={{ margin: 0, color: tokens.colors.primaryPinkDeep, fontSize: '0.72rem' }}>{errorMessage || error}</p>}
        </form>
      </SectionCard>
      {proposed.length > 0 && (
        <div data-together-time-proposals style={{ display: 'grid', gap: '8px' }}>
          {proposed.map((session) => {
            const mine = suggestedBy(session) === userId;
            return (
              <SectionCard key={session.id} data-together-time-session={session.id} data-together-time-status="proposed" style={{ padding: '13px 14px', border: `1.5px dashed ${tokens.colors.accentLavender}` }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '9px' }}>
                  <div style={{ width: '38px', height: '38px', flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: tokens.radii.md, background: session.activity_type === 'book' ? tokens.colors.primaryGreenSoft : tokens.colors.accentLavenderSoft, color: session.activity_type === 'book' ? tokens.colors.primaryGreenDeep : tokens.colors.accentLavenderDeep }}>
                    {session.activity_type === 'book' ? <BookOpen size={17} /> : <Gamepad2 size={17} />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, color: tokens.colors.textPrimary, fontSize: '0.84rem', fontWeight: 900, overflowWrap: 'anywhere' }}>{session.activity_name}</p>
                    <p style={{ margin: '3px 0 0', color: tokens.colors.textMuted, fontSize: '0.7rem', fontWeight: 800 }}>{formatTime(session.scheduled_at, session.timezone)} ({session.timezone})</p>
                    <p data-together-time-waiting={session.id} style={{ margin: '6px 0 0', display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '3px 8px', borderRadius: tokens.radii.pill, background: tokens.colors.accentLavenderSoft, color: tokens.colors.accentLavenderDeep, fontSize: '0.64rem', fontWeight: 900 }}>
                      <Clock3 size={11} />{mine ? `Waiting for ${partnerName} to agree` : `${partnerName} suggested this — it needs your yes to lock in`}
                    </p>
                  </div>
                  <button type="button" aria-label={`Cancel ${session.activity_name}`} onClick={() => { void updateSession(session, 'cancelled'); }} style={{ border: 0, padding: '3px', background: 'transparent', color: tokens.colors.textMuted, cursor: 'pointer', lineHeight: 0, flexShrink: 0 }}><Trash2 size={14} /></button>
                </div>
                {!mine && (
                  <button type="button" data-agree-together-time={session.id} disabled={saving} onClick={() => { void agreeToSession(session); }} style={{ ...buttonStyle, width: '100%', minHeight: '40px', padding: '8px 10px', marginTop: '10px', fontSize: '0.78rem', opacity: saving ? 0.6 : 1 }}>
                    <Check size={15} />{saving ? 'Locking it in…' : 'Agree & lock in this time'}
                  </button>
                )}
                {renderTalkAndSuggest(session)}
                {renderSuggestForm(session)}
              </SectionCard>
            );
          })}
        </div>
      )}
      {scheduled.length > 0 && (
        <div data-together-time-list style={{ display: 'grid', gap: '8px' }}>
          {scheduled.map((session) => {
            const due = new Date(session.scheduled_at).getTime() <= Date.now();
            return (
              <SectionCard key={session.id} data-together-time-session={session.id} data-together-time-status="scheduled" data-highlighted={undefined} style={{ padding: '13px 14px', border: due ? `1.5px solid ${tokens.colors.primaryPink}` : `1px solid ${tokens.colors.borderSubtle}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
                  <div style={{ width: '38px', height: '38px', flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: tokens.radii.md, background: session.activity_type === 'book' ? tokens.colors.primaryGreenSoft : tokens.colors.accentLavenderSoft, color: session.activity_type === 'book' ? tokens.colors.primaryGreenDeep : tokens.colors.accentLavenderDeep }}>
                    {session.activity_type === 'book' ? <BookOpen size={17} /> : <Gamepad2 size={17} />}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, color: tokens.colors.textPrimary, fontSize: '0.84rem', fontWeight: 900, overflowWrap: 'anywhere' }}>{session.activity_name}</p>
                    <p style={{ margin: '3px 0 0', color: due ? tokens.colors.primaryPinkDeep : tokens.colors.textMuted, fontSize: '0.7rem', fontWeight: 800 }}>{due ? 'It’s time' : `${formatTime(session.scheduled_at, session.timezone)} (${session.timezone})`}</p>
                    <p data-together-time-locked={session.id} style={{ margin: '6px 0 0', display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '3px 8px', borderRadius: tokens.radii.pill, background: tokens.colors.primaryGreenSoft, color: tokens.colors.primaryGreenDeep, fontSize: '0.64rem', fontWeight: 900 }}>
                      <CheckCircle2 size={11} />Locked in · you both agreed
                    </p>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '7px', marginTop: '10px' }}>
                  <button type="button" data-open-scheduled-activity={session.id} onClick={() => onOpen?.(session)} style={{ ...buttonStyle, flex: 1, minHeight: '37px', padding: '8px 10px', fontSize: '0.74rem', background: session.activity_type === 'book' ? tokens.colors.primaryGreenDeep : tokens.colors.accentLavenderDeep }}>
                    Open {session.activity_type === 'book' ? 'the book' : 'game'} <ArrowUpRight size={14} />
                  </button>
                  <button type="button" aria-label={`Cancel ${session.activity_name}`} onClick={() => { void updateSession(session, 'cancelled'); }} style={{ ...secondaryButtonStyle, minHeight: '37px', padding: '7px 10px', color: tokens.colors.textMuted }}><Trash2 size={14} /></button>
                  {due && <button type="button" aria-label={`Mark ${session.activity_name} complete`} onClick={() => { void updateSession(session, 'done'); }} style={{ ...secondaryButtonStyle, minHeight: '37px', padding: '7px 10px', color: tokens.colors.primaryGreenDeep }}><Check size={14} /></button>}
                </div>
                {renderTalkAndSuggest(session)}
                {renderSuggestForm(session)}
              </SectionCard>
            );
          })}
        </div>
      )}
      {past.length > 0 && (
        <details style={{ padding: '2px 4px', color: tokens.colors.textMuted }}>
          <summary style={{ cursor: 'pointer', fontSize: '0.72rem', fontWeight: 800 }}>Past dates ({past.length})</summary>
          <ul style={{ paddingLeft: '18px', fontSize: '0.72rem', lineHeight: 1.8 }}>{past.map((session) => <li key={session.id}>{session.activity_name} · {session.status === 'done' ? 'done' : 'cancelled'}</li>)}</ul>
        </details>
      )}
      <BookShelf state={state} userId={userId} onOpenReader={onOpenReader} />
    </section>
  );
}

function SomedaySection({ items = [], userId, saving = false, onAdd, onUpdate, onWant, onDelete }: {
  items?: SomedayItem[];
  userId: string;
  saving?: boolean;
  onAdd?: (text: string, details?: string | null, visibility?: 'open' | 'private') => Promise<unknown>;
  onUpdate?: (item: SomedayItem, text: string, details: string | null, visibility?: 'open' | 'private') => Promise<void>;
  onWant?: (item: SomedayItem) => Promise<void>;
  onDelete?: (item: SomedayItem) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [visibility, setVisibility] = useState<'open' | 'private'>('open');
  const [detailsById, setDetailsById] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!onAdd || !text.trim()) return;
    setError(null);
    try { await onAdd(text.trim(), null, visibility); setText(''); setVisibility('open'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Your idea could not be added.'); }
  };
  const saveDetails = async (item: SomedayItem) => {
    if (!onUpdate) return;
    setSavingId(item.id); setError(null);
    try { await onUpdate(item, item.text, detailsById[item.id] ?? item.details ?? '', item.visibility); }
    catch (err) { setError(err instanceof Error ? err.message : 'Your note could not be saved.'); }
    finally { setSavingId(null); }
  };
  const changeVisibility = async (item: SomedayItem) => {
    if (!onUpdate) return;
    const next = item.visibility === 'open' ? 'private' : 'open';
    if (next === 'private' && item.visit_id && !window.confirm('Take this idea off the visit and make it private?')) return;
    setSavingId(item.id); setError(null);
    try { await onUpdate(item, item.text, item.details, next); }
    catch (err) { setError(err instanceof Error ? err.message : 'The sharing setting could not be changed.'); }
    finally { setSavingId(null); }
  };
  const remove = async (item: SomedayItem) => {
    if (!onDelete || !window.confirm(`Delete “${item.text}” from the someday list?`)) return;
    try { await onDelete(item); }
    catch (err) { setError(err instanceof Error ? err.message : 'This idea could not be removed.'); }
  };
  const toggleWant = async (item: SomedayItem) => {
    if (!onWant) return;
    setError(null);
    try { await onWant(item); }
    catch (err) { setError(err instanceof Error ? err.message : 'Your choice could not be saved.'); }
  };
  return (
    <section data-section="someday-list" style={{ display: 'grid', gap: '10px' }}>
      <SectionHeading icon={<Sparkles size={17} />} title="Someday" subtitle="Share ideas without pressure. A match only appears when you both want it." />
      <SectionCard style={{ padding: 14 }}>
        <form onSubmit={(event) => { void add(event); }} style={{ display: 'grid', gap: '8px' }}>
          <input aria-label="A new someday idea" maxLength={500} value={text} onChange={(event) => setText(event.target.value)} placeholder="Something we could do together…" style={fieldStyle} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <div role="group" aria-label="Who can see this idea" style={{ flex: 1, display: 'flex', gap: '5px' }}>
              {(['open', 'private'] as const).map((option) => (
                <button type="button" key={option} aria-pressed={visibility === option} onClick={() => setVisibility(option)} style={{ flex: 1, padding: '8px 6px', border: `1px solid ${visibility === option ? tokens.colors.accentLavender : tokens.colors.borderSoft}`, borderRadius: tokens.radii.pill, background: visibility === option ? tokens.colors.accentLavenderSoft : tokens.colors.bgSurface, color: visibility === option ? tokens.colors.accentLavenderDeep : tokens.colors.textSecondary, fontFamily: tokens.typography.fontFamily, fontSize: '0.69rem', fontWeight: 800, cursor: 'pointer' }}>{option === 'open' ? <><Users size={12} style={{ verticalAlign: '-2px', marginRight: '3px' }} />Share openly</> : <><LockKeyhole size={12} style={{ verticalAlign: '-2px', marginRight: '3px' }} />Keep private</>}</button>
              ))}
            </div>
            <button type="submit" disabled={saving || !text.trim()} style={{ ...buttonStyle, width: '42px', minHeight: '38px', padding: 0, opacity: saving || !text.trim() ? 0.55 : 1 }}><Plus size={17} /></button>
          </div>
        </form>
        {error && <p role="alert" style={{ margin: '8px 0 0', color: tokens.colors.primaryPinkDeep, fontSize: '0.71rem' }}>{error}</p>}
      </SectionCard>
      {items.length === 0 ? (
        <SectionCard style={{ textAlign: 'center', padding: '18px 16px' }}><Sparkles size={22} color={tokens.colors.accentLavenderDeep} /><p style={{ margin: '6px 0 0', color: tokens.colors.textSecondary, fontSize: '0.78rem' }}>Add a private thought or share an idea openly.</p></SectionCard>
      ) : (
        <div data-someday-items style={{ display: 'grid', gap: '8px' }}>
          {items.map((item) => {
            const wants = item.wanters || [];
            const isMatch = wants.length >= 2;
            const iWantIt = wants.includes(userId);
            return (
              <SectionCard key={item.id} data-someday-item={item.id} data-someday-visibility={item.visibility} style={{ padding: '13px 14px', border: isMatch ? `1.5px solid ${tokens.colors.primaryGreen}` : `1px solid ${tokens.colors.borderSubtle}`, background: isMatch ? 'linear-gradient(140deg, #fff 0%, #f3fff8 100%)' : tokens.colors.bgSurface }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '7px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, color: tokens.colors.textPrimary, fontSize: '0.84rem', lineHeight: 1.35, fontWeight: 800, overflowWrap: 'anywhere' }}>{item.text}</p>
                    <div style={{ marginTop: '5px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '5px' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', padding: '3px 7px', borderRadius: tokens.radii.pill, color: item.visibility === 'private' ? tokens.colors.accentLavenderDeep : tokens.colors.textMuted, background: item.visibility === 'private' ? tokens.colors.accentLavenderSoft : tokens.colors.bgSurfaceSubtle, fontSize: '0.61rem', fontWeight: 800 }}>{item.visibility === 'private' ? <><LockKeyhole size={10} />Just you</> : <><Users size={10} />Shared</>}</span>
                      {isMatch && <span data-someday-match style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', padding: '3px 7px', borderRadius: tokens.radii.pill, color: tokens.colors.primaryGreenDeep, background: tokens.colors.primaryGreenSoft, fontSize: '0.61rem', fontWeight: 900 }}><Heart size={10} fill="currentColor" />It’s a match</span>}
                    </div>
                  </div>
                  <button type="button" aria-label={`Delete ${item.text}`} onClick={() => { void remove(item); }} style={{ border: 0, padding: '3px', color: tokens.colors.textMuted, background: 'transparent', cursor: 'pointer', lineHeight: 0 }}><Trash2 size={14} /></button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginTop: '10px' }}>
                  <button type="button" data-someday-want={item.id} onClick={() => { void toggleWant(item); }} disabled={saving || savingId === item.id} aria-pressed={iWantIt} style={{ ...secondaryButtonStyle, flex: 1, minHeight: '36px', padding: '7px 10px', background: iWantIt ? tokens.colors.primaryPinkSoft : tokens.colors.bgSurfaceSubtle, color: iWantIt ? tokens.colors.primaryPinkDeep : tokens.colors.textSecondary, borderColor: iWantIt ? tokens.colors.primaryPink : tokens.colors.borderSoft, fontSize: '0.71rem' }}>{iWantIt ? 'I want this ✓' : 'I want this'}</button>
                  <button type="button" onClick={() => { void changeVisibility(item); }} disabled={savingId === item.id || (item.visibility === 'open' && item.created_by !== userId)} style={{ ...secondaryButtonStyle, minHeight: '36px', padding: '7px 9px', fontSize: '0.66rem', opacity: item.visibility === 'open' && item.created_by !== userId ? 0.5 : 1 }}>{item.visibility === 'open' ? 'Make private' : 'Share'}</button>
                </div>
                <details style={{ marginTop: '8px' }}>
                  <summary style={{ color: tokens.colors.textMuted, cursor: 'pointer', fontSize: '0.68rem', fontWeight: 800 }}>More about it</summary>
                  <textarea aria-label={`More context for ${item.text}`} maxLength={1000} rows={2} value={detailsById[item.id] ?? item.details ?? ''} onChange={(event) => setDetailsById((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="Add a little context…" style={{ ...fieldStyle, marginTop: '7px', resize: 'vertical', fontSize: '0.73rem' }} />
                  <button type="button" disabled={savingId === item.id} onClick={() => { void saveDetails(item); }} style={{ ...secondaryButtonStyle, minHeight: '32px', marginTop: '5px', padding: '6px 10px', fontSize: '0.66rem' }}>{savingId === item.id ? 'Saving…' : 'Save note'}</button>
                </details>
              </SectionCard>
            );
          })}
        </div>
      )}
      <p style={{ margin: 0, textAlign: 'center', color: tokens.colors.textMuted, fontSize: '0.66rem' }}>Private ideas are only visible to the person who added them. Matching ideas rise to the top.</p>
    </section>
  );
}

/** The Together tab: the next visit countdown, agreed shared activities, and matched ideas. */
export const TogetherView: React.FC<TogetherViewProps> = ({
  state,
  userId,
  partnerName,
  visit = null,
  onPlanVisit = () => {},
  onViewVisitPlans = onPlanVisit,
  onOpenReader,
  somedayItems = [],
  somedayError = null,
  somedaySaving = false,
  onAddSomedayItem,
  onUpdateSomedayItem,
  onToggleSomedayWant,
  onDeleteSomedayItem,
  togetherTimeSessions = [],
  togetherTimeError = null,
  togetherTimeSaving = false,
  timezone,
  onProposeTogetherTime,
  onAgreeTogetherTime,
  onSuggestTogetherTime,
  onTalkAboutTogetherTime,
  onUpdateTogetherTime,
  onOpenActivity,
  initialSessionId = null,
  onClearInitialSession,
  remindersEnabled,
}) => {
  const handledSession = useRef<string | null>(null);
  const requestedSession = initialSessionId ? togetherTimeSessions.find((session) => session.id === initialSessionId && session.status === 'scheduled') : null;
  useEffect(() => {
    if (!initialSessionId) {
      handledSession.current = null;
      return;
    }
    if (!requestedSession || handledSession.current === requestedSession.id) return;
    handledSession.current = requestedSession.id;
    if (requestedSession.activity_type === 'book') onOpenReader(requestedSession.activity_id);
    else onOpenActivity?.(requestedSession);
    onClearInitialSession?.();
  }, [initialSessionId, requestedSession, onOpenReader, onOpenActivity, onClearInitialSession]);
  return (
    <div data-view="together" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 14px 22px', display: 'grid', alignContent: 'start', gap: '20px', overscrollBehavior: 'contain' }}>
      <div style={{ display: 'grid', gap: '6px', margin: '2px 2px 0' }}>
        <p style={{ margin: 0, color: tokens.colors.primaryPinkDeep, fontSize: '0.65rem', letterSpacing: '0.1em', fontWeight: 900, textTransform: 'uppercase' }}>Your shared space</p>
        <p style={{ margin: 0, color: tokens.colors.textSecondary, fontSize: '0.76rem' }}>A little planning, a little play.</p>
      </div>

      <section data-section="visit" style={{ display: 'grid', gap: '9px' }}>
        <SectionHeading icon={<Heart size={17} />} title="Next visit" subtitle="Keep the countdown going." />
        <VisitHero visit={visit} onPlanVisit={onPlanVisit} onViewPlans={onViewVisitPlans} />
      </section>

      <TogetherTimeSection
        sessions={togetherTimeSessions}
        state={state}
        userId={userId}
        partnerName={partnerName}
        onOpenReader={onOpenReader}
        timezone={timezone}
        saving={togetherTimeSaving}
        error={togetherTimeError}
        remindersEnabled={remindersEnabled}
        onPropose={onProposeTogetherTime}
        onAgree={onAgreeTogetherTime}
        onSuggest={onSuggestTogetherTime}
        onTalkAbout={onTalkAboutTogetherTime}
        onUpdate={onUpdateTogetherTime}
        onOpen={onOpenActivity}
      />

      <SomedaySection
        items={somedayItems}
        userId={userId}
        saving={somedaySaving}
        onAdd={onAddSomedayItem}
        onUpdate={onUpdateSomedayItem}
        onWant={onToggleSomedayWant}
        onDelete={onDeleteSomedayItem}
      />
      {somedayError && <p role="alert" style={{ margin: '-12px 0 0', color: tokens.colors.primaryPinkDeep, fontSize: '0.7rem' }}>{somedayError}</p>}
    </div>
  );
};

export default TogetherView;
