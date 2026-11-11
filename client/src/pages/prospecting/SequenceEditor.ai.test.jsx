import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
vi.mock('../../components/Toast.jsx', () => ({ useToast: () => toast }));
vi.mock('../../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'Dana Ruiz' }, can: () => true }) }));

const { ConfirmProvider } = await import('../../components/Modal.jsx');
const { default: SequenceEditor } = await import('./SequenceEditor.jsx');

const SEQUENCE = {
  id: 's1', name: 'New authority', description: null, active: true, respectBusinessHours: true, windowStartHour: 9, windowEndHour: 17,
  skipWeekends: true, maxEmailsPerDay: 50,
  steps: [
    { id: 'st1', order: 0, dayOffset: 0, type: 'email', templateId: null, subject: 'Hi {{company}}', body: 'Template body', instructions: null, aiMode: null, aiBrief: null },
    { id: 'st2', order: 1, dayOffset: 2, type: 'email', templateId: null, subject: null, body: null, instructions: null, aiMode: 'review', aiBrief: 'Follow up, ask for a call' },
  ],
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/app/sequences/s1']}>
        <ConfirmProvider>
          <Routes><Route path="/app/sequences/:id" element={<SequenceEditor />} /></Routes>
        </ConfirmProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  for (const fn of Object.values(toast)) fn.mockReset();
  api.get.mockImplementation(async (url) => {
    if (url === '/api/sequences/s1') return { sequence: SEQUENCE, enrollments: {}, midSequence: 0, emails: {} };
    if (url === '/api/email/templates') return { items: [] };
    if (url === '/api/carriers') return { items: [{ id: 'c9', companyName: 'Red River Transport' }], total: 1 };
    throw new Error(`unexpected GET ${url}`);
  });
  api.put.mockResolvedValue({ sequence: SEQUENCE, remapped: { moved: 0, completed: 0, retimed: 0 } });
});

describe('SequenceEditor AI steps', () => {
  it('shows "Written by" with the brief for AI steps and saves aiMode and aiBrief', async () => {
    renderPage();
    expect(await screen.findByDisplayValue('Follow up, ask for a call')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Written by')).toHaveLength(2);
    expect(screen.getByText('Fallback template')).toBeInTheDocument();

    // Switch step 1 from the template to "AI writes and sends" and write its brief.
    fireEvent.click(screen.getAllByLabelText('Written by')[0]);
    fireEvent.click(await screen.findByRole('option', { name: 'AI writes and sends' }));
    const brief = await screen.findAllByLabelText(/What should this email say/);
    expect(brief).toHaveLength(2);
    fireEvent.change(brief[0], { target: { value: 'Introduce my dispatch service' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const steps = api.put.mock.calls[0][1].steps;
    expect(steps[0]).toMatchObject({ id: 'st1', aiMode: 'auto', aiBrief: 'Introduce my dispatch service', subject: 'Hi {{company}}', body: 'Template body' });
    expect(steps[1]).toMatchObject({ id: 'st2', aiMode: 'review', aiBrief: 'Follow up, ask for a call' });
  });

  it('previews an AI step for a chosen carrier with the brief on screen', async () => {
    api.post.mockResolvedValue({ subject: 'Quick question, Red River', body: 'Hi there,\n\nFollowing up.\n\nBest,', flagged: [] });
    renderPage();
    fireEvent.change(await screen.findByDisplayValue('Follow up, ask for a call'), { target: { value: 'Follow up, offer a trial week' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview for a carrier' }));
    const dialog = await screen.findByRole('dialog', { name: 'Preview AI email' });
    const picker = within(dialog).getByLabelText('Carrier');
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'Red' } });
    fireEvent.mouseDown(await within(dialog).findByRole('option', { name: /Red River Transport/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Write preview' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/sequences/s1/steps/st2/ai-preview', { carrierId: 'c9', aiBrief: 'Follow up, offer a trial week' }));
    expect(await within(dialog).findByText('Quick question, Red River')).toBeInTheDocument();
  });
});
