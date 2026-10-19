// Test-only entry point. Vite's production build only includes index.html.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { GamesView } from '../../src/components/games/GamesView';
import { useGames } from '../../src/hooks/useGames';
import '../../src/index.css';

export function GamesFixture() {
  const games = useGames('test-couple', 'test-user');
  const partnerOnline = new URLSearchParams(window.location.search).get('online') === '1';
  return (
    <div className="nooki-viewport">
      <main className="nooki-shell">
        <GamesView games={games} userId="test-user" coupleId="test-couple" partnerId="test-partner" partnerName="Ana" partnerOnline={partnerOnline} />
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><GamesFixture /></StrictMode>);
