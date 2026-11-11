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
    { id: 'st1', order: 0, dayOffset: 0, type: 'call', templateId: null, subject: null, body: null, instructions: 'Intro call' },
    { id: 'st2', order: 1, dayOffset: 2, type: 'task', templateId: null, subject: null, body: null, instructions: 'Check back' },
  ],
};

let detail;
function get(url) {
  if (url === '/api/sequences/s1') return detail;
  if (url === '/api/email/templates') return { items: [] };
  if (url === '/api/sequences/s1/enrollments') {
    return {
      items: [{ id: 'e1', status: 'active', currentStep: 1, nextStepAt: new Date().toISOString(), carrier: { id: 'c1', companyName: 'Red River Transport' }, step: { order: 2, type: 'task' } }],
      total: 1, page: 1, pages: 1,
    };
  }
  throw new Error(`unexpected GET ${url}`);
}

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
  detail = { sequence: SEQUENCE, enrollments: { active: 2, paused: 1 }, midSequence: 3, emails: {} };
  for (const fn of Object.values(api)) fn.mockReset();
  for (const fn of Object.values(toast)) fn.mockReset();
  api.get.mockImplementation(async (url) => get(url));
  api.put.mockResolvedValue({ sequence: SEQUENCE, remapped: { moved: 2, completed: 0, retimed: 1 } });
  api.post.mockResolvedValue({ ok: true });
});

describe('SequenceEditor', () => {
  it('asks before editing a running sequence, then saves with the step ids so carriers keep their step', async () => {
    renderPage();
    fireEvent.change(await screen.findByDisplayValue('Intro call'), { target: { value: 'Intro call, confirm lanes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    const dialog = await screen.findByRole('dialog', { name: 'Change the steps of a running sequence?' });
    expect(dialog).toHaveTextContent('3 carriers are mid-sequence.');
    expect(api.put).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const [url, body] = api.put.mock.calls[0];
    expect(url).toBe('/api/sequences/s1');
    expect(body.steps.map((s) => s.id)).toEqual(['st1', 'st2']);
    expect(body.steps[0]).toMatchObject({ id: 'st1', type: 'call', dayOffset: 0, instructions: 'Intro call, confirm lanes', templateId: null });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Sequence saved. Carriers in it: 2 moved with their step, 1 re-timed.'));
  });

  it('cancelling the warning saves nothing', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Skip weekends' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Change the timing of a running sequence?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.put).not.toHaveBeenCalled();
  });

  it('saves at once when no carrier is mid-sequence', async () => {
    detail = { ...detail, enrollments: {}, midSequence: 0 };
    renderPage();
    fireEvent.change(await screen.findByDisplayValue('Check back'), { target: { value: 'Final check' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.put.mock.calls[0][1].steps.map((s) => s.id)).toEqual(['st1', 'st2']);
  });

  it('sends the step on screen when a step is marked done, so a stale click cannot complete the next one', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: /Enrollments/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Step done' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/sequences/enrollments/e1/complete-step', { stepIndex: 1 }));
  });
});
