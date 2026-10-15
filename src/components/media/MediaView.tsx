import React, { useRef, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  Clock,
  Play,
  Plus,
  Trash2,
  Upload,
  UserRound,
} from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { MAX_BOOKS_ON_SHELF, SHELF_FULL_HELP, isBookFileType } from '../../lib/booksService';
import type { BooksState } from '../../hooks/useBooks';
import type { SharedBook } from '../../types/database';

/**
 * The Media tab's "Read together" shelf card.
 *
 * States, in the order the couple meets them:
 *   - nothing on the shelf: "Read together" with an Upload book button;
 *   - a book in play: "Currently reading together" with the title, both people's
 *     progress and Continue reading;
 *   - a paused (left) or finished book: kept on the shelf with Continue, Delete
 *     and Upload new.
 *
 * A second active book is refused here and in the database: tapping upload while
 * one is reading says "Leave or delete current book first."
 */

interface MediaViewProps {
  state: BooksState;
  userId: string;
  userName: string;
  partnerName: string;
  /** Open the full-screen reader on this book. */
  onOpenReader: (bookId: string) => void;
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

export const MediaView: React.FC<MediaViewProps> = ({
  state,
  userId,
  userName,
  partnerName,
  onOpenReader,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const activeBook = state.books.find((book) => book.status === 'reading') ?? null;
  const pausedBooks = state.books.filter((book) => book.status !== 'reading');
  const shelfFull = state.books.length >= MAX_BOOKS_ON_SHELF;

  const openPicker = () => {
    // The two-book shelf limit: a disciplined reading habit.
    if (shelfFull) {
      setNotice(SHELF_FULL_HELP);
      return;
    }
    setNotice(null);
    fileInputRef.current?.click();
  };

  const handlePicked = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // The input value is reset so picking the same file twice fires every time.
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
      data-screen="media"
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
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
          data-media-notice
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
  );
};

export default MediaView;
