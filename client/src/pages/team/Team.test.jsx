import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const auth = vi.hoisted(() => ({ user: { id: 'u-owner', name: 'Owner Olivia', team: { role: 'owner', areas: ['sales', 'dispatch'] } } }));
vi.mock('../../context/AuthContext.jsx', () => ({ useAuth: () => ({ ...auth, refresh: vi.fn(), can: () => true }) }));
const calls = vi.hoisted(() => ({ patch: [], post: [] }));
const team = vi.hoisted(() => ({
  team: { id: 't1', name: 'Fleet Co', ownerId: 'u-owner', leaderboardEnabled: true, managersSeeAll: true, membersSeeAll: false, handoffMode: 'manager', keepWorkOnLeave: true },
  me: { role: 'owner', canManage: true, isLead: true, areas: ['sales', 'dispatch'], toAssign: 1 },
  seats: null, invitations: [],
  members: [
    { id: 'm1', userId: 'u-owner', role: 'owner', name: 'Owner Olivia', email: 'o@example.test', areas: ['sales', 'dispatch'], canViewTeamData: true, canManageMembers: true },
    { id: 'm2', userId: 'u-sales', role: 'sales', name: 'Sales Sam', email: 's@example.test', areas: ['sales'], canViewTeamData: false, canManageMembers: false },
    { id: 'm3', userId: 'u-disp', role: 'dispatcher', name: 'Dispatcher Dee', email: 'd@example.test', areas: ['dispatch'], canViewTeamData: false, canManageMembers: false },
  ],
}));
vi.mock('../../lib/api.js', () => ({
  api: {
    get: vi.fn(async (url) => {
      if (url === '/api/teams/mine') return team;
      if (url === '/api/teams/handoffs') {
        return {
          handoffMode: 'manager',
          pending: [{ id: 'c1', companyName: 'Signed Freight LLC', dotNumber: '1234567', city: 'Dallas', state: 'TX', soldBy: { id: 'u-sales', name: 'Sales Sam' }, signedAt: new Date().toISOString(), dispatchFeePercent: 8 }],
          assigned: [],
          dispatchers: [{ userId: 'u-disp', name: 'Dispatcher Dee', role: 'dispatcher' }],
        };
      }
      return { items: [], rows: [], totals: {} };
    }),
    patch: vi.fn(async (url, body) => { calls.patch.push([url, body]); return { member: {} }; }),
    post: vi.fn(async (url, body) => { calls.post.push([url, body]); return { carrier: { id: 'c1' } }; }),
    del: vi.fn(),
  },
}));
vi.mock('../../components/Toast.jsx', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

const { default: Team } = await import('./Team.jsx');

const renderAt = (url = '/app/team') => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[url]}><Team /></MemoryRouter>
  </QueryClientProvider>,
);

beforeEach(() => { calls.patch.length = 0; calls.post.length = 0; });

describe('Team page', () => {
  it('shows roles and the tools each member uses, and lets the manager switch tools on', async () => {
    renderAt();
    const row = (await screen.findByText('Sales Sam')).closest('tr');
    const sales = within(row).getByRole('button', { name: 'Leads & sales' });
    const dispatch = within(row).getByRole('button', { name: 'Dispatch' });
    expect(sales).toHaveAttribute('aria-pressed', 'true');
    expect(dispatch).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(dispatch);
    await vi.waitFor(() => expect(calls.patch).toContainEqual(['/api/teams/members/u-sales', { areas: ['sales', 'dispatch'] }]));
    // Owners always have every tool.
    expect(within(screen.getByText('Owner Olivia', { selector: 'p' }).closest('tr')).getByText('All tools')).toBeInTheDocument();
    // A banner points to carriers waiting for a dispatcher.
    expect(screen.getByText(/1 signed carrier/)).toBeInTheDocument();
  });

  it('lists signed carriers waiting for a dispatcher and assigns one', async () => {
    renderAt('/app/team?tab=assign');
    expect(await screen.findByText('Signed Freight LLC')).toBeInTheDocument();
    expect(screen.getByText(/Signed by Sales Sam/)).toHaveTextContent('8% fee');
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    await vi.waitFor(() => expect(calls.post).toContainEqual(['/api/teams/handoffs/c1/assign', { userId: 'u-disp' }]));
  });

  it('asks who receives the work when removing a member', async () => {
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Sales Sam' }));
    expect(await screen.findByText(/Give the carriers they added to/)).toBeInTheDocument();
    expect(screen.getByText(/Carriers they had before joining/)).toBeInTheDocument();
  });
});
