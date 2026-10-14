import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { recoverFromChunkError } from './lazy';
import { trackVisualViewport } from './viewport';
import { initPwa } from './pwa';
import './styles.css';

// Vite reports a failed chunk load here (old page, new build). Reload once onto the new build.
// The error still reaches the caller, where lazyWithReload keeps the loading state up meanwhile.
window.addEventListener('vite:preloadError', () => { recoverFromChunkError(); });

trackVisualViewport();
initPwa();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
