import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const get = vi.fn();
vi.mock('../../lib/api.js', () => ({ api: { get: (...a) => get(...a) } }));
vi.mock('../calling/CallButton.jsx', () => ({ default: ({ phone }) => <a href={`tel:${phone}`}>{phone}</a> }));

const { default: FmcsaProfile, FmcsaProfileButton, FmcsaProfileTab } = await import('./FmcsaProfile.jsx');

const SOURCES = [
  { key: 'census', name: 'Company Census', dataset: 'az4n-8mr2', url: 'https://data.transportation.gov/d/az4n-8mr2', ok: true, status: 'ok', error: null, asOf: '2026-11-12T21:07:14.000Z', note: null },
  { key: 'licensing', name: 'Operating authority (legacy)', dataset: '6eyk-hxee', url: 'https://data.transportation.gov/d/6eyk-hxee', ok: true, status: 'ok', error: null, asOf: '2026-05-14', note: 'No longer updated by FMCSA after May 14, 2026' },
  { key: 'qh9u', name: 'Insurance on file (legacy)', dataset: 'qh9u-swkp', url: 'https://data.transportation.gov/d/qh9u-swkp', ok: false, status: 'failed', error: 'Answered 500', asOf: null, note: null },
  { key: 'qcmobile', name: 'QCMobile (live status and safety)', dataset: null, url: null, ok: false, status: 'skipped', error: 'Not set up', asOf: null, note: null },
];

const PROFILE = {
  v: 1, found: true, dot: '1775913', mc: '647991', fetchedAt: '2026-11-13T12:00:00.000Z', complete: false,
  saferUrl: 'https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=1775913',
  identity: { available: true, legalName: 'DERICK DORIAN MYRICK', dbaName: 'DAKOTA TRUCKING', usdotStatus: 'active', registeredAt: '2008-05-27', businessType: null, officers: ['DERICK DORIAN MYRICK'], dunsNumber: '6383', dockets: [{ docket: 'MC647991' }] },
  contact: {
    available: true, phone: '4043974031', cellPhone: null, fax: null, email: 'myrick767@gmail.com',
    physicalAddress: { street: '1317 STONE RUN', city: 'STONE MOUNTAIN', state: 'GA', zip: '30083' },
    mailingAddress: { street: '4501 RUSSWOOD AVE', city: 'SNELLVILLE', state: 'GA', zip: '30083' },
    physicalUndeliverable: true, mailingUndeliverableSince: null, licensing: null,
  },
  authority: {
    available: true, partial: false, status: 'inactive', code: 'inactive', label: 'Authority inactive', basis: 'legacy', legacyAsOf: '2026-05-14', docket: 'MC647991',
    types: [{ docket: 'MC647991', type: 'Contract carrier (property)', kind: 'carrier', status: 'inactive', source: 'legacy' }],
    insuranceOnFile: false, revocationPending: false, required: { bipd: 750000, cargo: false, bond: false }, filed: { bipd: 0, cargo: false, bond: false },
    since: '2008-07-17', ageDays: 6693, ageYears: 18.3, revokedBefore: true, lastRevokedAt: '2025-10-20', revocations: 2, historyPartial: false,
    history: [
      { date: '2025-10-20', docket: 'MC647991', type: 'Motor property contract carrier', kind: 'carrier', action: 'Revoked', source: 'legacy' },
      { date: '2021-07-29', docket: 'MC647991', type: 'Motor property contract carrier', kind: 'carrier', action: 'Reinstated', source: 'legacy' },
      { date: '2008-07-17', docket: 'MC647991', type: 'Motor property contract carrier', kind: 'carrier', action: 'Granted', source: 'legacy' },
    ],
  },
  insurance: {
    available: true, partial: true, onFile: null, required: { bipd: 750000, cargo: false, bond: false }, filed: { bipd: 0, cargo: false, bond: false },
    history: [{ category: 'bipd', type: 'BIPD (primary)', company: 'PROGRESSIVE MOUNTAIN INSURANCE COMPANY OF OHI', policy: 'CA971627453', coverage: 750000, effective: '2025-08-25', cancelEffective: '2025-10-14', reason: 'Cancelled' }],
    historyCount: 1, lapses: [{ from: '2023-07-20', to: '2025-08-25', days: 767 }], legacyAsOf: '2026-05-14',
  },
  operation: { available: true, carrierOperation: 'Interstate', classifications: ['Authorized for hire'], entityTypes: ['Carrier'], hazmat: false },
  cargo: ['General freight', 'Other: Appliances'],
  fleet: { available: true, powerUnits: 1, trucks: 1, buses: 0 },
  equipment: { available: true, rows: [{ kind: 'Trucks', owned: 1, termLeased: 0, tripLeased: 0 }, { kind: 'Tractors', owned: 0, termLeased: 2, tripLeased: 0 }, { kind: 'Trailers', owned: 0, termLeased: 0, tripLeased: 3 }] },
  drivers: { available: true, total: 1, cdl: 0, interstate: 1, intrastate: 0, interstateWithin100: 0, interstateBeyond100: 1, intrastateWithin100: 0, intrastateBeyond100: 0, avgLeasedPerMonth: null },
  mileage: { available: true, miles: 50000, year: 2024 },
  safety: { available: true, live: false, liveStatus: 'not_configured', rating: null, ratingDate: null, review: null, recordableCrashRate: null, allowedToOperate: null, oosDate: null, crashes: null, inspections: null, basics: null },
  compliance: { available: true, mcs150Date: '2025-11-05', mcs150AgeMonths: 12, outdated: false, priorRevoke: { flag: null, dot: null } },
  flags: [
    { level: 'red', code: 'authority_inactive', text: 'Operating authority inactive' },
    { level: 'red', code: 'no_insurance', text: 'No liability (BIPD) insurance on file' },
    { level: 'amber', code: 'revoked_before', text: 'Authority revoked before (Oct 20, 2025)' },
  ],
  sources: SOURCES,
};

