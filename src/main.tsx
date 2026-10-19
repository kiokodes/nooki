import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { clearLegacyLocalData } from './lib/clearLegacyLocalData';
import { registerNookiServiceWorker, takePushDeepLink } from './lib/pushService';

clearLegacyLocalData();

// Registers nooki-sw.js (public/, root scope). The worker caches nothing — it exists to
// receive pushes and open the right tab — so registering it in development too is
// harmless, and doing it here means a push that arrives while the app is closed still
// lands: the worker is already installed and subscribed.
registerNookiServiceWorker();

// A tapped notification opens Nooki at `/?nooki=<tab>`. It is read (and taken out of the
// URL) once, before the first render, so the app opens on that tab rather than painting
// Home and jumping; a later reload then lands wherever the couple actually was.
const pushStartTab = takePushDeepLink();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App initialTab={pushStartTab} />
  </StrictMode>,
);
