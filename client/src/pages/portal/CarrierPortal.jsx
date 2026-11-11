import { useState } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { FileText, Printer, Mail, Phone, ChevronLeft, Lock } from 'lucide-react';
import { date, dollars, money, num } from '../../lib/format.js';
import { Badge, Button, Card, DataTable, EmptyState, Loading } from '../../components/ui.jsx';
import { openPrintable } from '../../components/invoices/print.js';
import { Logo } from '../../components/Logo.jsx';

const DOC = { rate_confirmation: 'Rate con', bol: 'BOL', pod: 'POD' };
/**
 * Portal API path for a link token. The token (and the week key) are encoded, so a crafted link such as
 * /portal/..%2F..%2Fcarriers cannot point the page at other API routes.
 */
const portalBase = (token) => `/api/public/portal/${encodeURIComponent(token)}`;

/** GET a portal endpoint without the session cookie: the public page never acts as the signed-in user. */
async function portalGet(path) {
  const res = await fetch(path, { headers: { Accept: 'application/json' }, credentials: 'omit' });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error || `Could not load this page (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

// Weeks are built in the dispatcher's time zone (Monday 00:00 there), so they are labeled in that zone too.
const range = (w, tz) => `${date(w.periodStart, { month: 'short', day: 'numeric', timeZone: tz })} – ${date(new Date(new Date(w.periodEnd).getTime() - 1), { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz })}`;

function Week({ token, week, tz, onBack }) {
  const base = portalBase(token);
  const weekPath = `${base}/statements/${encodeURIComponent(week.weekStart)}`;
  const q = useQuery({ queryKey: ['portal', token, week.weekStart], queryFn: () => portalGet(weekPath), retry: false });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" icon={ChevronLeft} onClick={onBack}>All weeks</Button>
        <Button variant="secondary" icon={Printer} onClick={() => openPrintable(`${weekPath}/print`)}>Print or save as PDF</Button>
      </div>
      <Card title={`Week of ${range(week, tz)}`} bodyClass="p-0">
        {q.isLoading ? <Loading /> : q.isError ? <p className="p-4 text-sm text-c-red">{q.error.message}</p> : (
          <>
            <DataTable rows={q.data.statement.lines}
              empty={<EmptyState title="No delivered loads this week" />}
              mobileRow={(l) => (
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between gap-2"><span className="min-w-0 font-medium">{l.lane}</span><span className="shrink-0 tabular">{money(l.grossCents)}</span></div>
                  <p className="text-xs text-muted">{date(l.date, { month: 'short', day: 'numeric' })}{l.reference ? ` · ref ${l.reference}` : ''} · fee {money(l.feeCents)} · net {money(l.netCents)}</p>
                  <DocLinks base={base} docs={l.documents} />
                </div>
              )}
              columns={[
                { key: 'date', header: 'Delivered', render: (l) => date(l.date, { month: 'short', day: 'numeric' }) },
                { key: 'lane', header: 'Load', render: (l) => <div><div>{l.lane}</div><div className="text-xs text-muted">{[l.reference && `Ref ${l.reference}`, l.broker].filter(Boolean).join(' · ')}</div></div> },
                { key: 'gross', header: 'Gross', className: 'text-right', render: (l) => <span className="tabular">{money(l.grossCents)}</span> },
                { key: 'rpm', header: 'RPM', className: 'text-right', render: (l) => <span className="tabular">{l.ratePerMile != null ? dollars(l.ratePerMile) : '—'}</span> },
                { key: 'fee', header: 'Fee', className: 'text-right', render: (l) => <span className="tabular">{l.feeCents != null ? `${money(l.feeCents)} (${l.feePercent}%)` : '—'}</span> },
                { key: 'net', header: 'Net', className: 'text-right', render: (l) => <span className="tabular font-medium">{money(l.netCents)}</span> },
                { key: 'docs', header: 'Files', render: (l) => <DocLinks base={base} docs={l.documents} /> },
              ]} />
            <dl className="ml-auto grid max-w-xs gap-1 px-4 py-3 text-sm">
              <div className="flex justify-between"><dt className="text-muted">Gross</dt><dd className="tabular">{money(q.data.statement.totals.grossCents)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Dispatch fee</dt><dd className="tabular">{money(q.data.statement.totals.feeCents)}</dd></div>
              <div className="flex justify-between border-t border-line pt-1 font-medium"><dt>Net to you</dt><dd className="tabular">{money(q.data.statement.totals.netCents)}</dd></div>
            </dl>
          </>
        )}
      </Card>
    </div>
  );
}

function DocLinks({ base, docs = [] }) {
  if (!docs.length) return <span className="text-xs text-muted">No files</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {docs.map((d) => (
        <a key={d.id} href={`${base}/documents/${encodeURIComponent(d.id)}`} className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-xs hover:bg-surface-2" title={d.originalName}>
          <FileText className="size-3" aria-hidden />{DOC[d.type] || 'File'}
        </a>
      ))}
    </span>
  );
}

/** Public carrier portal (/portal/:token): this carrier's weekly statements and its delivered loads' files, nothing else. */
export default function CarrierPortal() {
  const { token } = useParams();
  const [week, setWeek] = useState(null);
  const q = useQuery({ queryKey: ['portal', token], queryFn: () => portalGet(portalBase(token)), retry: false });
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <main className="mx-auto max-w-4xl px-4 py-8 sm:py-10">
        <div className="mb-6"><Logo compact /></div>
        {q.isLoading ? <Loading /> : q.isError ? (
          <div className="mx-auto max-w-md rounded-xl border border-line bg-surface p-6 text-center">
            <Lock className="mx-auto mb-3 size-5 text-muted" aria-hidden />
            <h1 className="text-lg font-medium">This link is not available</h1>
            <p className="mt-1 text-sm text-muted">{q.error.status === 404 ? 'It may have expired or been replaced. Ask your dispatcher for a new link.' : q.error.message}</p>
          </div>
        ) : (
          <div className="space-y-5">
            <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm text-muted">Dispatch statements</p>
                <h1 className="truncate text-2xl font-medium tracking-[-0.01em]">{q.data.carrier.companyName}</h1>
                <p className="text-sm text-muted">{[q.data.carrier.mcNumber && `MC ${q.data.carrier.mcNumber}`, q.data.carrier.dotNumber && `USDOT ${q.data.carrier.dotNumber}`].filter(Boolean).join(' · ')}</p>
              </div>
              <div className="text-sm sm:text-right">
                <p>From {q.data.dispatcher.company || q.data.dispatcher.name}</p>
                <div className="mt-1 flex flex-wrap gap-2 sm:justify-end">
                  {q.data.dispatcher.email && <Button size="sm" variant="secondary" icon={Mail} href={`mailto:${q.data.dispatcher.email}`}>Email</Button>}
                  {q.data.dispatcher.phone && <Button size="sm" variant="secondary" icon={Phone} href={`tel:${q.data.dispatcher.phone}`}>Call</Button>}
                </div>
              </div>
            </header>
            {week ? <Week token={token} week={week} tz={q.data.timezone} onBack={() => setWeek(null)} /> : (
              <Card title="Last 12 weeks" bodyClass="p-0">
                <DataTable rows={q.data.weeks.map((w) => ({ ...w, id: w.weekStart }))} onRowClick={(w) => w.totals.loads && setWeek(w)}
                  mobileRow={(w) => (
                    <div className="flex justify-between gap-3 text-sm">
                      <span><span className="block font-medium">{range(w, q.data.timezone)}</span><span className="text-xs text-muted">{w.totals.loads} load{w.totals.loads === 1 ? '' : 's'} · {num(w.totals.loadedMiles)} mi</span></span>
                      <span className="text-right tabular">{money(w.totals.netCents)}<span className="block text-xs text-muted">fee {money(w.totals.feeCents)}</span></span>
                    </div>
                  )}
                  columns={[
                    { key: 'week', header: 'Week', render: (w) => <span className="whitespace-nowrap">{range(w, q.data.timezone)}</span> },
                    { key: 'loads', header: 'Loads', className: 'text-right', render: (w) => <span className="tabular">{w.totals.loads}</span> },
                    { key: 'gross', header: 'Gross', className: 'text-right', render: (w) => <span className="tabular">{money(w.totals.grossCents)}</span> },
                    { key: 'fee', header: 'Dispatch fee', className: 'text-right', render: (w) => <span className="tabular">{money(w.totals.feeCents)}</span> },
                    { key: 'net', header: 'Net to you', className: 'text-right', render: (w) => <span className="tabular font-medium">{money(w.totals.netCents)}</span> },
                    { key: 'open', header: <span className="sr-only">Open</span>, className: 'text-right', render: (w) => (w.totals.loads ? <Badge color="blue">View</Badge> : <span className="text-xs text-muted">No loads</span>) },
                  ]} />
              </Card>
            )}
            <p className="text-xs text-muted">Read-only link{q.data.expiresAt ? `, valid until ${date(q.data.expiresAt)}` : ''}. It shows only your statements and the rate con, BOL and POD files of your delivered loads.</p>
          </div>
        )}
      </main>
    </div>
  );
}