const LIVE = {
  ...PROFILE, dot: '3100001', mc: '900001', complete: true,
  identity: { ...PROFILE.identity, legalName: 'PRAIRIE LINE TRANSPORT INC', dbaName: null },
  authority: { ...PROFILE.authority, status: 'active', code: 'active', label: 'Authority active, insurance on file', basis: 'motus', revokedBefore: false },
  insurance: { ...PROFILE.insurance, onFile: [{ category: 'bipd', type: 'BIPD (excess)', company: 'Ace Excess Insurance Company', policy: 'XS-100', coverage: 4000000, underlying: 1000000, effective: '2025-08-01', cancelEffective: null }] },
  safety: {
    available: true, live: true, liveStatus: 'ok', rating: 'Satisfactory', ratingDate: '2019-04-02', review: { type: 'Compliance review', code: 'C', date: '2019-03-20' }, recordableCrashRate: 0.12,
    allowedToOperate: true, oosDate: null, crashes: { fatal: 1, injury: 4, tow: 7, total: 12 },
    inspections: { driver: { inspections: 400, oos: 12, oosRate: 3, nationalAvg: 5.5 }, vehicle: { inspections: 300, oos: 90, oosRate: 30, nationalAvg: 20.7 }, hazmat: { inspections: 0, oos: 0, oosRate: null, nationalAvg: 4.5 } },
    basics: [{ name: 'Unsafe Driving', percentile: 72, threshold: 65, alert: true }, { name: 'Crash Indicator', percentile: null, threshold: 65, alert: false }],
  },
  flags: [{ level: 'amber', code: 'high_oos_vehicle', text: 'Vehicle out-of-service rate 30% vs 20.7% national average' }, { level: 'green', code: 'authority_active', text: 'Authority active, insurance on file' }],
  sources: SOURCES.map((s) => ({ ...s, ok: true, status: 'ok' })),
};

