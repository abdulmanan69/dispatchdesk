import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const get = vi.fn();
const post = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
vi.mock('../../lib/api.js', () => ({ api: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn(), del: vi.fn() } }));
vi.mock('../../components/Toast.jsx', () => ({ useToast: () => toast }));
vi.mock('../../components/Modal.jsx', () => ({
  useConfirm: () => vi.fn(),
  Modal: ({ open, title, children, footer }) => (open ? <div role="dialog" aria-label={title}>{children}{footer}</div> : null),
}));
vi.mock('../../components/carriers/EnrollModal.jsx', () => ({ default: () => null }));
vi.mock('../../components/carriers/FmcsaProfile.jsx', () => ({ FmcsaProfileButton: () => null }));

const { default: LeadGenerator, RunSummary } = await import('./LeadGenerator.jsx');

const ALL_CHECKED = 'All 14 carriers matching these filters were checked: 9 already in your CRM, 5 authority not active. Widen the filters (more states, a longer authority age range, fewer contact requirements) to find more.';
const CONTINUES = 'Added 0 new leads. Read 1,000 carriers this run; the next run continues where this one stopped.';
const run = (extra) => ({
  id: 'r1', generatorId: 'g1', trigger: 'manual', status: 'ok', scanned: 0, created: 0, skipped: 0, belowScore: 0, inactiveAuthority: 0,
  message: null, createdAt: '2026-11-13T10:00:00Z', carrierIds: [], ...extra,
});
const GEN = {
  id: 'g1', name: 'Ohio reefers', criteria: { states: ['OH'], cargo: [], requirePhone: true, requireMc: true, activeOnly: true },
  batchSize: 25, stageKey: 'lead', minScore: 40, list: null, sequence: null, autoRun: false, frequency: 'daily', lastRun: null,
};
const ENT = { planKey: 'free', planName: 'Free', monthlyLimit: 50, usedThisMonth: 0, maxGenerators: 1, generators: 1, autoRun: false };

describe('lead generator run summary', () => {
  beforeEach(() => {
    get.mockReset(); post.mockReset(); Object.values(toast).forEach((f) => f.mockReset());
  });

  it('every matching carrier checked: the message carries the counts, nothing about 600', () => {
    const { container } = render(<RunSummary run={run({ status: 'exhausted', scanned: 14, skipped: 9, inactiveAuthority: 5, message: ALL_CHECKED })} />);
    expect(screen.getByText('All matches checked')).toBeInTheDocument();
    expect(screen.getByText(ALL_CHECKED)).toBeInTheDocument();
    // The counts are in the message; the summary does not repeat them.
    expect(screen.queryByText(/carriers read ·/)).toBeNull();
    expect(container.textContent).not.toMatch(/600/);
    expect(container.textContent).not.toMatch(/census records/);
  });

  it('stopped at the per-run cap: counts and "the next run continues"', () => {
    render(<RunSummary run={run({ scanned: 1000, skipped: 1000, message: CONTINUES })} />);
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('1,000 carriers read · 1,000 already in CRM · 0 below score')).toBeInTheDocument();
    expect(screen.getByText(CONTINUES)).toBeInTheDocument();
  });

  it('a failed run shows its message without counts', () => {
    render(<RunSummary run={run({ status: 'error', message: 'Could not verify operating authority with FMCSA right now. No leads were added; try again in a few minutes.' })} />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.queryByText(/carriers read/)).toBeNull();
    expect(screen.getByText(/No leads were added/)).toBeInTheDocument();
  });

  it('"Run now" opens the result with the server message', async () => {
    get.mockImplementation(async (url) => {
      if (url === '/api/lead-generators') return { items: [GEN], entitlements: ENT, cargoOptions: [] };
      if (url === '/api/lead-generators/runs') return { items: [] };
      throw new Error(`unexpected ${url}`);
    });
    post.mockResolvedValue({ run: run({ status: 'exhausted', scanned: 14, skipped: 9, inactiveAuthority: 5, message: ALL_CHECKED }), carriers: [], entitlements: ENT });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><MemoryRouter><LeadGenerator /></MemoryRouter></QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /Run now/ }));
    const dialog = await screen.findByRole('dialog', { name: '0 new leads' });
    expect(post).toHaveBeenCalledWith('/api/lead-generators/g1/run');
    expect(within(dialog).getByText(ALL_CHECKED)).toBeInTheDocument();
    expect(within(dialog).getByText('All matches checked')).toBeInTheDocument();
    await waitFor(() => expect(dialog.textContent).not.toMatch(/600/));
  });
});
