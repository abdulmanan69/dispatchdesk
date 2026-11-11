import { Suspense, lazy, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, Receipt, Truck } from 'lucide-react';
import { api, qs } from '../../lib/api.js';
import { dollars, money, num } from '../../lib/format.js';
import { Button, Card, Checkbox, DataTable, EmptyState, ErrorBoundary, Input, PageHeader, QueryState, Select, StatCard, Tabs, cx } from '../../components/ui.jsx';
import { useToast } from '../../components/Toast.jsx';
import { Legend, PALETTE } from '../../components/dashboard/palette.jsx';
import { isChunkError, reloadForNewVersion } from '../../context/reload.js';
import { PaysInBadge } from './PaysIn.jsx';

// recharts loads after the numbers have painted, behind a fixed-height placeholder (as on the dashboard).
const ProfitChart = lazy(() => import('./ProfitChart.jsx'));
const CHART_HEIGHT = 280;
const ChartPlaceholder = () => <div style={{ height: CHART_HEIGHT }} className="w-full animate-pulse rounded-lg bg-surface-2/60" aria-hidden />;

export const RANGE_PRESETS = [
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'last_90', label: 'Last 90 days' },
  { value: 'this_year', label: 'This year' },
  { value: 'custom', label: 'Custom range' },
];
const TABS = [
  { value: 'carrier', label: 'By carrier' },
  { value: 'broker', label: 'By broker' },
  { value: 'lane', label: 'By lane' },
  { value: 'payments', label: 'Broker payments' },
];
const NOUN = { carrier: ['carrier', 'carriers', 'Carrier'], broker: ['broker', 'brokers', 'Broker'], lane: ['lane', 'lanes', 'Lane'] };
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const GROSS_SWATCH = 'color-mix(in srgb, var(--muted) 35%, transparent)';

const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
/** "Oct 1" from a YYYY-MM-DD key, without a time-zone shift. */
function dayLabel(key, withYear = false) {
  if (!key) return '';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) });
}
const rangeLabel = (r) => (r ? `${dayLabel(r.from, true)} to ${dayLabel(r.to, true)}` : '');
const cents = (v) => money(v, { digits: 0 });
const rpm = (v) => (v == null ? '—' : dollars(v));

