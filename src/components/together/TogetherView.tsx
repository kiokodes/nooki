import React, { useRef, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  Clock,
  Heart,
  MapPin,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  Calendar,
  Check,
  X,
  Pencil,
} from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { MAX_BOOKS_ON_SHELF, SHELF_FULL_HELP, isBookFileType } from '../../lib/booksService';
import type { BooksState } from '../../hooks/useBooks';
import type { SharedBook, Visit, SomedayItem } from '../../types/database';

/**
 * The Together tab: shared books, visits & someday list.
 *
 * Sections:
 *   1. Our next visit - countdown and visit details
 *   2. Read together - shared bookshelf
 *   3. Our someday list - shared list of things to experience together
 */

interface TogetherViewProps {
  state: BooksState;
  userId: string;
  userName: string;
  partnerName: string;
  /** Open the full-screen reader on this book. */
  onOpenReader: (bookId: string) => void;
  // Visit-related props
  visit?: Visit | null;
  onPlanVisit?: () => void;
  onViewVisitPlans?: () => void;
  // Someday list props
  somedayItems?: SomedayItem[];
  onAddSomedayItem?: (text: string) => Promise<void>;
  onToggleSomedayItem?: (item: SomedayItem) => Promise<void>;
  onDeleteSomedayItem?: (item: SomedayItem) => Promise<void>;
}

function ProgressBar({ label, percent, ink }: { label: string; percent: number; ink: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span
        style={{
          fontSize: '0.72rem',
          fontWeight: 700,
          color: tokens.colors.textSecondary,
          width: '52px',
          flexShrink: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      <div
        role="progressbar"
        aria-label={`${label} is at ${percent} percent`}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          flex: 1,
          height: '7px',
          borderRadius: tokens.radii.pill,
          backgroundColor: tokens.colors.bgCanvas,
          overflow: 'hidden',
        }}
      >
        <div
          data-progress-fill={label}
          style={{
            width: `${Math.max(0, Math.min(100, percent))}%`,
            height: '100%',
            borderRadius: tokens.radii.pill,
            backgroundColor: ink,
            transition: 'width 0.3s ease',
          }}
        />
      </div>
      <span style={{ fontSize: '0.72rem', fontWeight: 800, color: ink, width: '34px', textAlign: 'right' }}>
        {percent}%
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: SharedBook['status'] }) {
  if (status === 'reading') {
    return (
      <span
        data-book-status="reading"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          padding: '3px 10px',
          borderRadius: tokens.radii.pill,
          backgroundColor: tokens.colors.primaryGreenSoft,
          color: tokens.colors.primaryGreenDeep,
          fontSize: '0.7rem',
          fontWeight: 800,
        }}
      >
        <BookOpen size={11} aria-hidden="true" />
        Reading
      </span>
    );
  }
  if (status === 'left') {
    return (
      <span
        data-book-status="left"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          padding: '3px 10px',
          borderRadius: tokens.radii.pill,
          backgroundColor: tokens.colors.bgCanvas,
          color: tokens.colors.textSecondary,
          fontSize: '0.7rem',
          fontWeight: 800,
        }}
      >
        <Clock size={11} aria-hidden="true" />
        Paused
      </span>
    );
  }
  return (
    <span
      data-book-status="finished"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '3px 10px',
        borderRadius: tokens.radii.pill,
        backgroundColor: tokens.colors.accentLavenderSoft,
        color: tokens.colors.accentLavenderDeep,
        fontSize: '0.7rem',
        fontWeight: 800,
      }}
    >
      <CheckCircle2 size={11} aria-hidden="true" />
      Finished
    </span>
  );
}

