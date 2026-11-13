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

  it('lists the other reasons carriers were left out under the counts, never for an exhausted run', () => {
    const exclusions = { sharedContact: 3, unsafe: 0, outOfService: 1, filtered: 12, teamClaimed: 2, suppressed: 1, inactiveAuthority: 4 };
    const { rerender } = render(<RunSummary run={run({ scanned: 200, skipped: 20, inactiveAuthority: 4, exclusions, message: CONTINUES })} />);
    expect(screen.getByText('200 carriers read · 20 already in CRM · 0 below score · 4 skipped: authority not active')).toBeInTheDocument();
    expect(screen.getByText('Also left out: 3 shared contact (likely has a dispatcher) · 1 out of service · 12 outside your filters · 2 with teammates · 1 on your do-not-contact lists')).toBeInTheDocument();
    rerender(<RunSummary run={run({ status: 'exhausted', scanned: 14, skipped: 9, exclusions, message: ALL_CHECKED })} />);
    expect(screen.queryByText(/Also left out/)).toBeNull();
    rerender(<RunSummary run={run({ scanned: 1000, skipped: 1000, exclusions: { sharedContact: 0 }, message: CONTINUES })} />);
    expect(screen.queryByText(/Also left out/)).toBeNull();
  });
});

const PLAYBOOKS = [
  {
    key: 'new_mc_launch', title: 'New MC launch', why: 'MC granted 30–120 days ago. Brokers often turn them away.', sets: '1–5 trucks · MC 30–120 days · cell phone or email',
    criteria: {
      cargo: [], minPowerUnits: 1, maxPowerUnits: 5, authorityAgeMinMonths: null, authorityAgeMaxMonths: null, requirePhone: false, requireEmail: false, requireMc: true, activeOnly: true,
      zipPrefixes: [], counties: [], interstateOnly: true, forHireOnly: false, hazmat: 'any', minDrivers: null, maxDrivers: null, minCdlDrivers: null, maxMilesPerTruck: null,
      mcs150WithinMonths: null, excludeRatings: ['U'], mcAgeMinDays: 30, mcAgeMaxDays: 120, requireCell: false, requireCellOrEmail: true, excludeSharedContacts: true,
      excludeEmail: 'none', equipment: [], insurers: [], insurerMode: 'include', playbook: 'new_mc_launch',
    },
    weights: { need: 45, fit: 20, reach: 25, quality: 10 }, minScore: 55, pickEquipment: false,
  },
  {
    key: 'owner_operators', title: 'Owner-operators by equipment', why: 'One to three trucks and the owner drives.', sets: '1–3 trucks · pick equipment',
    criteria: { minPowerUnits: 1, maxPowerUnits: 3, requireMc: true, requirePhone: true, equipment: ['dry_van'], playbook: 'owner_operators' },
    weights: { need: 30, fit: 35, reach: 25, quality: 10 }, minScore: 55, pickEquipment: true,
  },
];
const LEAD = {
  dotNumber: '7001', companyName: 'FRESH START TRUCKING LLC', mcNumber: '1500001', city: 'AUSTIN', state: 'TX', fleetSize: 1, phone: '5125550101', cellPhone: '5125550199',
  authorityStatus: 'active', operatingStatus: 'Authority active · insurance on file', score: 88, tier: 'A', scoreReasons: ['New MC · 45 days', 'Cell phone'],
  signals: [
    { key: 'new_authority', label: 'New MC · 45 days', points: 32, group: 'need', tone: 'good' },
    { key: 'cell_phone', label: 'Cell phone', points: 14, group: 'reach', tone: 'good' },
    { key: 'eq_reefer', label: 'Reefer', points: 4, group: 'fit', tone: 'good' },
  ],
};

describe('lead generator editor', () => {
  beforeEach(() => {
    get.mockReset(); post.mockReset(); Object.values(toast).forEach((f) => f.mockReset());
    get.mockImplementation(async (url) => {
      if (url === '/api/lead-generators') return { items: [], entitlements: { ...ENT, generators: 0 }, cargoOptions: [], playbooks: PLAYBOOKS, equipmentOptions: [], insurerSuggestions: ['Progressive'] };
      return { items: [] };
    });
  });

  function openEditor() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><MemoryRouter><LeadGenerator /></MemoryRouter></QueryClientProvider>);
  }

  it('a playbook card sets the filters and the minimum score; the preview shows tiers and signal chips, best first', async () => {
    post.mockResolvedValue({
      items: [{ ...LEAD, dotNumber: '7002', companyName: 'SLOW HAUL LLC', score: 40, tier: 'C', signals: [{ key: 'shared_contact', label: 'Shared contact · 7 carriers', points: -20, group: 'need', tone: 'bad' }] }, LEAD],
      scanned: 120, skipped: 3, belowScore: 5, inactiveAuthority: 0, sharedContact: 7, unsafe: 1, outOfService: 0, filtered: 9, teamClaimed: 0, suppressed: 0,
      exhausted: false, note: null, authorityError: null, source: 'FMCSA Company Census (public)',
    });
    openEditor();
    fireEvent.click(await screen.findByRole('button', { name: /Create your first generator/ }));
    const dialog = await screen.findByRole('dialog', { name: 'New lead generator' });
    const card = within(dialog).getByRole('button', { name: /New MC launch/ });
    expect(card).toHaveTextContent('1–5 trucks · MC 30–120 days · cell phone or email');
    fireEvent.click(card);
    expect(card).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'TX' }));
    fireEvent.click(screen.getByRole('button', { name: /Preview matches/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/lead-generators/preview', {
      criteria: expect.objectContaining({
        states: ['TX'], playbook: 'new_mc_launch', minPowerUnits: 1, maxPowerUnits: 5, mcAgeMinDays: 30, mcAgeMaxDays: 120,
        requireCellOrEmail: true, interstateOnly: true, excludeSharedContacts: true, excludeRatings: ['U'], requirePhone: false,
      }),
      minScore: 55,
    }));
    expect(await screen.findByText('A · 88')).toBeInTheDocument();
    expect(screen.getByText('New MC · 45 days')).toBeInTheDocument();
    expect(screen.getByText('Shared contact · 7 carriers')).toHaveClass('text-c-red');
    expect(screen.getByText(/7 shared contact \(likely has a dispatcher\) · 1 unsafe safety rating · 9 outside your filters/)).toBeInTheDocument();
    // Best lead first.
    const names = screen.getAllByText(/^(FRESH START TRUCKING LLC|SLOW HAUL LLC)$/).map((el) => el.textContent);
    expect(names[0]).toBe('FRESH START TRUCKING LLC');
  });

  it('a playbook that asks for equipment shows the equipment picker', async () => {
    openEditor();
    fireEvent.click(await screen.findByRole('button', { name: /Create your first generator/ }));
    const dialog = await screen.findByRole('dialog', { name: 'New lead generator' });
    expect(within(dialog).queryByText('Equipment you book')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: /Owner-operators by equipment/ }));
    expect(within(dialog).getByText('Equipment you book')).toBeInTheDocument();
    const picker = within(dialog).getAllByRole('group', { name: 'Equipment' })[0];
    expect(within(picker).getByRole('button', { name: 'Dry van' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(picker).getByRole('button', { name: 'Reefer' }));
    expect(within(picker).getByRole('button', { name: 'Reefer' })).toHaveAttribute('aria-pressed', 'true');
    // Clicking the chosen card again turns the playbook off and keeps the filters.
    fireEvent.click(within(dialog).getByRole('button', { name: /Owner-operators by equipment/ }));
    expect(within(dialog).queryByText('Equipment you book')).toBeNull();
  });
});
