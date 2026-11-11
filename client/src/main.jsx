import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// Self-hosted IBM Plex (latin subset, the weights the UI uses): same-origin, hashed, cached for a year.
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import { router } from './router.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { ToastProvider } from './components/Toast.jsx';
import { ConfirmProvider } from './components/Modal.jsx';
import { applyTheme, watchSystemTheme } from './context/theme.js';
import { reloadForNewVersion } from './context/reload.js';
import { pendingHref } from './context/routes.jsx';
import { setSharedSink } from './context/tabSync.js';
import { initInstallPrompt, registerServiceWorkerWhenIdle } from './context/pwa.js';
import './index.css';

applyTheme();
watchSystemTheme();
initInstallPrompt();

// A preloaded chunk or stylesheet of a lazy route is gone after a deploy: reload once to get the new build, straight
// into the page that was being opened.
window.addEventListener('vite:preloadError', (event) => {
  if (reloadForNewVersion(pendingHref() || undefined)) event.preventDefault();
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      // Network errors, timeouts and 5xx retry twice; 429 retries once after Retry-After; other 4xx never retry.
      retry: (count, err) => {
        if (err?.name === 'AbortError') return false;
        if (err?.status === 429) return count < 1;
        return err?.status >= 400 && err?.status < 500 ? false : count < 2;
      },
      retryDelay: (attempt, err) => (err?.retryAfterMs != null ? Math.min(err.retryAfterMs, 30_000) : Math.min(1000 * 2 ** attempt, 30_000)),
    },
  },
});

// Poll results shared by another tab land in this tab's cache (see context/tabSync.js).
setSharedSink((queryKey, data) => {
  if (Array.isArray(queryKey) && queryClient.getQueryCache().find({ queryKey, exact: true })) queryClient.setQueryData(queryKey, data);
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <ConfirmProvider>
            <RouterProvider router={router} />
          </ConfirmProvider>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);

registerServiceWorkerWhenIdle();
