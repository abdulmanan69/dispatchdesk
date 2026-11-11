import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const get = vi.fn();
vi.mock('../../lib/api.js', () => ({ api: { get: (...a) => get(...a) } }));
vi.mock('../calling/CallButton.jsx', () => ({ default: ({ phone }) => <a href={`tel:${phone}`}>{phone}</a> }));
vi.mock('../email/ComposeModal.jsx', () => ({ default: () => null }));

const { default: ReloadIdeas, reloadParams } = await import('./ReloadIdeas.jsx');

function renderIt(props) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><ReloadIdeas {...props} /></MemoryRouter></QueryClientProvider>);
}

const DATA = {
  state: 'GA', city: 'Atlanta', days: 365, loadsConsidered: 3,
  brokers: [{ broker: { id: 'b1', companyName: 'Peach Logistics', contactName: 'Ann', phone: '4045550101', email: 'ann@peach.test', daysToPay: 21 }, loads: 2, cityLoads: 2, lastLoadAt: '2026-11-05T12:00:00Z', lastRateCents: 195000, lastRpm: 2.5, avgRpm: 2.4, topDestinations: ['TX'] }],
  lanes: [{ destState: 'TX', loads: 2, avgRpm: 2.5, lastLoadAt: '2026-11-05T12:00:00Z', topCities: ['Dallas'] }],
  customerLanes: [],
  fmcsa: { state: { state: 'GA', carriers: 900, brokers: 15 }, city: null, error: null },
};

beforeEach(() => get.mockReset());

describe('ReloadIdeas', () => {
  it('builds request params only for a valid state', () => {
    expect(reloadParams({ state: 'ga', city: 'Atlanta' })).toEqual({ state: 'GA', city: 'Atlanta', equipment: undefined });
    expect(reloadParams({ state: '' })).toBeNull();
    expect(reloadParams({ state: 'Georgia' })).toBeNull();
  });

  it('asks for a location instead of loading without one', () => {
    renderIt({ state: '' });
    expect(screen.getByText('No location yet')).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it('shows brokers, lanes and FMCSA context from the workspace data', async () => {
    get.mockResolvedValue(DATA);
    renderIt({ state: 'GA', city: 'Atlanta', equipment: 'dry_van' });
    await waitFor(() => expect(screen.getByText('Peach Logistics')).toBeInTheDocument());
    expect(get).toHaveBeenCalledWith('/api/truck-posts/reload-ideas', { state: 'GA', city: 'Atlanta', equipment: 'dry_van' }, expect.anything());
    expect(screen.getByText('2 from Atlanta')).toBeInTheDocument();
    expect(screen.getByText(/2 loads · last .* at \$1,950 \(\$2\.50\/mi\) · average \$2\.40\/mi/)).toBeInTheDocument();
    expect(screen.getByText(/pays in about 21 days/)).toBeInTheDocument();
    expect(screen.getByText('GA to TX')).toBeInTheDocument();
    expect(screen.getByText(/900 carriers and 15 listing brokerage/)).toBeInTheDocument();
    expect(screen.getByText(/None of your customers list a lane out of GA/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Email/ })).toBeInTheDocument();
  });

  it('says so honestly when there is no history', async () => {
    get.mockResolvedValue({ ...DATA, brokers: [], lanes: [], loadsConsidered: 0, fmcsa: { state: null, city: null, error: 'down' } });
    renderIt({ state: 'GA' });
    await waitFor(() => expect(screen.getByText(/No loads out of GA with a broker in the last 365 days/)).toBeInTheDocument());
    expect(screen.getByText(/FMCSA census counts are not available right now/)).toBeInTheDocument();
  });
});
