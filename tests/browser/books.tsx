// Test-only entry point. Vite's production build only includes index.html.
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EpubReader } from '../../src/components/media/EpubReader';
import type { Highlight } from '../../src/types/database';

// The event log the Playwright test reads through `window.__bookLog`.
const log: Array<Record<string, unknown>> = [];
(window as unknown as { __bookLog: typeof log }).__bookLog = log;

async function loadBytes(file: string): Promise<ArrayBuffer> {
  const response = await fetch(`/tests/browser/fixtures/${file}`);
  if (!response.ok) throw new Error(`fixture epub missing: ${response.status}`);
  return response.arrayBuffer();
}

function BookFixture({ file }: { file: string }) {
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  useEffect(() => { void loadBytes(file).then(setBytes); }, [file]);
  if (!bytes) return <div data-book-loading="true">loading fixture…</div>;
  return (
    <div className="nooki-viewport" style={{ width: '390px', height: '844px' }}>
      <main className="nooki-shell" style={{ width: '100%', height: '100%' }}>
        <EpubReader
          bytes={bytes}
          initialLocation={null}
          highlights={[] as Highlight[]}
          myUserId="test-user"
          jump={null}
          onLocationChange={(location, percent) => {
            log.push({ type: 'location', location, percent });
          }}
          onSelection={(selection) => {
            log.push({ type: 'selection', location: selection.location, quoteText: selection.quoteText });
          }}
          onToggleChrome={() => { log.push({ type: 'chrome' }); }}
          onReady={() => { log.push({ type: 'ready' }); }}
          onError={(message) => { log.push({ type: 'error', message }); }}
        />
      </main>
    </div>
  );
}

const params = new URLSearchParams(window.location.search);
const file = params.get('file') ?? 'sample.epub';

export function BooksFixture() {
  return <BookFixture file={file} />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><BooksFixture /></StrictMode>);
