import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const auth = vi.hoisted(() => ({ user: null }));
vi.mock('../../context/AuthContext.jsx', () => ({ useAuth: () => auth }));
const post = vi.hoisted(() => vi.fn(async () => ({ status: 'pending' })));
vi.mock('../../lib/api.js', () => ({ api: { post } }));
vi.mock('../Toast.jsx', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

const { default: TeamHandoff } = await import('./TeamHandoff.jsx');
const wrap = (ui) => render(<QueryClientProvider client={new QueryClient()}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
const signed = { id: 'c1', stage: { key: 'customer' }, soldBy: { id: 'u-s', name: 'Sales Sam' }, handoffStatus: null, assignedTo: null };

describe('TeamHandoff', () => {
  it('shows nothing outside a team', () => {
    auth.user = { id: 'u1', team: null };
    const { container } = wrap(<TeamHandoff carrier={signed} canWrite />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows who signed a carrier and hands it to dispatch', async () => {
    auth.user = { id: 'u-s', team: { role: 'sales', areas: ['sales'] } };
    wrap(<TeamHandoff carrier={signed} canWrite />);
    expect(screen.getByText('Sales Sam')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hand to dispatch' }));
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith('/api/teams/handoffs/c1'));
  });

  it('says when a carrier waits for a dispatcher, with a link for leads', () => {
    auth.user = { id: 'u-o', team: { role: 'owner', areas: ['sales', 'dispatch'] } };
    wrap(<TeamHandoff carrier={{ ...signed, handoffStatus: 'pending', handoffAt: new Date().toISOString() }} canWrite />);
    expect(screen.getByText('Waiting for a dispatcher')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Assign in Team' })).toHaveAttribute('href', '/app/team?tab=assign');
    expect(screen.queryByRole('button', { name: 'Hand to dispatch' })).toBeNull();
  });
});
