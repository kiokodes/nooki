import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import {
  BookOpen,
  Bookmark,
  CheckCircle2,
  LogOut,
  MoreVertical,
  Send,
  X,
} from 'lucide-react';
import { tokens } from '../../tokens/designTokens';
import { fetchBookBytes } from '../../lib/booksService';
import type { Highlight, ReadingProgress, SharedBook } from '../../types/database';
import type { EngineSelection } from './EpubReader';

// The engines (epub.js, pdf.js) are the bulk of the reader's weight. They load on
// demand, the first time a book actually opens — never on the way to the Media tab.
const EpubReader = lazy(() => import('./EpubReader'));
const PdfReader = lazy(() => import('./PdfReader'));

/**
 * The full-screen reader shell, for EPUB and PDF alike.
 *
 * Chrome rules: the reader hides all of its bars and the tap zones run the book —
 * tap the middle to show or hide the top and bottom bars, tap the edges (or swipe)
 * to turn pages. The bars carry only what the couple needs while reading: the
 * title, where each of them is, "Jump to {partner}", and the Leave / Finish menu.
 *
 * Progress is saved on a debounce of a few seconds — never on every page turn —
 * and selecting text opens the small comment box that creates a highlight AND
 * sends it to the chat in one go.
 */

/** Progress saves land a few seconds after the page turns, not on every turn. */
export const PROGRESS_SAVE_DEBOUNCE_MS = 3000;

/**
 * Error boundary wrapping the reader engine so a crash in epub.js or pdf.js shows
 * a friendly "Back to the shelf" button instead of a blank white screen.
 */
interface EngineErrorBoundaryProps {
  children: ReactNode;
  onClose: () => void;
}

interface EngineErrorBoundaryState {
  hasError: boolean;
  message: string;
}

class EngineErrorBoundary extends Component<EngineErrorBoundaryProps, EngineErrorBoundaryState> {
  state: EngineErrorBoundaryState = { hasError: false, message: '' };