const INSPECTIONS = {
  dot: '3100001', windowMonths: 24, minForRate: 5, nationalAvgAsOf: '2026-01-31', complete: true, detailCount: 1,
  summary: {
    inspections: 700, withViolations: 300, oosInspections: 100,
    driver: { inspections: 400, oos: 12, oosRate: 3, nationalAvg: 6.4 },
    vehicle: { inspections: 300, oos: 90, oosRate: 30, nationalAvg: 23.2 },
    hazmat: { inspections: 0, oos: 0, oosRate: null, nationalAvg: 4.4 },
  },
  byYear: [{ year: 2026, inspections: 400, oos: 60 }, { year: 2025, inspections: 300, oos: 40 }],
  byState: [{ state: 'TX', inspections: 500 }, { state: 'OK', inspections: 200 }],
  violationsByCategory: [{ key: 'vehicle_maintenance', label: 'Vehicle maintenance', violations: 20, oos: 5, inspections: 10 }],
  records: [{
    id: '88591735', date: '2026-07-31', reportNumber: 'PSC0881250', state: 'WV', location: 'Triadelphia WV', level: 2, levelLabel: 'Level II · walk-around',
    facility: 'Roadside', violations: 1, oosViolations: 1, postCrash: false, hazmat: false,
    units: [{ type: 'Truck tractor', make: 'Freightliner', license: 'ABC123', licenseState: 'TX', vin: '1FUJGLDR0CLBP8834' }],
    violationList: [{ code: '393.75A', description: 'Tire - flat', category: 'vehicle_maintenance', categoryLabel: 'Vehicle maintenance', oos: true, citation: false, unit: 'Truck tractor' }],
  }],
  equipment: [{ type: 'Truck tractor', year: 2012, make: 'Freightliner', model: 'Cascadia', license: 'ABC123', licenseState: 'TX', vin: '1FUJGLDR0CLBP8834', inspections: 1, oosInspections: 1, lastSeen: '2026-07-31' }],
  crashes: { total: 12, fatal: 1, injury: 4, tow: 7, records: [] },
  flags: [
    { level: 'amber', code: 'oos_vehicle', text: 'Vehicle out-of-service rate 30% vs 23.2% national average (300 inspections, 24 months)' },
    { level: 'red', code: 'fatal_crash', text: '1 fatal crash in the last 24 months' },
  ],
  sources: [],
};
const RELATED = {
  checked: ['phone', 'email', 'address'], total: 1, serviceShared: [],
  carriers: [{ dot: '2000001', mc: null, name: 'MYRICK HAULING', city: 'Stone Mountain', state: 'GA', usdotStatus: 'inactive', registeredAt: '2015-01-01', priorRevoke: false, matches: ['phone'] }],
  flags: [{ level: 'amber', code: 'related_inactive', text: 'Shares phone with 1 inactive or revoked carrier: check it is not a reincarnated carrier' }],
};
/** The profile answer for the profile URL; the inspection and related reports for theirs. */
const answer = (profileBody) => async (url) => {
  if (url.endsWith('/inspections')) return { report: INSPECTIONS };
  if (url.endsWith('/related')) return { related: RELATED };
  return profileBody;
};

function renderIt(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}
const section = (name) => screen.getByRole('button', { name }).closest('section');

beforeEach(() => { get.mockReset(); });

