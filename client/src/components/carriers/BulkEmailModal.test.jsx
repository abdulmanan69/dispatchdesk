import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const post = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
vi.mock('../../lib/api.js', () => ({ api: { post: (...a) => post(...a) } }));
vi.mock('../Toast.jsx', () => ({ useToast: () => toast }));
vi.mock('../templates/TemplatePicker.jsx', () => ({ default: () => null }));

const { default: BulkEmailModal, capacityLine } = await import('./BulkEmailModal.jsx');

const REVIEW = {
  requested: 2, inaccessible: 0, recipients: 1,
  capacity: { mailbox: { dailyLimit: 50, cooldownSeconds: 30 }, planLeftToday: 20, sendableToday: 20, mailboxLeftToday: 50, alreadyWaiting: 0 },
  mailbox: { id: 'm1', fromEmail: 'me@dispatch.test', label: 'Work' },
  // Every sample can be complete while another recipient lacks a field; missingFields carries that.
  samples: [{ carrierId: 'c2', name: 'Mc Haulers', toEmail: 'ops@mc.test', subject: 'MC 778899', body: 'Hi there', signature: null, unresolved: [], unknown: [] }],
  skipped: [{ id: 'c1', name: 'Open Road LLC', reason: 'Unfilled merge fields: mc' }],
  skippedCount: 1,
  missingFields: ['mc'],
};

function renderIt() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><MemoryRouter>
      <BulkEmailModal open onClose={() => {}} target={{ ids: ['c1', 'c2'] }} count={2} />
    </MemoryRouter></QueryClientProvider>,
  );
}

beforeEach(() => { post.mockReset(); Object.values(toast).forEach((f) => f.mockReset()); });

describe('BulkEmailModal', () => {
  it('warns about fields that have no value for some carriers even when the samples are complete', async () => {
    post.mockResolvedValue(REVIEW);
    renderIt();
    fireEvent.change(screen.getByLabelText(/Subject/), { target: { value: 'MC {{mc}}' } });
    fireEvent.change(screen.getByLabelText(/Message/), { target: { value: 'Hi {{first_name}}' } });
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));
    await waitFor(() => expect(screen.getByText(/has no value for some carriers/)).toBeInTheDocument());
    expect(post).toHaveBeenCalledWith('/api/carriers/bulk/email', expect.objectContaining({ ids: ['c1', 'c2'], subject: 'MC {{mc}}', dryRun: true }));
    expect(screen.getByText(/\{\{mc\}\} has no value for some carriers\. Their emails are not queued/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Queue 1 email' })).toBeEnabled();
  });

  it('explains when the emails go out', () => {
    expect(capacityLine(REVIEW.capacity, 1)).toBe('All 1 can go out today (mailbox 50 a day, 20 left on your plan today). Emails go out 30 seconds apart.');
    expect(capacityLine({ ...REVIEW.capacity, sendableToday: 5 }, 12)).toMatch(/^About 5 can go out today/);
  });
});
