import React, { useEffect, useRef, useState } from 'react';
import {
  CalendarHeart,
  Check,
  Heart,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { SOMEDAY_DETAILS_MAX, SOMEDAY_TEXT_MAX } from '../../lib/somedayService';
import type { SomedayItem, Visit } from '../../types/database';

interface SomedayItemModalProps {
  item: SomedayItem;
  /** The next upcoming visit, when the couple has one. */
  visit: Visit | null;
  onClose: () => void;
  onSave: (item: SomedayItem, text: string, details: string | null) => Promise<void>;
  onDelete: (item: SomedayItem) => Promise<void>;
  /** Pin this idea to the couple's next visit. */
  onAddToVisit: (item: SomedayItem) => Promise<void>;
  /** Take it back off the visit, leaving the idea on the someday list. */
  onRemoveFromVisit: (item: SomedayItem) => Promise<void>;
  /** No visit yet: close this sheet and open the visit planner for this idea. */
  onPlanVisit: (item: SomedayItem) => void;
}

function formatVisitDate(visit: Visit): string {
  const start = new Date(`${visit.start_date}T00:00:00`);
  return start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * One someday idea, opened from the Together tab.
 *
 * This is where the idea grows up: a title, up to 1,000 characters of context, a
 * delete, and the bridge into a real visit. The same sheet is how an idea already
 * pinned to the next visit comes back off it.
 */
export const SomedayItemModal: React.FC<SomedayItemModalProps> = ({
  item,
  visit,
  onClose,
  onSave,
  onDelete,
  onAddToVisit,
  onRemoveFromVisit,
  onPlanVisit,
}) => {
  const [text, setText] = useState(item.text);
  const [details, setDetails] = useState(item.details || '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'delete' | 'visit' | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Focus the sheet so Escape closes it and keyboard focus does not stay on the row
  // behind the overlay; keep the page behind it from scrolling.
  useEffect(() => {
    dialogRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const attachedToNextVisit = Boolean(visit && item.visit_id === visit.id);
  const attachedSomewhere = Boolean(item.visit_id);
  const changed = text.trim() !== item.text || (details.trim() || null) !== item.details;

  const handleSave = async () => {
    setError(null);
    setBusy('save');
    try {
      await onSave(item, text, details);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This idea could not be saved.');
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete “${item.text}”? It will leave your someday list for both of you.`)) {
      return;
    }
    setError(null);
    setBusy('delete');
    try {
      await onDelete(item);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This idea could not be deleted.');
    } finally {
      setBusy(null);
    }
  };

  const handleVisit = async () => {
    setError(null);
    setBusy('visit');
    try {
      if (attachedToNextVisit) await onRemoveFromVisit(item);
      else if (visit) await onAddToVisit(item);
      else onPlanVisit(item);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This idea could not be moved.');
    } finally {
      setBusy(null);
    }
  };

  // An idea can be left on a visit that is no longer the next one (the visit has
  // passed, or a later one was planned). Offer a way back even then.
  const handleRemoveVisit = async () => {
    setError(null);
    setBusy('visit');
    try {
      await onRemoveFromVisit(item);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This idea could not be moved.');
    } finally {
      setBusy(null);
    }
  };

  const fieldStyle: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    borderRadius: tokens.radii.md,
    border: `1px solid ${tokens.colors.borderSoft}`,
    backgroundColor: tokens.colors.bgSurface,
    color: tokens.colors.textPrimary,
    fontFamily: tokens.typography.fontFamily,
    fontSize: '0.9rem',
    lineHeight: 1.5,
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(55, 46, 41, 0.5)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        zIndex: 1100,
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="someday-item-title"
        tabIndex={-1}
        data-someday-sheet={item.id}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
        style={{
          width: '100%',
          maxWidth: '390px',
          maxHeight: '92vh',
          overflowY: 'auto',
          backgroundColor: tokens.colors.bgCanvas,
          borderTopLeftRadius: tokens.radii.card,
          borderTopRightRadius: tokens.radii.card,
          boxShadow: tokens.shadows.modal,
          padding: '10px 20px 24px',
          boxSizing: 'border-box',
          outline: 'none',
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: '42px',
            height: '5px',
            borderRadius: tokens.radii.pill,
            backgroundColor: tokens.colors.borderSoft,
            margin: '0 auto 14px',
          }}
        />

        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
          <h2
            id="someday-item-title"
            style={{
              margin: 0,
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '1.05rem',
              fontWeight: 800,
              color: tokens.colors.textPrimary,
            }}
          >
            <Sparkles size={18} style={{ color: tokens.colors.accentLavenderDeep }} aria-hidden="true" />
            A someday thing
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none',
              border: 'none',
              color: tokens.colors.textMuted,
              cursor: 'pointer',
              padding: '6px',
              lineHeight: 0,
            }}
          >
            <X size={20} />
          </button>
        </header>

        <div style={{ marginTop: '18px' }}>
          <label
            htmlFor="someday-text"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: '12px',
              marginBottom: '6px',
              fontSize: '0.78rem',
              fontWeight: 800,
              color: tokens.colors.textSecondary,
            }}
          >
            <span>The idea</span>
            <span data-someday-text-count style={{ color: tokens.colors.textMuted, fontWeight: 700 }}>
              {text.length}/{SOMEDAY_TEXT_MAX}
            </span>
          </label>
          <input
            id="someday-text"
            type="text"
            value={text}
            maxLength={SOMEDAY_TEXT_MAX}
            onChange={(event) => setText(event.target.value)}
            style={{ ...fieldStyle, padding: '12px 14px', fontWeight: 700 }}
          />
        </div>

        <div style={{ marginTop: '18px' }}>
          <label
            htmlFor="someday-details"
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: '12px',
              marginBottom: '6px',
              fontSize: '0.78rem',
              fontWeight: 800,
              color: tokens.colors.textSecondary,
            }}
          >
            <span>More about it</span>
            <span data-someday-details-count style={{ color: tokens.colors.textMuted, fontWeight: 700 }}>
              {details.length}/{SOMEDAY_DETAILS_MAX}
            </span>
          </label>
          <textarea
            id="someday-details"
            value={details}
            maxLength={SOMEDAY_DETAILS_MAX}
            rows={6}
            onChange={(event) => setDetails(event.target.value)}
            placeholder="The place, the plan, why you want to go, who mentioned it…"
            aria-describedby="someday-details-help"
            style={{ ...fieldStyle, padding: '12px 14px', resize: 'vertical', minHeight: '120px' }}
          />
          <p
            id="someday-details-help"
            style={{
              margin: '6px 2px 0',
              fontSize: '0.72rem',
              lineHeight: 1.5,
              fontWeight: 600,
              color: tokens.colors.textMuted,
            }}
          >
            Both of you can add to this. Up to {SOMEDAY_DETAILS_MAX.toLocaleString('en-US')} characters.
          </p>
        </div>

        {/* The bridge from a someday idea into a real visit. */}
        <section
          data-someday-visit
          style={{
            marginTop: '18px',
            padding: '14px',
            borderRadius: tokens.radii.md,
            backgroundColor: attachedToNextVisit ? tokens.colors.primaryGreenSoft : tokens.colors.primaryPinkSoft,
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '9px' }}>
            <Heart
              size={16}
              aria-hidden="true"
              style={{
                flexShrink: 0,
                marginTop: '2px',
                color: attachedToNextVisit ? tokens.colors.primaryGreenDeep : tokens.colors.primaryPinkDeep,
              }}
            />
            <div>
              <p
                style={{
                  margin: 0,
                  fontSize: '0.84rem',
                  fontWeight: 800,
                  color: attachedToNextVisit ? tokens.colors.primaryGreenDeep : tokens.colors.primaryPinkDeep,
                }}
              >
                {attachedToNextVisit
                  ? 'On our next visit'
                  : attachedSomewhere
                    ? 'On one of our visit plans'
                    : visit
                      ? 'Make it part of our next visit'
                      : 'No visit planned yet'}
              </p>
              <p
                style={{
                  margin: '3px 0 0',
                  fontSize: '0.76rem',
                  lineHeight: 1.5,
                  fontWeight: 600,
                  color: tokens.colors.textSecondary,
                }}
              >
                {attachedToNextVisit && visit
                  ? `It shows on your ${formatVisitDate(visit)} visit card too.`
                  : attachedSomewhere
                    ? 'Move it to the next visit, or take it back off this one.'
                    : visit
                      ? `Add it to the ${formatVisitDate(visit)} visit so you both see it there.`
                      : 'Plan your next time together and this idea will be added to it.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            data-someday-add-to-visit
            onClick={() => { void handleVisit(); }}
            disabled={busy !== null}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '7px',
              width: '100%',
              padding: '11px 16px',
              borderRadius: tokens.radii.pill,
              border: 'none',
              backgroundColor: attachedToNextVisit
                ? tokens.colors.bgSurface
                : visit
                  ? tokens.colors.primaryPinkDeep
                  : tokens.colors.accentLavenderDeep,
              color: attachedToNextVisit ? tokens.colors.textSecondary : tokens.colors.textWhite,
              fontSize: '0.84rem',
              fontWeight: 800,
              fontFamily: tokens.typography.fontFamily,
              cursor: busy !== null ? 'default' : 'pointer',
              opacity: busy !== null ? 0.65 : 1,
            }}
          >
            <CalendarHeart size={16} aria-hidden="true" />
            {attachedToNextVisit
              ? 'Remove from this visit'
              : visit
                ? 'Add to our next visit'
                : 'Plan our next visit'}
          </button>
          {attachedSomewhere && !attachedToNextVisit && (
            <button
              type="button"
              data-someday-remove-visit
              onClick={() => { void handleRemoveVisit(); }}
              disabled={busy !== null}
              style={{
                background: 'none',
                border: 'none',
                padding: '2px',
                color: tokens.colors.textSecondary,
                fontSize: '0.76rem',
                fontWeight: 700,
                fontFamily: tokens.typography.fontFamily,
                textDecoration: 'underline',
                cursor: busy !== null ? 'default' : 'pointer',
              }}
            >
              Take it off that visit
            </button>
          )}
        </section>

        {error && (
          <p
            role="alert"
            style={{
              margin: '14px 0 0',
              padding: '10px 12px',
              borderRadius: tokens.radii.sm,
              backgroundColor: tokens.colors.primaryPinkSoft,
              color: tokens.colors.primaryPinkDeep,
              fontSize: '0.8rem',
              fontWeight: 700,
            }}
          >
            {error}
          </p>
        )}

        <footer
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            marginTop: '20px',
          }}
        >
          <button
            type="button"
            data-someday-delete
            onClick={() => { void handleDelete(); }}
            disabled={busy !== null}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '11px 14px',
              borderRadius: tokens.radii.pill,
              border: `1.5px solid ${tokens.colors.borderSoft}`,
              backgroundColor: tokens.colors.bgSurface,
              color: tokens.colors.primaryPinkDeep,
              fontSize: '0.82rem',
              fontWeight: 800,
              fontFamily: tokens.typography.fontFamily,
              cursor: busy !== null ? 'default' : 'pointer',
            }}
          >
            <Trash2 size={15} aria-hidden="true" />
            Delete
          </button>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '11px 18px',
              borderRadius: tokens.radii.pill,
              border: 'none',
              backgroundColor: 'transparent',
              color: tokens.colors.textMuted,
              fontSize: '0.84rem',
              fontWeight: 700,
              fontFamily: tokens.typography.fontFamily,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            data-someday-save
            onClick={() => { void handleSave(); }}
            disabled={busy !== null || !text.trim() || !changed}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '11px 22px',
              borderRadius: tokens.radii.pill,
              border: 'none',
              backgroundColor: tokens.colors.primaryPinkDeep,
              color: tokens.colors.textWhite,
              fontSize: '0.86rem',
              fontWeight: 800,
              fontFamily: tokens.typography.fontFamily,
              cursor: busy !== null || !text.trim() || !changed ? 'default' : 'pointer',
              opacity: busy !== null || !text.trim() || !changed ? 0.55 : 1,
            }}
          >
            <Check size={16} aria-hidden="true" />
            Save
          </button>
        </footer>
      </div>
    </div>
  );
};

export default SomedayItemModal;
