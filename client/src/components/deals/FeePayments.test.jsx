import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../Toast.jsx';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
const { FeeBadge, FeePaymentsModal } = await import('./FeePayments.jsx');

const FEES = {
  feeCents: 32500, collectedCents: 20000, owedCents: 12500, status: 'partial', recordedCents: 20000, invoicePaidCents: 0,
  payments: [{ id: 'p1', amountCents: 20000, paidAt: '2026-11-13T12:00:00.000Z', method: 'zelle', reference: 'ZL-1', note: null }],
};

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider>{ui}</ToastProvider></QueryClientProvider>);
}

describe('FeeBadge', () => {
  it('shows paid, still owed, unpaid, or nothing', () => {
    const { rerender } = render(<FeeBadge fees={{ status: 'paid' }} />);
    expect(screen.getByText('Paid')).toBeInTheDocument();
    rerender(<FeeBadge fees={{ status: 'partial', owedCents: 12500 }} />);
    expect(screen.getByText('Owes $125.00')).toBeInTheDocument();
    rerender(<FeeBadge fees={{ status: 'unpaid', owedCents: 100 }} />);
    expect(screen.getByText('Unpaid')).toBeInTheDocument();
    rerender(<FeeBadge fees={{ status: 'none' }} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('FeePaymentsModal', () => {
  beforeEach(() => { api.get.mockReset(); api.post.mockReset(); });

  it('lists payments and records a new one for what is still owed', async () => {
    api.get.mockResolvedValue({ statement: { lines: [] }, fees: FEES });
    api.post.mockResolvedValue({ fees: { ...FEES, owedCents: 0, status: 'paid' } });
    wrap(<FeePaymentsModal customerId="c1" week="2026-11-09" title="Fee payments" onClose={() => {}} />);
    expect(await screen.findByText(/ZL-1/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Amount received/)).toHaveValue(125);
    fireEvent.change(screen.getByLabelText(/Reference/), { target: { value: 'ACH-77' } });
    fireEvent.click(screen.getByRole('button', { name: /record payment/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/customers/c1/statements/2026-11-09/payments', expect.objectContaining({ amountCents: 12500, reference: 'ACH-77' })));
  });
});