describe('FmcsaProfile', () => {
  it('shows the header with the authority badge, flags and data date, and every section', async () => {
    get.mockImplementation(answer({ profile: PROFILE, stored: true }));
    renderIt(<FmcsaProfile carrierId="c1" />);
    expect(await screen.findByRole('heading', { name: 'DERICK DORIAN MYRICK' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/api/carrier-profile/carrier/c1', undefined, expect.objectContaining({ timeoutMs: 90000 }));
    expect(screen.getByText('USDOT 1775913 · MC 647991')).toBeInTheDocument();
    // MC age from the authority history, in the header.
    expect(screen.getByTestId('mc-age')).toHaveTextContent(/MC age\s*18\.3 years · granted Jul 17, 2008/);
    expect(screen.getAllByText('Authority inactive')[0]).toHaveClass('text-c-red');
    // Verdict and checklist: each FMCSA flag lands on its row, the worst first.
    const vetting = screen.getByTestId('vetting');
    expect(within(vetting).getByText('Do not book')).toBeInTheDocument();
    const checklist = within(vetting).getByRole('list', { name: 'Vetting checklist' });
    const authorityRow = within(checklist).getByText('Operating authority').closest('li');
    expect(authorityRow).toHaveTextContent('Operating authority inactive');
    expect(authorityRow).toHaveTextContent('Authority revoked before (Oct 20, 2025)');
    expect(within(checklist).getByText('Insurance').closest('li')).toHaveTextContent('No liability (BIPD) insurance on file');
    // Related carriers and inspections load after the profile and join the checklist.
    expect(await within(checklist).findByText(/Shares phone with 1 inactive or revoked carrier/)).toBeInTheDocument();
    expect(within(checklist).getByText('Inspections and crashes').closest('li')).toHaveTextContent('1 fatal crash in the last 24 months');
    expect(screen.getByText(/Data as of/)).toBeInTheDocument();
    expect(screen.getByText(/Some FMCSA sources did not answer/)).toBeInTheDocument();

    for (const name of ['Company and contact', 'Authority', 'Insurance', 'Operation and cargo', 'Fleet and equipment', 'Drivers and mileage', 'Safety rating', 'Inspections and crashes (last 24 months)', 'Related carriers', 'Compliance', 'Sources']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    const company = section('Company and contact');
    expect(within(company).getByRole('link', { name: '4043974031' })).toHaveAttribute('href', 'tel:4043974031');
    expect(within(company).getByRole('link', { name: 'myrick767@gmail.com' })).toHaveAttribute('href', 'mailto:myrick767@gmail.com');
    expect(within(company).getByText('Undeliverable')).toBeInTheDocument();

    const authority = section('Authority');
    expect(within(authority).getByText('Jul 17, 2008 · 18.3 years')).toBeInTheDocument();
    expect(within(authority).getByText('Contract carrier (property)')).toBeInTheDocument();
    expect(within(authority).getByText('Revoked')).toBeInTheDocument();
    expect(within(authority).getByText(/stopped updating on May 14, 2026/)).toBeInTheDocument();

    const insurance = section('Insurance');
    expect(within(insurance).getByText('$750,000')).toBeInTheDocument();
    expect(within(insurance).getByText('None')).toBeInTheDocument();
    // Policies on file did not answer: that part says so; the history still shows.
    expect(within(insurance).getByText('Not available right now')).toBeInTheDocument();
    expect(within(insurance).getByText('Cancelled')).toBeInTheDocument();
    expect(within(insurance).getByText('Aug 25, 2025 to Oct 14, 2025')).toBeInTheDocument();
    expect(within(insurance).getByText('(767 days)')).toBeInTheDocument();

    const fleet = section('Fleet and equipment');
    const tractors = within(fleet).getByText('Tractors').closest('tr');
    expect(within(tractors).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Tractors', '0', '2', '0']);
    expect(within(section('Drivers and mileage')).getByText('50,000 miles in 2024')).toBeInTheDocument();
    expect(within(section('Operation and cargo')).getByText('Other: Appliances')).toBeInTheDocument();
    expect(within(section('Safety rating')).getByText(/needs the free FMCSA web key/)).toBeInTheDocument();
    expect(within(section('Related carriers')).getByText('MYRICK HAULING').closest('li')).toHaveTextContent('Same phone');
    expect(within(section('Compliance')).getByText('Nov 5, 2025')).toBeInTheDocument();

    const sources = section('Sources');
    expect(within(sources).getByText('Not available right now')).toHaveAttribute('title', 'Answered 500');
    expect(within(sources).getByText('Not set up')).toBeInTheDocument();
    expect(within(sources).getByText('as of May 14, 2026')).toBeInTheDocument();
    expect(within(sources).getByRole('link', { name: /SAFER snapshot/ })).toHaveAttribute('href', PROFILE.saferUrl);
  });

  it('shows live safety data: crashes, inspections against the national average, BASIC alerts', async () => {
    get.mockImplementation(answer({ profile: LIVE }));
    renderIt(<FmcsaProfile dot="3100001" />);
    await screen.findByRole('heading', { name: 'PRAIRIE LINE TRANSPORT INC' });
    expect(get).toHaveBeenCalledWith('/api/carrier-profile/dot/3100001', undefined, expect.anything());
    expect(screen.getAllByText('Authority active')[0]).toHaveClass('text-c-green');
    expect(screen.getAllByText('Allowed to operate')[0]).toHaveClass('text-c-green');
    expect(screen.getAllByText('Satisfactory rating').length).toBeGreaterThan(0);
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/carrier-profile/dot/3100001/inspections', undefined, expect.anything()));
    expect(get).toHaveBeenCalledWith('/api/carrier-profile/dot/3100001/related', undefined, expect.anything());
  });

  it('never shows a green "Allowed to operate" next to inactive authority', async () => {
    get.mockImplementation(answer({ profile: { ...PROFILE, safety: { ...PROFILE.safety, live: true, allowedToOperate: true } } }));
    renderIt(<FmcsaProfile dot="1775913" />);
    await screen.findByRole('heading', { name: 'DERICK DORIAN MYRICK' });
    expect(screen.getByText('USDOT not out of service')).not.toHaveClass('text-c-green');
    expect(screen.queryByText('Allowed to operate', { selector: '.text-c-green' })).toBeNull();
  });

  it('shows inspections against the national average, vehicles and reports, and the live safety section', async () => {
    get.mockImplementation(answer({ profile: LIVE }));
    renderIt(<FmcsaProfile dot="3100001" />);
    await screen.findByRole('heading', { name: 'PRAIRIE LINE TRANSPORT INC' });
    const inspections = (await screen.findByRole('button', { name: 'Inspections and crashes (last 24 months)' })).closest('section');
    const vehicle = within(inspections).getByRole('cell', { name: 'Vehicle' }).closest('tr');
    expect(within(vehicle).getByText('30%')).toHaveClass('text-c-amber');
    expect(within(within(inspections).getByRole('cell', { name: 'Driver' }).closest('tr')).getByText('3%')).toHaveClass('text-c-green');
    expect(within(inspections).getByText('2012 Freightliner Cascadia')).toBeInTheDocument();
    fireEvent.click(within(inspections).getByText(/Triadelphia WV/).closest('button'));
    expect(within(inspections).getByText('Tire - flat')).toBeInTheDocument();
    expect(screen.getByTestId('vetting')).toHaveTextContent('Do not book');
    const safety = section('Safety rating');
    expect(within(safety).getByText('Unsafe Driving').closest('li')).toHaveTextContent('Alert');
    expect(within(safety).getByText('Crash Indicator').closest('li')).toHaveTextContent('Not public');
    const policy = within(section('Insurance')).getByText('BIPD (excess)').closest('li');
    expect(policy).toHaveTextContent('$4,000,000 over $1,000,000');
    expect(policy).toHaveTextContent('Ace Excess Insurance Company');
  });

  it('Refresh asks FMCSA again and shows the new copy', async () => {
    get.mockImplementation(answer({ profile: PROFILE, stored: true }));
    renderIt(<FmcsaProfile carrierId="c1" />);
    await screen.findByRole('heading', { name: 'DERICK DORIAN MYRICK' });
    get.mockImplementation(answer({ profile: { ...PROFILE, identity: { ...PROFILE.identity, legalName: 'DAKOTA TRUCKING LLC' } } }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('heading', { name: 'DAKOTA TRUCKING LLC' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/api/carrier-profile/carrier/c1', { refresh: 1 }, expect.objectContaining({ timeoutMs: 90000 }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/carrier-profile/dot/1775913/inspections', { refresh: 1 }, expect.anything()));
  });

  it('says when a refresh failed and keeps the profile on screen', async () => {
    get.mockImplementation(answer({ profile: PROFILE }));
    renderIt(<FmcsaProfile carrierId="c1" />);
    await screen.findByRole('heading', { name: 'DERICK DORIAN MYRICK' });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    get.mockRejectedValueOnce(Object.assign(new Error('Too many FMCSA profile lookups. Try again in a minute.'), { status: 429 }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Could not refresh: Too many FMCSA profile lookups. Try again in a minute.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'DERICK DORIAN MYRICK' })).toBeInTheDocument();
  });

  it('marks a stored copy served while FMCSA was down', async () => {
    get.mockImplementation(answer({ profile: PROFILE, stored: true, stale: true, error: 'FMCSA census is not available right now' }));
    renderIt(<FmcsaProfile carrierId="c1" />);
    expect(await screen.findByText(/FMCSA did not answer just now/)).toBeInTheDocument();
  });

  it('shows "No FMCSA record" for an unknown USDOT number', async () => {
    get.mockImplementation(async () => { throw Object.assign(new Error('No FMCSA census record for USDOT 9999991'), { status: 404 }); });
    renderIt(<FmcsaProfile dot="9999991" />);
    expect(await screen.findByText('No FMCSA record')).toBeInTheDocument();
    expect(screen.getByText('No FMCSA census record for USDOT 9999991')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('sections collapse on phones', async () => {
    get.mockImplementation(answer({ profile: PROFILE }));
    renderIt(<FmcsaProfile carrierId="c1" />);
    await screen.findByRole('heading', { name: 'DERICK DORIAN MYRICK' });
    const toggle = screen.getByRole('button', { name: 'Company and contact' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(toggle.getAttribute('aria-controls'))).toHaveClass('hidden', 'sm:block');
    expect(screen.getByRole('button', { name: 'Fleet and equipment' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('FmcsaProfileButton and FmcsaProfileTab', () => {
  it('opens the profile of an unsaved lead in a dialog', async () => {
    get.mockImplementation(answer({ profile: LIVE }));
    const onRow = vi.fn();
    renderIt(<div onClick={onRow}><FmcsaProfileButton dot="03100001" /></div>);
    expect(get).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    const dialog = await screen.findByRole('dialog', { name: 'Carrier check · USDOT 3100001' });
    expect(within(dialog).getByRole('link', { name: /Open full page/ })).toHaveAttribute('href', '/app/carrier-check?dot=3100001');
    expect(await within(dialog).findByRole('heading', { name: 'PRAIRIE LINE TRANSPORT INC' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/api/carrier-profile/dot/3100001', undefined, expect.anything());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Authority' }));
    expect(onRow).not.toHaveBeenCalled();
  });

  it('renders nothing without a USDOT number', () => {
    const { container } = renderIt(<FmcsaProfileButton dot="" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('the carrier tab shows an empty state until the carrier has a USDOT number', async () => {
    renderIt(<FmcsaProfileTab carrier={{ id: 'c9', dotNumber: null }} />);
    expect(screen.getByText('No USDOT number')).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });
});
