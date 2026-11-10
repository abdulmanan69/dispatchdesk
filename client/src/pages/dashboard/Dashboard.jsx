import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AreaChart, Area, Line, XAxis, YAxis, CartesianGrid } from 'recharts';
import { ListOrdered, CalendarClock, BadgeCheck, Phone, UserPlus, Handshake } from 'lucide-react';
import { api } from '../../lib/api.js';
import { num, pct, relative, dateTime, date, label } from '../../lib/format.js';
import { Card, PageHeader, Select, StatCard, Loading, ErrorState, EmptyState, Button, cx } from '../../components/ui.jsx';
import GettingStarted from '../../components/tour/GettingStarted.jsx';
import { ChartBox, ThemedTooltip, useChartTheme, axisProps, shortDate, PALETTE, Legend, SERIES } from '../../components/dashboard/charts.jsx';

const POSITIVE = new Set(['interested', 'converted', 'call_back', 'follow_up']);

// Each call outcome keeps one color across the app: good news green/teal, neutral blue/purple, bad red/gray.
const OUTCOME_COLOR = {
  interested: '#22c55e', converted: '#14b8a6', follow_up: '#3b82f6', call_back: '#8b5cf6', voicemail: '#f59e0b',
  no_answer: '#94a3b8', busy: '#f97316', not_interested: '#ef4444', wrong_number: '#ec4899',
};

export default function Dashboard() {
  const [range, setRange] = useState('30');
  const [scope, setScope] = useState('mine');
  const q = useQuery({ queryKey: ['dashboard', range, scope], queryFn: () => api.get('/api/dashboard', { range, scope }) });
  const t = useChartTheme();
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div>
      <PageHeader
        title={today}
        subtitle={`${scope === 'team' ? 'Team' : 'Your'} numbers for the last ${range} days`}
        actions={<>
          {q.data?.canViewTeam && (
            <Select aria-label="Scope" value={scope} onChange={(e) => setScope(e.target.value)} className="w-32">
              <option value="mine">Just me</option>
              <option value="team">Team</option>
            </Select>
          )}
          <Select aria-label="Date range" value={range} onChange={(e) => setRange(e.target.value)} className="w-36">
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </Select>
        </>}
      />
      {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={q.refetch} /> : <Body d={q.data} t={t} />}
    </div>
  );
}

