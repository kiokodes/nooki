import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Filter, Lock } from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { DISCUSS_CATEGORIES, categoryDisplay, formatAnswerSummary } from '../../lib/questionFormat';
import type { SessionDetail } from '../../hooks/useDiscuss';

interface HistoryListProps {
  sessions: SessionDetail[];
  /** The categories this couple's library holds: the filter menu is built from them. */
  categories: string[];
  /** The category the list is narrowed to, or null for every question. */
  filter: string | null;
  onFilterChange: (category: string | null) => void;
  /** This phone's account, so the list can show your own comment on a row. */
  userId: string;
  partnerName: string;
  onOpen: (sessionId: string) => void;
  onBack: () => void;
}

interface StateChip {
  label: string;
  color: string;
  background: string;
}

/** The three things a past session can still be doing. */
function stateChip(detail: SessionDetail, partnerName: string): StateChip {
  if (detail.revealed) {
    return { label: 'Revealed', color: tokens.colors.primaryGreenDeep, background: tokens.colors.primaryGreenSoft };
  }
  if (!detail.myAnswer) {
    return { label: 'Your turn', color: tokens.colors.primaryPinkDeep, background: tokens.colors.primaryPinkSoft };
  }
  return { label: `Waiting for ${partnerName}`, color: tokens.colors.accentSageDeep, background: tokens.colors.accentSageSoft };
}

