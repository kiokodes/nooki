import { useState } from 'react';
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
import { HomeView } from '../components/home/HomeView';
import { CalendarModal } from '../components/calendar/CalendarModal';
import type { Couple, Profile, CoupleEvent, RepeatFrequency } from '../types/database';

/**
 * Design preview for the Home tab, served by the dev server at /preview.html.
 *
 * It exists so the Home tab can be reviewed without a Supabase project or two live
 * accounts. It runs on static sample data, never contacts the backend, and is not part
 * of the production build (`npm run build` only builds index.html).
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

export const HomePreview = () => {
  const [preset, setPreset] = useState(PRESETS[0]);
  const [partnerOnline, setPartnerOnline] = useState(true);
  const [showCalendar, setShowCalendar] = useState(false);
  // In-memory events so add/edit/delete can be tried out without a backend.
  const [events, setEvents] = useState<CoupleEvent[]>(STARTING_EVENTS);
  const couple: Couple = {
    id: 'preview-couple',
    invite_code: '7K4MZ9',
    anniversary_date: preset.anniversary,
    created_at: NOW,
    breakup_requested_by: null,
    breakup_requested_at: null,
  };
  // Partner 1 owns this phone; partner 2 is the person at the other end of the distance.
  const profile: Profile = {
    id: 'preview-sam',
    couple_id: couple.id,
    name: 'Sam',
    timezone: 'Africa/Lagos',
    last_seen_at: NOW,
    created_at: NOW,
  };
  const partner: Profile = {
    id: 'preview-ana',
    couple_id: couple.id,
    name: 'Ana',
    timezone: 'America/Los_Angeles',
    last_seen_at: PARTNER_LAST_SEEN,
    created_at: NOW,
  };

  const controlStyle = (active: boolean): CSSProperties => ({
    padding: '7px 14px',
    borderRadius: tokens.radii.pill,
    border: `1.5px solid ${active ? tokens.colors.primaryPink : tokens.colors.borderSoft}`,
    backgroundColor: active ? tokens.colors.primaryPinkSoft : tokens.colors.bgSurface,
    color: active ? tokens.colors.primaryPinkDeep : tokens.colors.textSecondary,
    fontFamily: tokens.typography.fontFamily,
    fontSize: '0.78rem',
    fontWeight: 700,
    cursor: 'pointer',
  });

  return (
    <div
      style={{
        width: '100vw',
        minHeight: '100vh',
        backgroundColor: tokens.colors.bgDesktop,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '14px',
        padding: '20px 0',
        fontFamily: tokens.typography.fontFamily,
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'center', padding: '0 16px' }}>
        {PRESETS.map((item) => (
          <button key={item.label} type="button" style={controlStyle(item === preset)} onClick={() => setPreset(item)}>
            {item.label}
          </button>
        ))}
        <button type="button" style={controlStyle(false)} onClick={() => setPartnerOnline((value) => !value)}>
          {partnerOnline ? 'Partner is online → show last seen' : 'Partner is away → show online'}
        </button>
      </div>

      <main
        style={{
          width: '390px',
          height: '844px',
          maxHeight: '100vh',
          backgroundColor: tokens.colors.bgCanvas,
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: tokens.shadows.card,
          borderRadius: '36px',
          overflow: 'hidden',
        }}
      >
        {/* The real header component, so the preview can never drift from the app. */}
        <CoupleHeader
          profile={profile}
          partner={partner}
          couple={couple}
          partnerOnline={partnerOnline}
          onOpenSettings={() => {}}
        />

        <HomeView
          events={events}
          anniversaryDate={couple.anniversary_date}
          eventsLoading={false}
          eventsError={null}
          onOpenCalendar={() => setShowCalendar(true)}
        />

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

        <nav
          aria-label="Preview navigation"
          style={{
            height: '76px',
            backgroundColor: tokens.colors.bgSurface,
            boxShadow: tokens.shadows.navBar,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-around',
            padding: '0 8px 12px 8px',
          }}
        >
          {[
            { label: 'Chat', Icon: MessageCircle, tint: tokens.colors.primaryPinkSoft, ink: tokens.colors.primaryPinkDeep },
            { label: 'Media', Icon: ImageIcon, tint: tokens.colors.primaryGreenSoft, ink: tokens.colors.primaryGreenDeep },
          ].map(({ label, Icon, tint, ink }) => (
            <span key={label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', color: tokens.colors.textMuted }}>
              <span style={{ width: '32px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: tokens.radii.sm, backgroundColor: tint, color: ink }}>
                <Icon size={20} />
              </span>
              <span style={{ fontSize: '0.72rem', fontWeight: 500 }}>{label}</span>
            </span>
          ))}
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative', top: '-14px' }}>
            <span
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
              }}
            >
              <HomeIcon size={24} strokeWidth={2.4} />
            </span>
            <span style={{ fontSize: '0.72rem', fontWeight: 700, color: tokens.colors.primaryPinkDeep, marginTop: '2px' }}>
              Home
            </span>
          </span>
          {[
            { label: 'Discuss', Icon: MessageSquare, tint: tokens.colors.accentSageSoft, ink: tokens.colors.accentSageDeep },
            { label: 'Games', Icon: Gamepad2, tint: tokens.colors.accentLavenderSoft, ink: tokens.colors.accentLavenderDeep },
          ].map(({ label, Icon, tint, ink }) => (
            <span key={label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', color: tokens.colors.textMuted }}>
              <span style={{ width: '32px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: tokens.radii.sm, backgroundColor: tint, color: ink }}>
                <Icon size={20} />
              </span>
              <span style={{ fontSize: '0.72rem', fontWeight: 500 }}>{label}</span>
            </span>
          ))}
        </nav>
      </main>

      <p style={{ display: 'flex', alignItems: 'center', gap: '6px', margin: 0, fontSize: '0.76rem', color: tokens.colors.textMuted }}>
        <Heart size={13} fill={tokens.colors.primaryPink} strokeWidth={1.5} />
        Home tab preview · sample data only · tap the calendar icon to open the full calendar
      </p>
    </div>
  );
};
