import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
const auth = vi.hoisted(() => ({ user: null }));
vi.mock('../../context/AuthContext.jsx', () => ({ useAuth: () => auth }));

const { default: TrialBanner } = await import('./TrialBanner.jsx');
const { default: AnnouncementBar } = await import('../announcement/AnnouncementBar.jsx');

const wrap = (ui) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>{ui}</MemoryRouter>
  </QueryClientProvider>,
);

describe('TrialBanner', () => {
  it('shows days left during the trial and the lock after it', () => {
    auth.user = { trial: { active: true, locked: false, daysLeft: 3, endsAt: '2026-11-20T00:00:00Z' } };
    const { unmount } = wrap(<TrialBanner />);
    expect(screen.getByText(/Free trial: 3 days left/)).toBeInTheDocument();
    unmount();
    auth.user = { trial: { active: false, locked: true, daysLeft: 0, endsAt: '2026-11-01T00:00:00Z' } };
    wrap(<TrialBanner />);
    expect(screen.getByText(/free trial has ended/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose a plan' })).toHaveAttribute('href', '/app/billing');
  });

  it('shows nothing for accounts with a plan', () => {
    auth.user = { trial: null };
    const { container } = wrap(<TrialBanner />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('AnnouncementBar', () => {
  beforeEach(() => { localStorage.clear(); api.get.mockReset(); });

  it('shows the announcement for its audience and stays closed once closed', async () => {
    api.get.mockResolvedValue({ announcement: { id: 'abc123', text: 'Fee payments are here', linkUrl: '/app/customers', linkLabel: 'Open', tone: 'success', audience: 'app' } });
    const { unmount } = wrap(<AnnouncementBar place="app" />);
    expect(await screen.findByText(/Fee payments are here/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/app/customers');
    fireEvent.click(screen.getByRole('button', { name: /close announcement/i }));
    expect(screen.queryByText(/Fee payments are here/)).not.toBeInTheDocument();
    unmount();
    wrap(<AnnouncementBar place="app" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/Fee payments are here/)).not.toBeInTheDocument();
  });

  it('is hidden where the admin did not choose to show it', async () => {
    api.get.mockResolvedValue({ announcement: { id: 'x1', text: 'Website only', tone: 'info', audience: 'public' } });
    wrap(<AnnouncementBar place="app" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Website only')).not.toBeInTheDocument();
  });
});