/** The canonical order first, then any category the CSV introduced on its own. */
function byCategoryOrder(a: string, b: string): number {
  const rank = (name: string) => {
    const index = DISCUSS_CATEGORIES.findIndex((entry) => entry.name === name);
    return index === -1 ? DISCUSS_CATEGORIES.length : index;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

/**
 * Every question this couple has asked, newest first. A sealed session shows its state
 * and nothing else — the partner's answer is not in this list because the database never
 * sent it.
 *
 * The filter beside the back button narrows the list to one category of the library.
 */
export const HistoryList: React.FC<HistoryListProps> = ({
  sessions,
  categories,
  filter,
  onFilterChange,
  userId,
  partnerName,
  onOpen,
  onBack,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // The menu is a small popover: a tap elsewhere or Escape puts it away again.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: Event) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node | null)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  // The library's categories, plus any category a question in the history still carries
  // (a row may have been imported after the library counts were read).
  const options = useMemo(() => {
    const names = new Set<string>(categories);
    for (const detail of sessions) {
      const category = detail.question?.category;
      if (category) names.add(category);
    }
    return [...names].sort(byCategoryOrder);
  }, [categories, sessions]);

  /** How many past questions each category holds, for the menu's counts. */
  const counts = useMemo(() => {
    const tally = new Map<string, number>();
    for (const detail of sessions) {
      const category = detail.question?.category;
      if (!category) continue;
      tally.set(category, (tally.get(category) ?? 0) + 1);
    }
    return tally;
  }, [sessions]);

  const visible = useMemo(
    () => (filter ? sessions.filter((detail) => detail.question?.category === filter) : sessions),
    [filter, sessions],
  );

  const active = filter ? categoryDisplay(filter) : null;

  return (
    <div data-discuss-history style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
        <button
          type="button"
          aria-label="Back to categories"
          onClick={onBack}
          style={{
            padding: '8px 14px',
            borderRadius: tokens.radii.pill,
            border: `1.5px solid ${tokens.colors.borderSoft}`,
            backgroundColor: tokens.colors.bgSurface,
            color: tokens.colors.textSecondary,
            fontSize: '0.8rem',
            fontWeight: 700,
            fontFamily: tokens.typography.fontFamily,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <ArrowLeft size={14} aria-hidden="true" />
          <span>Categories</span>
        </button>

        <div ref={menuRef} style={{ position: 'relative', flexShrink: 0 }}>
          <button
            type="button"
            aria-label={active ? `Filter by category, ${active.name} chosen` : 'Filter by category'}
            aria-haspopup="listbox"
            aria-expanded={menuOpen}
            data-history-filter
            data-filter-active={active ? 'true' : 'false'}
            onClick={() => setMenuOpen((open) => !open)}
            style={{
              padding: '8px 14px',
              borderRadius: tokens.radii.pill,
              border: `1.5px solid ${active ? active.accent : tokens.colors.borderSoft}`,
              backgroundColor: active ? active.accentSoft : tokens.colors.bgSurface,
              color: active ? active.accent : tokens.colors.textSecondary,
              fontSize: '0.8rem',
              fontWeight: 700,
              fontFamily: tokens.typography.fontFamily,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <Filter size={14} aria-hidden="true" />
            <span data-history-filter-label>{active ? active.name : 'Filter'}</span>
            <ChevronDown
              size={13}
              aria-hidden="true"
              style={{ transform: menuOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}
            />
          </button>

          {menuOpen && (
            <div
              data-history-filter-menu
              role="listbox"
              aria-label="Filter by category"
              style={{
                position: 'absolute',
                top: 'calc(100% + 6px)',
                right: 0,
                width: '212px',
                maxHeight: '260px',
                overflowX: 'hidden',
                overflowY: 'auto',
                backgroundColor: tokens.colors.bgSurface,
                borderRadius: tokens.radii.md,
                boxShadow: tokens.shadows.soft,
                border: `1px solid ${tokens.colors.borderSubtle}`,
                zIndex: 5,
              }}
            >
              <button
                type="button"
                role="option"
                aria-selected={filter === null}
                data-history-filter-option="all"
                onClick={() => {
                  onFilterChange(null);
                  setMenuOpen(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '9px',
                  width: '100%',
                  padding: '11px 14px',
                  border: 'none',
                  borderBottom: `1px solid ${tokens.colors.borderSubtle}`,
                  backgroundColor: filter === null ? tokens.colors.bgSurfaceSubtle : 'transparent',
                  color: tokens.colors.textPrimary,
                  fontSize: '0.82rem',
                  fontWeight: 700,
                  fontFamily: tokens.typography.fontFamily,
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <span style={{ fontSize: '0.95rem', width: '18px', textAlign: 'center' }} aria-hidden="true">✧</span>
                <span style={{ flex: 1 }}>All categories</span>
                <span style={{ fontSize: '0.72rem', color: tokens.colors.textMuted }}>{sessions.length}</span>
              </button>

              {options.map((name) => {
                const display = categoryDisplay(name);
                const selected = filter === name;
                return (
                  <button
                    key={name}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-history-filter-option={name}
                    onClick={() => {
                      onFilterChange(name);
                      setMenuOpen(false);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '9px',
                      width: '100%',
                      padding: '11px 14px',
                      border: 'none',
                      borderBottom: `1px solid ${tokens.colors.borderSubtle}`,
                      backgroundColor: selected ? display.accentSoft : 'transparent',
                      color: tokens.colors.textPrimary,
                      fontSize: '0.82rem',
                      fontWeight: 700,
                      fontFamily: tokens.typography.fontFamily,
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ fontSize: '0.95rem', width: '18px', textAlign: 'center' }} aria-hidden="true">
                      {display.emoji}
                    </span>
                    <span style={{ flex: 1 }}>{display.name}</span>
                    <span style={{ fontSize: '0.72rem', color: tokens.colors.textMuted }}>
                      {counts.get(name) ?? 0}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {!visible.length && (
        <div
          data-history-empty
          style={{
            padding: '24px 18px',
            borderRadius: tokens.radii.lg,
            backgroundColor: tokens.colors.bgSurface,
            border: `1.5px dashed ${tokens.colors.borderSoft}`,
            textAlign: 'center',
            fontSize: '0.82rem',
            color: tokens.colors.textSecondary,
            lineHeight: 1.5,
          }}
        >
          {active
            ? `No ${active.name} questions in your history yet.`
            : 'Nothing asked yet. Pick a category and ask your first question.'}
        </div>
      )}

      {visible.map((detail) => {
        const chip = stateChip(detail, partnerName);
        const display = categoryDisplay(detail.question?.category ?? '');
        const myComment = detail.comments.find((entry) => entry.user_id === userId) ?? null;
        return (
          <button
            key={detail.session.id}
            type="button"
            aria-label={`Open ${detail.question?.text ?? 'this question'}`}
            data-history-item={detail.session.id}
            data-history-state={detail.revealed ? 'revealed' : detail.myAnswer ? 'waiting' : 'your-turn'}
            onClick={() => onOpen(detail.session.id)}
            style={{
              width: '100%',
              padding: '13px 14px',
              borderRadius: tokens.radii.lg,
              backgroundColor: tokens.colors.bgSurface,
              border: `1.5px solid ${tokens.colors.borderSubtle}`,
              boxShadow: tokens.shadows.subtle,
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              cursor: 'pointer',
              fontFamily: tokens.typography.fontFamily,
              textAlign: 'left',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: '34px',
                height: '34px',
                borderRadius: tokens.radii.full,
                backgroundColor: display.accentSoft,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '1rem',
                flexShrink: 0,
              }}
            >
              {display.emoji}
            </span>
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <span
                style={{
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  color: tokens.colors.textPrimary,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {detail.question?.text ?? 'A question that is no longer in your library'}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <span
                  style={{
                    padding: '2px 9px',
                    borderRadius: tokens.radii.pill,
                    backgroundColor: chip.background,
                    color: chip.color,
                    fontSize: '0.66rem',
                    fontWeight: 800,
                  }}
                >
                  {chip.label}
                </span>
                <span style={{ fontSize: '0.66rem', color: tokens.colors.textMuted }}>
                  {new Date(detail.session.created_at).toLocaleDateString()}
                </span>
                {detail.revealed && detail.myAnswer?.answer != null && (
                  <span style={{ fontSize: '0.66rem', color: tokens.colors.textMuted }}>
                    {formatAnswerSummary(detail.myAnswer.answer, detail.question?.input_type ?? 'text').slice(0, 34)}
                  </span>
                )}
                {myComment && (
                  <span data-my-comment style={{ fontSize: '0.66rem', color: tokens.colors.textSecondary }}>
                    {`💬 ${myComment.comment.length > 28 ? `${myComment.comment.slice(0, 28)}…` : myComment.comment}`}
                  </span>
                )}
              </span>
            </span>
            {!detail.revealed && <Lock size={14} color={tokens.colors.textMuted} aria-hidden="true" />}
            <ChevronRight size={16} color={tokens.colors.textMuted} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
};

export default HistoryList;