/** Reports: KPI tiles, gross and profit by month, profit by carrier, broker and lane, and broker payment speed. */
export default function Reports() {
  const [sp, setSp] = useSearchParams();
  const set = (patch) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '' || v === false) next.delete(k);
      else next.set(k, String(v));
    }
    setSp(next, { replace: true });
  };
  const range = RANGE_PRESETS.some((p) => p.value === sp.get('range')) ? sp.get('range') : 'this_month';
  const from = sp.get('from') || '';
  const to = sp.get('to') || '';
  const scope = sp.get('scope') === 'team' ? 'team' : 'mine';
  const inTransit = sp.get('inTransit') === 'true';
  const tab = TABS.some((t) => t.value === sp.get('tab')) ? sp.get('tab') : 'carrier';
  const ready = range !== 'custom' || (DAY_KEY.test(from) && DAY_KEY.test(to) && from <= to);
  const params = { range, ...(range === 'custom' ? { from, to } : {}), scope, ...(inTransit ? { inTransit: 'true' } : {}) };

  const summary = useQuery({
    queryKey: ['reports', 'summary', scope, inTransit],
    queryFn: ({ signal }) => api.get('/api/reports/summary', { scope, ...(inTransit ? { inTransit: 'true' } : {}) }, { signal }),
    placeholderData: keepPreviousData,
  });
  const months = useQuery({
    queryKey: ['reports', 'profit', 'month', params],
    queryFn: ({ signal }) => api.get('/api/reports/profit', { ...params, groupBy: 'month' }, { signal }),
    enabled: ready,
    placeholderData: keepPreviousData,
  });
  const canViewTeam = summary.data?.canViewTeam || months.data?.canViewTeam;

  return (
    <div>
      <PageHeader title="Reports" subtitle="Gross, dispatch fees and estimated profit from your delivered loads, and how fast brokers pay you."
        actions={<>
          {canViewTeam && (
            <Select aria-label="Scope" className="w-32" value={scope} onChange={(e) => set({ scope: e.target.value === 'team' ? 'team' : null })}>
              <option value="mine">Just me</option>
              <option value="team">Team</option>
            </Select>
          )}
          <Select aria-label="Date range" className="w-40" value={range} onChange={(e) => {
            const v = e.target.value;
            // A custom range starts from the dates on screen, so the report never goes blank while picking.
            if (v === 'custom') set({ range: v, from: from || months.data?.range.from, to: to || months.data?.range.to });
            else set({ range: v === 'this_month' ? null : v, from: null, to: null });
          }}>
            {RANGE_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </Select>
        </>} />

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        {range === 'custom' && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Input type="date" aria-label="Start date" className="h-9 w-40" value={from} max={to || undefined} onChange={(e) => set({ from: e.target.value })} />
            <span className="text-muted">to</span>
            <Input type="date" aria-label="End date" className="h-9 w-40" value={to} min={from || undefined} onChange={(e) => set({ to: e.target.value })} />
            {!ready && <span className="text-xs text-red-600 dark:text-red-400">Pick a start date on or before the end date.</span>}
          </div>
        )}
        <Checkbox label="Include loads in transit" checked={inTransit} onChange={(e) => set({ inTransit: e.target.checked ? 'true' : null })} />
      </div>

      <SummaryTiles query={summary} />

      <Card className="mb-6" title={<div className="min-w-0"><h2 className="text-sm font-medium">Gross and profit by month</h2>{months.data && <p className="truncate text-xs text-muted">{rangeLabel(months.data.range)}</p>}</div>}
        actions={<Legend items={[{ label: 'Gross', color: GROSS_SWATCH }, { label: 'Est. profit', color: PALETTE.brand }]} />}>
        {!ready ? <p className="text-sm text-muted">Pick a start and an end date to see the report.</p> : (
          <QueryState query={months}>
            {(d) => (d.totals.loads === 0 ? <NoLoads range={d.range} undated={d.undatedLoads} /> : (
              <>
                <ErrorBoundary onError={(e) => { if (isChunkError(e)) reloadForNewVersion(); }}
                  fallback={<div style={{ height: CHART_HEIGHT }} className="flex items-center justify-center text-sm text-muted">The chart could not load. Reload the page to try again.</div>}>
                  <Suspense fallback={<ChartPlaceholder />}>
                    <ProfitChart rows={d.rows} height={CHART_HEIGHT} />
                  </Suspense>
                </ErrorBoundary>
                <RangeTotals d={d} />
              </>
            ))}
          </QueryState>
        )}
      </Card>

      <Tabs className="mb-3" value={tab} onChange={(v) => set({ tab: v === 'carrier' ? null : v })} tabs={TABS} />
      {tab === 'payments'
        ? <PaymentsTable scope={scope} />
        : <GroupTable key={tab} groupBy={tab} params={params} ready={ready} />}
    </div>
  );
}

function Change({ value, base }) {
  const up = value > 0;
  return (
    <span>
      <span className={cx('tabular font-medium', value === 0 ? 'text-fg-2' : up ? 'text-c-green' : 'text-c-red')}>{`${up ? '+' : ''}${value.toFixed(1)}%`}</span> {base}
    </span>
  );
}

function SummaryTiles({ query }) {
  const s = query.data;
  const cur = s?.thisMonth;
  const prev = s?.lastMonthToDate;
  const span = prev ? `${dayLabel(prev.from)} to ${dayLabel(prev.to)}` : '';
  // Against last month up to the same day: "+12.5% vs Oct 1 to Oct 11", or last month's figure when there is no %.
  const sub = (key, prevText) => {
    if (!s) return undefined;
    if (s.change[key] != null) return <Change value={s.change[key]} base={`vs ${span}`} />;
    return prevText ? `${prevText} ${span}` : `None ${span}`;
  };
  return (
    <section aria-label="This month" className="mb-6">
      <p className="mb-2 text-sm text-fg-2">{cur ? `${cur.label} so far` : 'This month so far'}{s?.scope === 'team' ? ' · team' : ''}</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Gross" value={cur ? cents(cur.grossCents) : '—'} sub={sub('grossCents', prev?.grossCents ? cents(prev.grossCents) : null)} color="blue" />
        <StatCard label="Dispatch fees" value={cur ? cents(cur.feeCents) : '—'} sub={sub('feeCents', prev?.feeCents ? cents(prev.feeCents) : null)} color="green" />
        <StatCard label="Loads delivered" value={cur ? num(cur.loads) : '—'} sub={sub('loads', prev?.loads ? plural(prev.loads, 'load') : null)} color="purple" />
        <StatCard label="Average RPM" value={cur ? rpm(cur.ratePerMile) : '—'} sub={sub('ratePerMile', prev?.ratePerMile != null ? `${rpm(prev.ratePerMile)}/mi` : null)} color="amber" />
      </div>
      {query.isError && !s && <p className="mt-2 text-xs text-red-600 dark:text-red-400">These numbers could not load. {query.error?.message}</p>}
    </section>
  );
}

