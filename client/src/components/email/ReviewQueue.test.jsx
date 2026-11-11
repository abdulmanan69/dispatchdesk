import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../Toast.jsx';
import { ConfirmProvider } from '../Modal.jsx';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
const { default: ReviewQueue } = await import('./ReviewQueue.jsx');

const now = new Date().toISOString();
const ITEMS = [
  {
    id: 'e1', status: 'review', aiGenerated: true, toEmail: 'ops@redriver.test', subject: 'Loads for Red River', body: 'Hi Marcus,\n\nShort intro.\n\nBest,', createdAt: now,
    carrier: { id: 'c1', companyName: 'Red River Transport' }, sequence: { id: 's1', name: 'New authority', ended: false }, note: null, needsWriting: false,
  },
  {
    id: 'e2', status: 'review', aiGenerated: false, toEmail: 'a@b.test', subject: 'Following up', body: 'Offer my service', createdAt: now,
    carrier: { id: 'c2', companyName: 'Blue Line LLC' }, sequence: { id: 's1', name: 'New authority', ended: false },
    note: 'AI could not write this email (AI is not set up). The text below is your brief: write the email, then approve it.', needsWriting: true,
  },
  {
    id: 'e3', status: 'review', aiGenerated: true, toEmail: 'c@d.test', subject: 'Checking in', body: 'Hello', createdAt: now,
    carrier: { id: 'c3', companyName: 'Gone Quiet Inc' }, sequence: { id: 's1', name: 'New authority', ended: true, endedReason: 'replied' }, note: null, needsWriting: false,
  },
];

function setup() {
  api.get.mockImplementation(async (url) => {
    if (url === '/api/email/review') return { items: ITEMS, total: ITEMS.length, page: 1, pages: 1 };
    throw new Error(`unexpected GET ${url}`);
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ConfirmProvider>
          <MemoryRouter><ReviewQueue /></MemoryRouter>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const table = () => screen.getByRole('table');

describe('ReviewQueue', () => {
  beforeEach(() => { for (const fn of Object.values(api)) fn.mockReset(); });

  it('lists waiting emails with the AI badge and their state', async () => {
    setup();
    const t = await screen.findByRole('table');
    const row = within(t).getByText('Loads for Red River').closest('tr');
    expect(within(row).getByText('AI')).toBeInTheDocument();
    expect(within(row).getByText('Ready')).toBeInTheDocument();
    expect(within(within(t).getByText('Following up').closest('tr')).getByText('Needs writing')).toBeInTheDocument();
    expect(within(within(t).getByText('Checking in').closest('tr')).getByText('Sequence ended')).toBeInTheDocument();
  });

  it('approves an edited email with its new subject and body', async () => {
    api.post.mockResolvedValue({ email: { id: 'e1', status: 'scheduled' }, message: 'Approved.' });
    setup();
    fireEvent.click(within(await screen.findByRole('table')).getByText('Loads for Red River'));
    const dialog = await screen.findByRole('dialog', { name: 'Review email' });
    fireEvent.change(within(dialog).getByLabelText('Subject'), { target: { value: 'Trucks for Red River' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve & send' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/email/messages/e1/approve', { subject: 'Trucks for Red River', body: ITEMS[0].body }));
  });

  it('keeps an unwritten brief and an ended sequence from being approved', async () => {
    setup();
    fireEvent.click(within(await screen.findByRole('table')).getByText('Following up'));
    let dialog = await screen.findByRole('dialog', { name: 'Review email' });
    expect(within(dialog).getByText(/AI could not write this email/)).toBeInTheDocument();
    const approve = within(dialog).getByRole('button', { name: 'Approve & send' });
    expect(approve).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/^Message/), { target: { value: 'Hi there,\n\nA real email.' } });
    expect(approve).toBeEnabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    fireEvent.click(within(table()).getByText('Checking in'));
    dialog = await screen.findByRole('dialog', { name: 'Review email' });
    expect(within(dialog).getByText(/sequence ended \(replied\)/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Approve & send' })).toBeDisabled();
  });

  it('rejects after saying the carrier leaves the sequence', async () => {
    api.post.mockResolvedValue({ email: { id: 'e1', status: 'canceled' }, stopped: 1, canceled: 0 });
    setup();
    fireEvent.click(within(await screen.findByRole('table')).getByText('Loads for Red River'));
    const dialog = await screen.findByRole('dialog', { name: 'Review email' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));
    const ask = await screen.findByRole('dialog', { name: 'Reject this email?' });
    expect(ask).toHaveTextContent('Red River Transport leaves the sequence "New authority"');
    fireEvent.click(within(ask).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/email/messages/e1/reject'));
  });

  it('approves the selected emails in bulk', async () => {
    api.post.mockResolvedValue({ approved: 1, skipped: [{ id: 'e2', reason: 'Needs writing first: the AI could not write it' }], message: '1 email(s) approved.' });
    setup();
    const t = await screen.findByRole('table');
    const boxes = within(t).getAllByRole('checkbox', { name: 'Select row' });
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Approve selected (2)' }));
    const ask = await screen.findByRole('dialog', { name: 'Approve and send 2 emails?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Approve & send' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/email/review/approve-bulk', { ids: ['e1', 'e2'] }));
    expect(await screen.findByText(/1 approved, 1 not approved: Needs writing first/)).toBeInTheDocument();
  });
});
