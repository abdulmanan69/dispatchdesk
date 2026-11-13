import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const get = vi.fn();
const post = vi.fn();
vi.mock('../../lib/api.js', () => ({ api: { get: (...a) => get(...a), post: (...a) => post(...a) } }));
vi.mock('../../components/carriers/FmcsaProfile.jsx', () => ({ default: ({ dot, actions }) => <div data-testid="profile">Profile {dot}{actions}</div> }));

const { default: CarrierCheck } = await import('./CarrierCheck.jsx');

const DEAN = { dotNumber: '3636864', mcNumber: '1248213', companyName: "DEAN'S LOGISTICS LLC", city: 'Carnegie', state: 'PA', fleetSize: 1, usdotStatus: 'active', authorityStatus: 'active', authority: { label: 'Active' }, existsInCrm: false };
const OTHER = { ...DEAN, dotNumber: '2331182', mcNumber: null, companyName: 'DEAN LOGISTICS INC' };

function renderAt(url) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}><Routes><Route path="/app/carrier-check" element={<CarrierCheck />} /></Routes></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => { get.mockReset(); post.mockReset(); });

describe('CarrierCheck', () => {
  it('a USDOT or MC search with one match opens the carrier straight away', async () => {
    get.mockResolvedValue({ query: { kind: 'mc', value: '1248213' }, items: [DEAN] });
    renderAt('/app/carrier-check?q=MC%201248213');
    expect(await screen.findByTestId('profile')).toHaveTextContent('Profile 3636864');
    expect(get).toHaveBeenCalledWith('/api/carrier-profile/search', { q: 'MC 1248213' }, expect.anything());
    expect(screen.getByRole('button', { name: 'Save as lead' })).toBeInTheDocument();
  });

  it('a name search lists the matches; picking one opens it', async () => {
    get.mockResolvedValue({ query: { kind: 'name', value: 'DEAN' }, items: [DEAN, OTHER] });
    renderAt('/app/carrier-check?q=dean');
    fireEvent.click(await screen.findByText('DEAN LOGISTICS INC'));
    expect(await screen.findByTestId('profile')).toHaveTextContent('Profile 2331182');
    expect(screen.getByRole('button', { name: 'All 2 results' })).toBeInTheDocument();
  });

  it('bulk check posts the numbers and shows each result', async () => {
    post.mockResolvedValue({ authorityAnswered: true, results: [{ input: '3636864', carrier: DEAN }, { input: '1', error: 'No FMCSA record' }] });
    renderAt('/app/carrier-check?tab=bulk');
    fireEvent.change(screen.getByLabelText('USDOT or MC numbers'), { target: { value: '3636864\n1' } });
    fireEvent.click(screen.getByRole('button', { name: /Check 2 carriers/ }));
    expect(await screen.findByText("DEAN'S LOGISTICS LLC")).toBeInTheDocument();
    expect(screen.getByText('No FMCSA record')).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith('/api/carrier-profile/bulk', { numbers: ['3636864', '1'] }, expect.anything());
  });
});