function NoLoads({ range, undated }) {
  return (
    <EmptyState icon={Truck} title="No delivered loads in this range" action={<Button variant="secondary" to="/app/loads">Open loads</Button>}>
      Loads count here once they are delivered, invoiced or paid, dated by delivery date (or pickup date). {rangeLabel(range)}.
      {undated > 0 && ` ${plural(undated, 'delivered load has', 'delivered loads have')} no pickup or delivery date and cannot be placed in a range.`}
    </EmptyState>
  );
}

function RangeTotals({ d }) {
  const t = d.totals;
  const items = [
    ['Loads', num(t.loads)],
    ['Gross', cents(t.grossCents)],
    ['Dispatch fees', cents(t.feeCents)],
    ['Est. profit', cents(t.profitCents)],
    ['Loaded miles', num(t.loadedMiles)],
    ['RPM', rpm(t.ratePerMile)],
    ['All-in RPM', rpm(t.allInRatePerMile)],
    ['Average per load', cents(t.avgGrossCents)],
  ];
  const ran = t.loads - t.tonuLoads;
  const notes = [
    `Est. profit is gross minus fuel and other costs. Fuel is counted on ${plural(t.fuelKnownLoads, 'load')} of ${num(ran)} with MPG and a fuel price set.`,
    t.feeMissingLoads > 0 && `${plural(t.feeMissingLoads, 'load has', 'loads have')} no dispatch fee % on the load or the customer.`,
    t.tonuLoads > 0 && `${plural(t.tonuLoads, 'canceled load')} with a TONU ${t.tonuLoads === 1 ? 'counts' : 'count'} the TONU only.`,
    d.undatedLoads > 0 && `${plural(d.undatedLoads, 'delivered load has', 'delivered loads have')} no pickup or delivery date and ${d.undatedLoads === 1 ? 'is' : 'are'} left out.`,
  ].filter(Boolean);
  return (
    <>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-4 sm:grid-cols-4">
        {items.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="mt-0.5 truncate text-sm font-medium tabular">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-muted">{notes.join(' ')}</p>
    </>
  );
}

const SORTERS = {
  name: (r) => r.label.toLowerCase(),
  loads: (r) => r.loads,
  gross: (r) => r.grossCents,
  fee: (r) => r.feeCents,
  profit: (r) => r.profitCents,
  miles: (r) => r.loadedMiles,
  rpm: (r) => r.ratePerMile ?? -Infinity,
  allIn: (r) => r.allInRatePerMile ?? -Infinity,
  avg: (r) => r.avgGrossCents ?? -Infinity,
};

export function sortRows(rows, sort, sorters = SORTERS) {
  const get = sorters[sort.field];
  if (!get) return rows;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}

function GroupTable({ groupBy, params, ready }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [one, many, heading] = NOUN[groupBy];
  const [sort, setSort] = useState({ field: 'gross', dir: 'desc' });
  const [exporting, setExporting] = useState(false);
  const q = useQuery({
    queryKey: ['reports', 'profit', groupBy, params],
    queryFn: ({ signal }) => api.get('/api/reports/profit', { ...params, groupBy }, { signal }),
    enabled: ready,
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(() => {
    const sorted = sortRows(q.data?.rows || [], sort);
    // "Others" sums everything past the top 50 and stays last whatever the sort.
    return q.data?.others ? [...sorted, { ...q.data.others, others: true }] : sorted;
  }, [q.data, sort]);
  const linkOf = (r) => (r.others || !r.id ? null : groupBy === 'carrier' ? `/app/carriers/${r.id}` : groupBy === 'broker' ? `/app/brokers/${r.id}` : null);
  const nameOf = (r) => (r.others ? `Other ${plural(r.groups, one, many)}` : r.label);

  const exportCsv = async () => {
    setExporting(true);
    try {
      await api.download(`/api/reports/profit.csv${qs({ ...params, groupBy })}`, `profit-by-${groupBy}.csv`);
    } catch (err) {
      toast.error(err);
    } finally {
      setExporting(false);
    }
  };

  const columns = [
    { key: 'name', header: heading, sortable: true, render: (r) => <span className={cx('font-medium', r.others && 'font-normal italic text-fg-2')}>{nameOf(r)}</span> },
    { key: 'loads', header: 'Loads', sortable: true, className: 'text-right', render: (r) => <span className="tabular">{num(r.loads)}</span> },
    { key: 'gross', header: 'Gross', sortable: true, className: 'text-right', render: (r) => <span className="tabular">{cents(r.grossCents)}</span> },
    { key: 'fee', header: 'Dispatch fee', sortable: true, className: 'text-right', render: (r) => <span className="tabular">{cents(r.feeCents)}</span> },
    { key: 'profit', header: 'Est. profit', sortable: true, className: 'text-right', render: (r) => <span className="tabular">{cents(r.profitCents)}</span> },
    { key: 'miles', header: 'Loaded mi', sortable: true, className: 'text-right', render: (r) => <span className="tabular">{num(r.loadedMiles)}</span> },
    { key: 'rpm', header: 'RPM', sortable: true, className: 'text-right', render: (r) => <span className="tabular">{rpm(r.ratePerMile)}</span> },
    { key: 'allIn', header: 'All-in RPM', sortable: true, className: 'text-right', render: (r) => <span className="tabular">{rpm(r.allInRatePerMile)}</span> },
    { key: 'avg', header: 'Avg per load', sortable: true, className: 'text-right', render: (r) => <span className="tabular">{cents(r.avgGrossCents)}</span> },
  ];

  return (
    <Card bodyClass="p-0" title={`Profit by ${one}`}
      actions={<Button size="sm" variant="secondary" icon={Download} loading={exporting} disabled={!ready || !q.data?.totals.loads} onClick={exportCsv}>Export CSV</Button>}>
      {!ready ? <p className="px-5 py-4 text-sm text-muted">Pick a start and an end date to see the report.</p> : (
        <QueryState query={q}>
          {(d) => (
            <>
              <DataTable rows={rows} rowKey="key" columns={columns} sort={sort} onSort={setSort}
                onRowClick={(r) => { const to = linkOf(r); if (to) navigate(to); }}
                empty={<NoLoads range={d.range} undated={d.undatedLoads} />}
                mobileRow={(r) => (
                  <div className="space-y-1">
                    <div className="flex items-start justify-between gap-2">
                      <span className={cx('min-w-0 truncate text-sm font-medium', r.others && 'font-normal italic text-fg-2')}>{nameOf(r)}</span>
                      <span className="shrink-0 text-sm font-medium tabular">{cents(r.grossCents)}</span>
                    </div>
                    <p className="text-xs text-muted tabular">{[plural(r.loads, 'load'), `fee ${cents(r.feeCents)}`, `profit ${cents(r.profitCents)}`, r.ratePerMile != null && `${dollars(r.ratePerMile)}/mi`].filter(Boolean).join(' · ')}</p>
                  </div>
                )} />
              {d.rows.length > 0 && (
                <p className="border-t border-line px-4 py-2 text-xs text-muted tabular">
                  Total · {plural(d.totals.loads, 'load')} · {cents(d.totals.grossCents)} gross · {cents(d.totals.feeCents)} fees · {rpm(d.totals.ratePerMile)}/mi
                  {d.others ? ` · top 50 of ${num(d.groups)} ${many} by gross` : ''}
                </p>
              )}
            </>
          )}
        </QueryState>
      )}
    </Card>
  );
}

const PAY_SORTERS = {
  name: (r) => (r.name || '').toLowerCase(),
  invoices: (r) => r.invoices,
  avg: (r) => r.avgDaysToPay ?? -Infinity,
  median: (r) => r.medianDaysToPay ?? -Infinity,
  late: (r) => r.paidLate,
  open: (r) => r.openCents,
  pastDue: (r) => r.pastDueCents,
  oldest: (r) => r.oldestOpenDays ?? -Infinity,
};

function PaymentsTable({ scope }) {
  const navigate = useNavigate();
  const [sort, setSort] = useState({ field: 'pastDue', dir: 'desc' });
  const q = useQuery({
    queryKey: ['reports', 'payments', scope],
    queryFn: ({ signal }) => api.get('/api/reports/brokers/payments', { scope }, { signal }),
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(() => sortRows(q.data?.rows || [], sort, PAY_SORTERS), [q.data, sort]);
  const days = (v) => (v == null ? '—' : plural(v, 'day'));
  const columns = [
    { key: 'name', header: 'Broker', sortable: true, render: (r) => <span className="font-medium">{r.name || 'Unknown broker'}</span> },
    { key: 'invoices', header: 'Invoices', sortable: true, className: 'text-right', render: (r) => <span className="tabular">{num(r.invoices)}<span className="text-xs text-muted"> · {num(r.paidInvoices)} paid</span></span> },
    { key: 'avg', header: 'Pays in', sortable: true, render: (r) => <PaysInBadge p={r} /> },
    { key: 'median', header: 'Median', sortable: true, className: 'text-right', render: (r) => <span className="tabular">{days(r.medianDaysToPay)}</span> },
    { key: 'late', header: 'Paid late', sortable: true, className: 'text-right', render: (r) => <span className="tabular">{r.paidInvoices ? `${num(r.paidLate)} of ${num(r.paidInvoices)}` : '—'}</span> },
    { key: 'open', header: 'Open', sortable: true, className: 'text-right', render: (r) => <span className="tabular">{cents(r.openCents)}</span> },
    { key: 'pastDue', header: 'Past due', sortable: true, className: 'text-right', render: (r) => <span className={cx('tabular', r.pastDueCents > 0 && 'font-medium text-c-red')}>{cents(r.pastDueCents)}</span> },
    { key: 'oldest', header: 'Oldest open', sortable: true, className: 'text-right', render: (r) => <span className="tabular">{days(r.oldestOpenDays)}</span> },
  ];
  return (
    <Card bodyClass="p-0" title={<div className="min-w-0 py-1"><h2 className="text-sm font-medium">Broker payments</h2><p className="text-xs text-muted">From your own invoices to brokers, not industry data. Days to pay run from the invoice date to the payment.</p></div>}
      actions={<Button size="sm" variant="secondary" icon={Receipt} to="/app/invoices?status=overdue">Past-due invoices</Button>}>
      <QueryState query={q}>
        {(d) => (
          <>
            <DataTable rows={rows} rowKey="brokerId" columns={columns} sort={sort} onSort={setSort}
              onRowClick={(r) => { if (r.known) navigate(`/app/brokers/${r.brokerId}`); }}
              empty={<EmptyState icon={Receipt} title="No invoices to brokers yet" action={<Button variant="secondary" to="/app/invoices">Open invoices</Button>}>Send freight invoices from Invoices. How fast each broker pays shows here once they pay.</EmptyState>}
              mobileRow={(r) => (
                <div className="space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-medium">{r.name || 'Unknown broker'}</span>
                    <PaysInBadge p={r} />
                  </div>
                  <p className="text-xs text-muted tabular">{[plural(r.invoices, 'invoice'), `open ${cents(r.openCents)}`, r.pastDueCents > 0 && `past due ${cents(r.pastDueCents)}`, r.paidLate > 0 && `${num(r.paidLate)} paid late`].filter(Boolean).join(' · ')}</p>
                </div>
              )} />
            {d.total > d.rows.length && (
              <p className="border-t border-line px-4 py-2 text-xs text-muted">Showing {num(d.rows.length)} of {num(d.total)} brokers, most past due and open balance first.</p>
            )}
          </>
        )}
      </QueryState>
    </Card>
  );
}

