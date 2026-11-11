import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const h = vi.hoisted(() => ({
  user: null,
  setUser: null,
  get: null,
  patch: null,
}));

vi.mock('../../lib/api.js', () => ({
  api: {
    get: (...args) => h.get(...args),
    patch: (...args) => h.patch(...args),
    post: vi.fn(async () => ({})),
    del: vi.fn(async () => ({})),
  },
}));
vi.mock('../../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: h.user, setUser: h.setUser }) }));
vi.mock('../../context/push.js', () => ({
  pushSupport: () => ({ supported: true, permission: 'default', needsInstall: false }),
  enablePush: vi.fn(),
  disablePush: vi.fn(),
  currentSubscription: async () => null,
  thisDeviceId: () => 'device-1',
  deviceLabel: () => 'Chrome on Android',
}));
vi.mock('../../components/settings/SecurityPanel.jsx', () => ({ default: () => null }));
vi.mock('../../components/calling/CallingSettings.jsx', () => ({ default: () => null }));

const { default: Settings } = await import('./Settings.jsx');
const { ToastProvider } = await import('../../components/Toast.jsx');
const { ConfirmProvider } = await import('../../components/Modal.jsx');

const baseUser = {
  id: 'u1', name: 'Dee Dispatcher', email: 'dee@example.com', emailVerified: true, timezone: 'America/Chicago', theme: 'light',
  roleName: 'Dispatcher', notifyInApp: true, notifyEmail: true, notifyFollowUps: true, notifyDigest: true, notifyCommunity: true, notifyPush: true,
};

function renderNotifications() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ConfirmProvider>
          <MemoryRouter initialEntries={['/app/settings?tab=notifications']}><Settings /></MemoryRouter>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  h.user = { ...baseUser };
  h.setUser = vi.fn();
  h.get = vi.fn(async (url) => (url === '/api/push/subscriptions' ? { items: [], max: 5, notifyPush: true } : {}));
  h.patch = vi.fn(async (url, body) => ({ user: { ...h.user, ...body } }));
});

describe('Settings, notifications tab', () => {
  it('shows the daily digest switch bound to the profile', async () => {
    renderNotifications();
    const digest = screen.getByRole('switch', { name: 'Daily digest email' });
    expect(digest).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/One email at 7 AM your time/)).toBeInTheDocument();
    expect(screen.getByText(/By email, only in the daily digest/)).toBeInTheDocument();
    fireEvent.click(digest);
    await waitFor(() => expect(h.patch).toHaveBeenCalledWith('/api/profile', { notifyDigest: false }));
    await waitFor(() => expect(h.setUser).toHaveBeenCalledWith(expect.objectContaining({ notifyDigest: false })));
  });

  it('explains when the digest cannot be sent', () => {
    h.user = { ...baseUser, notifyFollowUps: false };
    const { unmount } = renderNotifications();
    expect(screen.getByText('The digest is sent only while follow-up reminders are on.')).toBeInTheDocument();
    unmount();
    h.user = { ...baseUser, emailVerified: false };
    renderNotifications();
    expect(screen.getByText(/Without one, it comes from platform email/)).toBeInTheDocument();
  });

  it('saves the push switch on the profile and updates the signed-in user', async () => {
    renderNotifications();
    const push = await screen.findByRole('switch', { name: 'Send push notifications' });
    expect(push).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(push);
    await waitFor(() => expect(h.patch).toHaveBeenCalledWith('/api/profile', { notifyPush: false }));
    await waitFor(() => expect(h.setUser).toHaveBeenCalledWith(expect.objectContaining({ notifyPush: false })));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Send push notifications' })).toHaveAttribute('aria-checked', 'false'));
  });
});
