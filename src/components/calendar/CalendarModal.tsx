import React, { useEffect, useRef, useState } from 'react';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Heart,
  Pencil,
  Plus,
  Repeat,
  Trash,
  X,
} from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import {
  formatLongDate,
  formatMonthLabel,
  formatMonthShort,
  getItemsForDate,
  getMonthGrid,
  isSameMonth,
  getSwipeDirection,
  shiftMonth,
  toDateKey,
  type CalendarItem,
} from '../../lib/calendar';
import { parseIsoDate } from '../../lib/coupleTime';
import { useNow } from '../../hooks/useNow';
import { REPEAT_FREQUENCIES, type CoupleEvent, type RepeatFrequency } from '../../types/database';
import type { CoupleEventInput } from '../../lib/authService';

/** Readable names for the cycling repeat control. */
const REPEAT_CONTROL_LABELS: Record<RepeatFrequency, string> = {
  none: 'Once',
  weekly: 'Every week',
  monthly: 'Every month',
  yearly: 'Every year',
};

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const MONTHS = Array.from({ length: 12 }, (_, index) => index + 1);

interface CalendarModalProps {
  partnerName: string;
  events: CoupleEvent[];
  anniversaryDate: string | null;
  saving?: boolean;
  onAddEvent: (input: CoupleEventInput) => Promise<void>;
  onEditEvent: (eventId: string, input: CoupleEventInput) => Promise<void>;
  onDeleteEvent: (eventId: string) => Promise<void>;
  onClose: () => void;
}

type FormState =
  | { mode: 'create'; date: string; title: string; repeatFrequency: RepeatFrequency }
  | { mode: 'edit'; date: string; title: string; repeatFrequency: RepeatFrequency; eventId: string }
  | null;

const iconButtonStyle: React.CSSProperties = {
  width: '32px',
  height: '32px',
  borderRadius: tokens.radii.full,
  border: 'none',
  backgroundColor: tokens.colors.bgSurfaceSubtle,
  color: tokens.colors.textSecondary,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  flexShrink: 0,
};

/**
 * The full calendar, as a modal over the current tab. Nothing navigates away: the Home
 * tab stays mounted and exactly as it was behind the overlay.
 */
