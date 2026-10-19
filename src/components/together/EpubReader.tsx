import React, { useEffect, useRef, useState } from 'react';
import ePub from 'epubjs';
import type { Book, Contents, Rendition } from 'epubjs';
import { tokens } from '../../tokens/designTokens';
import type { Highlight } from '../../types/database';

/**
 * The EPUB engine: epub.js renders the book paginated inside the reader shell.
 *
 * The engine owns only the format — page turns, the current CFI/percent, painting
 * the couple's two-colour highlights, and reporting a text selection so the shell
 * can ask for a comment. Progress saving, the comment box and all chrome live in
 * ReaderView.
 *
 * epub.js gives every book CFIs (canonical fragment identifiers): a stable address
 * for a passage that survives reflow, which is exactly what highlights and "Jump to
 * partner" store.
 */

export interface EngineSelection {
  /** The CFI range of the highlighted passage. */
  location: string;
  quoteText: string;
}

interface EpubReaderProps {
  bytes: ArrayBuffer;
  /** CFI to open at first — a chat jump or the partner's place. */
  initialLocation: string | null;
  highlights: Highlight[];
  myUserId: string;
  /** Bump the nonce to jump the rendition to `location`. */
  jump: { location: string; nonce: number } | null;
  onLocationChange: (location: string, percent: number) => void;
  onSelection: (selection: EngineSelection) => void;
  /** Tap the middle of the page: show or hide the reader's bars. */
  onToggleChrome: () => void;
  onReady?: () => void;
  onError: (message: string) => void;
}

/** How finely the book is sliced for percentage progress. */
const LOCATIONS_CHARS = 1200;

/**
 * epubjs never settles `book.ready` when an archive cannot be opened —
 * its open() rejection only emits `book:openFailed` — so a corrupt or
 * truncated file (or a poisoned cache entry) would otherwise leave the
 * reader blank forever. The open steps are raced against this timeout
 * as the backstop that always says something.
 */
const OPEN_TIMEOUT_MS = 15000;

const OPEN_TIMEOUT_HELP = 'The book took too long to open. The file may be corrupted — try uploading it again.';

/** Settles with the promise's result, or rejects with a readable error. */
function openWithin<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), OPEN_TIMEOUT_MS);
    promise.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error) => { window.clearTimeout(timer); reject(error); },
    );
  });
}

const HIGHLIGHT_STYLES = {
  rose: { fill: tokens.highlightInk.rose, 'fill-opacity': '0.28', 'mix-blend-mode': 'multiply' },
  sage: { fill: tokens.highlightInk.sage, 'fill-opacity': '0.28', 'mix-blend-mode': 'multiply' },
} as const;

