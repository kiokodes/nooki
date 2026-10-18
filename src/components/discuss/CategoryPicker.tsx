import React from 'react';
import { Lock, Shuffle, Sparkles } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { DISCUSS_CATEGORIES, categoryDisplay } from '../../lib/questionFormat';
import { DifficultyModal } from './DifficultyModal';
import type { CategoryCount } from '../../lib/discussService';

interface CategoryPickerProps {
  /** Only the categories this couple may see: the database already withheld 18+ rows. */
  categories: CategoryCount[];
  adultEnabled: boolean;
  partnerName: string;
  libraryEmpty: boolean;
  busy: boolean;
  selectedCategory: string | null;
  onSelectCategory: (category: string | null) => void;
  /** Null category and null level is "Surprise me". */
  onPick: (category: string | null, seriousness: number | null) => void;
  onOpenSettings: () => void;
}

const ADULT_CATEGORY = 'Intimacy';

const tileStyle = (dimmed: boolean): React.CSSProperties => ({
  flex: '1 1 calc(50% - 6px)',
  minWidth: '140px',
  padding: '14px',
  borderRadius: tokens.radii.lg,
  backgroundColor: tokens.colors.bgSurface,
  border: `1.5px solid ${tokens.colors.borderSubtle}`,
  boxShadow: tokens.shadows.subtle,
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  cursor: dimmed ? 'default' : 'pointer',
  opacity: dimmed ? 0.62 : 1,
  textAlign: 'left',
  fontFamily: tokens.typography.fontFamily,
  position: 'relative',
});

/**
 * Step one of the Discuss flow: choose a category, and a pop-up asks how heavy it
 * should be before a question card follows. "Surprise me" skips both and pulls anything
 * the couple has not asked yet.
 *
 * The tiles describe the imported library — nothing here carries question text of its own.
 */
export const CategoryPicker: React.FC<CategoryPickerProps> = ({
  categories,
  adultEnabled,
  partnerName,
  libraryEmpty,
  busy,
  selectedCategory,
  onSelectCategory,
  onPick,
  onOpenSettings,
}) => {
  // Canonical order first, then any category the CSV introduced on its own.
  const ordered = [...categories].sort((a, b) => {
    const rank = (name: string) => {
      const index = DISCUSS_CATEGORIES.findIndex((entry) => entry.name === name);
      return index === -1 ? DISCUSS_CATEGORIES.length : index;
    };
    return rank(a.category) - rank(b.category) || a.category.localeCompare(b.category);
  });
  const showAdultLock = !adultEnabled && !ordered.some((entry) => entry.category === ADULT_CATEGORY);
  const selected = ordered.find((entry) => entry.category === selectedCategory) ?? null;

  return (
    <div data-discuss-browse style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '10px',
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
            What should we talk about?
          </h2>
        </div>
        <button
          type="button"
          aria-label="Surprise me"
          disabled={busy || libraryEmpty}
          onClick={() => onPick(null, null)}
          style={{
            flexShrink: 0,
            padding: '10px 14px',
            borderRadius: tokens.radii.pill,
            border: 'none',
            backgroundColor: tokens.colors.accentSageDeep,
            color: tokens.colors.textWhite,
            fontSize: '0.78rem',
            fontWeight: 800,
            fontFamily: tokens.typography.fontFamily,
            cursor: busy || libraryEmpty ? 'not-allowed' : 'pointer',
            opacity: busy || libraryEmpty ? 0.6 : 1,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            boxShadow: tokens.shadows.subtle,
          }}
        >
          <Shuffle size={14} aria-hidden="true" />
          <span>Surprise me</span>
        </button>
      </div>

      {libraryEmpty && (
        <div
          data-discuss-empty
          style={{
            padding: '22px 18px',
            borderRadius: tokens.radii.lg,
            backgroundColor: tokens.colors.bgSurface,
            border: `1.5px dashed ${tokens.colors.borderSoft}`,
            textAlign: 'center',
          }}
        >
          <Sparkles size={20} color={tokens.colors.accentSageDeep} aria-hidden="true" />
          <p style={{ margin: '8px 0 4px 0', fontSize: '0.92rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
            The question library is empty
          </p>
          <p style={{ margin: 0, fontSize: '0.78rem', color: tokens.colors.textSecondary, lineHeight: 1.5 }}>
            Import your questions CSV into the Supabase <code>questions</code> table and this
            screen fills up by itself.
          </p>
        </div>
      )}

      {!libraryEmpty && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
          {ordered.map((entry) => {
            const display = categoryDisplay(entry.category);
            const isSelected = selectedCategory === entry.category;
            const done = entry.remaining === 0;
            return (
              <button
                key={entry.category}
                type="button"
                aria-label={`${display.name}, ${entry.remaining} left`}
                aria-pressed={isSelected}
                data-category={display.name}
                data-selected={isSelected ? 'true' : 'false'}
                disabled={busy}
                onClick={() => onSelectCategory(display.name)}
                style={{
                  ...tileStyle(busy),
                  borderColor: isSelected ? display.accent : tokens.colors.borderSubtle,
                  backgroundColor: isSelected ? display.accentSoft : tokens.colors.bgSurface,
                }}
              >
                <span style={{ fontSize: '1.3rem', lineHeight: 1 }} aria-hidden="true">{display.emoji}</span>
                <span style={{ fontSize: '0.9rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
                  {display.name}
                </span>
                <span style={{ fontSize: '0.7rem', color: tokens.colors.textSecondary, lineHeight: 1.35 }}>
                  {display.blurb}
                </span>
                <span
                  data-category-remaining
                  style={{
                    marginTop: '4px',
                    fontSize: '0.68rem',
                    fontWeight: 800,
                    color: done ? tokens.colors.textMuted : display.accent,
                  }}
                >
                  {done ? 'All asked' : `${entry.remaining} left`}
                </span>
              </button>
            );
          })}

          {showAdultLock && (
            <div
              data-category="Intimacy"
              data-adult-locked="true"
              style={{
                ...tileStyle(false),
                borderColor: tokens.colors.borderSoft,
                backgroundColor: tokens.colors.bgSurfaceSubtle,
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Lock size={14} color={tokens.colors.textMuted} aria-hidden="true" />
                <span style={{ fontSize: '0.9rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
                  {ADULT_CATEGORY}
                </span>
              </span>
              <span style={{ fontSize: '0.7rem', color: tokens.colors.textSecondary, lineHeight: 1.35 }}>
                18+ · hidden until you and {partnerName} both turn it on
              </span>
              <button
                type="button"
                aria-label="Turn on Intimacy questions in settings"
                onClick={onOpenSettings}
                style={{
                  marginTop: '6px',
                  alignSelf: 'flex-start',
                  padding: '6px 12px',
                  borderRadius: tokens.radii.pill,
                  border: `1px solid ${tokens.colors.borderSoft}`,
                  backgroundColor: tokens.colors.bgSurface,
                  color: tokens.colors.textSecondary,
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  fontFamily: tokens.typography.fontFamily,
                  cursor: 'pointer',
                }}
              >
                Open settings
              </button>
            </div>
          )}
        </div>
      )}

      {selected && (
        <DifficultyModal
          entry={selected}
          busy={busy}
          onPick={onPick}
          onClose={() => onSelectCategory(null)}
        />
      )}
    </div>
  );
};

export default CategoryPicker;