function BookCard({
  book,
  state,
  userId,
  userName,
  partnerName,
  shelfFull,
  onOpenReader,
  onUploadNew,
  onDelete,
}: {
  book: SharedBook;
  state: BooksState;
  userId: string;
  userName: string;
  partnerName: string;
  shelfFull: boolean;
  onOpenReader: (bookId: string) => void;
  onUploadNew: () => void;
  onDelete: (book: SharedBook) => void;
}) {
  const myProgress = state.progress.find((item) => item.book_id === book.id && item.user_id === userId);
  const partnerProgress = state.progress.find((item) => item.book_id === book.id && item.user_id !== userId);
  const myInk = tokens.highlightInk.rose;
  const partnerInk = tokens.highlightInk.sage;
  const headline = book.status === 'reading'
    ? 'Currently reading together'
    : book.status === 'left'
      ? 'Paused on the shelf'
      : 'Finished together';

  return (
    <article
      data-book-card={book.id}
      data-book-state={book.status}
      style={{
        backgroundColor: tokens.colors.bgSurface,
        borderRadius: tokens.radii.card,
        padding: '18px 18px 16px',
        boxShadow: tokens.shadows.card,
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <span
          style={{
            fontSize: '0.72rem',
            fontWeight: 800,
            color: tokens.colors.primaryGreenDeep,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}
        >
          {headline}
        </span>
        <StatusBadge status={book.status} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div
          aria-hidden="true"
          style={{
            width: '42px',
            height: '42px',
            borderRadius: tokens.radii.md,
            backgroundColor: tokens.colors.primaryGreenSoft,
            color: tokens.colors.primaryGreenDeep,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <BookOpen size={21} />
        </div>
        <div style={{ minWidth: 0 }}>
          <h2
            data-book-title
            style={{
              margin: 0,
              fontSize: '1.02rem',
              fontWeight: 800,
              color: tokens.colors.textPrimary,
              overflowWrap: 'anywhere',
            }}
          >
            {book.title}
          </h2>
          <span style={{ fontSize: '0.72rem', color: tokens.colors.textMuted, fontWeight: 600 }}>
            {isBookFileType(book.file_type) ? book.file_type.toUpperCase() : 'BOOK'} · up to you both
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
        <ProgressBar label={userName} percent={myProgress?.percent ?? 0} ink={myInk} />
        <ProgressBar label={partnerName} percent={partnerProgress?.percent ?? 0} ink={partnerInk} />
      </div>

      <button
        type="button"
        data-continue-book={book.id}
        disabled={state.busy}
        onClick={() => onOpenReader(book.id)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '7px',
          width: '100%',
          padding: '12px 16px',
          borderRadius: tokens.radii.pill,
          border: 'none',
          backgroundColor: tokens.colors.primaryGreenDeep,
          color: tokens.colors.textWhite,
          fontSize: '0.88rem',
          fontWeight: 800,
          fontFamily: tokens.typography.fontFamily,
          cursor: state.busy ? 'default' : 'pointer',
          opacity: state.busy ? 0.6 : 1,
        }}
      >
        <Play size={15} aria-hidden="true" />
        Continue reading
      </button>

      {book.status !== 'reading' && (
        <div style={{ display: 'flex', gap: '8px' }}>
          {!shelfFull && (
            <button
              type="button"
              data-upload-new
              disabled={state.busy}
              onClick={onUploadNew}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '5px',
                padding: '10px 12px',
                borderRadius: tokens.radii.pill,
                border: `1.5px solid ${tokens.colors.borderSoft}`,
                backgroundColor: tokens.colors.bgSurface,
                color: tokens.colors.textSecondary,
                fontSize: '0.78rem',
                fontWeight: 700,
                fontFamily: tokens.typography.fontFamily,
                cursor: state.busy ? 'default' : 'pointer',
              }}
            >
              <Plus size={13} aria-hidden="true" />
              Upload new
            </button>
          )}
          <button
            type="button"
            data-delete-book={book.id}
            disabled={state.busy}
            onClick={() => onDelete(book)}
            style={{
              flex: shelfFull ? 1 : 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '5px',
              padding: '10px 12px',
              borderRadius: tokens.radii.pill,
              border: `1.5px solid ${tokens.colors.borderSubtle}`,
              backgroundColor: tokens.colors.bgSurface,
              color: tokens.colors.primaryPinkDeep,
              fontSize: '0.78rem',
              fontWeight: 700,
              fontFamily: tokens.typography.fontFamily,
              cursor: state.busy ? 'default' : 'pointer',
            }}
          >
            <Trash2 size={13} aria-hidden="true" />
            Delete
          </button>
        </div>
      )}
    </article>
  );
}

// ============================================================================
// Our Next Visit Section
// ============================================================================

function VisitCard({
  visit,
  userName,
  partnerName,
  onViewPlans,
}: {
  visit: Visit;
  userName: string;
  partnerName: string;
  onViewPlans: () => void;
}) {
  // Calculate days until visit
  const startDate = new Date(visit.start_date);
  const today = new Date();
  const diffTime = startDate.getTime() - today.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  // Check if visit is currently happening
  const endDate = visit.end_date ? new Date(visit.end_date) : null;
  const isDuringVisit = !visit.end_date
    ? false
    : today >= startDate && today <= endDate;

  // Check if visit is in the past
  const isPastVisit = endDate ? today > endDate : today > startDate;

  if (isDuringVisit) {
    return (
      <article
        data-visit-card="current"
        style={{
          backgroundColor: tokens.colors.bgSurface,
          borderRadius: tokens.radii.card,
          padding: '20px 20px 18px',
          boxShadow: tokens.shadows.card,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '12px',
          textAlign: 'center',
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: '64px',
            height: '64px',
            borderRadius: tokens.radii.full,
            background: `linear-gradient(135deg, ${tokens.colors.primaryPinkDeep} 0%, ${tokens.colors.primaryPink} 100%)`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Heart size={32} style={{ color: tokens.colors.textWhite }} />
        </div>
        <h2 style={{ margin: 0, fontSize: '1.35rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
          You're together <span style={{ color: tokens.colors.primaryPinkDeep }}>💛</span>
        </h2>
        <p style={{ margin: 0, fontSize: '0.88rem', color: tokens.colors.textSecondary }}>
          Enjoy your time with {partnerName}!
        </p>
        {visit.location && (
          <p style={{ margin: 0, fontSize: '0.82rem', color: tokens.colors.textMuted, display: 'flex', alignItems: 'center', gap: '6px' }}>
            <MapPin size={14} />
            {visit.location}
          </p>
        )}
      </article>
    );
  }

  if (isPastVisit) {
    return (
      <article
        data-visit-card="past"
        style={{
          backgroundColor: tokens.colors.bgSurface,
          borderRadius: tokens.radii.card,
          padding: '20px 20px 18px',
          boxShadow: tokens.shadows.card,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '12px',
          textAlign: 'center',
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: '64px',
            height: '64px',
            borderRadius: tokens.radii.full,
            backgroundColor: tokens.colors.accentLavenderSoft,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <CheckCircle2 size={32} style={{ color: tokens.colors.accentLavenderDeep }} />
        </div>
        <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
          Visit completed
        </h2>
        <p style={{ margin: 0, fontSize: '0.88rem', color: tokens.colors.textSecondary }}>
          Save a memory or plan your next visit
        </p>
        <button
          type="button"
          onClick={onViewPlans}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '10px 20px',
            borderRadius: tokens.radii.pill,
            border: 'none',
            backgroundColor: tokens.colors.primaryPinkDeep,
            color: tokens.colors.textWhite,
            fontSize: '0.88rem',
            fontWeight: 700,
            fontFamily: tokens.typography.fontFamily,
            cursor: 'pointer',
            marginTop: '8px',
          }}
        >
          <Calendar size={16} aria-hidden="true" />
          Plan next visit
        </button>
      </article>
    );
  }

  return (
    <article
      data-visit-card="upcoming"
      style={{
        backgroundColor: tokens.colors.bgSurface,
        borderRadius: tokens.radii.card,
        padding: '20px 20px 18px',
        boxShadow: tokens.shadows.card,
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div
          aria-hidden="true"
          style={{
            width: '48px',
            height: '48px',
            borderRadius: tokens.radii.md,
            background: `linear-gradient(135deg, ${tokens.colors.primaryPinkDeep} 0%, ${tokens.colors.primaryPink} 100%)`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Heart size={22} style={{ color: tokens.colors.textWhite }} />
        </div>
        <div style={{ minWidth: 0 }}>
          <h2
            style={{
              margin: 0,
              fontSize: '1.15rem',
              fontWeight: 800,
              color: tokens.colors.textPrimary,
            }}
          >
            {diffDays === 0 ? 'Tomorrow!' : diffDays === 1 ? '1 day' : `${diffDays} days`} until your next hug
          </h2>
          <p style={{ margin: 0, fontSize: '0.82rem', color: tokens.colors.textSecondary }}>
            {visit.is_tentative ? 'Our hopeful plan' : `${userName} is going to ${partnerName}'s place`}
            {visit.location && ` in ${visit.location}`}
          </p>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
        <Calendar size={16} style={{ color: tokens.colors.textMuted }} />
        <span style={{ fontSize: '0.8rem', color: tokens.colors.textMuted }}>
          {formatDateRange(visit.start_date, visit.end_date)}
        </span>
      </div>
      <button
        type="button"
        onClick={onViewPlans}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '6px',
          width: '100%',
          padding: '12px 16px',
          borderRadius: tokens.radii.pill,
          border: 'none',
          backgroundColor: tokens.colors.primaryPinkDeep,
          color: tokens.colors.textWhite,
          fontSize: '0.88rem',
          fontWeight: 700,
          fontFamily: tokens.typography.fontFamily,
          cursor: 'pointer',
          marginTop: '8px',
        }}
      >
        View our plans
        <Pencil size={16} aria-hidden="true" />
      </button>
    </article>
  );
}

function NoVisitCard({ onPlanVisit }: { onPlanVisit: () => void }) {
  return (
    <article
      data-visit-card="empty"
      style={{
        backgroundColor: tokens.colors.bgSurface,
        borderRadius: tokens.radii.card,
        padding: '28px 22px',
        boxShadow: tokens.shadows.card,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '13px',
        textAlign: 'center',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: '64px',
          height: '64px',
          borderRadius: tokens.radii.full,
          backgroundColor: tokens.colors.primaryPinkSoft,
          color: tokens.colors.primaryPinkDeep,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Heart size={30} />
      </div>
      <h1 style={{ margin: 0, fontSize: '1.45rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
        Something to look forward to
      </h1>
      <p
        style={{
          margin: 0,
          fontSize: '0.86rem',
          lineHeight: 1.55,
          color: tokens.colors.textSecondary,
          maxWidth: '260px',
        }}
      >
        Plan your next time together.
      </p>
      <button
        type="button"
        onClick={onPlanVisit}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '13px 24px',
          borderRadius: tokens.radii.pill,
          border: 'none',
          backgroundColor: tokens.colors.primaryPinkDeep,
          color: tokens.colors.textWhite,
          fontSize: '0.92rem',
          fontWeight: 800,
          fontFamily: tokens.typography.fontFamily,
          cursor: 'pointer',
        }}
      >
        <Calendar size={16} aria-hidden="true" />
        Plan a visit
      </button>
    </article>
  );
}

// Helper function to format date range
function formatDateRange(startDate: string, endDate: string | null): string {
  const start = new Date(startDate);
  const end = endDate ? new Date(endDate) : null;

  const startMonth = start.toLocaleDateString('en-US', { month: 'short' });
  const startDay = start.getDate();

  if (!end) {
    return `${startMonth} ${startDay}`;
  }

  const endMonth = end.toLocaleDateString('en-US', { month: 'short' });
  const endDay = end.getDate();
  const startYear = start.getFullYear();
  const endYear = end.getFullYear();

  if (startMonth === endMonth && startYear === endYear) {
    return `${startMonth} ${startDay}–${endDay}, ${startYear}`;
  }

  if (startYear === endYear) {
    return `${startMonth} ${startDay} – ${endMonth} ${endDay}, ${startYear}`;
  }

  return `${startMonth} ${startDay}, ${startYear} – ${endMonth} ${endDay}, ${endYear}`;
}

// ============================================================================
// Our Someday List Section
// ============================================================================

function SomedayList({
  items,
  userName,
  partnerName,
  onAddItem,
  onToggleItem,
  onDeleteItem,
}: {
  items: SomedayItem[];
  userName: string;
  partnerName: string;
  onAddItem: (text: string) => Promise<void>;
  onToggleItem: (item: SomedayItem) => Promise<void>;
  onDeleteItem: (item: SomedayItem) => Promise<void>;
}) {
  const [newItemText, setNewItemText] = useState('');
  const [adding, setAdding] = useState(false);

  const handleAdd = async () => {
    if (!newItemText.trim()) return;
    setAdding(true);
    await onAddItem(newItemText.trim());
    setNewItemText('');
    setAdding(false);
  };

  const completedItems = items.filter((item) => item.completed);
  const activeItems = items.filter((item) => !item.completed);

  return (
    <section
      data-someday-list
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2
          style={{
            fontSize: '0.88rem',
            fontWeight: 800,
            color: tokens.colors.textPrimary,
            letterSpacing: '0.02em',
            textTransform: 'uppercase',
          }}
        >
          <Sparkles size={14} style={{ marginRight: '6px', verticalAlign: 'middle' }} />
          Our someday list
        </h2>
        <span
          style={{
            fontSize: '0.72rem',
            color: tokens.colors.textMuted,
            fontWeight: 600,
          }}
        >
          {activeItems.length} to do
        </span>
      </div>

      {/* Add new item */}
      {adding ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '12px 14px',
            borderRadius: tokens.radii.md,
            backgroundColor: tokens.colors.bgSurface,
            boxShadow: tokens.shadows.card,
          }}
        >
          <input
            type="text"
            value={newItemText}
            onChange={(e) => setNewItemText(e.target.value)}
            placeholder="Add something you want to do together..."
            style={{
              flex: 1,
              border: 'none',
              background: 'transparent',
              fontSize: '0.88rem',
              fontFamily: tokens.typography.fontFamily,
              color: tokens.colors.textPrimary,
              padding: '4px 0',
            }}
            onKeyDown={async (e) => {
              if (e.key === 'Enter') {
                await handleAdd();
              }
              if (e.key === 'Escape') {
                setAdding(false);
                setNewItemText('');
              }
            }}
            autoFocus
          />
          <button
            type="button"
            onClick={handleAdd}
            disabled={!newItemText.trim() || adding}
            style={{
              background: 'none',
              border: 'none',
              color: tokens.colors.primaryPinkDeep,
              cursor: !newItemText.trim() ? 'default' : 'pointer',
              padding: '4px',
            }}
          >
            <Check size={18} />
          </button>
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setNewItemText('');
            }}
            style={{
              background: 'none',
              border: 'none',
              color: tokens.colors.textMuted,
              cursor: 'pointer',
              padding: '4px',
            }}
          >
            <X size={18} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            width: '100%',
            padding: '12px 16px',
            borderRadius: tokens.radii.pill,
            border: `1.5px dashed ${tokens.colors.borderSoft}`,
            backgroundColor: tokens.colors.bgSurface,
            color: tokens.colors.primaryPinkDeep,
            fontSize: '0.88rem',
            fontWeight: 700,
            fontFamily: tokens.typography.fontFamily,
            cursor: 'pointer',
            boxShadow: tokens.shadows.card,
          }}
        >
          <Plus size={16} aria-hidden="true" />
          Add to our list
        </button>
      )}

      {/* Active items */}
      {activeItems.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          {activeItems.map((item) => (
            <SomedayItemRow
              key={item.id}
              item={item}
              onToggle={onToggleItem}
              onDelete={onDeleteItem}
            />
          ))}
        </div>
      )}

      {/* Completed items (collapsed by default) */}
      {completedItems.length > 0 && (
        <details
          style={{
            borderTop: `1px solid ${tokens.colors.borderSubtle}`,
            paddingTop: '12px',
          }}
        >
          <summary
            style={{
              cursor: 'pointer',
              fontSize: '0.78rem',
              color: tokens.colors.textMuted,
              fontWeight: 600,
              padding: '4px 0',
            }}
          >
            {completedItems.length} completed
          </summary>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              marginTop: '8px',
            }}
          >
            {completedItems.map((item) => (
              <SomedayItemRow
                key={item.id}
                item={item}
                onToggle={onToggleItem}
                onDelete={onDeleteItem}
              />
            ))}
          </div>
        </details>
      )}

      {activeItems.length === 0 && completedItems.length === 0 && !adding && (
        <p
          style={{
            fontSize: '0.82rem',
            color: tokens.colors.textMuted,
            textAlign: 'center',
            padding: '16px',
          }}
        >
          Your shared list will appear here. Add things you want to experience together!
        </p>
      )}
    </section>
  );
}