function Body({ d, t }) {
  const x = d.totals;
  const empty = x.carriers === 0;
  const maxStage = Math.max(1, ...d.pipeline.filter((s) => s.key !== 'archived').map((s) => s.count));
  const outcomes = [...d.callOutcomes].sort((a, b) => b.count - a.count);
  const maxOutcome = Math.max(1, ...outcomes.map((o) => o.count));
  const days = `last ${d.range} days`;

  return (
    <div className="space-y-6">
      <GettingStarted />
      {empty && (
        <Card>
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium">Start by building your carrier list</p>
              <p className="mt-1 text-sm text-fg-2">Search the FMCSA public census, import a CSV or add a carrier by hand. These numbers fill in as you work.</p>
            </div>
            <div className="flex gap-2">
              <Button to="/app/discover">Find carriers</Button>
              <Button variant="secondary" to="/app/import">Import CSV</Button>
            </div>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Calls made" value={num(x.callsCompleted)} sub={days} to="/app/prospecting" icon={Phone} color="blue" />
        <StatCard label="New leads" value={num(x.newLeads)} sub={`${num(x.carriers)} carriers in total`} to="/app/carriers" icon={UserPlus} color="purple" />
        <StatCard label="Active opportunities" value={num(x.activeOpportunities)} sub={`${num(x.trials)} on trial`} to="/app/opportunities" icon={Handshake} color="amber" />
        <StatCard label="Signed customers" value={num(x.customers)} sub={`${num(x.customersInRange)} signed in the ${days}`} to="/app/customers" icon={BadgeCheck} color="green" />
      </div>

      <dl className="grid grid-cols-2 divide-line rounded-xl border border-line bg-surface sm:grid-cols-4 sm:divide-x">
        {[
          ['Due in sequence today', num(x.dueToday), `${num(x.inSequence)} ${x.inSequence === 1 ? "carrier" : "carriers"} enrolled`, '/app/prospecting'],
          ['Pending follow-ups', num(x.pendingFollowUps), x.overdueFollowUps ? `${num(x.overdueFollowUps)} overdue` : 'None overdue', '/app/follow-ups', x.overdueFollowUps > 0],
          ['Emails sent', num(x.emailsSent), 'Accepted by your mail provider', '/app/email?tab=sent'],
          ['Lead to customer', x.conversionRate == null ? '—' : pct(x.conversionRate), `${x.overallConversionRate == null ? '—' : pct(x.overallConversionRate)} of all carriers are customers`],
        ].map(([k, v, sub, to, warn], i) => {
          const inner = (
            <>
              <dt className="flex items-center gap-2 text-xs text-fg-2"><span className="size-2 rounded-full" style={{ background: SERIES[(i + 4) % SERIES.length] }} aria-hidden />{k}</dt>
              <dd className="mt-1 flex items-baseline gap-2"><span className="text-lg font-medium tabular">{v}</span></dd>
              <dd className={cx('mt-0.5 truncate text-xs', warn ? 'text-red-600 dark:text-red-400' : 'text-muted')}>{sub}</dd>
            </>
          );
          return to
            ? <Link key={k} to={to} className="block px-5 py-4 transition-ui hover:bg-surface-2/60">{inner}</Link>
            : <div key={k} className="px-5 py-4">{inner}</div>;
        })}
      </dl>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Calls and new leads" actions={<Legend items={[{ label: 'Calls', color: PALETTE.brand }, { label: 'New leads', color: PALETTE.purple }]} />}>
          <ChartBox height={300} label={`Calls and new leads per day: ${x.callsCompleted} calls, ${x.newLeads} new leads`}>
            <AreaChart data={d.series} margin={{ left: -20, right: 8, top: 8 }}>
              <defs>
                <linearGradient id="gCalls" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={PALETTE.brand} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={PALETTE.brand} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={t.line} vertical={false} />
              <XAxis dataKey="date" tickFormatter={shortDate} {...axisProps(t)} minTickGap={24} />
              <YAxis allowDecimals={false} {...axisProps(t)} />
              <ThemedTooltip labelFormatter={shortDate} />
              <Line type="monotone" dataKey="leads" name="New leads" stroke={PALETTE.purple} strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="calls" name="Calls" stroke={PALETTE.brand} fill="url(#gCalls)" strokeWidth={2} activeDot={{ r: 3 }} />
            </AreaChart>
          </ChartBox>
        </Card>

        <Card title="Pipeline" actions={<Link to="/app/pipeline" className="text-xs text-fg-2 hover:text-fg">Open board</Link>}>
          <ul className="space-y-3">
            {d.pipeline.filter((s) => s.key !== 'archived').map((s) => (
              <li key={s.key}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2"><span className="size-2 rounded-full" style={{ background: s.color }} />{s.name}</span>
                  <span className="font-mono text-xs tabular text-fg-2">{num(s.count)}</span>
                </div>
                <div className="h-1.5 rounded-full bg-surface-2">
                  <div className="h-1.5 rounded-full" style={{ width: `${(s.count / maxStage) * 100}%`, background: s.color }} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Today's sequence" actions={<Link to="/app/prospecting" className="text-xs text-fg-2 hover:text-fg">Call queue</Link>} bodyClass="p-0">
          {!d.todaysSequence.length ? <EmptyState icon={ListOrdered} title="Nothing due today">Enroll carriers in a sequence to get a daily call list.</EmptyState> : (
            <ul className="divide-y divide-line">
              {d.todaysSequence.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <Link to={`/app/carriers/${e.carrier.id}`} className="block truncate text-sm font-medium hover:underline">{e.carrier.companyName}</Link>
                    <p className="truncate text-xs text-muted">{label(e.stepType)} · {e.sequence} · day {e.day}</p>
                  </div>
                  <span className={cx('shrink-0 font-mono text-xs', e.overdue ? 'text-red-600 dark:text-red-400' : 'text-muted')}>{e.overdue ? 'Overdue' : dateTime(e.dueAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Upcoming follow-ups" actions={<Link to="/app/follow-ups" className="text-xs text-fg-2 hover:text-fg">All</Link>} bodyClass="p-0">
          {!d.upcomingFollowUps.length ? <EmptyState icon={CalendarClock} title="No follow-ups scheduled" /> : (
            <ul className="divide-y divide-line">
              {d.upcomingFollowUps.map((f) => (
                <li key={f.id} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <Link to={`/app/carriers/${f.carrier.id}`} className="truncate text-sm font-medium hover:underline">{f.carrier.companyName}</Link>
                    <span className={cx('shrink-0 font-mono text-xs', f.overdue ? 'text-red-600 dark:text-red-400' : 'text-muted')}>{relative(f.dueAt)}</span>
                  </div>
                  <p className="truncate text-xs text-muted">{label(f.type)}{f.note ? ` · ${f.note}` : ''}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Call outcomes" actions={<span className="text-xs text-muted">{days}</span>}>
          {!outcomes.length ? <EmptyState icon={Phone} title="No calls logged yet">Log calls from Prospecting to see how conversations go.</EmptyState> : (
            <ul className="space-y-3">
              {outcomes.map((o) => (
                <li key={o.outcome}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span>{label(o.outcome)}</span>
                    <span className="font-mono text-xs tabular text-fg-2">{num(o.count)}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-surface-2">
                    <div className="h-1.5 rounded-full" style={{ width: `${(o.count / maxOutcome) * 100}%`, background: OUTCOME_COLOR[o.outcome] || (POSITIVE.has(o.outcome) ? PALETTE.green : PALETTE.slate) }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Recent activity" bodyClass="p-0">
          {!d.recentActivities.length ? <EmptyState title="No activity yet">Calls, emails, notes and stage changes appear here.</EmptyState> : (
            <ul className="divide-y divide-line">
              {d.recentActivities.map((a) => (
                <li key={a.id} className="grid grid-cols-[96px_1fr] gap-4 px-5 py-3 text-sm sm:grid-cols-[112px_1fr_auto]">
                  <span className="font-mono text-xs leading-5 text-muted">{relative(a.createdAt)}</span>
                  <div className="min-w-0">
                    <p className="truncate">{a.summary}</p>
                    <p className="text-xs text-muted">
                      {label(a.type)}{!a.mine && <> · {a.user.name}</>}
                      {a.carrier && <> · <Link to={`/app/carriers/${a.carrier.id}`} className="hover:text-fg hover:underline">{a.carrier.companyName}</Link></>}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Recent customers" actions={<Link to="/app/customers" className="text-xs text-fg-2 hover:text-fg">All</Link>} bodyClass="p-0">
          {!d.recentCustomers.length ? <EmptyState icon={BadgeCheck} title="No customers yet">Move a carrier to Customers when they sign.</EmptyState> : (
            <ul className="divide-y divide-line">
              {d.recentCustomers.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3 px-5 py-3">
                  <div className="min-w-0">
                    <Link to={`/app/customers/${c.id}`} className="block truncate text-sm font-medium hover:underline">{c.carrier.companyName}</Link>
                    <p className="font-mono text-xs text-muted">{c.carrier.mcNumber ? `MC ${c.carrier.mcNumber}` : 'No MC'}{c.carrier.state ? ` · ${c.carrier.state}` : ''}</p>
                  </div>
                  <span className="shrink-0 font-mono text-xs text-muted">{date(c.signedAt, { month: 'short', day: 'numeric' })}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
