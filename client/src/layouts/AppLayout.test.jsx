import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router';

const h = vi.hoisted(() => ({ user: null, refresh: null, get: null, post: null }));

vi.mock('../lib/api.js', () => ({
  api: {
    get: (...args) => h.get(...args),
    post: (...args) => h.post(...args),
    patch: vi.fn(async () => ({})),
  },
}));
vi.mock('../context/AuthContext.jsx', () => ({
  useAuth: () => ({
    user: h.user, loading: false, connection: null, retryNow: vi.fn(), refresh: h.refresh,
    can: () => true, logout: vi.fn(), setUser: vi.fn(),
  }),
}));
vi.mock('../context/pwa.js', () => ({
  promptInstall: vi.fn(), registerServiceWorker: vi.fn(), useInstallPrompt: () => ({ canInstall: false, iosHint: false }),
}));
vi.mock('../context/push.js', () => ({ syncPushSubscription: vi.fn(async () => {}) }));
vi.mock('../components/CommandPalette.jsx', () => ({ default: () => null, CommandHint: () => null }));
vi.mock('../components/market/FloatingDock.jsx', () => ({ default: () => null }));
vi.mock('../components/tour/TourHost.jsx', () => ({ default: () => null }));

const { default: AppLayout } = await import('./AppLayout.jsx');
const { ToastProvider } = await import('../components/Toast.jsx');
const { clearShared } = await import('../context/tabSync.js');

const COUNTS = {
  '/api/follow-ups': { counts: { overdue: 1, today: 2 } },
  '/api/prospecting/queue/count': { queue: 7, count: 7, followUps: 2, overdue: 0 },
  '/api/today/count': { urgent: 3, total: 9 },
  '/api/notifications/unread-count': { unread: 0 },
  '/api/billing/me': {},
};

function renderShell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: '/app', element: <AppLayout />, children: [{ index: true, element: <p>Home page</p> }] }],
    { initialEntries: ['/app'] },
  );
  return render(<QueryClientProvider client={qc}><ToastProvider><RouterProvider router={router} /></ToastProvider></QueryClientProvider>);
}

const navRow = (name) => document.querySelector(`a[data-tour="nav-${name}"]`);

beforeEach(() => {
  clearShared(); // shared poll results are module state (context/tabSync.js)
  h.user = { id: 'u1', name: 'Dee Dispatcher', email: 'dee@example.com', emailVerified: true, roleName: 'Dispatcher', team: null };
  h.refresh = vi.fn(async () => null);
  h.get = vi.fn(async (url) => COUNTS[url] ?? {});
  h.post = vi.fn(async () => ({}));
});

describe('AppLayout shell', () => {
  it('shows live nav counts: prospecting queue, follow-ups and urgent Today items', async () => {
    renderShell();
    expect(await screen.findByText('Home page')).toBeInTheDocument();
    await waitFor(() => expect(navRow('prospecting')).toHaveTextContent('7'));
    await waitFor(() => expect(navRow('follow-ups')).toHaveTextContent('3'));
    await waitFor(() => expect(navRow('today')).toHaveTextContent('3'));
    expect(h.get).toHaveBeenCalledWith('/api/today/count', undefined, expect.anything());
  });

  it('shows no Today badge when the board is not available to this user', async () => {
    h.get = vi.fn(async (url) => {
      if (url === '/api/today/count') throw Object.assign(new Error('Forbidden'), { status: 403 });
      return COUNTS[url] ?? {};
    });
    renderShell();
    await waitFor(() => expect(h.get).toHaveBeenCalledWith('/api/today/count', undefined, expect.anything()));
    await waitFor(() => expect(navRow('prospecting')).toHaveTextContent('7'));
    await new Promise((r) => setTimeout(r, 20)); // let the refused count settle
    expect(navRow('today').textContent).toBe('Today');
  });

  it('asks unverified users to verify before saving, and reloads the account when already verified', async () => {
    h.user = { ...h.user, emailVerified: false, mailConfigured: true, verificationRequired: true };
    h.post = vi.fn(async () => ({ ok: true, alreadyVerified: true }));
    renderShell();
    expect(await screen.findByText('Verify your email to start saving changes. Until then you can look around.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resend link' }));
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/api/auth/resend-verification'));
    expect(await screen.findByText(/Your email is already verified/)).toBeInTheDocument();
    expect(h.refresh).toHaveBeenCalled();
  });
});
