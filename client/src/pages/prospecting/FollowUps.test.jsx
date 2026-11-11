import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
vi.mock('../../components/Toast.jsx', () => ({ useToast: () => toast }));
vi.mock('../../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'Dana Ruiz', team: null } }) }));

const { ConfirmProvider } = await import('../../components/Modal.jsx');
const { default: FollowUps } = await import('./FollowUps.jsx');

const followUp = (id, carrierId, companyName) => ({
  id, userId: 'u1', type: 'call', priority: 0, status: 'pending', recurrence: 'none', snoozeCount: 0, title: null, note: null,
  dueAt: new Date(Date.now() + 3600000).toISOString(),
  carrier: { id: carrierId, companyName, phone: null, email: null, state: 'TX', timezone: 'America/Chicago', doNotCall: false },
});
const ITEMS = [followUp('f1', 'c1', 'Red River Transport'), followUp('f2', 'c2', 'Blue Line Carriers')];

function get(url) {
  if (url === '/api/follow-ups') return { items: ITEMS, counts: { overdue: 0, today: 2, upcoming: 0, done: 0 }, total: 2, page: 1, pages: 1 };
  if (url === '/api/telephony/settings') return { settings: { provider: 'tel' } };
  throw new Error(`unexpected GET ${url}`);
}

function renderPage(path = '/app/follow-ups') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15000 } } });
  const spy = vi.spyOn(qc, 'invalidateQueries');
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}><ConfirmProvider><FollowUps /></ConfirmProvider></MemoryRouter>
    </QueryClientProvider>,
  );
  return { qc, spy };
}

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockImplementation(async (url) => get(url));
  for (const fn of Object.values(toast)) fn.mockReset();
});

describe('FollowUps', () => {
  it('opens the tab named in ?view= (links from reminder notifications)', async () => {
    renderPage('/app/follow-ups?view=overdue');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/follow-ups', expect.objectContaining({ view: 'overdue' }), expect.anything()));
    expect(screen.getByRole('tab', { name: /Overdue/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('refreshes only the profile of the carrier whose follow-up changed', async () => {
    api.post.mockResolvedValue({ followUp: { ...ITEMS[0], dueAt: new Date(Date.now() + 2 * 3600000).toISOString() } });
    const { spy } = renderPage();
    await screen.findByText('Red River Transport');
    fireEvent.click(screen.getAllByRole('button', { name: 'Snooze' })[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: '15 minutes' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/follow-ups/f1/snooze', { minutes: 15 }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['carrier', 'c1'] }));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['follow-ups'] });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ['carrier'] });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ['carrier', 'c2'] });
  });

  it('bulk actions send only ids and the action, then refresh the selected carriers', async () => {
    api.post.mockResolvedValue({ updated: 2, skipped: 0 });
    const { spy } = renderPage();
    await screen.findByText('Red River Transport');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Red River Transport' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Blue Line Carriers' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/follow-ups/bulk', { action: 'complete', ids: ['f1', 'f2'] }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['carrier', 'c2'] }));
    expect(spy).toHaveBeenCalledWith({ queryKey: ['carrier', 'c1'] });
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ['carrier'] });
  });

  it('keeps the loaded list on screen when a refresh fails', async () => {
    const { qc } = renderPage();
    await screen.findByText('Red River Transport');
    api.get.mockImplementation(async (url) => {
      if (url === '/api/follow-ups') throw Object.assign(new Error('The server took too long to answer. Try again.'), { status: 0 });
      return get(url);
    });
    await act(async () => { await qc.invalidateQueries({ queryKey: ['follow-ups'] }); });
    expect(await screen.findByText(/Couldn't refresh/)).toBeInTheDocument();
    expect(screen.getByText('Red River Transport')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/api/follow-ups', expect.objectContaining({ view: 'today' }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});
