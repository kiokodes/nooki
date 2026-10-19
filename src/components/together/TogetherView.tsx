import React, { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  CalendarHeart,
  CheckCircle2,
  Clock,
  GripVertical,
  Heart,
  MapPin,
  Play,
  Plus,
  Sparkles,
  StickyNote,
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
import {
  SOMEDAY_DETAILS_MAX,
  SOMEDAY_TEXT_MAX,
  moveSomedayItem,
  somedayItemsForVisit,
} from '../../lib/somedayService';
import { SomedayItemModal } from './SomedayItemModal';
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
  somedayError?: string | null;
  onAddSomedayItem?: (text: string, details?: string | null) => Promise<unknown>;
  onUpdateSomedayItem?: (item: SomedayItem, text: string, details: string | null) => Promise<void>;
  onToggleSomedayItem?: (item: SomedayItem) => Promise<void>;
  onDeleteSomedayItem?: (item: SomedayItem) => Promise<void>;
  /** Save the dragged order, ids top to bottom. */
  onReorderSomedayItems?: (orderedIds: string[]) => Promise<void>;
  /** Pin an idea to the couple's next visit. */
  onAddSomedayItemToVisit?: (item: SomedayItem) => Promise<void>;
  /** Take an idea back off the visit it is pinned to. */
  onRemoveSomedayItemFromVisit?: (item: SomedayItem) => Promise<void>;
  /** No visit yet: plan one and pin this idea to it. */
  onPlanSomedayItemVisit?: (item: SomedayItem) => void;
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
  visitItems,
  userName,
  partnerName,
  onViewPlans,
}: {
  visit: Visit;
  visitItems: SomedayItem[];
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
  const isDuringVisit = endDate !== null && today >= startDate && today <= endDate;

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
        <VisitIdeas items={visitItems} />
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
      <VisitIdeas items={visitItems} />
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

function VisitIdeas({ items }: { items: SomedayItem[] }) {
  if (items.length === 0) return null;
  const shown = items.slice(0, 4);
  return (
    <div
      data-visit-ideas
      style={{
        width: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '11px 13px',
        borderRadius: tokens.radii.md,
        backgroundColor: tokens.colors.bgSurfaceSubtle,
        textAlign: 'left',
      }}
    >
      <p
        style={{
          margin: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '5px',
          fontSize: '0.68rem',
          fontWeight: 800,
          letterSpacing: '0.03em',
          textTransform: 'uppercase',
          color: tokens.colors.primaryPinkDeep,
        }}
      >
        <CalendarHeart size={12} aria-hidden="true" />
        What we'll do
      </p>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {shown.map((item) => (
          <li
            key={item.id}
            data-visit-idea={item.id}
            style={{
              fontSize: '0.8rem',
              fontWeight: 600,
              lineHeight: 1.4,
              color: item.completed ? tokens.colors.textMuted : tokens.colors.textPrimary,
              textDecoration: item.completed ? 'line-through' : 'none',
            }}
          >
            • {item.text}
          </li>
        ))}
      </ul>
      {items.length > shown.length && (
        <p style={{ margin: 0, fontSize: '0.7rem', fontWeight: 600, color: tokens.colors.textMuted }}>
          +{items.length - shown.length} more on our someday list
        </p>
      )}
    </div>
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

interface SomedayListProps {
  items: SomedayItem[];
  error: string | null;
  nextVisit: Visit | null;
  onAddItem: (text: string, details?: string | null) => Promise<unknown>;
  onUpdateItem: (item: SomedayItem, text: string, details: string | null) => Promise<void>;
  onToggleItem: (item: SomedayItem) => Promise<void>;
  onDeleteItem: (item: SomedayItem) => Promise<void>;
  onReorderItems: (orderedIds: string[]) => Promise<void>;
  onAddToVisit: (item: SomedayItem) => Promise<void>;
  onRemoveFromVisit: (item: SomedayItem) => Promise<void>;
  onPlanVisit: (item: SomedayItem) => void;
}

function SomedayList({
  items,
  error,
  nextVisit,
  onAddItem,
  onUpdateItem,
  onToggleItem,
  onDeleteItem,
  onReorderItems,
  onAddToVisit,
  onRemoveFromVisit,
  onPlanVisit,
}: SomedayListProps) {
  const [newItemText, setNewItemText] = useState('');
  const [adding, setAdding] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragOrder, setDragOrder] = useState<SomedayItem[] | null>(null);
  const [announcement, setAnnouncement] = useState('');

  // The order the rows are painted in while a drag is happening. The stored list
  // takes over again the moment the pointer lifts.
  const dragOrderRef = useRef<SomedayItem[] | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const completedItems = items.filter((item) => item.completed);
  const activeFromProps = items.filter((item) => !item.completed);
  const activeItems = dragOrder ?? activeFromProps;
  const selected = selectedId ? items.find((item) => item.id === selectedId) ?? null : null;

  // Realtime can replace the stored list at any moment. Never yank the rows out
  // from under an active drag; otherwise follow the server.
  useEffect(() => {
    if (dragIdRef.current === null) {
      dragOrderRef.current = null;
      setDragOrder(null);
    }
  }, [items]);

  useEffect(() => {
    if (selectedId && !items.some((item) => item.id === selectedId)) {
      setSelectedId(null);
    }
  }, [items, selectedId]);

  const handleAdd = async () => {
    if (!newItemText.trim()) return;
    setAdding(true);
    try {
      await onAddItem(newItemText.trim(), null);
      setNewItemText('');
      setAdding(false);
    } catch {
      // The section shows the hook's error; keep what was typed.
      setAdding(false);
    }
  };

  const registerRow = (id: string, element: HTMLDivElement | null) => {
    if (element) rowRefs.current.set(id, element);
    else rowRefs.current.delete(id);
  };

  const commitOrder = (item: SomedayItem, order: SomedayItem[], before: SomedayItem[]) => {
    const ids = order.map((entry) => entry.id);
    if (ids.join('|') === before.map((entry) => entry.id).join('|')) return;
    setAnnouncement(`Moved “${item.text}” to position ${ids.indexOf(item.id) + 1} of ${ids.length}.`);
    void onReorderItems(ids);
  };

  const startDrag = (item: SomedayItem, event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    const initial = itemsRef.current.filter((entry) => !entry.completed);
    dragOrderRef.current = initial;
    dragIdRef.current = item.id;
    setDragOrder(initial);
    setAnnouncement(`Moving “${item.text}”. Release to drop it.`);

    const handleMove = (moveEvent: PointerEvent) => {
      const order = dragOrderRef.current;
      if (!order) return;
      // Measure the rows as they are laid out right now; the first row whose middle
      // the pointer has crossed is the slot the dragged idea wants.
      let target = order.length - 1;
      for (let index = 0; index < order.length; index += 1) {
        const element = rowRefs.current.get(order[index].id);
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        if (moveEvent.clientY < rect.top + rect.height / 2) {
          target = index;
          break;
        }
      }
      const currentIndex = order.findIndex((entry) => entry.id === item.id);
      if (target === currentIndex) return;
      const next = moveSomedayItem(order, item.id, target);
      dragOrderRef.current = next;
      setDragOrder(next);
    };

    const finishDrag = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
      const order = dragOrderRef.current;
      dragIdRef.current = null;
      dragOrderRef.current = null;
      setDragOrder(null);
      if (!order) return;
      if (order.map((entry) => entry.id).join('|') === initial.map((entry) => entry.id).join('|')) {
        setAnnouncement('');
        return;
      }
      commitOrder(item, order, initial);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
  };

  const moveByKeyboard = (item: SomedayItem, direction: -1 | 1) => {
    const order = itemsRef.current.filter((entry) => !entry.completed);
    const index = order.findIndex((entry) => entry.id === item.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= order.length) return;
    const next = moveSomedayItem(order, item.id, target);
    setAnnouncement(`Moved “${item.text}” to position ${target + 1} of ${next.length}.`);
    void onReorderItems(next.map((entry) => entry.id));
  };

  return (
    <section
      data-someday-list
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
        <h2
          style={{
            margin: 0,
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

      {activeItems.length > 0 && (
        <p
          style={{
            margin: '-4px 2px 0',
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            fontSize: '0.72rem',
            lineHeight: 1.5,
            fontWeight: 600,
            color: tokens.colors.textMuted,
          }}
        >
          <GripVertical size={12} aria-hidden="true" />
          {activeItems.length > 1 ? 'Drag the dots to set what matters most. ' : ''}
          Tap an idea for notes (up to {SOMEDAY_DETAILS_MAX.toLocaleString('en-US')} characters).
        </p>
      )}

      {error && (
        <p
          role="alert"
          data-someday-error
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
          {error}
        </p>
      )}

      {/* Screen readers hear where a dragged or nudged idea landed. */}
      <p role="status" aria-live="polite" style={{ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
        {announcement}
      </p>

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
            maxLength={SOMEDAY_TEXT_MAX}
            onChange={(e) => setNewItemText(e.target.value)}
            placeholder="Add something you want to do together..."
            aria-label="A new someday idea"
            style={{
              flex: 1,
              minWidth: 0,
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
            onClick={() => { void handleAdd(); }}
            disabled={!newItemText.trim() || adding}
            aria-label="Add to our someday list"
            style={{
              background: 'none',
              border: 'none',
              color: tokens.colors.primaryPinkDeep,
              cursor: !newItemText.trim() ? 'default' : 'pointer',
              padding: '4px',
              opacity: !newItemText.trim() ? 0.5 : 1,
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
            aria-label="Cancel"
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

      {/* Active items, in the couple's own order */}
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
              canReorder
              dragging={dragIdRef.current === item.id && dragOrder !== null}
              isPinnedToNextVisit={Boolean(nextVisit && item.visit_id === nextVisit.id)}
              registerRow={registerRow}
              onOpen={(entry) => setSelectedId(entry.id)}
              onToggle={onToggleItem}
              onDelete={onDeleteItem}
              onStartDrag={startDrag}
              onMoveByKeyboard={moveByKeyboard}
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
                canReorder={false}
                dragging={false}
                isPinnedToNextVisit={Boolean(nextVisit && item.visit_id === nextVisit.id)}
                registerRow={registerRow}
                onOpen={(entry) => setSelectedId(entry.id)}
                onToggle={onToggleItem}
                onDelete={onDeleteItem}
                onStartDrag={startDrag}
                onMoveByKeyboard={moveByKeyboard}
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

      {selected && (
        <SomedayItemModal
          key={selected.id}
          item={selected}
          visit={nextVisit}
          onClose={() => setSelectedId(null)}
          onSave={onUpdateItem}
          onDelete={onDeleteItem}
          onAddToVisit={onAddToVisit}
          onRemoveFromVisit={onRemoveFromVisit}
          onPlanVisit={(entry) => {
            setSelectedId(null);
            onPlanVisit(entry);
          }}
        />
      )}
    </section>
  );
}

function SomedayItemRow({
  item,
  canReorder,
  dragging,
  isPinnedToNextVisit,
  registerRow,
  onOpen,
  onToggle,
  onDelete,
  onStartDrag,
  onMoveByKeyboard,
}: {
  item: SomedayItem;
  canReorder: boolean;
  dragging: boolean;
  isPinnedToNextVisit: boolean;
  registerRow: (id: string, element: HTMLDivElement | null) => void;
  onOpen: (item: SomedayItem) => void;
  onToggle: (item: SomedayItem) => Promise<void>;
  onDelete: (item: SomedayItem) => Promise<void>;
  onStartDrag: (item: SomedayItem, event: React.PointerEvent<HTMLButtonElement>) => void;
  onMoveByKeyboard: (item: SomedayItem, direction: -1 | 1) => void;
}) {
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!window.confirm(`Delete “${item.text}”?`)) return;
    setDeleting(true);
    try {
      await onDelete(item);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      ref={(element) => registerRow(item.id, element)}
      data-someday-item={item.id}
      data-someday-dragging={dragging ? 'true' : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '7px',
        padding: canReorder ? '8px 10px 8px 3px' : '10px 14px',
        borderRadius: tokens.radii.md,
        backgroundColor: dragging ? tokens.colors.accentLavenderSoft : tokens.colors.bgSurface,
        border: `1.5px solid ${dragging ? tokens.colors.accentLavender : 'transparent'}`,
        boxShadow: dragging ? tokens.shadows.soft : tokens.shadows.card,
        transition: 'background-color 0.15s ease, border-color 0.15s ease',
      }}
    >
      {canReorder && (
        <button
          type="button"
          data-someday-grip
          aria-label={`Reorder “${item.text}”. Use the up and down arrow keys.`}
          title="Drag to reorder"
          onPointerDown={(event) => onStartDrag(item, event)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              onMoveByKeyboard(item, -1);
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              onMoveByKeyboard(item, 1);
            }
          }}
          style={{
            flexShrink: 0,
            padding: '6px 2px',
            background: 'none',
            border: 'none',
            color: tokens.colors.textMuted,
            cursor: dragging ? 'grabbing' : 'grab',
            touchAction: 'none',
            lineHeight: 0,
          }}
        >
          <GripVertical size={17} aria-hidden="true" />
        </button>
      )}

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

      <button
        type="button"
        data-someday-open={item.id}
        onClick={() => onOpen(item)}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '3px',
          alignItems: 'flex-start',
          padding: '3px 0',
          background: 'none',
          border: 'none',
          textAlign: 'left',
          fontFamily: tokens.typography.fontFamily,
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            maxWidth: '100%',
            overflowWrap: 'anywhere',
            fontSize: '0.88rem',
            fontWeight: 600,
            color: item.completed ? tokens.colors.textMuted : tokens.colors.textPrimary,
            textDecoration: item.completed ? 'line-through' : 'none',
            textDecorationColor: tokens.colors.textMuted,
          }}
        >
          {item.text}
        </span>
        {(item.details || isPinnedToNextVisit) && (
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '4px 6px',
              maxWidth: '100%',
            }}
          >
            {item.details && (
              <span
                data-someday-detail-preview
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  maxWidth: '100%',
                  fontSize: '0.72rem',
                  fontWeight: 600,
                  color: tokens.colors.textMuted,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                }}
              >
                <StickyNote size={11} aria-hidden="true" style={{ flexShrink: 0 }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.details}</span>
              </span>
            )}
            {isPinnedToNextVisit && (
              <span
                data-someday-pinned
                style={{
                  flexShrink: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '3px',
                  padding: '2px 7px',
                  borderRadius: tokens.radii.pill,
                  backgroundColor: tokens.colors.primaryPinkSoft,
                  color: tokens.colors.primaryPinkDeep,
                  fontSize: '0.64rem',
                  fontWeight: 800,
                  whiteSpace: 'nowrap',
                }}
              >
                <CalendarHeart size={10} aria-hidden="true" />
                Next visit
              </span>
            )}
          </span>
        )}
      </button>

      <button
        type="button"
        onClick={() => { void handleDelete(); }}
        disabled={deleting}
        style={{
          background: 'none',
          border: 'none',
          color: tokens.colors.textMuted,
          cursor: 'pointer',
          padding: '4px',
          flexShrink: 0,
        }}
        aria-label={`Delete “${item.text}”`}
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
  somedayError = null,
  onAddSomedayItem,
  onUpdateSomedayItem,
  onToggleSomedayItem,
  onDeleteSomedayItem,
  onReorderSomedayItems,
  onAddSomedayItemToVisit,
  onRemoveSomedayItemFromVisit,
  onPlanSomedayItemVisit,
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
          <VisitCard
            visit={visit}
            visitItems={somedayItemsForVisit(somedayItems, visit.id)}
            userName={userName}
            partnerName={partnerName}
            onViewPlans={onViewVisitPlans || (() => {})}
          />
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
        {onAddSomedayItem &&
        onUpdateSomedayItem &&
        onToggleSomedayItem &&
        onDeleteSomedayItem &&
        onReorderSomedayItems &&
        onAddSomedayItemToVisit &&
        onRemoveSomedayItemFromVisit ? (
          <SomedayList
            items={somedayItems}
            error={somedayError}
            nextVisit={visit ?? null}
            onAddItem={onAddSomedayItem}
            onUpdateItem={onUpdateSomedayItem}
            onToggleItem={onToggleSomedayItem}
            onDeleteItem={onDeleteSomedayItem}
            onReorderItems={onReorderSomedayItems}
            onAddToVisit={onAddSomedayItemToVisit}
            onRemoveFromVisit={onRemoveSomedayItemFromVisit}
            onPlanVisit={onPlanSomedayItemVisit ?? (() => onPlanVisit?.())}
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
