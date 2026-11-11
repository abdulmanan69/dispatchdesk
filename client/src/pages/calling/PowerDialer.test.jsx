import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
vi.mock('../../components/Toast.jsx', () => ({ useToast: () => toast }));
vi.mock('../../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'Dana Ruiz' } }) }));

const { ConfirmProvider } = await import('../../components/Modal.jsx');
const { saveSession } = await import('../../components/calling/dialerSession.js');
const { default: PowerDialer } = await import('./PowerDialer.jsx');

const carrier = {
  id: 'c1', companyName: 'Red River Transport', phone: '3185550100', state: 'LA', timezone: 'America/Chicago', doNotCall: false,
  stage: { key: 'lead', name: 'All Leads', color: '#3b82f6' },
};
const STEPS = ['Check the FMCSA record', 'Send the packet'];
const taskItem = (index) => ({
  enrollmentId: 'e1', status: 'active', dueAt: new Date().toISOString(), carrier,
  sequence: { id: 's1', name: 'Intro', stepCount: 2 },
  step: { index, number: index + 1, type: 'task', day: index + 1, instructions: STEPS[index] },
});
let enrollment; // what GET /api/sequences/enrollments/e1 answers (the server's current step)

function get(url) {
  switch (url) {
    case '/api/prospecting/lists': return { items: [{ id: 'l1', name: 'Texas reefers', count: 1 }] };
    case '/api/sequences': return { items: [{ id: 's1', name: 'Intro', active: true }] };
    case '/api/telephony/settings': return { settings: { provider: 'tel', configured: true, autoAdvance: true } };
    case '/api/telephony/providers': return { items: [{ key: 'tel', label: 'Phone app' }] };
    case '/api/prospecting/lists/l1': return { list: { id: 'l1', name: 'Texas reefers' }, items: [{ carrier }] };
    case '/api/sequences/s1/session': return { sequence: { id: 's1', name: 'Intro', active: true }, dueToday: 1, upcoming: 0, items: [taskItem(0)] };
    case '/api/carriers/c1': return { carrier: { ...carrier, contacts: [], notes: [], calls: [], enrollments: [] } };
    case '/api/call-scripts': return { items: [] };
    case '/api/sequences/enrollments/e1': return { item: enrollment };
    default: throw new Error(`unexpected GET ${url}`);
  }
}

function renderAt(path) {
  // staleTime as in main.jsx: the session's own copy of a step is used until something invalidates it.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15000 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <ConfirmProvider><PowerDialer /></ConfirmProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function startSequenceSession() {
  renderAt('/app/dialer?sequenceId=s1');
  await screen.findByText('Red River Transport');
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
}

beforeEach(() => {
  window.sessionStorage.clear();
  enrollment = taskItem(0);
  api.get.mockReset();
  api.post.mockReset();
  api.get.mockImplementation(async (url) => get(url));
  for (const fn of Object.values(toast)) fn.mockReset();
});

describe('PowerDialer', () => {
  it('starts with the prospect list named in ?listId=', async () => {
    renderAt('/app/dialer?listId=l1');
    expect(await screen.findByText('Red River Transport')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/api/prospecting/lists/l1', { pageSize: 200 });
    expect(screen.queryByText(/Unfinished session/)).not.toBeInTheDocument();
  });

  it('offers a saved session for another source instead of resuming it when a list is linked', async () => {
    saveSession('u1', { source: 'queue', includeUpcoming: false, session: { items: [{ key: 'k1', carrier, reason: 'Hot lead' }], index: 0, results: [], skipped: 0 } });
    renderAt('/app/dialer?listId=l1');
    expect(await screen.findByText(/Unfinished session/)).toBeInTheDocument();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/api/prospecting/lists/l1', { pageSize: 200 }));
    expect(api.get).not.toHaveBeenCalledWith('/api/prospecting/queue', expect.anything());
  });

  it('marks a sequence carrier as replied after a confirmation and moves on', async () => {
    api.post.mockImplementation(async (url) => {
      if (url === '/api/carriers/c1/replied') return { ok: true, stopped: 1, emailId: null };
      throw new Error(`unexpected POST ${url}`);
    });
    await startSequenceSession();
    fireEvent.click(await screen.findByRole('button', { name: 'Mark replied' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/stops its running sequences/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark replied' }));
    expect(await screen.findByText('Session finished')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/api/carriers/c1/replied');
    expect(screen.getByText('Replies logged')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('Red River Transport: reply logged and 1 sequence stopped');
  });

  it('sends the step on screen and shows the current step when the server says it moved on (409)', async () => {
    enrollment = taskItem(1); // the scheduler or another tab already completed step 1
    api.post.mockImplementation(async (url) => {
      if (url === '/api/sequences/enrollments/e1/complete-step') throw Object.assign(new Error('This step was already completed or changed. Refresh and try again.'), { status: 409 });
      throw new Error(`unexpected POST ${url}`);
    });
    await startSequenceSession();
    expect(await screen.findByText('Check the FMCSA record')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/sequences/enrollments/e1/complete-step', { stepIndex: 0 }));
    expect(await screen.findByText('Send the packet')).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalled();
    expect(screen.queryByText('Session finished')).not.toBeInTheDocument();
  });
});
