import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../Toast.jsx';
import { ConfirmProvider } from '../Modal.jsx';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
const { default: FactoringCard, termsExample } = await import('./FactoringCard.jsx');

const APEX = { id: 'f1', ownerId: 'u1', name: 'Apex Capital', submitEmail: 'invoices@apex.test', remitTo: 'PO Box 961029\nFort Worth, TX 76161', phone: '8005551000', website: null, notes: null, carrierCount: 2 };
const RTS = { id: 'f2', ownerId: 'u1', name: 'RTS Financial', submitEmail: null, remitTo: null, phone: null, website: null, notes: null, carrierCount: 0 };
const BASE = {
  id: 'cu1', carrierId: 'c1', ownerId: 'u1', factoringCompanyId: null, factoringCompany: null, factoringClientNo: null,
  factoringAdvancePct: null, factoringFeePct: null, factoringRecourse: null, noa: { onFile: false, documentId: null, uploadedAt: null },
};

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><ToastProvider><ConfirmProvider>{ui}</ConfirmProvider></ToastProvider></MemoryRouter></QueryClientProvider>);
}

describe('FactoringCard', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    api.get.mockImplementation((url) => Promise.resolve(url === '/api/factoring-companies' ? { items: [APEX, RTS] } : {}));
    api.patch.mockResolvedValue({ customer: BASE });
  });

  it('works out the example in plain words', () => {
    expect(termsExample('90', '3')).toBe('On a $2,000 invoice: $1,800.00 advance, $60.00 factoring fee, $140.00 reserve released later.');
    expect(termsExample('', '3')).toBeNull();
    expect(termsExample('98', '3')).toBeNull();
  });

  it('starts as "does not factor", then links a company with its terms', async () => {
    const onDocuments = vi.fn();
    wrap(<FactoringCard customer={BASE} onDocuments={onDocuments} />);
    expect(screen.getAllByText('Does not factor').length).toBeGreaterThan(0);
    expect(screen.getByText(/the broker pays the carrier directly/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Client number')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save factoring' })).toBeDisabled();

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/factoring-companies', { customerId: 'cu1' }, expect.anything()));
    await waitFor(() => expect(screen.getByLabelText('Factoring company')).toBeEnabled());
    fireEvent.click(screen.getByLabelText('Factoring company'));
    fireEvent.click(await screen.findByRole('option', { name: 'Apex Capital' }));
    expect(screen.getByText('invoices@apex.test')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Client number'), { target: { value: 'BL-2231' } });
    fireEvent.change(screen.getByLabelText('Advance (%)'), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText('Factoring fee (%)'), { target: { value: '3' } });
    expect(screen.getByText(/\$1,800\.00 advance, \$60\.00 factoring fee, \$140\.00 reserve released later/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Recourse'));
    fireEvent.click(await screen.findByRole('option', { name: 'Non-recourse' }));

    expect(screen.getByText('No NOA uploaded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Documents' }));
    expect(onDocuments).toHaveBeenCalled();

    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save factoring' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/customers/cu1', {
      factoringCompanyId: 'f1', factoringClientNo: 'BL-2231', factoringAdvancePct: 90, factoringFeePct: 3, factoringRecourse: false,
    }));
  });

  it('refuses an advance plus fee over 100% and warns when the company has no submission email', async () => {
    wrap(<FactoringCard customer={{ ...BASE, factoringCompanyId: 'f2', factoringCompany: { id: 'f2', name: 'RTS Financial', submitEmail: null, remitTo: null, phone: null } }} />);
    expect(await screen.findByText(/Add the submission email to send invoice packets/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Advance (%)'), { target: { value: '98' } });
    fireEvent.change(screen.getByLabelText('Factoring fee (%)'), { target: { value: '5' } });
    expect(screen.getByText('Advance plus fee is more than 100%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save factoring' })).toBeDisabled();
  });

  it('shows the saved company and the NOA on file', async () => {
    wrap(<FactoringCard customer={{ ...BASE, factoringCompanyId: 'f1', factoringCompany: APEX, factoringClientNo: 'BL-2231', factoringAdvancePct: 90, factoringFeePct: 3, factoringRecourse: true, noa: { onFile: true, documentId: 'd9', uploadedAt: '2026-11-02T15:00:00.000Z' } }} />);
    expect(screen.getByText(/Invoices for this carrier are paid to the factoring company\. DispatchDesk fills the remit-to and can send the paperwork for you\./)).toBeInTheDocument();
    expect(screen.getByText(/^NOA on file · Nov 2, 2026$/)).toBeInTheDocument();
    expect(screen.getByLabelText('Client number')).toHaveValue('BL-2231');
    expect(screen.getByRole('button', { name: 'Save factoring' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit company' })).toBeInTheDocument();
  });

  it('adds a factoring company for the customer’s owner and picks it', async () => {
    const TRIUMPH = { id: 'f3', ownerId: 'u1', name: 'Triumph', submitEmail: 'docs@triumph.test', remitTo: null, phone: null, website: null, notes: null, carrierCount: 0 };
    let added = false;
    api.post.mockImplementation(async () => { added = true; return { company: TRIUMPH }; });
    api.get.mockImplementation((url) => Promise.resolve(url === '/api/factoring-companies' ? { items: added ? [APEX, RTS, TRIUMPH] : [APEX, RTS] } : {}));
    wrap(<FactoringCard customer={BASE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add factoring company' }));
    const dialog = await screen.findByRole('dialog');
    const save = within(dialog).getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: 'Triumph' } });
    fireEvent.change(within(dialog).getByLabelText('Submission email'), { target: { value: 'docs@triumph.test' } });
    fireEvent.change(within(dialog).getByLabelText('Website'), { target: { value: 'https://triumph.test' } });
    fireEvent.click(save);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/factoring-companies', {
      name: 'Triumph', submitEmail: 'docs@triumph.test', remitTo: null, phone: null, website: 'https://triumph.test', notes: null, ownerId: 'u1',
    }));
    await waitFor(() => expect(screen.getByLabelText('Client number')).toBeInTheDocument());
    expect(screen.getByText('docs@triumph.test')).toBeInTheDocument();
  });
});