function SomedayItemRow({
  item,
  onToggle,
  onDelete,
}: {
  item: SomedayItem;
  onToggle: (item: SomedayItem) => Promise<void>;
  onDelete: (item: SomedayItem) => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);

  return (
    <div
      data-someday-item={item.id}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '10px 14px',
        borderRadius: tokens.radii.md,
        backgroundColor: tokens.colors.bgSurface,
        boxShadow: tokens.shadows.card,
      }}
    >
      <button
        type="button"
        onClick={() => onToggle(item)}
        disabled={deleting}
        style={{
          width: '22px',
          height: '22px',
          borderRadius: tokens.radii.full,
          border: `2px solid ${item.completed ? tokens.colors.primaryGreenDeep : tokens.colors.borderSoft}`,
          backgroundColor: item.completed ? tokens.colors.primaryGreenDeep : 'transparent',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          flexShrink: 0,
        }}
        aria-label={item.completed ? 'Mark as incomplete' : 'Mark as complete'}
      >
        {item.completed && <Check size={14} style={{ color: tokens.colors.textWhite }} />}
      </button>
      <span
        style={{
          flex: 1,
          fontSize: '0.88rem',
          color: item.completed ? tokens.colors.textMuted : tokens.colors.textPrimary,
          textDecoration: item.completed ? 'line-through' : 'none',
          textDecorationColor: tokens.colors.textMuted,
        }}
      >
        {item.text}
      </span>
      <button
        type="button"
        onClick={async () => {
          setDeleting(true);
          await onDelete(item);
          setDeleting(false);
        }}
        disabled={deleting}
        style={{
          background: 'none',
          border: 'none',
          color: tokens.colors.textMuted,
          cursor: 'pointer',
          padding: '4px',
        }}
        aria-label="Delete"
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}