  static getDerivedStateFromError(error: unknown): Partial<EngineErrorBoundaryState> {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : 'Something went wrong opening this book.',
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // In production this would go to a logging service.
    console.error('[ReaderView] Engine error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            padding: '24px',
            textAlign: 'center',
          }}
        >
          <p role="alert" style={{ color: tokens.colors.primaryPinkDeep, fontWeight: 700, fontSize: '0.9rem' }}>
            This book could not be opened. {this.state.message}
          </p>
          <button
            type="button"
            onClick={this.props.onClose}
            style={{
              padding: '10px 22px',
              borderRadius: tokens.radii.pill,
              border: 'none',
              backgroundColor: tokens.colors.primaryGreenDeep,
              color: tokens.colors.textWhite,
              fontWeight: 800,
              fontFamily: tokens.typography.fontFamily,
              cursor: 'pointer',
            }}
          >
            Back to the shelf
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export interface ShareHighlightInput extends EngineSelection {
  /** PDF rectangles as fractions of the page box; undefined for EPUB. */
  rects?: unknown;
}

interface ReaderViewProps {
  book: SharedBook;
  userId: string;
  userName: string;
  partnerName: string;
  /** This phone's saved place, so Continue reading continues. */
  myProgress: ReadingProgress | null;
  /** The partner's saved place — the target of "Jump to {partner}". */
  partnerProgress: ReadingProgress | null;
  /** Highlights belonging to this book (both people's). */
  highlights: Highlight[];
  /**
   * Where to open: the partner's place, a highlight's place (a chat quote), or
   * just this phone's own saved place.
   */
  initialJump: 'partner' | { location: string } | null;
  onSaveProgress: (location: string, percent: number) => void;
  /** Creates the highlight and sends the chat message. */
  onShareHighlight: (input: ShareHighlightInput, comment: string) => Promise<void>;
  onLeave: () => Promise<void>;
  onFinish: () => Promise<void>;
  onClose: () => void;
}

type PendingSelection = ShareHighlightInput;

export const ReaderView: React.FC<ReaderViewProps> = ({
  book,
  userId,
  userName,
  partnerName,
  myProgress,
  partnerProgress,
  highlights,
  initialJump,
  onSaveProgress,
  onShareHighlight,
  onLeave,
  onFinish,
  onClose,
}) => {
  const [chromeVisible, setChromeVisible] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [percent, setPercent] = useState(myProgress?.percent ?? 0);
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [comment, setComment] = useState('');
  const [sharing, setSharing] = useState(false);
  const [jump, setJump] = useState<{ location: string; nonce: number } | null>(null);
  const jumpNonce = useRef(0);

  // Open exactly once: Continue reading resumes this phone's place, a chat quote
  // jumps to the highlight, and "Jump to {partner}" opens on theirs.
  const [startLocation] = useState<string | null>(() => {
    if (initialJump === 'partner') return partnerProgress?.location ?? null;
    if (initialJump && typeof initialJump === 'object') return initialJump.location;
    return myProgress?.location ?? null;
  });

  // --- Debounced progress saves ------------------------------------------------------
  const pendingSave = useRef<{ location: string; percent: number } | null>(null);
  const saveTimer = useRef<number | null>(null);
  const saveRef = useRef(onSaveProgress);
  useEffect(() => {
    saveRef.current = onSaveProgress;
  });

  const flushProgress = useCallback(() => {
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const snapshot = pendingSave.current;
    pendingSave.current = null;
    if (snapshot) saveRef.current(snapshot.location, snapshot.percent);
  }, []);

  useEffect(() => flushProgress, [flushProgress]);

  const handleLocationChange = useCallback((location: string, nextPercent: number) => {
    setPercent(nextPercent);
    pendingSave.current = { location, percent: nextPercent };
    if (saveTimer.current !== null) return;
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      const snapshot = pendingSave.current;
      pendingSave.current = null;
      if (snapshot) saveRef.current(snapshot.location, snapshot.percent);
    }, PROGRESS_SAVE_DEBOUNCE_MS);
  }, []);

  // --- The file, downloaded once and cached -----------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchBookBytes(book.file_path);
        if (!cancelled) {
          setLoadError(null);
          setBytes(data);
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'The book file could not be downloaded.');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [book.file_path]);

  // --- Keyboard: Escape backs out one layer ------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (pending) {
        setPending(null);
        setComment('');
      } else if (menuOpen) {
        setMenuOpen(false);
      } else {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen, onClose, pending]);

  const handleSelection = useCallback((selection: PendingSelection) => {
    setMenuOpen(false);
    setPending(selection);
    setComment('');
  }, []);

  const handleShare = async () => {
    if (!pending || sharing) return;
    setSharing(true);
    try {
      await onShareHighlight(pending, comment);
      setPending(null);
      setComment('');
    } catch {
      // The error surfaces through the shared book state; keep the box open so the
      // comment is not lost.
    } finally {
      setSharing(false);
    }
  };

  const jumpToPartner = useCallback(() => {
    if (!partnerProgress?.location) return;
    jumpNonce.current += 1;
    setJump({ location: partnerProgress.location, nonce: jumpNonce.current });
    setMenuOpen(false);
    setChromeVisible(true);
  }, [partnerProgress]);

  const handleLeave = async () => {
    setMenuOpen(false);
    flushProgress();
    await onLeave();
    onClose();
  };

  const handleFinish = async () => {
    setMenuOpen(false);
    flushProgress();
    await onFinish();
    onClose();
  };

  const myInk = tokens.highlightInk.rose;
  const partnerInk = tokens.highlightInk.sage;

  const engine = useMemo(() => {
    if (!bytes) return null;
    const shared = {
      bytes,
      initialLocation: startLocation,
      jump,
      onLocationChange: handleLocationChange,
      onToggleChrome: () => setChromeVisible((visible) => !visible),
      onError: (message: string) => setLoadError(message),
    };
    return (
      <Suspense
        fallback={
          <div
            style={{
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '10px',
            }}
          >
            <BookOpen size={30} color={tokens.colors.primaryGreenDeep} aria-hidden="true" />
            <p style={{ color: tokens.colors.textSecondary, fontSize: '0.85rem', fontWeight: 600 }}>
              Opening the book…
            </p>
          </div>
        }
      >
        {book.file_type === 'epub' ? (
          <EpubReader
            {...shared}
            highlights={highlights}
            myUserId={userId}
            onSelection={handleSelection}
          />
        ) : (
          <PdfReader
            {...shared}
            highlights={highlights}
            myUserId={userId}
            onSelection={handleSelection}
          />
        )}
      </Suspense>
    );
  }, [bytes, book.file_type, handleLocationChange, handleSelection, highlights, jump, startLocation, userId]);

  return (
    <section
      data-screen="reader"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 30,
        backgroundColor: tokens.colors.bgCanvas,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* The pages fill the screen; bars float over them. */}
      <div style={{ position: 'absolute', inset: 0, paddingTop: '0px' }}>
        {loadError && (
          <div
            style={{
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px',
              padding: '24px',
              textAlign: 'center',
            }}
          >
            <p role="alert" style={{ color: tokens.colors.primaryPinkDeep, fontWeight: 700, fontSize: '0.9rem' }}>
              {loadError}
            </p>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '10px 22px',
                borderRadius: tokens.radii.pill,
                border: 'none',
                backgroundColor: tokens.colors.primaryGreenDeep,
                color: tokens.colors.textWhite,
                fontWeight: 800,
                fontFamily: tokens.typography.fontFamily,
                cursor: 'pointer',
              }}
            >
              Back to the shelf
            </button>
          </div>
        )}
        {!loadError && !bytes && (
          <div
            style={{
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '10px',
            }}
          >
            <BookOpen size={30} color={tokens.colors.primaryGreenDeep} aria-hidden="true" />
            <p style={{ color: tokens.colors.textSecondary, fontSize: '0.85rem', fontWeight: 600 }}>
              Downloading the book…
            </p>
            <p style={{ color: tokens.colors.textMuted, fontSize: '0.72rem', maxWidth: '230px', textAlign: 'center', margin: 0 }}>
              The first open downloads the whole file; after that it opens from this phone's cache.
            </p>
          </div>
        )}
        <EngineErrorBoundary onClose={onClose}>
          {engine}
        </EngineErrorBoundary>
      </div>

      {/* Top bar: out of the way until the middle of the page is tapped. */}
      <header
        data-reader-chrome="top"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '12px 12px 14px',
          paddingTop: 'calc(12px + env(safe-area-inset-top, 0px))',
          backgroundColor: 'rgba(250, 246, 238, 0.94)',
          borderBottom: `1px solid ${tokens.colors.borderSubtle}`,
          transform: chromeVisible ? 'translateY(0)' : 'translateY(-110%)',
          transition: 'transform 0.22s ease',
          pointerEvents: chromeVisible ? 'auto' : 'none',
        }}
      >
        <button
          type="button"
          aria-label="Close the book"
          onClick={onClose}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '34px',
            height: '34px',
            borderRadius: tokens.radii.full,
            border: 'none',
            backgroundColor: tokens.colors.bgSurface,
            color: tokens.colors.textPrimary,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <X size={17} />
        </button>
        <div style={{ flex: 1, minWidth: 0, textAlign: 'center' }}>
          <div
            data-reader-title
            style={{
              fontSize: '0.82rem',
              fontWeight: 800,
              color: tokens.colors.textPrimary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {book.title}
          </div>
          <div style={{ fontSize: '0.66rem', color: tokens.colors.textMuted, fontWeight: 600 }}>
            {percent}% through
          </div>
        </div>
        <button
          type="button"
          aria-label="Book menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '34px',
            height: '34px',
            borderRadius: tokens.radii.full,
            border: 'none',
            backgroundColor: tokens.colors.bgSurface,
            color: tokens.colors.textPrimary,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <MoreVertical size={17} />
        </button>

        {menuOpen && (
          <div
            data-reader-menu
            role="menu"
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              right: '10px',
              width: '210px',
              backgroundColor: tokens.colors.bgSurface,
              borderRadius: tokens.radii.md,
              boxShadow: tokens.shadows.soft,
              border: `1px solid ${tokens.colors.borderSubtle}`,
              overflow: 'hidden',
              zIndex: 5,
            }}
          >
            <button
              type="button"
              role="menuitem"
              data-finish-book
              onClick={handleFinish}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '9px',
                width: '100%',
                padding: '12px 14px',
                border: 'none',
                borderBottom: `1px solid ${tokens.colors.borderSubtle}`,
                backgroundColor: 'transparent',
                color: tokens.colors.textPrimary,
                fontSize: '0.82rem',
                fontWeight: 700,
                fontFamily: tokens.typography.fontFamily,
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <CheckCircle2 size={15} color={tokens.colors.primaryGreenDeep} aria-hidden="true" />
              Mark as finished
            </button>
            <button
              type="button"
              role="menuitem"
              data-leave-book
              onClick={handleLeave}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '9px',
                width: '100%',
                padding: '12px 14px',
                border: 'none',
                backgroundColor: 'transparent',
                color: tokens.colors.primaryPinkDeep,
                fontSize: '0.82rem',
                fontWeight: 700,
                fontFamily: tokens.typography.fontFamily,
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <LogOut size={15} aria-hidden="true" />
              Leave book (pause)
            </button>
          </div>
        )}
      </header>

      {/* Bottom bar: both places in the book, and the jump. */}
      <footer
        data-reader-chrome="bottom"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '12px 14px',
          paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
          backgroundColor: 'rgba(250, 246, 238, 0.94)',
          borderTop: `1px solid ${tokens.colors.borderSubtle}`,
          transform: chromeVisible ? 'translateY(0)' : 'translateY(110%)',
          transition: 'transform 0.22s ease',
          pointerEvents: chromeVisible ? 'auto' : 'none',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.72rem', fontWeight: 700, color: tokens.colors.textSecondary }}>
            <span aria-hidden="true" style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: myInk }} />
            {userName}: {percent}%
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '0.72rem', fontWeight: 700, color: tokens.colors.textSecondary }}>
            <span aria-hidden="true" style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: partnerInk }} />
            {partnerName}: {partnerProgress?.percent ?? 0}%
          </span>
        </div>
        <button
          type="button"
          data-jump-partner
          disabled={!partnerProgress?.location}
          onClick={jumpToPartner}
          title={partnerProgress?.location ? `Jump to where ${partnerName} is reading` : `${partnerName} has not opened this book yet`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '10px 14px',
            borderRadius: tokens.radii.pill,
            border: 'none',
            backgroundColor: partnerProgress?.location ? tokens.colors.accentSageDeep : tokens.colors.bgSurfaceSubtle,
            color: partnerProgress?.location ? tokens.colors.textWhite : tokens.colors.textMuted,
            fontSize: '0.78rem',
            fontWeight: 800,
            fontFamily: tokens.typography.fontFamily,
            cursor: partnerProgress?.location ? 'pointer' : 'default',
            whiteSpace: 'nowrap',
          }}
        >
          <Bookmark size={14} aria-hidden="true" />
          Jump to {partnerName}
        </button>
      </footer>

      {/* The small box: an optional comment, then the highlight goes to the chat. */}
      {pending && (
        <div
          data-highlight-box
          role="dialog"
          aria-label="Add a comment to this highlight"
          style={{
            position: 'absolute',
            left: '12px',
            right: '12px',
            bottom: chromeVisible ? '86px' : '18px',
            backgroundColor: tokens.colors.bgSurface,
            borderRadius: tokens.radii.lg,
            boxShadow: tokens.shadows.card,
            border: `1px solid ${tokens.colors.borderSubtle}`,
            padding: '14px',
            zIndex: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            transition: 'bottom 0.22s ease',
          }}
        >
          <div
            data-highlight-quote
            style={{
              fontSize: '0.8rem',
              fontStyle: 'italic',
              lineHeight: 1.5,
              color: tokens.colors.textPrimary,
              borderLeft: `3px solid ${tokens.highlightInk.rose}`,
              paddingLeft: '9px',
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            “{pending.quoteText}”
          </div>
          <textarea
            data-highlight-comment
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="Say something about it (optional)"
            rows={2}
            maxLength={2000}
            style={{
              resize: 'none',
              borderRadius: tokens.radii.sm,
              border: `1px solid ${tokens.colors.borderSoft}`,
              padding: '9px 11px',
              fontSize: '0.84rem',
              fontFamily: tokens.typography.fontFamily,
              color: tokens.colors.textPrimary,
              backgroundColor: tokens.colors.bgSurfaceSubtle,
              outline: 'none',
            }}
          />
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              onClick={() => {
                setPending(null);
                setComment('');
              }}
              style={{
                flex: 1,
                padding: '10px 12px',
                borderRadius: tokens.radii.pill,
                border: `1.5px solid ${tokens.colors.borderSoft}`,
                backgroundColor: tokens.colors.bgSurface,
                color: tokens.colors.textSecondary,
                fontSize: '0.82rem',
                fontWeight: 700,
                fontFamily: tokens.typography.fontFamily,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              data-highlight-share
              disabled={sharing}
              onClick={handleShare}
              style={{
                flex: 2,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
                padding: '10px 12px',
                borderRadius: tokens.radii.pill,
                border: 'none',
                backgroundColor: tokens.colors.primaryGreenDeep,
                color: tokens.colors.textWhite,
                fontSize: '0.82rem',
                fontWeight: 800,
                fontFamily: tokens.typography.fontFamily,
                cursor: sharing ? 'default' : 'pointer',
                opacity: sharing ? 0.6 : 1,
              }}
            >
              <Send size={13} aria-hidden="true" />
              {sharing ? 'Sharing…' : 'Highlight & share'}
            </button>
          </div>
          <p style={{ margin: 0, fontSize: '0.68rem', color: tokens.colors.textMuted, fontWeight: 600, textAlign: 'center' }}>
            The highlight appears in the book for both of you and goes to your chat.
          </p>
        </div>
      )}
    </section>
  );
};

export default ReaderView;
