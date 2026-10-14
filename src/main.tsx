import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { injectTokensToCSS } from './tokens/injectTokens.ts'

// Initialize design tokens into CSS variables
injectTokensToCSS()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