export const EpubReader: React.FC<EpubReaderProps> = ({
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
  const holderRef = useRef<HTMLDivElement | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const bookRef = useRef<Book | null>(null);
  const appliedHighlights = useRef<Set<string>>(new Set());
  // Read inside epub callbacks that outlive a render.
  const handlersRef = useRef({ onLocationChange, onSelection, onToggleChrome, onError, onReady });
  useEffect(() => {
    handlersRef.current = { onLocationChange, onSelection, onToggleChrome, onError, onReady };
  });
  // The open-at location is read once, at mount: Continue reading continues.
  const initialLocationRef = useRef(initialLocation);
  const [ready, setReady] = useState(false);

  // --- Set the book up once per file ------------------------------------------------
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    let cancelled = false;
    const book = ePub(bytes.slice(0));
    bookRef.current = book;
    appliedHighlights.current = new Set();

    void (async () => {
      try {
        await openWithin(book.ready, OPEN_TIMEOUT_HELP);
        // Locations give every CFI a percentage: "42% through" for the card and the
        // partner's bookmark. Heavy books take a few seconds here; the reader stays up.
        await openWithin(book.locations.generate(LOCATIONS_CHARS), OPEN_TIMEOUT_HELP);
        if (cancelled) return;

        const rendition = book.renderTo(holder, {
          width: '100%',
          height: '100%',
          flow: 'paginated',
          spread: 'none',
        });
        renditionRef.current = rendition;
        rendition.themes.default({
          body: {
            'font-family': tokens.typography.fontFamily,
            'line-height': '1.6',
            color: tokens.colors.textPrimary,
          },
          'a, a:hover, a:link, a:visited': { color: tokens.colors.primaryGreenDeep },
          p: { 'margin': '0 0 0.8em 0', 'text-align': 'left' },
        });

        rendition.on('relocated', (location: { start?: { cfi?: string } }) => {
          const cfi = location.start?.cfi;
          if (!cfi) return;
          let percent = 0;
          try {
            percent = Math.round((book.locations.percentageFromCfi(cfi) ?? 0) * 100);
          } catch {
            percent = 0;
          }
          handlersRef.current.onLocationChange(cfi, percent);
        });

        rendition.on('selected', (cfiRange: string, contents?: Contents) => {
          const quoteText = (contents?.window?.getSelection?.()?.toString() ?? '').trim();
          if (!quoteText) return;
          handlersRef.current.onSelection({ location: cfiRange, quoteText: quoteText.slice(0, 2000) });
        });

        // Clicks happen inside the rendition's iframe, so each rendered section gets
        // its own listener: edges turn pages, the middle toggles the chrome — unless
        // the tap finished a text selection, which belongs to highlighting.
        rendition.on('rendered', (_section: unknown, contents?: Contents) => {
          const doc = contents?.document;
          if (!doc) return;
          doc.addEventListener('click', (event: MouseEvent) => {
            const selection = contents?.window?.getSelection?.();
            if (selection && !selection.isCollapsed) return;
            const width = doc.documentElement.clientWidth || 1;
            const x = event.clientX / width;
            if (x < 0.18) {
              void rendition.prev();
            } else if (x > 0.82) {
              void rendition.next();
            } else {
              handlersRef.current.onToggleChrome();
            }
          });
        });

        await rendition.display(initialLocationRef.current ?? undefined);
        if (cancelled) return;
        setReady(true);
        handlersRef.current.onReady?.();
      } catch (error) {
        if (!cancelled) {
          handlersRef.current.onError(
            error instanceof Error && error.message
              ? `This book could not be opened. ${error.message}`
              : 'This book could not be opened.',
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      renditionRef.current = null;
      bookRef.current = null;
      try {
        book.destroy();
      } catch {
        // A half-built book has nothing to tear down.
      }
    };
    // The file identity is the dependency: a new file is a new book. Everything else
    // (the open-at location, the callbacks) is read through refs.
  }, [bytes]);

  // --- Paint the couple's highlights -------------------------------------------------
  useEffect(() => {
    const rendition = renditionRef.current;
    if (!rendition || !ready) return;
    for (const highlight of highlights) {
      if (appliedHighlights.current.has(highlight.id) || !highlight.location) continue;
      appliedHighlights.current.add(highlight.id);
      try {
        // Two colours, one per person — always the person's own, never the reader's,
        // so a passage looks the same on both phones.
        const ink: 'rose' | 'sage' = highlight.user_id === myUserId ? 'rose' : 'sage';
        rendition.annotations.highlight(
          highlight.location,
          { id: highlight.id },
          undefined,
          'nooki-highlight',
          HIGHLIGHT_STYLES[ink],
        );
      } catch {
        // A stale CFI from an older file must not stop the others painting.
      }
    }
  }, [highlights, myUserId, ready]);

  // --- Jump: partner's bookmark or a chat quote --------------------------------------
  useEffect(() => {
    if (!jump || !ready) return;
    void renditionRef.current?.display(jump.location).catch(() => {
      // A CFI this file does not contain: stay where we are.
    });
  }, [jump, ready]);

  return (
    <div
      data-epub-holder
      ref={holderRef}
      style={{ width: '100%', height: '100%', overflow: 'hidden' }}
    />
  );
};

export default EpubReader;
