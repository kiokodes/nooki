import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/TextLayer.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import { tokens } from '../../tokens/designTokens';
import type { Highlight } from '../../types/database';
import type { EngineSelection } from './EpubReader';

/**
 * The PDF engine: react-pdf renders one page at a time over a text layer the couple
 * can select from.
 *
 * PDF highlighting is the weaker half of the feature on purpose: a highlight stores
 * the page plus the selection's rectangles (as fractions of the page box), which
 * paints fine at any zoom but is not a text anchor the way an EPUB CFI is. And a
 * scanned PDF has NO selectable text — nothing to highlight — so the reader says so
 * instead of pretending.
 *
 * Progress is a page number (`page:12`), which is all a PDF has to offer.
 */

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export interface PdfEngineSelection extends EngineSelection {
  /** `page:N`, matching every location this engine reports. */
  location: string;
  /** Fractions (0..1) of the page box, ready to paint at any width. */
  rects: Array<{ x: number; y: number; w: number; h: number }>;
}

interface PdfReaderProps {
  bytes: ArrayBuffer;
  /** `page:N` to open at first — a chat jump or the partner's place. */
  initialLocation: string | null;
  highlights: Highlight[];
  myUserId: string;
  jump: { location: string; nonce: number } | null;
  onLocationChange: (location: string, percent: number) => void;
  onSelection: (selection: PdfEngineSelection) => void;
  /** Tap the middle of the page: show or hide the reader's bars. */
  onToggleChrome: () => void;
  onReady?: () => void;
  onError: (message: string) => void;
}

const HIGHLIGHT_INK = {
  rose: tokens.highlightInk.rose,
  sage: tokens.highlightInk.sage,
} as const;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function pageFromLocation(location: string | null | undefined): number | null {
  const match = /^page:(\d+)$/.exec(location ?? '');
  return match ? Number(match[1]) : null;
}

/** The rendered page's box inside the scroll container, or null before layout. */
function measurePageBox(container: HTMLElement | null): Box | null {
  const pageEl = container?.querySelector('.react-pdf__Page');
  const wrapper = container;
  if (!pageEl || !wrapper) return null;
  const page = pageEl.getBoundingClientRect();
  const host = wrapper.getBoundingClientRect();
  return {
    left: page.left - host.left,
    top: page.top - host.top,
    width: page.width,
    height: page.height,
  };
}

/** Rectangles of the current selection as fractions of the rendered page box. */
function readSelection(pageEl: Element, pageNumber: number): PdfEngineSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return null;
  const quoteText = selection.toString().trim();
  if (!quoteText) return null;

  const box = pageEl.getBoundingClientRect();
  const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
  const range = selection.getRangeAt(0);
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width < 1 || rect.height < 1) continue;
    // Keep only the part of a multi-page selection that sits on this page.
    const clipped = {
      left: Math.max(rect.left, box.left),
      top: Math.max(rect.top, box.top),
      right: Math.min(rect.right, box.right),
      bottom: Math.min(rect.bottom, box.bottom),
    };
    if (clipped.right - clipped.left < 1 || clipped.bottom - clipped.top < 1) continue;
    rects.push({
      x: (clipped.left - box.left) / (box.width || 1),
      y: (clipped.top - box.top) / (box.height || 1),
      w: (clipped.right - clipped.left) / (box.width || 1),
      h: (clipped.bottom - clipped.top) / (box.height || 1),
    });
  }
  if (!rects.length) return null;

  return {
    location: `page:${pageNumber}`,
    quoteText: quoteText.slice(0, 2000),
    rects,
  };
}