export const CalendarModal: React.FC<CalendarModalProps> = ({
  partnerName,
  events,
  anniversaryDate,
  saving,
  onAddEvent,
  onEditEvent,
  onDeleteEvent,
  onClose,
}) => {
  const today = useNow(60_000);
  const todayKey = toDateKey(today);
  const [view, setView] = useState(() => ({ year: today.getFullYear(), month: today.getMonth() + 1 }));
  const [selected, setSelected] = useState(todayKey);
  const [form, setForm] = useState<FormState>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const grid = getMonthGrid(view.year, view.month);
  const selectedItems = getItemsForDate(selected, events, anniversaryDate);
  const selectedEvents = selectedItems.filter((item) => item.kind === 'event');
  const monthEventDates = new Set(
    [...grid.flat()].filter((dateKey) => getItemsForDate(dateKey, events, anniversaryDate).length > 0),
  );

  const goToMonth = (delta: number) => {
    setView((current) => shiftMonth(current.year, current.month, delta));
    setPickerOpen(false);
  };

  const selectMonth = (month: number) => {
    setView((current) => ({ year: current.year, month }));
    setPickerOpen(false);
  };

  // Escape closes the picker first, then the modal — one step at a time.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (pickerOpen) setPickerOpen(false);
      else if (form) setForm(null);
      else onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [pickerOpen, form, onClose]);

  const startCreate = () => {
    setFormError(null);
    setForm({ mode: 'create', date: selected, title: '', repeatFrequency: 'none' });
  };

  const startEdit = (event: CoupleEvent) => {
    setFormError(null);
    setForm({
      mode: 'edit',
      eventId: event.id,
      date: event.event_date,
      title: event.title,
      repeatFrequency: event.repeat_frequency,
    });
  };

  const submitForm = async (submitEvent: React.FormEvent) => {
    submitEvent.preventDefault();
    if (!form) return;
    try {
      setFormError(null);
      const input = { title: form.title, date: form.date, repeatFrequency: form.repeatFrequency };
      if (form.mode === 'create') await onAddEvent(input);
      else await onEditEvent(form.eventId, input);
      setForm(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'That did not save. Please try again.');
    }
  };

  const handleDelete = async (event: CoupleEvent) => {
    if (!window.confirm(`Delete “${event.title}”?`)) return;
    try {
      setFormError(null);
      await onDeleteEvent(event.id);
      setForm(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'That event could not be deleted.');
    }
  };

  const selectedDate = parseIsoDate(selected);

  return (
    <div
      data-modal="calendar"
      role="dialog"
      aria-modal="true"
      aria-label="Calendar"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 40,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        backgroundColor: 'rgba(55, 46, 41, 0.28)',
        backdropFilter: 'blur(2px)',
        animation: 'nooki-fade-in 0.18s ease',
      }}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        className="nooki-modal-sheet"
        style={{
          backgroundColor: tokens.colors.bgCanvas,
          borderTopLeftRadius: tokens.radii.card,
          borderTopRightRadius: tokens.radii.card,
          boxShadow: tokens.shadows.card,
          maxHeight: '94%',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'nooki-sheet-up 0.24s cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        {/* Month header */}
        <div style={{ padding: '14px 16px 8px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button type="button" style={iconButtonStyle} aria-label="Previous month" onClick={() => goToMonth(-1)}>
              <ChevronLeft size={17} />
            </button>
            <button
              type="button"
              aria-label="Choose month and year"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((open) => !open)}
              style={{
                flex: 1,
                padding: '6px 10px',
                borderRadius: tokens.radii.pill,
                border: 'none',
                backgroundColor: 'transparent',
                color: tokens.colors.textPrimary,
                fontSize: '0.98rem',
                fontWeight: 800,
                letterSpacing: '-0.01em',
                cursor: 'pointer',
                fontFamily: tokens.typography.fontFamily,
              }}
            >
              {formatMonthLabel(view.year, view.month)}
            </button>
            <button type="button" style={iconButtonStyle} aria-label="Next month" onClick={() => goToMonth(1)}>
              <ChevronRight size={17} />
            </button>
            <button type="button" style={iconButtonStyle} aria-label="Close calendar" onClick={onClose}>
              <X size={17} />
            </button>
          </div>

          {pickerOpen && (
            <div
              data-modal-picker
              style={{
                marginTop: '10px',
                padding: '10px',
                backgroundColor: tokens.colors.bgSurface,
                borderRadius: tokens.radii.lg,
                boxShadow: tokens.shadows.subtle,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                <button type="button" style={iconButtonStyle} aria-label="Previous year" onClick={() => setView((c) => ({ ...c, year: c.year - 1 }))}>
                  <ChevronLeft size={16} />
                </button>
                <span style={{ fontSize: '0.9rem', fontWeight: 800, color: tokens.colors.textPrimary }}>{view.year}</span>
                <button type="button" style={iconButtonStyle} aria-label="Next year" onClick={() => setView((c) => ({ ...c, year: c.year + 1 }))}>
                  <ChevronRight size={16} />
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px' }}>
                {MONTHS.map((month) => {
                  const active = month === view.month;
                  return (
                    <button
                      key={month}
                      type="button"
                      onClick={() => selectMonth(month)}
                      aria-pressed={active}
                      style={{
                        padding: '7px 0',
                        borderRadius: tokens.radii.sm,
                        border: 'none',
                        backgroundColor: active ? tokens.colors.primaryPinkSoft : tokens.colors.bgSurfaceSubtle,
                        color: active ? tokens.colors.primaryPinkDeep : tokens.colors.textSecondary,
                        fontSize: '0.78rem',
                        fontWeight: active ? 800 : 600,
                        cursor: 'pointer',
                        fontFamily: tokens.typography.fontFamily,
                      }}
                    >
                      {formatMonthShort(month)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '6px' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '0.68rem', color: tokens.colors.textMuted }}>
              <span style={{ width: '5px', height: '5px', borderRadius: tokens.radii.full, backgroundColor: tokens.colors.primaryGreenDeep }} />
              has something on
            </span>
            <button
              type="button"
              onClick={() => { setView({ year: today.getFullYear(), month: today.getMonth() + 1 }); setSelected(todayKey); }}
              style={{
                background: 'none',
                border: 'none',
                color: tokens.colors.primaryPinkDeep,
                fontSize: '0.74rem',
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: tokens.typography.fontFamily,
              }}
            >
              Back to today
            </button>
          </div>
        </div>

        {/* Weekday row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', padding: '0 10px' }}>
          {WEEKDAYS.map((day, index) => (
            <span
              key={`${day}-${index}`}
              style={{
                textAlign: 'center',
                fontSize: '0.68rem',
                fontWeight: 700,
                color: tokens.colors.textMuted,
                paddingBottom: '4px',
              }}
            >
              {day}
            </span>
          ))}
        </div>

        {/* Month grid. Swipe left/right to change month; the sheet follows your finger. */}
        <div
          data-modal-grid
          style={{ padding: '0 10px 6px 10px', overflowY: 'auto', flex: 1 }}
          onTouchStart={(event) => {
            const touch = event.changedTouches?.[0];
            touchStartRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
          }}
          onTouchEnd={(event) => {
            const start = touchStartRef.current;
            const touch = event.changedTouches?.[0];
            touchStartRef.current = null;
            if (!start || !touch) return;
            const direction = getSwipeDirection(touch.clientX - start.x, touch.clientY - start.y);
            if (direction !== 0) goToMonth(direction);
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
          {grid.flat().map((dateKey) => {
            const date = parseIsoDate(dateKey);
            if (!date) return null;
            const inMonth = isSameMonth(dateKey, view.year, view.month);
            const isToday = dateKey === todayKey;
            const isSelected = dateKey === selected;
            const hasItems = monthEventDates.has(dateKey);
            const items = getItemsForDate(dateKey, events, anniversaryDate);
            return (
              <button
                key={dateKey}
                type="button"
                data-day={dateKey}
                aria-label={`${dateKey}${items.length ? `, ${items.length} thing${items.length === 1 ? '' : 's'} on` : ''}`}
                aria-pressed={isSelected}
                onClick={() => { setSelected(dateKey); setForm(null); }}
                style={dayCellStyle}
              >
                <span
                  style={{
                    width: '28px',
                    height: '28px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: tokens.radii.full,
                    fontSize: '0.8rem',
                    fontWeight: isToday || isSelected ? 800 : 600,
                    color: isSelected
                      ? tokens.colors.textWhite
                      : inMonth
                        ? tokens.colors.textPrimary
                        : tokens.colors.textMuted,
                    backgroundColor: isSelected
                      ? tokens.colors.primaryPink
                      : 'transparent',
                    border: isToday && !isSelected ? `1.5px solid ${tokens.colors.primaryPink}` : '1.5px solid transparent',
                    opacity: inMonth ? 1 : 0.55,
                  }}
                >
                  {date.day}
                </span>
                <span style={{ display: 'flex', gap: '2px', height: '5px', alignItems: 'center' }}>
                  {hasItems && items.slice(0, 3).map((item, dotIndex) => (
                    <span
                      key={`${item.id}-${dotIndex}`}
                      data-dot={dateKey}
                      style={{
                        width: '4px',
                        height: '4px',
                        borderRadius: tokens.radii.full,
                        backgroundColor: item.kind === 'event'
                          ? tokens.colors.primaryGreenDeep
                          : tokens.colors.primaryPinkDeep,
                      }}
                    />
                  ))}
                </span>
              </button>
            );
          })}
          </div>
        </div>

        {/* Selected day */}
        <div
          style={{
            borderTop: `1px solid ${tokens.colors.borderSubtle}`,
            backgroundColor: tokens.colors.bgSurface,
            padding: '12px 16px 16px 16px',
            maxHeight: '42%',
            overflowY: 'auto',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <span style={{ fontSize: '0.82rem', fontWeight: 800, color: tokens.colors.textPrimary }} data-selected-label>
              {formatLongDate(selected)}
            </span>
            {!form && (
              <button
                type="button"
                onClick={startCreate}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '5px',
                  padding: '6px 12px',
                  borderRadius: tokens.radii.pill,
                  border: 'none',
                  backgroundColor: tokens.colors.primaryPinkSoft,
                  color: tokens.colors.primaryPinkDeep,
                  fontSize: '0.76rem',
                  fontWeight: 800,
                  cursor: 'pointer',
                  fontFamily: tokens.typography.fontFamily,
                  flexShrink: 0,
                }}
              >
                <Plus size={13} /> Add event
              </button>
            )}
          </div>

          {form ? (
            <form onSubmit={submitForm} data-event-form style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <input
                autoFocus
                aria-label="Event name"
                placeholder="Birthday, visit, date night…"
                value={form.title}
                maxLength={120}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                style={{
                  width: '100%',
                  padding: '10px 14px',
                  borderRadius: tokens.radii.pill,
                  border: `1.5px solid ${tokens.colors.borderSubtle}`,
                  backgroundColor: tokens.colors.bgSurfaceSubtle,
                  fontSize: '0.88rem',
                  fontFamily: tokens.typography.fontFamily,
                  color: tokens.colors.textPrimary,
                  outline: 'none',
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                <input
                  type="date"
                  aria-label="Event date"
                  value={form.date}
                  onChange={(event) => setForm({ ...form, date: event.target.value })}
                  style={{
                    padding: '8px 12px',
                    borderRadius: tokens.radii.pill,
                    border: `1.5px solid ${tokens.colors.borderSubtle}`,
                    backgroundColor: tokens.colors.bgSurfaceSubtle,
                    fontSize: '0.82rem',
                    fontFamily: tokens.typography.fontFamily,
                    color: tokens.colors.textPrimary,
                  }}
                />
                <button
                  type="button"
                  data-repeat-toggle
                  aria-label={`Repeats: ${REPEAT_CONTROL_LABELS[form.repeatFrequency]}. Tap to change.`}
                  title="Tap to change how often this repeats"
                  onClick={() => setForm((current) => {
                    if (!current) return current;
                    const index = REPEAT_FREQUENCIES.indexOf(current.repeatFrequency);
                    // Cycles Once -> Every week -> Every month -> Every year -> Once.
                    return { ...current, repeatFrequency: REPEAT_FREQUENCIES[(index + 1) % REPEAT_FREQUENCIES.length] };
                  })}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '7px 14px',
                    borderRadius: tokens.radii.pill,
                    border: `1.5px solid ${form.repeatFrequency === 'none' ? tokens.colors.borderSoft : tokens.colors.primaryGreen}`,
                    backgroundColor: form.repeatFrequency === 'none' ? tokens.colors.bgSurfaceSubtle : tokens.colors.primaryGreenSoft,
                    color: form.repeatFrequency === 'none' ? tokens.colors.textSecondary : tokens.colors.primaryGreenDeep,
                    fontSize: '0.78rem',
                    fontWeight: 700,
                    cursor: 'pointer',
                    fontFamily: tokens.typography.fontFamily,
                    transition: 'all 0.15s ease',
                  }}
                >
                  <Repeat size={13} />
                  {REPEAT_CONTROL_LABELS[form.repeatFrequency]}
                </button>
              </div>
              {formError && <p role="alert" style={{ margin: 0, fontSize: '0.76rem', color: '#DC2626' }}>{formError}</p>}
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="submit"
                  disabled={saving}
                  style={{
                    flex: 1,
                    padding: '10px',
                    borderRadius: tokens.radii.pill,
                    border: 'none',
                    backgroundColor: tokens.colors.primaryPink,
                    color: tokens.colors.textWhite,
                    fontSize: '0.86rem',
                    fontWeight: 800,
                    cursor: saving ? 'wait' : 'pointer',
                    fontFamily: tokens.typography.fontFamily,
                    boxShadow: tokens.shadows.highlightPink,
                  }}
                >
                  {saving ? 'Saving…' : form.mode === 'create' ? 'Add to calendar' : 'Save changes'}
                </button>
                <button
                  type="button"
                  onClick={() => { setForm(null); setFormError(null); }}
                  style={{
                    padding: '10px 16px',
                    borderRadius: tokens.radii.pill,
                    border: `1px solid ${tokens.colors.borderSoft}`,
                    background: 'none',
                    color: tokens.colors.textSecondary,
                    fontSize: '0.84rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: tokens.typography.fontFamily,
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <>
              {selectedItems.length === 0 && (
                <p style={{ margin: '8px 0 0 0', fontSize: '0.78rem', color: tokens.colors.textMuted }} data-selected-empty>
                  Nothing on {selectedDate ? `${selectedDate.day}/${selectedDate.month}` : 'this day'} yet.
                </p>
              )}

              {selectedItems.length > 0 && (
                <ul style={{ listStyle: 'none', margin: '6px 0 0 0', padding: 0 }}>
                  {selectedItems.map((item: CalendarItem) => (
                    <li
                      key={item.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '9px',
                        padding: '7px 0',
                        borderBottom: `1px solid ${tokens.colors.borderSubtle}`,
                      }}
                    >
                      {item.kind === 'event' ? (
                        <span style={{ width: '6px', height: '6px', borderRadius: tokens.radii.full, backgroundColor: tokens.colors.primaryGreenDeep, flexShrink: 0 }} />
                      ) : (
                        <Heart
                          size={12}
                          fill={item.kind === 'anniversary' ? tokens.colors.primaryPink : 'none'}
                          color={tokens.colors.primaryPinkDeep}
                          style={{ flexShrink: 0 }}
                        />
                      )}
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: tokens.colors.textPrimary, wordBreak: 'break-word' }}>
                          {item.title}
                        </span>
                        {item.detail && (
                          <span style={{ display: 'block', fontSize: '0.72rem', color: tokens.colors.textMuted }}>
                            {item.detail}
                          </span>
                        )}
                      </span>

                      {item.kind === 'event' && item.event ? (
                        <span style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                          <button
                            type="button"
                            aria-label={`Edit ${item.title}`}
                            onClick={() => startEdit(item.event as CoupleEvent)}
                            style={{ ...iconButtonStyle, width: '28px', height: '28px', backgroundColor: 'transparent' }}
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete ${item.title}`}
                            onClick={() => void handleDelete(item.event as CoupleEvent)}
                            style={{ ...iconButtonStyle, width: '28px', height: '28px', backgroundColor: 'transparent', color: tokens.colors.textMuted }}
                          >
                            <Trash size={14} />
                          </button>
                        </span>
                      ) : (
                        <span style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: tokens.colors.textMuted, flexShrink: 0 }}>
                          automatic
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              <p style={{ display: 'flex', alignItems: 'center', gap: '6px', margin: '10px 0 0 0', fontSize: '0.72rem', color: tokens.colors.textMuted }}>
                <CalendarDays size={12} />
                {`${partnerName} sees these dates too. Swipe the month to browse.`}
                {selectedEvents.length > 1 && ` ${selectedEvents.length} events on this day.`}
              </p>
              {formError && <p role="alert" style={{ margin: '8px 0 0 0', fontSize: '0.76rem', color: '#DC2626' }}>{formError}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const dayCellStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '1px',
  padding: '3px 0 5px 0',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontFamily: "'Quicksand', 'Nunito', -apple-system, BlinkMacSystemFont, sans-serif",
};

export default CalendarModal;
