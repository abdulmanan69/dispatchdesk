import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const get = vi.fn();
const download = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
vi.mock('../../lib/api.js', async (importOriginal) => ({ ...(await importOriginal()), api: { get: (...a) => get(...a), download: (...a) => download(...a) } }));
vi.mock('../../components/Toast.jsx', () => ({ useToast: () => toast }));
vi.mock('./ProfitChart.jsx', () => ({ default: ({ rows }) => <div data-testid="chart">{rows.length} months</div> }));

const { default: Reports } = await import('./Reports.jsx');
const { paysInTone } = await import('./PaysIn.jsx');

const zero = { loads: 0, grossCents: 0, feeCents: 0, profitCents: 0, loadedMiles: 0, totalMiles: 0, ratePerMile: null, allInRatePerMile: null, avgGrossCents: null, tonuLoads: 0, fuelKnownLoads: 0, feeMissingLoads: 0 };
const row = (key, label, grossCents, extra = {}) => ({ ...zero, key, id: key, label, loads: 2, grossCents, feeCents: grossCents / 10, profitCents: grossCents - 1000, loadedMiles: 1000, ratePerMile: 2.5, allInRatePerMile: 2.2, avgGrossCents: grossCents / 2, ...extra });
const SUMMARY = {
  scope: 'mine', canViewTeam: false,
  thisMonth: { ...zero, label: 'November 2026', loads: 3, grossCents: 600000, feeCents: 60000, ratePerMile: 2.5 },
  lastMonthToDate: { ...zero, from: '2026-10-01', to: '2026-10-11', loads: 2, grossCents: 400000, feeCents: 40000, ratePerMile: 2.4 },
  lastMonth: { ...zero },
  change: { grossCents: 50, feeCents: 50, loads: 50, ratePerMile: 4.2, profitCents: null },
};
const range = { key: 'this_month', from: '2026-11-01', to: '2026-11-11', timezone: 'America/Chicago' };
const MONTHS = { range, rows: [row('2026-11', 'Nov 2026', 600000)], others: null, totals: row('t', 'Total', 600000), groups: 1, undatedLoads: 0, canViewTeam: false };
const CARRIERS = {
  range, groups: 52, undatedLoads: 0,
  rows: [row('c1', 'Alpha Trucking', 400000), row('c2', 'Bravo Lines', 150000)],
  others: { ...row('others', 'Others (50)', 50000), id: null, groups: 50 },
  totals: row('t', 'Total', 600000),
};

function renderIt(path = '/app/reports') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}><Reports /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  get.mockReset(); download.mockReset();
  get.mockImplementation(async (url, params) => {
    if (url === '/api/reports/summary') return SUMMARY;
    if (url === '/api/reports/brokers/payments') return { rows: [], total: 0, basis: 'own_invoices' };
    if (params?.groupBy === 'month') return MONTHS;
    return CARRIERS;
  });
});

describe('Reports page', () => {
  it('shows this month against last month, the chart, and a sortable table with the others row last', async () => {
    renderIt();
    expect(await screen.findByText('November 2026 so far')).toBeInTheDocument();
    expect(screen.getAllByText('$6,000').length).toBeGreaterThan(0);
    expect(screen.getAllByText('+50.0%').length).toBe(3);
    expect(await screen.findByTestId('chart')).toHaveTextContent('1 months');
    await waitFor(() => expect(screen.getAllByText('Alpha Trucking').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Other 50 carriers').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Gross' }));
    const names = () => screen.getAllByRole('row').slice(1).map((tr) => tr.cells[0].textContent);
    expect(names()).toEqual(['Bravo Lines', 'Alpha Trucking', 'Other 50 carriers']);

    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    await waitFor(() => expect(download).toHaveBeenCalledWith('/api/reports/profit.csv?range=this_month&scope=mine&groupBy=carrier', 'profit-by-carrier.csv'));
  });

  it('shows an empty state when the range has no delivered loads, and the payments tab says where its data comes from', async () => {
    get.mockImplementation(async (url, params) => {
      if (url === '/api/reports/summary') return { ...SUMMARY, thisMonth: { ...zero, label: 'November 2026' }, change: { grossCents: null, feeCents: null, loads: null, ratePerMile: null } };
      if (url === '/api/reports/brokers/payments') return { rows: [], total: 0 };
      return { ...MONTHS, rows: [], totals: zero, undatedLoads: 2, groupBy: params?.groupBy };
    });
    renderIt('/app/reports?range=last_month');
    expect((await screen.findAllByText('No delivered loads in this range')).length).toBeGreaterThan(0);
    expect(get).toHaveBeenCalledWith('/api/reports/profit', expect.objectContaining({ range: 'last_month', groupBy: 'month' }), expect.anything());
    fireEvent.click(screen.getByRole('tab', { name: 'Broker payments' }));
    expect(await screen.findByText(/From your own invoices to brokers, not industry data/)).toBeInTheDocument();
    expect(await screen.findByText('No invoices to brokers yet')).toBeInTheDocument();
  });
});

describe('pays-in tone', () => {
  it('is green to 30 days, amber to 45, red beyond or with anything past due', () => {
    expect(paysInTone(null)).toBeNull();
    expect(paysInTone({ avgDaysToPay: null, pastDueInvoices: 0 })).toBeNull();
    expect(paysInTone({ avgDaysToPay: 30, pastDueInvoices: 0 })).toBe('green');
    expect(paysInTone({ avgDaysToPay: 31, pastDueInvoices: 0 })).toBe('amber');
    expect(paysInTone({ avgDaysToPay: 45, pastDueInvoices: 0 })).toBe('amber');
    expect(paysInTone({ avgDaysToPay: 46, pastDueInvoices: 0 })).toBe('red');
    expect(paysInTone({ avgDaysToPay: 12, pastDueInvoices: 1 })).toBe('red');
    expect(paysInTone({ avgDaysToPay: null, pastDueInvoices: 2 })).toBe('red');
  });
});
