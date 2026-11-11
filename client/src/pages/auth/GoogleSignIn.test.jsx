import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const h = vi.hoisted(() => ({ providers: { google: false }, status: null, user: null }));

vi.mock('../../lib/api.js', () => ({
  api: {
    get: vi.fn(async (url) => {
      if (url === '/api/auth/providers') return h.providers;
      if (url === '/api/auth/google/status') return h.status;
      return {};
    }),
    post: vi.fn(async () => ({})),
  },
}));
vi.mock('../../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: h.user, login: vi.fn(), register: vi.fn() }) }));
vi.mock('../../components/ShaderBackground.jsx', () => ({ default: () => null }));

const { default: Login } = await import('./Login.jsx');
const { default: Register } = await import('./Register.jsx');
const { safeNext } = await import('./AuthShell.jsx');
const { default: GoogleLink } = await import('../../components/account/GoogleLink.jsx');
const { ToastProvider } = await import('../../components/Toast.jsx');
const { ConfirmProvider } = await import('../../components/Modal.jsx');

function renderAt(ui, url) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ConfirmProvider>
          <MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.providers = { google: false };
  h.status = null;
  h.user = null;
});

describe('Continue with Google', () => {
  it('is hidden when Google sign-in is not configured', async () => {
    renderAt(<Login />, '/login');
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('Continue with Google')).toBeNull();
  });

  it('links to the server start route with mode and next on the login page', async () => {
    h.providers = { google: true };
    renderAt(<Login />, '/login?next=%2Fapp%2Floads');
    const link = await screen.findByRole('link', { name: /Continue with Google/ });
    const href = new URL(link.getAttribute('href'), 'http://x');
    expect(href.pathname).toBe('/api/auth/google/start');
    expect(href.searchParams.get('mode')).toBe('login');
    expect(href.searchParams.get('next')).toBe('/app/loads');
    expect(screen.getByText(/By continuing you agree to the/)).toBeInTheDocument();
  });

  it('uses register mode on the sign-up page', async () => {
    h.providers = { google: true };
    renderAt(<Register />, '/register');
    const link = await screen.findByRole('link', { name: /Continue with Google/ });
    expect(new URL(link.getAttribute('href'), 'http://x').searchParams.get('mode')).toBe('register');
  });

  it('shows a friendly message for a failed Google sign-in', async () => {
    renderAt(<Login />, '/login?error=google&reason=suspended');
    expect(await screen.findByRole('alert')).toHaveTextContent('This account is suspended. Contact support.');
  });

  it('keeps next on this site', () => {
    expect(safeNext('//evil.example')).toBe('/app');
    expect(safeNext('/\\evil.example')).toBe('/app');
    expect(safeNext('https://evil.example')).toBe('/app');
    expect(safeNext('/app/carriers')).toBe('/app/carriers');
  });
});

describe('Google account in Settings', () => {
  it('asks for a password before unlinking an account created with Google', async () => {
    h.user = { id: 'u1', email: 'dee@example.com', mailConfigured: true };
    h.status = { linked: true, hasPassword: false, available: true };
    renderAt(<GoogleLink />, '/app/settings?tab=security');
    expect(await screen.findByText('Google account linked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set a password' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlink' })).toBeNull();
  });

  it('offers Unlink when the account has a password', async () => {
    h.user = { id: 'u1', email: 'dee@example.com', mailConfigured: true };
    h.status = { linked: true, hasPassword: true, available: true };
    renderAt(<GoogleLink />, '/app/settings?tab=security');
    expect(await screen.findByRole('button', { name: 'Unlink' })).toBeInTheDocument();
  });

  it('stays hidden when Google sign-in is off and nothing is linked', async () => {
    h.user = { id: 'u1', email: 'dee@example.com' };
    h.status = { linked: false, hasPassword: true, available: false };
    const { container } = renderAt(<GoogleLink />, '/app/settings?tab=security');
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toBe('');
  });
});