// ============================================================================
// Main TogetherView Component
// ============================================================================

export const TogetherView: React.FC<TogetherViewProps> = ({
  state,
  userId,
  userName,
  partnerName,
  onOpenReader,
  // Visit props (optional for now)
  visit,
  onPlanVisit,
  onViewVisitPlans,
  // Someday list props (optional for now)
  somedayItems = [],
  onAddSomedayItem,
  onToggleSomedayItem,
  onDeleteSomedayItem,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const activeBook = state.books.find((book) => book.status === 'reading') ?? null;
  const pausedBooks = state.books.filter((book) => book.status !== 'reading');
  const shelfFull = state.books.length >= MAX_BOOKS_ON_SHELF;

  const openPicker = () => {
    if (shelfFull) {
      setNotice(SHELF_FULL_HELP);
      return;
    }
    setNotice(null);
    fileInputRef.current?.click();
  };

  const handlePicked = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setNotice(null);
    const book = await state.upload(file);
    if (book) onOpenReader(book.id);
  };

  const handleDelete = (book: SharedBook) => {
    const ok = window.confirm(
      `Delete "${book.title}"? The file goes away, and quotes already in chat keep their words but lose the jump back into the book.`,
    );
    if (ok) void state.remove(book);
  };

  return (
    <section
      data-screen="together"
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        padding: '14px 16px 22px',
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".epub,.pdf,application/epub+zip,application/pdf"
        data-upload-input
        aria-label="Choose a book file to read together"
        style={{ display: 'none' }}
        onChange={handlePicked}
      />

      {notice && (
        <p
          role="status"
          data-together-notice
          style={{
            margin: 0,
            padding: '10px 14px',
            borderRadius: tokens.radii.md,
            backgroundColor: tokens.colors.primaryPinkSoft,
            color: tokens.colors.primaryPinkDeep,
            fontSize: '0.8rem',
            fontWeight: 700,
          }}
        >
          {notice}
        </p>
      )}

      {state.error && (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: '10px 14px',
            borderRadius: tokens.radii.md,
            backgroundColor: tokens.colors.primaryPinkSoft,
            color: tokens.colors.primaryPinkDeep,
            fontSize: '0.8rem',
            fontWeight: 700,
          }}
        >
          {state.error}
        </p>
      )}

      {/* Section 1: Our Next Visit */}
      <section
        data-section="visit"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <h2
          style={{
            fontSize: '0.88rem',
            fontWeight: 800,
            color: tokens.colors.textPrimary,
            letterSpacing: '0.02em',
            textTransform: 'uppercase',
          }}
        >
          <Heart size={14} style={{ marginRight: '6px', verticalAlign: 'middle', color: tokens.colors.primaryPinkDeep }} />
          Our next visit
        </h2>
        {visit ? (
          <VisitCard visit={visit} userName={userName} partnerName={partnerName} onViewPlans={onViewVisitPlans || (() => {})} />
        ) : (
          <NoVisitCard onPlanVisit={onPlanVisit || (() => {})} />
        )}
      </section>

      {/* Section 2: Read Together */}
      <section
        data-section="read-together"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <h2
          style={{
            fontSize: '0.88rem',
            fontWeight: 800,
            color: tokens.colors.textPrimary,
            letterSpacing: '0.02em',
            textTransform: 'uppercase',
          }}
        >
          <BookOpen size={14} style={{ marginRight: '6px', verticalAlign: 'middle', color: tokens.colors.primaryGreenDeep }} />
          Read together
        </h2>
        {state.books.length === 0 ? (
          <article
            data-card="read-together"
            style={{
              backgroundColor: tokens.colors.bgSurface,
              borderRadius: tokens.radii.card,
              padding: '28px 22px',
              boxShadow: tokens.shadows.card,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '13px',
              textAlign: 'center',
            }}
          >
            <div
              aria-hidden="true"
              style={{
                width: '64px',
                height: '64px',
                borderRadius: tokens.radii.full,
                backgroundColor: tokens.colors.primaryGreenSoft,
                color: tokens.colors.primaryGreenDeep,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <BookOpen size={30} />
            </div>
            <h1 style={{ margin: 0, fontSize: '1.45rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
              Read together
            </h1>
            <p
              style={{
                margin: 0,
                fontSize: '0.86rem',
                lineHeight: 1.55,
                color: tokens.colors.textSecondary,
                maxWidth: '260px',
              }}
            >
              One book for the two of you — up to {MAX_BOOKS_ON_SHELF} at a time. Highlight passages, leave
              comments in chat, and jump to wherever your partner is reading. Finish one to
              open the next.
            </p>
            <button
              type="button"
              data-upload-book
              disabled={state.busy}
              onClick={openPicker}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '13px 24px',
                borderRadius: tokens.radii.pill,
                border: 'none',
                backgroundColor: tokens.colors.primaryGreenDeep,
                color: tokens.colors.textWhite,
                fontSize: '0.92rem',
                fontWeight: 800,
                fontFamily: tokens.typography.fontFamily,
                cursor: state.busy ? 'default' : 'pointer',
                opacity: state.busy ? 0.6 : 1,
              }}
            >
              <Upload size={16} aria-hidden="true" />
              {state.busy ? 'Uploading…' : 'Upload book'}
            </button>
            <p style={{ margin: 0, fontSize: '0.72rem', color: tokens.colors.textMuted, fontWeight: 600 }}>
              DRM-free EPUB or PDF only · up to 40 MB
            </p>
          </article>
        ) : (
          <>
            {activeBook && (
              <BookCard
                book={activeBook}
                state={state}
                userId={userId}
                userName={userName}
                partnerName={partnerName}
                shelfFull={shelfFull}
                onOpenReader={onOpenReader}
                onUploadNew={openPicker}
                onDelete={handleDelete}
              />
            )}

            {pausedBooks.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                state={state}
                userId={userId}
                userName={userName}
                partnerName={partnerName}
                shelfFull={shelfFull}
                onOpenReader={onOpenReader}
                onUploadNew={openPicker}
                onDelete={handleDelete}
              />
            ))}

            {!shelfFull && (
              <button
                type="button"
                data-upload-book
                disabled={state.busy}
                onClick={openPicker}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  width: '100%',
                  padding: '13px 20px',
                  borderRadius: tokens.radii.pill,
                  border: `1.5px dashed ${tokens.colors.borderSoft}`,
                  backgroundColor: tokens.colors.bgSurface,
                  color: tokens.colors.primaryGreenDeep,
                  fontSize: '0.88rem',
                  fontWeight: 800,
                  fontFamily: tokens.typography.fontFamily,
                  cursor: state.busy ? 'default' : 'pointer',
                  boxShadow: tokens.shadows.card,
                }}
              >
                <Upload size={16} aria-hidden="true" />
                {state.busy ? 'Uploading…' : 'Upload book'}
              </button>
            )}

            <p
              style={{
                margin: '2px 4px 0',
                fontSize: '0.72rem',
                lineHeight: 1.5,
                color: tokens.colors.textMuted,
                fontWeight: 600,
              }}
            >
              <UserRound size={11} style={{ verticalAlign: '-2px', marginRight: '4px' }} aria-hidden="true" />
              {userName} and {partnerName} share this shelf · up to {MAX_BOOKS_ON_SHELF} books at a time.
              Files stay private to the two of you — DRM-free EPUB or PDF only.
            </p>
          </>
        )}
      </section>

      {/* Section 3: Our Someday List */}
      <section
        data-section="someday-list"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        {onAddSomedayItem && onToggleSomedayItem && onDeleteSomedayItem ? (
          <SomedayList
            items={somedayItems}
            userName={userName}
            partnerName={partnerName}
            onAddItem={onAddSomedayItem}
            onToggleItem={onToggleSomedayItem}
            onDeleteItem={onDeleteSomedayItem}
          />
        ) : (
          <article
            data-card="someday-placeholder"
            style={{
              backgroundColor: tokens.colors.bgSurface,
              borderRadius: tokens.radii.card,
              padding: '24px 20px',
              boxShadow: tokens.shadows.card,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '12px',
              textAlign: 'center',
            }}
          >
            <div
              aria-hidden="true"
              style={{
                width: '56px',
                height: '56px',
                borderRadius: tokens.radii.full,
                backgroundColor: tokens.colors.accentLavenderSoft,
                color: tokens.colors.accentLavenderDeep,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Sparkles size={26} />
            </div>
            <h2 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 800, color: tokens.colors.textPrimary }}>
              Our someday list
            </h2>
            <p
              style={{
                margin: 0,
                fontSize: '0.84rem',
                lineHeight: 1.55,
                color: tokens.colors.textSecondary,
                maxWidth: '280px',
              }}
            >
              A shared list of things you want to experience together. Coming soon!
            </p>
          </article>
        )}
      </section>
    </section>
  );
};

export default TogetherView;
