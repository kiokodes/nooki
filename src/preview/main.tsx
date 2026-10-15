import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { HomePreview } from './HomePreview';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HomePreview />
  </StrictMode>,
);
