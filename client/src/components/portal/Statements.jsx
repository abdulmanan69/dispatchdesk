import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FileText, Mail, MessageSquare, Phone, Printer } from 'lucide-react';
import { date, dollars, money, num } from '../../lib/format.js';
import { Button, EmptyState, Loading, cx } from '../ui.jsx';
import { openPrintable } from '../invoices/print.js';

/**
 * What a carrier sees of one dispatcher's statements: totals for the last 12 weeks, a weekly bar chart, each week
 * with its loads (gross, rate per mile, dispatch fee, net) and the rate con, BOL and POD of each load. Used by the
 * token portal (/portal/:token) and the signed-in carrier profile (/carrier).
 *   base     API path of the statements root (summary at `base`, a week at `${base}/statements/:week`)
 *   docBase  API path that serves load documents (`${docBase}/:documentId`)
 *   get      fetch function for this page (the portal never sends the dispatcher's session cookie)
 *   summary  the summary answer (already loaded by the page)
 */
const DOC = { rate_confirmation: 'Rate con', bol: 'BOL', pod: 'POD' };

// Weeks are built in the dispatcher's time zone (Monday 00:00 there), so they are labeled in that zone too.
export const weekRange = (w, tz) => `${date(w.periodStart, { month: 'short', day: 'numeric', timeZone: tz })} – ${date(new Date(new Date(w.periodEnd).getTime() - 1), { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz })}`;
const short = (w, tz) => date(w.periodStart, { month: 'numeric', day: 'numeric', timeZone: tz });

/** Dispatcher card: who dispatches you and one tap to call, text or email them. */
export function DispatcherCard({ dispatcher, title = 'Your dispatcher' }) {
  const d = dispatcher || {};
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <p className="text-xs text-muted">{title}</p>
      <p className="mt-0.5 font-medium">{d.company || d.name || 'Dispatcher'}</p>
      {d.company && d.name && d.company !== d.name && <p className="text-sm text-fg-2">{d.name}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {d.phone && <Button size="sm" icon={Phone} href={`tel:${d.phone}`}>Call</Button>}
        {d.phone && <Button size="sm" variant="secondary" icon={MessageSquare} href={`sms:${d.phone}`}>Text</Button>}
        {d.email && <Button size="sm" variant="secondary" icon={Mail} href={`mailto:${d.email}`}>Email</Button>}
      </div>
    </section>
  );
}

