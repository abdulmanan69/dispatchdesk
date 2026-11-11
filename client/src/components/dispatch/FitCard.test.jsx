import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../Toast.jsx';
import { ConfirmProvider } from '../Modal.jsx';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), upload: vi.fn(), del: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
const { default: FitCard } = await import('./FitCard.jsx');
const { default: DocumentsPanel } = await import('../documents/DocumentsPanel.jsx');

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider><ConfirmProvider>{ui}</ConfirmProvider></ToastProvider></QueryClientProvider>);
}

const RULES = { carrier: { id: 'c1', companyName: 'Blue Line' }, customer: { customerId: 'cu1', dispatchFeePercent: 8, rules: { minRatePerMile: 2.1, maxWeightLbs: 44000, costPerMileCents: 160, avoidStates: 'FL', carrierName: 'Blue Line' } } };

describe('FitCard', () => {
  beforeEach(() => { api.get.mockReset(); api.post.mockReset(); });

  it('shows the carrier rules, plain warnings, the walk-away rate and lane history with its sample size', async () => {
    api.get.mockImplementation((url) => Promise.resolve(url === '/api/customers/rules' ? RULES : { stats: { originState: 'TX', destState: 'FL', sampleSize: 4, avgRatePerMile: 2.31, minRatePerMile: 2.05, maxRatePerMile: 2.6 } }));
    wrap(<FitCard carrierId="c1" load={{ rateCents: 185000, loadedMiles: 1000, deadheadMiles: 100, weightLbs: 46000, originState: 'TX', destState: 'FL' }} />);
    expect(await screen.findByText("$1.85/mi is below Blue Line's $2.10 floor")).toBeInTheDocument();
    expect(screen.getByText('46,000 lb exceeds the 44,000 lb max')).toBeInTheDocument();
    expect(screen.getByText('FL is on the avoid list')).toBeInTheDocument();
    expect(screen.getByText('Warnings never block booking.')).toBeInTheDocument();
    expect(screen.getByText('$2,100')).toBeInTheDocument(); // walk-away = max($2.10 x 1,000, $1.60 x 1,100)
    expect(await screen.findByText(/from 4 loads TX → FL/)).toBeInTheDocument();
    expect(screen.getByText('From your own loads only. Not a market rate.')).toBeInTheDocument();
  });

  it('says honestly when there is no carrier or no rules', async () => {
    api.get.mockResolvedValue({ carrier: { id: 'c2', companyName: 'Prospect Freight' }, customer: null });
    const { rerender } = wrap(<FitCard load={{ originState: 'TX' }} />);
    expect(screen.getByText('Pick the carrier to check this load against its rules.')).toBeInTheDocument();
    rerender(<QueryClientProvider client={new QueryClient()}><ToastProvider><ConfirmProvider><FitCard carrierId="c2" load={{}} /></ConfirmProvider></ToastProvider></QueryClientProvider>);
    expect(await screen.findByText(/Prospect Freight is not a customer yet/)).toBeInTheDocument();
  });

  it('acknowledges saved warnings on a load', async () => {
    api.get.mockImplementation((url) => Promise.resolve(url === '/api/customers/rules' ? RULES : { stats: { sampleSize: 0 } }));
    api.post.mockResolvedValue({ load: { id: 'l1' } });
    wrap(<FitCard carrierId="c1" loadId="l1" stored={{ warnings: [{ code: 'weight', message: 'x' }], acknowledgedAt: null }} load={{ rateCents: 300000, loadedMiles: 1000, originState: 'TX', destState: 'GA' }} />);
    fireEvent.click(await screen.findByRole('button', { name: /acknowledge 1 saved warning/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/loads/l1/fit-ack'));
  });
});

describe('DocumentsPanel', () => {
  beforeEach(() => { api.get.mockReset(); api.upload.mockReset(); });

  it('lets the user confirm each guessed type before uploading several files', async () => {
    api.get.mockResolvedValue({ items: [] });
    api.upload.mockResolvedValue({ document: { id: 'd1' } });
    wrap(<DocumentsPanel carrierId="c1" />);
    const input = screen.getByLabelText('Choose document files');
    const w9 = new File(['%PDF'], 'W9 Blue Line.pdf', { type: 'application/pdf' });
    const scan = new File(['%PDF'], 'scan0001.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [w9, scan] } });
    expect(await screen.findByText('W9 Blue Line.pdf')).toBeInTheDocument();
    const types = screen.getAllByRole('combobox', { name: 'Type' });
    expect(types[0]).toHaveTextContent('W-9');
    expect(types[1]).toHaveTextContent('Other');
    expect(api.upload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Upload 2 files' }));
    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(2));
    const sentTypes = api.upload.mock.calls.map(([, fd]) => fd.get('type'));
    expect(sentTypes).toEqual(['w9', 'other']);
  });
});
