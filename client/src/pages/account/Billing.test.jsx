import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

const data = vi.hoisted(() => {
  const MB = 1024 * 1024;
  const plan = {
    id: 1, key: 'free', name: 'Free', description: 'Start here', priceCents: 0, interval: 'month', perSeat: false, minSeats: 1, trialDays: 0, purchasable: false,
    limits: { maxCarriers: 500, dailyEmailLimit: 20, monthlyAiMessages: 30, maxSequences: 1, maxAutomations: 0, maxDiscoveryPerDay: 100, monthlyLeadGenLimit: 50, maxLeadGenerators: 1, storageMb: 500 },
    features: ['500 carrier records', '500 MB file storage'],
  };
  const usage = { carriers: 3, emailsToday: 1, aiMonth: 0, sequences: 0, automations: 0, discoveryToday: 0, leadGenMonth: 0, leadGenerators: 0 };
  return {
    MB,
    plans: { plans: [plan], paymentsEnabled: false },
    me: (usedBytes) => ({ plan, subscription: null, pendingSubscription: null, usage, storage: { usedBytes, limitBytes: 500 * MB, scope: 'user' }, payments: [], stripeMode: 'unconfigured' }),
    current: { usedBytes: 12 * MB },
  };
});

vi.mock('../../lib/api.js', () => ({
  api: { get: vi.fn(async (url) => (url === '/api/billing/me' ? data.me(data.current.usedBytes) : data.plans)), post: vi.fn() },
}));
vi.mock('../../context/AuthContext.jsx', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'Dee', timezone: 'America/Chicago', team: null } }) }));
const mutations = vi.hoisted(() => ({ calls: [] }));
vi.mock('../../lib/hooks.js', () => ({ useApiMutation: (fn) => ({ mutate: (v) => mutations.calls.push(fn.toString().match(/\/api\/billing\/[a-z-]+/)?.[0] + ' ' + JSON.stringify(v ?? null)), isPending: false }) }));
vi.mock('../../components/Modal.jsx', () => ({
  useConfirm: () => vi.fn(async () => false),
  Modal: ({ open, title, children, footer }) => (open ? <div role="dialog" aria-label={title}>{children}{footer}</div> : null),
}));

const { default: Billing } = await import('./Billing.jsx');

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><Billing /></MemoryRouter></QueryClientProvider>);
}

describe('Billing page storage', () => {
  it('shows file storage used against the plan allowance and when limits reset', async () => {
    data.current.usedBytes = 12 * data.MB;
    renderPage();
    expect(await screen.findByRole('progressbar', { name: 'File storage' })).toHaveAttribute('aria-valuenow', String(12 * data.MB));
    expect(screen.getByText('12 MB / 500 MB')).toBeInTheDocument();
    expect(screen.getByText(/reset at midnight in your time zone \(Chicago\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Storage is almost full/)).not.toBeInTheDocument();
  });

  it('warns when storage is almost full', async () => {
    data.current.usedBytes = 480 * data.MB;
    renderPage();
    expect(await screen.findByText('480 MB / 500 MB')).toBeInTheDocument();
    expect(screen.getByText(/Storage is almost full/)).toBeInTheDocument();
  });
});

describe('Billing page for a monthly Pro subscriber', () => {
  const pro = { ...data.me(0).plan, key: 'pro', name: 'Pro', priceCents: 999, interval: 'month', purchasable: true };
  const annual = { ...pro, key: 'annual', name: 'Annual', priceCents: 9590, interval: 'year' };
  const sub = { id: 's1', status: 'active', seats: 1, planKey: 'pro', isOwner: true, hasPortal: true, granted: false, cancelAtPeriodEnd: false, managedByTeam: false, provider: 'paddle' };
  async function setup() {
    const { api } = await import('../../lib/api.js');
    api.get.mockImplementation(async (url) => (url === '/api/billing/me'
      ? { ...data.me(0), plan: pro, subscription: sub, provider: 'paddle', paymentsEnabled: true }
      : { plans: [pro, annual], provider: 'paddle', paymentsEnabled: true, trial: { days: 14, planKey: 'pro' } }));
    renderPage();
  }

  it('offers the yearly plan and asks why when cancelling', async () => {
    await setup();
    expect(await screen.findByText('Save with Annual')).toBeInTheDocument();
    expect(screen.getByText(/\$95\.90 a year instead of \$119\.88/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));
    const dialog = screen.getByRole('dialog', { name: 'Cancel subscription?' });
    expect(dialog).toHaveTextContent(/read-only until you choose a plan again/);
    fireEvent.click(screen.getByLabelText('It costs too much'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel subscription' }).at(-1));
    expect(mutations.calls.at(-1)).toBe('/api/billing/cancel {"reason":"too_expensive"}');
  });
});
