import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../Toast.jsx';
import { ConfirmProvider } from '../Modal.jsx';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
const { SendToFactoringModal, PaymentModal, FactoringSummary } = await import('./InvoiceModals.jsx');

const INVOICE = { id: 'i1', number: 1001, kind: 'freight', status: 'draft', amountCents: 210000, paidCents: 0, balanceCents: 210000, meta: { reference: 'F-100' }, factoring: null };
const PACKET = {
  to: 'invoices@apex.test', company: { id: 'f1', name: 'Apex Capital', submitEmail: 'invoices@apex.test' }, customerId: 'cu1', clientNo: 'BL-2231', problem: null,
  attachments: [{ id: null, type: 'invoice', name: 'invoice-1001.pdf', generated: true }, { id: 'd1', type: 'rate_confirmation', name: 'ratecon.pdf', sizeBytes: 1000 }],
  documents: [{ id: 'd1', type: 'rate_confirmation', name: 'ratecon.pdf', sizeBytes: 1000 }, { id: 'd2', type: 'lumper_receipt', name: 'lumper.pdf', sizeBytes: 2000 }],
  missing: ['bol', 'pod'], maxAttachments: 5,
  subject: 'Invoice #1001 · Blue Line Trucking · client BL-2231 · load F-100',
  body: 'Hello,\n\nPlease find attached the invoice packet for Blue Line Trucking (MC 765432).',
  submitted: null,
};

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><ToastProvider><ConfirmProvider>{ui}</ConfirmProvider></ToastProvider></MemoryRouter></QueryClientProvider>);
}

describe('Send to factoring', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
  });

  it('shows the packet with missing-paperwork warnings and sends the chosen attachments with the edited text', async () => {
    api.get.mockResolvedValue(PACKET);
    api.post.mockResolvedValue({ invoice: { ...INVOICE, status: 'sent' }, outcome: 'sent' });
    const onClose = vi.fn();
    wrap(<SendToFactoringModal invoice={INVOICE} onClose={onClose} />);
    expect(await screen.findByText('Apex Capital')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/api/invoices/i1/factoring-packet', undefined, expect.anything());
    expect(screen.getByText(/No POD on this load\. Most factoring companies reject a packet/)).toBeInTheDocument();
    expect(screen.getByText(/No BOL on this load/)).toBeInTheDocument();
    expect(screen.queryByText(/No rate confirmation/)).toBeNull();
    const pdf = screen.getByRole('checkbox', { name: /Invoice PDF/ });
    expect(pdf).toBeChecked();
    expect(pdf).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /ratecon\.pdf/ })).toBeChecked();
    const lumper = screen.getByRole('checkbox', { name: /lumper\.pdf/ });
    expect(lumper).not.toBeChecked();
    fireEvent.click(lumper);
    expect(screen.getByText(/3 of 5 files/)).toBeInTheDocument();
    expect(screen.getByLabelText('Subject')).toHaveValue(PACKET.subject);
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Invoice 1001 for purchase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send packet' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/invoices/i1/send-to-factoring', {
      documentIds: ['d1', 'd2'], subject: 'Invoice 1001 for purchase', body: PACKET.body,
    }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('cannot send until the factoring company has a submission email', async () => {
    api.get.mockResolvedValue({ ...PACKET, to: null, company: { id: 'f1', name: 'Apex Capital', submitEmail: null }, problem: 'Add the factoring company’s submission email on the carrier’s profile' });
    wrap(<SendToFactoringModal invoice={INVOICE} onClose={() => {}} />);
    expect(await screen.findByText('Add the factoring company’s submission email on the carrier’s profile.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the customer profile' })).toHaveAttribute('href', '/app/customers/cu1');
    expect(screen.getByRole('button', { name: 'Send packet' })).toBeDisabled();
  });
});

describe('Factoring payments', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.post.mockResolvedValue({ invoice: { ...INVOICE, status: 'partial' } });
  });

  const TERMS = { companyId: 'f1', companyName: 'Apex Capital', advancePct: 90, feePct: 3, suggested: { advanceCents: 189000, feeCents: 6300, reserveCents: 14700 } };
  const SENT = { ...INVOICE, status: 'sent' };

  it('records an advance from the carrier terms', async () => {
    wrap(<PaymentModal invoice={SENT} terms={TERMS} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('Type'));
    fireEvent.click(await screen.findByRole('option', { name: 'Advance from factoring' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use carrier terms' }));
    expect(screen.getByLabelText('Amount received ($)')).toHaveValue(1890);
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/invoices/i1/payments', expect.objectContaining({ amountCents: 189000, kind: 'advance' })));
  });

  it('labels the factoring fee as a fee, not money received', async () => {
    wrap(<PaymentModal invoice={SENT} terms={TERMS} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('Type'));
    fireEvent.click(await screen.findByRole('option', { name: 'Factoring fee' }));
    expect(screen.getByText(/It settles that part of the invoice but is not money received/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use carrier terms' }));
    expect(screen.getByLabelText('Fee amount ($)')).toHaveValue(63);
    fireEvent.click(screen.getByRole('button', { name: 'Record fee' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/invoices/i1/payments', expect.objectContaining({ amountCents: 6300, kind: 'fee' })));
  });

  it('has no type choice for a carrier that does not factor, and shows the factoring summary', () => {
    const { unmount } = wrap(<PaymentModal invoice={SENT} terms={null} onClose={() => {}} />);
    expect(screen.queryByLabelText('Type')).toBeNull();
    unmount();
    wrap(<FactoringSummary summary={{ companyName: 'Apex Capital', submittedAt: null, advancedCents: 189000, feeCents: 6300, reserveReleasedCents: 0, reservePendingCents: 14700 }} />);
    expect(screen.getByText('Factoring · Apex Capital')).toBeInTheDocument();
    expect(screen.getByText('$1,890.00')).toBeInTheDocument();
    expect(screen.getByText('Reserve still due')).toBeInTheDocument();
    expect(screen.getByText('$147.00')).toBeInTheDocument();
  });
});