export const PdfReader: React.FC<PdfReaderProps> = ({
  bytes,
  initialLocation,
  highlights,
  myUserId,
  jump,
  onLocationChange,
  onSelection,
  onToggleChrome,
  onReady,
  onError,
}) => {
  // pdf.js takes ownership of the buffer it is given (it detaches it), so every
  // mount gets its own copy of the cached bytes.
  const fileData = useMemo(() => bytes.slice(0), [bytes]);
  const [numPages, setNumPages] = useState(0);
  const [pageNumber, setPageNumber] = useState(() => {
    const start = pageFromLocation(initialLocation);
    return start && start > 0 ? start : 1;
  });
  const [hasSelectableText, setHasSelectableText] = useState<boolean | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [pageWidth, setPageWidth] = useState(320);
  const [pageBox, setPageBox] = useState<Box | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  const handlersRef = useRef({ onLocationChange, onSelection, onToggleChrome, onError, onReady });
  useEffect(() => {
    handlersRef.current = { onLocationChange, onSelection, onToggleChrome, onError, onReady };
  });

  const remeasure = useCallback(() => {
    setPageBox(measurePageBox(containerRef.current));
    const el = containerRef.current;
    if (el) setPageWidth(Math.max(200, el.clientWidth - 8));
  }, []);

  // --- Container width and page box: pages fit the phone exactly --------------------
  useLayoutEffect(() => {
    remeasure();
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(remeasure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [remeasure, pageNumber, numPages]);

  // --- Report the place in the book --------------------------------------------------
  useEffect(() => {
    if (!numPages) return;
    handlersRef.current.onLocationChange(
      `page:${pageNumber}`,
      Math.round((pageNumber / numPages) * 100),
    );
  }, [numPages, pageNumber]);

  // --- Jump: partner's bookmark or a chat quote --------------------------------------
  useEffect(() => {
    if (!jump || !numPages) return;
    const target = pageFromLocation(jump.location);
    if (!target || target < 1 || target > numPages) return;
    // Deferred one tick: a jump is a new page request, not a cascade off this render.
    const timer = window.setTimeout(() => setPageNumber(target), 0);
    return () => window.clearTimeout(timer);
  }, [jump, numPages]);

  const handleDocumentLoad = useCallback(async (pdf: {
    numPages: number;
    getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }>;
  }) => {
    setNumPages(pdf.numPages);
    // A scanned PDF has an empty text layer: no selection, no highlighting. Saying
    // so beats a highlight button that silently does nothing.
    try {
      const page = await pdf.getPage(1);
      const content = await page.getTextContent();
      setHasSelectableText(content.items.length > 0);
    } catch {
      setHasSelectableText(true);
    }
    handlersRef.current.onReady?.();
    // Open past the end (a jump to a longer copy): clamp instead of crashing.
    setPageNumber((current) => Math.min(Math.max(1, current), pdf.numPages));
    window.setTimeout(remeasure, 50);
  }, [remeasure]);

  const goPrev = () => setPageNumber((current) => Math.max(1, current - 1));
  const goNext = () => setPageNumber((current) => Math.min(numPages || 1, current + 1));

  const handleWrapperClick = (event: React.MouseEvent<HTMLDivElement>) => {
    // A tap that finished selecting text belongs to highlighting.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return;
    const x = (event.clientX - box.left) / box.width;
    if (x < 0.18) goPrev();
    else if (x > 0.82) goNext();
    else handlersRef.current.onToggleChrome();
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    touchStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  };

  const handleTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const start = touchStart.current;
    touchStart.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.6) {
      if (dx < 0) goNext();
      else goPrev();
    }
  };

  const handleWrapperMouseUp = () => {
    // Give the browser a tick to settle the selection range before reading it.
    window.setTimeout(() => {
      const pageEl = containerRef.current?.querySelector('.react-pdf__Page');
      const box = pageBox ?? measurePageBox(containerRef.current);
      if (!pageEl || !box) return;
      const picked = readSelection(pageEl, pageNumber);
      if (picked) handlersRef.current.onSelection(picked);
    }, 10);
  };

  const pageHighlights = highlights.filter((highlight) => pageFromLocation(highlight.location) === pageNumber);

  return (
    <div
      data-pdf-holder
      ref={containerRef}
      onClick={handleWrapperClick}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onMouseUp={handleWrapperMouseUp}
      style={{
        width: '100%',
        height: '100%',
        overflowY: 'auto',
        overflowX: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        touchAction: 'pan-y',
      }}
    >
      <div style={{ position: 'relative', margin: '0 auto' }}>
        <Document
          file={fileData}
          onLoadSuccess={handleDocumentLoad}
          onLoadError={(error: Error) => handlersRef.current.onError(
            `This PDF could not be opened. ${error.message}`,
          )}
          loading={
            <p style={{ color: tokens.colors.textSecondary, fontSize: '0.85rem', padding: '40px 0' }}>
              Opening the pages…
            </p>
          }
          error={
            <p role="alert" style={{ color: tokens.colors.primaryPinkDeep, fontSize: '0.85rem', padding: '40px 0' }}>
              This PDF could not be opened.
            </p>
          }
        >
          <Page
            pageNumber={pageNumber}
            width={pageWidth}
            renderAnnotationLayer={false}
            canvasBackground={tokens.colors.bgSurface}
          />
        </Document>

        {/* The couple's highlights, painted over the page from stored rectangles. */}
        {pageBox && pageHighlights.map((highlight) => {
          const rects = Array.isArray(highlight.rects)
            ? (highlight.rects as Array<{ x: number; y: number; w: number; h: number }>)
            : [];
          const ink = highlight.user_id === myUserId ? 'rose' : 'sage';
          return rects.map((rect, index) => (
            <div
              key={`${highlight.id}-${index}`}
              data-pdf-highlight={highlight.id}
              style={{
                position: 'absolute',
                left: pageBox.left + rect.x * pageBox.width,
                top: pageBox.top + rect.y * pageBox.height,
                width: rect.w * pageBox.width,
                height: rect.h * pageBox.height,
                backgroundColor: HIGHLIGHT_INK[ink],
                opacity: 0.3,
                borderRadius: '3px',
                pointerEvents: 'none',
              }}
            />
          ));
        })}
      </div>

      {hasSelectableText === false && (
        <p
          data-pdf-no-text
          role="status"
          style={{
            margin: '10px 16px 24px',
            padding: '10px 14px',
            borderRadius: tokens.radii.md,
            backgroundColor: tokens.colors.bgSurfaceSubtle,
            color: tokens.colors.textSecondary,
            fontSize: '0.78rem',
            fontWeight: 600,
            lineHeight: 1.5,
            textAlign: 'center',
          }}
        >
          This PDF has no selectable text (it looks like a scan), so highlighting won't
          work here. Reading together and jumping to each other still do.
        </p>
      )}
    </div>
  );
};

export default PdfReader;
