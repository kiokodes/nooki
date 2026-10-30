import React, { useState } from 'react';
import {
  Check,
  ChevronDown,
  Sprout,
  ChevronUp,
  CalendarDays,
  CalendarHeart,
  Heart,
  MapPin,
  Plus,
  Trash2,
} from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { RaiseAChildCard } from '../raisechild/RaiseAChildCard';
import type { RaiseChildState } from '../../hooks/useRaiseChild';
import './together.css';
import type { SomedayItem, Visit } from '../../types/database';

interface TogetherViewProps {
  visit?: Visit | null;
  onPlanVisit?: () => void;
  onViewVisitPlans?: () => void;
  somedayItems?: SomedayItem[];
  somedayError?: string | null;
  onAddSomedayItem?: (text: string) => Promise<unknown>;
  onDeleteSomedayItem?: (item: SomedayItem) => Promise<void>;
  onToggleSomedayItem?: (item: SomedayItem) => Promise<void>;
  onReorderSomedayItems?: (orderedIds: string[]) => Promise<void>;
  somedaySaving?: boolean;
  /** The one card that opens the family, raised together, one year at a time. */
  raiseChild?: RaiseChildState;
  onOpenRaiseChild?: () => void;
  partnerName?: string;
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

function SomedaySection({ items = [], saving = false, onAdd, onDelete, onToggle, onReorder }: {
  items?: SomedayItem[];
  saving?: boolean;
  onAdd?: (text: string) => Promise<unknown>;
  onDelete?: (item: SomedayItem) => Promise<void>;
  onToggle?: (item: SomedayItem) => Promise<void>;
  onReorder?: (orderedIds: string[]) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [workingId, setWorkingId] = useState<string | null>(null);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!onAdd || !text.trim()) return;
    setError(null);
    try {
      await onAdd(text.trim());
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This task could not be added.');
    }
  };

  const move = async (index: number, offset: -1 | 1) => {
    if (!onReorder) return;
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= items.length) return;
    const ordered = [...items];
    [ordered[index], ordered[nextIndex]] = [ordered[nextIndex], ordered[index]];
    setError(null);
    try {
      await onReorder(ordered.map((item) => item.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The list order could not be saved.');
    }
  };

  const toggle = async (item: SomedayItem) => {
    if (!onToggle) return;
    setWorkingId(item.id);
    setError(null);
    try { await onToggle(item); }
    catch (err) { setError(err instanceof Error ? err.message : 'This task could not be updated.'); }
    finally { setWorkingId(null); }
  };

  const remove = async (item: SomedayItem) => {
    if (!onDelete) return;
    setWorkingId(item.id);
    setError(null);
    try { await onDelete(item); }
    catch (err) { setError(err instanceof Error ? err.message : 'This task could not be deleted.'); }
    finally { setWorkingId(null); }
  };

  return (
    <section data-section="someday-list" className="someday-section">
      <h2 className="someday-title">Someday list</h2>
      <form className="someday-add" onSubmit={(event) => { void add(event); }}>
        <input
          aria-label="Add a task to the shared list"
          maxLength={500}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Write something for our list…"
        />
        <button type="submit" aria-label="Add task" disabled={saving || !text.trim()}>
          <Plus size={18} />
        </button>
      </form>
      {error && <p role="alert" className="someday-error">{error}</p>}
      {items.length === 0 ? (
        <div className="someday-notebook someday-empty" data-someday-items>
          <p>Leave a note for something you’d like us to do together.</p>
        </div>
      ) : (
        <ol className="someday-notebook" data-someday-items>
          {items.map((item, index) => (
            <li key={item.id} data-someday-item={item.id} data-someday-order={index + 1} className="someday-line">
              <button
                type="button"
                className={`someday-check${item.completed ? ' is-done' : ''}`}
                aria-label={`${item.completed ? 'Mark incomplete' : 'Mark complete'}: ${item.text}`}
                aria-pressed={item.completed}
                disabled={workingId === item.id}
                onClick={() => { void toggle(item); }}
              >{item.completed && <Check size={14} />}</button>
              <span className={item.completed ? 'someday-task is-done' : 'someday-task'}>{item.text}</span>
              <div className="someday-controls">
                <button type="button" aria-label={`Move ${item.text} up`} title="Move up" disabled={saving || index === 0} onClick={() => { void move(index, -1); }}><ChevronUp size={17} /></button>
                <button type="button" aria-label={`Move ${item.text} down`} title="Move down" disabled={saving || index === items.length - 1} onClick={() => { void move(index, 1); }}><ChevronDown size={17} /></button>
                <button type="button" aria-label={`Delete ${item.text}`} title="Delete" disabled={workingId === item.id} onClick={() => { void remove(item); }}><Trash2 size={15} /></button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** The Together tab keeps the next visit and a simple shared notebook. */
export const TogetherView: React.FC<TogetherViewProps> = ({
  visit = null,
  onPlanVisit = () => {},
  onViewVisitPlans = onPlanVisit,
  somedayItems = [],
  somedayError = null,
  somedaySaving = false,
  onAddSomedayItem,
  onDeleteSomedayItem,
  onToggleSomedayItem,
  onReorderSomedayItems,
  raiseChild,
  onOpenRaiseChild,
  partnerName = 'your partner',
}) => {
  return (
    <div data-view="together" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 14px 22px', display: 'grid', alignContent: 'start', gap: '20px', overscrollBehavior: 'contain' }}>
      <section data-section="visit" style={{ display: 'grid', gap: '9px' }}>
        <SectionHeading icon={<Heart size={17} />} title="Next visit" subtitle="Keep the countdown going." />
        <VisitHero visit={visit} onPlanVisit={onPlanVisit} onViewPlans={onViewVisitPlans} />
      </section>

      {raiseChild && onOpenRaiseChild && (
        <section data-section="raise-a-child" style={{ display: 'grid', gap: '9px' }}>
          <SectionHeading icon={<Sprout size={17} />} title="Raise a child" subtitle="One small life, decided together." />
          <RaiseAChildCard state={raiseChild} partnerName={partnerName} onOpen={onOpenRaiseChild} />
        </section>
      )}

      <SomedaySection
        items={somedayItems}
        saving={somedaySaving}
        onAdd={onAddSomedayItem}
        onDelete={onDeleteSomedayItem}
        onToggle={onToggleSomedayItem}
        onReorder={onReorderSomedayItems}
      />
      {somedayError && <p role="alert" style={{ margin: '-12px 0 0', color: tokens.colors.primaryPinkDeep, fontSize: '0.7rem' }}>{somedayError}</p>}
    </div>
  );
};

export default TogetherView;
