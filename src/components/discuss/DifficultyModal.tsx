import React, { useEffect } from 'react';
import { Sparkles, X } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { SERIOUSNESS_LEVELS, categoryDisplay } from '../../lib/questionFormat';
import type { CategoryCount } from '../../lib/discussService';

interface DifficultyModalProps {
  /** The category the couple just tapped: its levels and what is left in each. */
  entry: CategoryCount;
  busy: boolean;
  /** Null seriousness is \"Any level\" within this category. */
  onPick: (category: string | null, seriousness: number | null) => void;
  onClose: () => void;
}

const levelButtonStyle = (disabled: boolean): React.CSSProperties => ({
  width: '100%',
  padding: '11px 12px',
  borderRadius: tokens.radii.md,
  border: `1.5px solid ${tokens.colors.borderSubtle}`,
  backgroundColor: tokens.colors.bgSurface,
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.55 : 1,
  textAlign: 'left',
  fontFamily: tokens.typography.fontFamily,
});

/**
 * Step two of the Discuss flow, as a pop-up: the couple tapped a category, and this
 * modal asks how deep it should go before anything else can happen.
 *
 * A modal instead of an inline strip, so there is exactly one thing on screen to do
 * next — pick a level (or Any) and the question card follows. The level counts come
 * from the same `CategoryCount` the tiles use, so a level with nothing left in it is
 * disabled here the way it would be anywhere else.
 */
export const DifficultyModal: React.FC<DifficultyModalProps> = ({
  entry,
  busy,
  onPick,
  onClose,
}) => {
  const display = categoryDisplay(entry.category);

  // Escape steps back to the categories. While a pick is in flight the modal stays
  // put, so closing cannot swallow the question that is about to arrive.
  useEffect(() => {
    if (busy) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  return (
    <div
      data-modal="difficulty"
      role="dialog"
      aria-modal="true"
      aria-label={`Choose how deep ${entry.category} should go`}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 40,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        backgroundColor: 'rgba(55, 46, 41, 0.45)',
        backdropFilter: 'blur(3px)',
        animation: 'nooki-fade-in 0.18s ease',
      }}
      onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}
    >
      <div
        data-seriousness-picker
        style={{
          width: '100%',
          maxWidth: '320px',
          maxHeight: '90%',
          overflowY: 'auto',
          backgroundColor: tokens.colors.bgSurface,
          borderRadius: tokens.radii.card,
          boxShadow: tokens.shadows.card,
          padding: '20px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          animation: 'nooki-modal-pop 0.22s cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 }}>
            <span
              style={{
                fontSize: '0.64rem',
                fontWeight: 800,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: tokens.colors.accentSageDeep,
              }}
            >
              Step 2 · Pick a depth
            </span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                alignSelf: 'flex-start',
                gap: '5px',
                padding: '5px 12px',
                borderRadius: tokens.radii.pill,
                backgroundColor: display.accentSoft,
                color: display.accent,
                fontSize: '0.72rem',
                fontWeight: 800,
              }}
            >
              <span aria-hidden="true">{display.emoji}</span>
              <span>{display.name}</span>
            </span>
          </div>
          <button
            type="button"
            aria-label="Close difficulty picker"
            disabled={busy}
            onClick={onClose}
            style={{
              width: '32px',
              height: '32px',
              borderRadius: tokens.radii.full,
              border: 'none',
              backgroundColor: tokens.colors.bgSurfaceSubtle,
              color: tokens.colors.textSecondary,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.6 : 1,
              flexShrink: 0,
            }}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div>
          <h2 style={{ margin: 0, fontSize: '1.02rem', fontWeight: 800, color: tokens.colors.textPrimary, letterSpacing: '-0.01em' }}>
            {`How deep should ${entry.category} go?`}
          </h2>
          <p style={{ margin: '4px 0 0 0', fontSize: '0.76rem', color: tokens.colors.textSecondary, lineHeight: 1.5 }}>
            {`Pick a level and we'll pull a ${entry.category} question you haven't asked yet.`}
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button
            type="button"
            aria-label="Any level"
            disabled={busy || entry.remaining === 0}
            onClick={() => onPick(entry.category, null)}
            style={levelButtonStyle(busy || entry.remaining === 0)}
          >
            <span
              aria-hidden="true"
              style={{
                width: '30px',
                height: '30px',
                borderRadius: tokens.radii.full,
                backgroundColor: tokens.colors.accentSageSoft,
                color: tokens.colors.accentSageDeep,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Sparkles size={14} />
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ fontSize: '0.84rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
                Any level
              </span>
              <span style={{ fontSize: '0.7rem', color: tokens.colors.textMuted }}>
                Surprise us within this category
              </span>
            </span>
            <span style={{ marginLeft: 'auto', fontSize: '0.7rem', fontWeight: 800, color: entry.remaining === 0 ? tokens.colors.textMuted : display.accent, flexShrink: 0 }}>
              {entry.remaining === 0 ? 'Done' : `${entry.remaining} left`}
            </span>
          </button>

          {SERIOUSNESS_LEVELS.map((level) => {
            const remaining = entry.byLevel[level.level] ?? 0;
            const disabled = busy || remaining === 0;
            return (
              <button
                key={level.level}
                type="button"
                aria-label={`${level.label}, level ${level.level}, ${remaining} left`}
                data-seriousness={level.level}
                disabled={disabled}
                title={level.hint}
                onClick={() => onPick(entry.category, level.level)}
                style={levelButtonStyle(disabled)}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: '30px',
                    height: '30px',
                    borderRadius: tokens.radii.full,
                    backgroundColor: display.accentSoft,
                    color: display.accent,
                    fontSize: '0.82rem',
                    fontWeight: 800,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {level.level}
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={{ fontSize: '0.84rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
                    {level.label}
                  </span>
                  <span style={{ fontSize: '0.7rem', color: tokens.colors.textMuted }}>
                    {level.hint}
                  </span>
                </span>
                <span style={{ marginLeft: 'auto', fontSize: '0.7rem', fontWeight: 800, color: remaining === 0 ? tokens.colors.textMuted : display.accent, flexShrink: 0 }}>
                  {remaining === 0 ? 'Done' : `${remaining} left`}
                </span>
              </button>
            );
          })}
        </div>

        {entry.remaining === 0 ? (
          <span style={{ fontSize: '0.74rem', color: tokens.colors.textSecondary, lineHeight: 1.5 }}>
            {`You have asked every ${entry.category} question in your library.`}
          </span>
        ) : (
          <p style={{ margin: 0, textAlign: 'center', fontSize: '0.7rem', color: tokens.colors.textMuted, lineHeight: 1.45 }}>
            Your question appears next — you both answer privately.
          </p>
        )}
      </div>
    </div>
  );
};

export default DifficultyModal;