function Totals({ weeks }) {
  const t = weeks.reduce((a, w) => ({
    gross: a.gross + (w.totals.grossCents || 0), fee: a.fee + (w.totals.feeCents || 0), net: a.net + (w.totals.netCents || 0),
    loads: a.loads + (w.totals.loads || 0), miles: a.miles + (w.totals.loadedMiles || 0),
  }), { gross: 0, fee: 0, net: 0, loads: 0, miles: 0 });
  const last = weeks.find((w) => w.totals.loads) || null;
  const rpm = t.miles ? t.gross / 100 / t.miles : null;
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {[
        ['Net to you', money(t.net), '12 weeks', true],
        ['Gross', money(t.gross), `${num(t.loads)} load${t.loads === 1 ? '' : 's'}`],
        ['Rate per mile', rpm != null ? dollars(rpm) : '—', `${num(t.miles)} loaded miles`],
        ['Dispatch fee', money(t.fee), last ? `last load week net ${money(last.totals.netCents)}` : 'no loads yet'],
      ].map(([k, v, sub, lead]) => (
        <div key={k} className={cx('rounded-2xl border px-4 py-3', lead ? 'border-brand-600/25 bg-brand-50 dark:bg-brand-950/40' : 'border-line bg-surface')}>
          <dt className="text-xs text-muted">{k}</dt>
          <dd className={cx('mt-0.5 font-medium tabular', lead ? 'text-2xl' : 'text-lg')}>{v}</dd>
          <dd className="text-xs text-muted">{sub}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Weekly net as bars, oldest to newest; a bar opens that week. */
function WeekBars({ weeks, tz, onOpen }) {
  const list = [...weeks].reverse();
  const max = Math.max(1, ...list.map((w) => w.totals.netCents || 0));
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="mb-3 text-sm font-medium">Net per week</p>
      <div className="flex h-28 items-end gap-1.5" role="list" aria-label="Net per week">
        {list.map((w) => {
          const h = w.totals.netCents > 0 ? Math.max(6, Math.round((w.totals.netCents / max) * 100)) : 2;
          return (
            <button key={w.weekStart} type="button" role="listitem" disabled={!w.totals.loads} onClick={() => onOpen(w)}
              title={`${weekRange(w, tz)}: ${money(w.totals.netCents)} net, ${w.totals.loads} load${w.totals.loads === 1 ? '' : 's'}`}
              className="group flex h-full flex-1 flex-col justify-end disabled:cursor-default">
              <span className={cx('block w-full rounded-t-md transition-ui', w.totals.loads ? 'bg-brand-600 group-hover:bg-brand-500' : 'bg-line')} style={{ height: `${h}%` }} />
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] tabular text-muted">
        <span>{list[0] ? short(list[0], tz) : ''}</span><span>{list.at(-1) ? short(list.at(-1), tz) : ''}</span>
      </div>
    </div>
  );
}

function DocLinks({ docBase, docs = [] }) {
  if (!docs.length) return <span className="text-xs text-muted">No files</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {docs.map((d) => (
        <a key={d.id} href={`${docBase}/${encodeURIComponent(d.id)}`} className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs hover:bg-surface-2" title={d.originalName}>
          <FileText className="size-3.5" aria-hidden />{DOC[d.type] || 'File'}
        </a>
      ))}
    </span>
  );
}

function Week({ base, docBase, get, week, tz, onBack, queryKey }) {
  const path = `${base}/statements/${encodeURIComponent(week.weekStart)}`;
  const q = useQuery({ queryKey: [...queryKey, week.weekStart], queryFn: () => get(path), retry: false });
  const s = q.data?.statement;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" icon={ChevronLeft} onClick={onBack}>All weeks</Button>
        <Button variant="secondary" icon={Printer} onClick={() => openPrintable(`${path}/print`)}>Print or save PDF</Button>
      </div>
      <section className="rounded-2xl border border-line bg-surface">
        <header className="border-b border-line px-4 py-3">
          <p className="text-xs text-muted">Statement</p>
          <h2 className="font-medium">Week of {weekRange(week, tz)}</h2>
        </header>
        {q.isLoading ? <Loading /> : q.isError ? <p className="p-4 text-sm text-c-red">{q.error.message}</p> : !s.lines.length ? (
          <EmptyState title="No delivered loads this week" />
        ) : (
          <>
            <ul className="divide-y divide-line">
              {s.lines.map((l, i) => (
                <li key={`${l.reference}-${i}`} className="space-y-1.5 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block font-medium">{l.lane}</span>
                      <span className="block text-xs text-muted">{[date(l.date, { month: 'short', day: 'numeric' }), l.reference && `ref ${l.reference}`, l.broker].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block font-medium tabular">{money(l.netCents)}</span>
                      <span className="block text-xs text-muted tabular">net</span>
                    </span>
                  </div>
                  <p className="text-xs text-fg-2 tabular">
                    Gross {money(l.grossCents)}{l.ratePerMile != null ? ` · ${dollars(l.ratePerMile)}/mi` : ''}{l.feeCents != null ? ` · fee ${money(l.feeCents)} (${l.feePercent}%)` : ''}
                  </p>
                  <DocLinks docBase={docBase} docs={l.documents} />
                </li>
              ))}
            </ul>
            <dl className="space-y-1 border-t border-line px-4 py-3 text-sm">
              <div className="flex justify-between"><dt className="text-muted">Gross</dt><dd className="tabular">{money(s.totals.grossCents)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Dispatch fee</dt><dd className="tabular">{money(s.totals.feeCents)}</dd></div>
              <div className="flex justify-between border-t border-line pt-1 text-base font-medium"><dt>Net to you</dt><dd className="tabular">{money(s.totals.netCents)}</dd></div>
            </dl>
          </>
        )}
      </section>
    </div>
  );
}

export function StatementsView({ base, docBase, get, summary, queryKey }) {
  const [week, setWeek] = useState(null);
  const tz = summary.timezone;
  if (week) return <Week base={base} docBase={docBase} get={get} week={week} tz={tz} onBack={() => setWeek(null)} queryKey={queryKey} />;
  // Weeks are newest first. Older weeks before the first load are left out of the list (the chart still shows them).
  let lastWithLoads = -1;
  summary.weeks.forEach((w, i) => { if (w.totals.loads) lastWithLoads = i; });
  const listed = summary.weeks.slice(0, Math.max(1, lastWithLoads + 1));
  const hidden = summary.weeks.length - listed.length;
  return (
    <div className="space-y-3">
      <Totals weeks={summary.weeks} />
      <WeekBars weeks={summary.weeks} tz={tz} onOpen={setWeek} />
      <section className="rounded-2xl border border-line bg-surface">
        <header className="border-b border-line px-4 py-3"><h2 className="font-medium">Weekly statements</h2></header>
        <ul className="divide-y divide-line">
          {listed.map((w) => (
            <li key={w.weekStart}>
              <button type="button" disabled={!w.totals.loads} onClick={() => setWeek(w)}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-ui hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent">
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{weekRange(w, tz)}</span>
                  <span className="block text-xs text-muted">{w.totals.loads ? `${w.totals.loads} load${w.totals.loads === 1 ? '' : 's'} · ${num(w.totals.loadedMiles)} mi · fee ${money(w.totals.feeCents)}` : 'No loads'}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className={cx('tabular', w.totals.loads ? 'font-medium' : 'text-muted')}>{money(w.totals.netCents)}</span>
                  {w.totals.loads > 0 && <ChevronRight className="size-4 text-muted" aria-hidden />}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {hidden > 0 && <p className="border-t border-line px-4 py-3 text-xs text-muted">No loads in the {hidden} week{hidden === 1 ? '' : 's'} before this.</p>}
      </section>
    </div>
  );
}
