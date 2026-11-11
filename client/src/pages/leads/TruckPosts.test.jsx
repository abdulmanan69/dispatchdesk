import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const get = vi.fn();
const post = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
vi.mock('../../lib/api.js', () => ({ api: { get: (...a) => get(...a), post: (...a) => post(...a) } }));
vi.mock('../../components/Toast.jsx', () => ({ useToast: () => toast }));
vi.mock('../../components/templates/TemplatePicker.jsx', () => ({ default: () => null }));
vi.mock('../../components/carriers/ReloadIdeas.jsx', () => ({ default: () => null }));

const { default: TruckPosts } = await import('./TruckPosts.jsx');

const TRUCK = { id: 't1', companyName: 'Lone Star Haulers', equipmentText: 'Dry van', location: 'Dallas, TX', truckStatus: 'available', available: true, availableAt: null, locationState: 'TX', locationCity: 'Dallas', equipment: 'dry_van' };
const BROKERS = [
  { id: 'b1', companyName: 'Peach Logistics', contactName: 'Ann', email: 'ann@peach.test', lanes: [], states: [], loads: 0, lastLoadAt: null, postedAt: null },
  { id: 'b2', companyName: 'Blue Freight', contactName: null, email: 'loads@blue.test', lanes: [], states: [], loads: 0, lastLoadAt: null, postedAt: null },
];
const routes = {
  '/api/truck-posts/trucks': { items: [TRUCK], total: 1, available: 1 },
  '/api/truck-posts/draft': { truck: TRUCK, values: { equipment: 'Dry van', truck_location: 'Dallas, TX' }, template: { subject: 'Truck in {{truck_location}}', body: 'Hi {{first_name}}' }, fields: [], recent: {} },
  '/api/truck-posts/brokers': { items: BROKERS, total: 2, limited: false },
  '/api/truck-posts/history': { items: [] },
};
const PREVIEW = {
  values: {},
  mailbox: { id: 'm1', fromEmail: 'me@dispatch.test', label: 'Work' },
  capacity: { mailbox: { dailyLimit: 50, cooldownSeconds: 30 }, planLeftToday: 20, sendableToday: 20 },
  items: [
    { brokerId: 'b1', brokerName: 'Peach Logistics', toEmail: 'ann@peach.test', subject: 'Truck in Dallas, TX', body: 'Attn Ann', unresolved: [], unknown: [], postedAt: null, skip: null },
    { brokerId: 'b2', brokerName: 'Blue Freight', toEmail: 'loads@blue.test', subject: 'Truck in Dallas, TX', body: 'Attn {{contact_name}}', unresolved: ['contact_name'], unknown: [], postedAt: null, skip: null },
  ],
};

function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/app/truck-posts?truck=t1']}><TruckPosts /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  get.mockReset(); post.mockReset();
  get.mockImplementation(async (url) => routes[url]);
});

describe('TruckPosts broker search', () => {
  it('searches once the typing stops, passes the abort signal and keeps the list on screen', async () => {
    renderIt();
    await waitFor(() => expect(screen.getAllByLabelText('Select Peach Logistics').length).toBeGreaterThan(0));
    const box = screen.getByLabelText('Search brokers');
    fireEvent.change(box, { target: { value: 'p' } });
    fireEvent.change(box, { target: { value: 'pe' } });
    fireEvent.change(box, { target: { value: 'peach ' } });
    // Still showing the loaded brokers while the search waits and runs.
    expect(screen.getAllByLabelText('Select Peach Logistics').length).toBeGreaterThan(0);
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/truck-posts/brokers', expect.objectContaining({ q: 'peach', carrierId: 't1' }), expect.objectContaining({ signal: expect.anything() })));
    const searches = get.mock.calls.filter(([url, params]) => url === '/api/truck-posts/brokers' && params?.q);
    expect(searches.map(([, params]) => params.q)).toEqual(['peach']);
  });
});

describe('TruckPosts preview', () => {
  it('counts only the emails the send will queue (a broker missing a field is left out)', async () => {
    post.mockResolvedValue(PREVIEW);
    renderIt();
    await waitFor(() => expect(screen.getAllByLabelText('Select Peach Logistics').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByLabelText('Select Peach Logistics')[0]);
    fireEvent.click(screen.getAllByLabelText('Select Blue Freight')[0]);
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Preview: 1 email to queue' });
    expect(post).toHaveBeenCalledWith('/api/truck-posts/preview', expect.objectContaining({ carrierId: 't1', brokerIds: ['b1', 'b2'] }));
    expect(within(dialog).getByText(/has no value, so this email will not be queued/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Queue emails/ })).toBeEnabled();
  });

  it('disables queueing when nothing in the preview can be queued', async () => {
    post.mockResolvedValue({ ...PREVIEW, items: [PREVIEW.items[1]] });
    renderIt();
    await waitFor(() => expect(screen.getAllByLabelText('Select Blue Freight').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByLabelText('Select Blue Freight')[0]);
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Preview: 0 emails to queue' });
    expect(within(dialog).getByText(/None of these emails can be queued yet/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Queue emails/ })).toBeDisabled();
  });
});
