import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../Toast.jsx';
import { ConfirmProvider } from '../Modal.jsx';
import { browserTz, dateToZonedInput } from '../calling/callWindow.js';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
vi.mock('../email/ComposeModal.jsx', () => ({ default: () => null }));

const { NewOpportunityModal, OpportunityModal } = await import('./OpportunityModal.jsx');

/** A zone that differs from the browser's right now, so the follow-up is typed in carrier time. */
const otherZone = () => (dateToZonedInput(new Date(), 'Pacific/Honolulu') === dateToZonedInput(new Date(), browserTz()) ? 'Asia/Tokyo' : 'Pacific/Honolulu');

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><ToastProvider><ConfirmProvider>{ui}</ConfirmProvider></ToastProvider></MemoryRouter></QueryClientProvider>);
}

describe('opportunity follow-up time', () => {
  beforeEach(() => { api.get.mockReset(); api.post.mockReset(); api.patch.mockReset(); });

  it("reads the next follow-up in the carrier's local time when creating an opportunity", async () => {
    const tz = otherZone();
    api.post.mockResolvedValue({ opportunity: { id: 'o1' } });
    wrap(<NewOpportunityModal open onClose={() => {}} carrier={{ id: 'c1', companyName: 'Desert Mile Freight', timezone: tz }} />);
    fireEvent.change(screen.getByLabelText('Next follow-up', { selector: 'input' }), { target: { value: '2026-11-12T10:00' } });
    expect(screen.getByRole('radio', { name: /carrier time/i })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Create opportunity' }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [url, body] = api.post.mock.calls[0];
    expect(url).toBe('/api/opportunities');
    expect(body.carrierId).toBe('c1');
    expect(dateToZonedInput(body.nextFollowUpAt, tz)).toBe('2026-11-12T10:00');
  });

  it('keeps the saved follow-up moment unchanged when the opportunity is saved again', async () => {
    const tz = otherZone();
    const at = '2026-11-12T20:00:00.000Z';
    api.get.mockResolvedValue({
      opportunity: { id: 'o1', status: 'open', estimatedValueCents: 100000, dispatchFeePercent: 8, probability: 40, nextFollowUpAt: at, notes: '', carrier: { id: 'c1', companyName: 'Desert Mile Freight', timezone: tz, state: 'AZ' } },
      calls: [], emails: [], activities: [], followUps: [],
    });
    api.patch.mockResolvedValue({ opportunity: { id: 'o1' } });
    wrap(<OpportunityModal id="o1" onClose={() => {}} />);
    expect(await screen.findByLabelText('Next follow-up', { selector: 'input' })).toHaveValue(dateToZonedInput(at, tz));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.patch.mock.calls[0][1].nextFollowUpAt).toBe(at);
  });
});
