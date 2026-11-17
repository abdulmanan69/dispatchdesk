import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid } from 'recharts';
import { Users, UserCheck, UserPlus, CreditCard, DollarSign, Truck, UsersRound, Flag, GraduationCap, Store, MessagesSquare, Gift, Hourglass, CalendarClock, Lock } from 'lucide-react';
import { api } from '../../lib/api.js';
import { money, num, label } from '../../lib/format.js';
import { Card, StatCard, QueryState, DataTable, Badge, EmptyState } from '../ui.jsx';
import { ChartBox, ThemedTooltip, useChartTheme, axisProps, shortDate, PALETTE } from '../dashboard/charts.jsx';

const CANCEL_REASON = {
  too_expensive: 'It costs too much',
  missing_feature: 'A feature is missing',
  not_using: 'Not using it enough',
  switching: 'Moving to another tool',
  business_paused: 'Business paused or closed',
  other: 'Something else',
  none: 'No reason given',
};

/** Why subscribers canceled in the last 90 days (reasons from the cancel dialog; comments are in the audit log). */
function CancelReasons({ rows }) {
  if (!rows?.length) return null;
  const total = rows.reduce((n, r) => n + r.count, 0);
  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="mb-2 flex items-baseline justify-between text-xs text-muted">
        <span>Why people canceled, last 90 days</span>
        <span className="tabular-nums">{num(total)} total</span>
      </div>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.reason} className="grid grid-cols-[minmax(0,12rem)_1fr_2.5rem] items-center gap-3 text-sm">
            <span className="truncate">{CANCEL_REASON[r.reason] || r.reason}</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-surface-2"><span className="block h-full rounded-full bg-brand-500" style={{ width: `${Math.round((r.count / total) * 100)}%` }} /></span>
            <span className="text-right tabular-nums text-muted">{num(r.count)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Overview({ onTab }) {
  const q = useQuery({ queryKey: ['admin', 'stats'], queryFn: () => api.get('/api/admin/stats') });
  const t = useChartTheme();
  return (
    <QueryState query={q}>
      {(d) => (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <StatCard label="Total users" value={num(d.users.total)} icon={Users} />
            <StatCard label="Active (30 days)" value={num(d.users.active30d)} icon={UserCheck} tone="green" />
            <StatCard label="New (30 days)" value={num(d.users.new30d)} icon={UserPlus} tone="signal" />
            <StatCard label="Active subscriptions" value={num(d.activeSubscriptions)} icon={CreditCard} />
            <StatCard label="MRR (estimate)" value={money(d.mrrCents, { digits: 0 })} sub="paying subscriptions × plan price" icon={DollarSign} tone="green" />
            <StatCard label="Revenue (12 months)" value={money(d.revenue12mCents, { digits: 0 })} sub="paid invoices" icon={DollarSign} />
            <StatCard label="Carriers" value={num(d.carriers.total)} sub={`${num(d.carriers.new30d)} added in 30 days`} icon={Truck} />
            <StatCard label="Teams" value={num(d.teams)} icon={UsersRound} />
            <StatCard label="Open reports" value={num(d.openReports)} icon={Flag} tone={d.openReports ? 'red' : 'muted'} />
            <StatCard label="Training requests" value={num(d.newTrainingRequests)} sub="new" icon={GraduationCap} to="/app/admin/training" />
            <StatCard label="Marketplace listings" value={num(d.marketplaceListings)} icon={Store} />
            <StatCard label="Community posts" value={num(d.communityPosts)} icon={MessagesSquare} />
          </div>
          {d.billing && (
            <Card title="Trial and plans" actions={<span className="text-xs text-muted">{d.billing.trialDays ? `${d.billing.trialDays}-day free trial` : 'Free trial off'}</span>}>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                <StatCard label="Paying customers" value={num(d.billing.paying)} icon={CreditCard} tone="green" />
                <StatCard label="Gifted plans" value={num(d.billing.gifted)} sub="admin gifts and codes" icon={Gift} />
                <StatCard label="On free trial" value={num(d.billing.onTrial)} icon={Hourglass} tone="signal" />
                <StatCard label="Trials ending in 7 days" value={num(d.billing.endingSoon)} icon={CalendarClock} tone={d.billing.endingSoon ? 'amber' : 'muted'} />
                <StatCard label="Trials ended, no plan" value={num(d.billing.ended)} sub="read-only now" icon={Lock} tone={d.billing.ended ? 'red' : 'muted'} />
              </div>
              <CancelReasons rows={d.billing.cancelReasons} />
            </Card>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="New registrations (30 days)">
              <ChartBox label={`New registrations per day, ${d.users.new30d} total`}>
                <AreaChart data={d.registrations} margin={{ left: -18, right: 6, top: 6 }}>
                  <CartesianGrid stroke={t.line} vertical={false} />
                  <XAxis dataKey="date" tickFormatter={shortDate} {...axisProps(t)} minTickGap={18} />
                  <YAxis allowDecimals={false} {...axisProps(t)} />
                  <ThemedTooltip labelFormatter={shortDate} />
                  <Area type="monotone" dataKey="count" name="Registrations" stroke={PALETTE.brand} fill={PALETTE.brand} fillOpacity={0.15} strokeWidth={2} />
                </AreaChart>
              </ChartBox>
            </Card>
            <Card title="Revenue by month">
              <ChartBox label="Paid invoice revenue by month">
                <BarChart data={d.revenueByMonth.map((m) => ({ ...m, dollars: m.cents / 100 }))} margin={{ left: -6, right: 6, top: 6 }}>
                  <CartesianGrid stroke={t.line} vertical={false} />
                  <XAxis dataKey="month" {...axisProps(t)} tickFormatter={(m) => m.slice(5)} />
                  <YAxis {...axisProps(t)} tickFormatter={(v) => `$${v}`} />
                  <ThemedTooltip formatter={(v) => [`$${Number(v).toFixed(2)}`, 'Revenue']} />
                  <Bar dataKey="dollars" name="Revenue" fill={PALETTE.green} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ChartBox>
            </Card>
            <Card title="Subscriptions by plan and status" bodyClass="p-0" actions={<button type="button" className="text-xs text-brand-700 hover:underline dark:text-brand-300" onClick={() => onTab('subscriptions')}>View all</button>}>
              <DataTable rows={d.subscriptions.map((s, i) => ({ ...s, id: i }))} empty={<EmptyState title="No subscriptions yet" />}
                columns={[
                  { key: 'plan', header: 'Plan' },
                  { key: 'status', header: 'Status', render: (s) => <Badge>{label(s.status)}</Badge> },
                  { key: 'count', header: 'Count', className: 'text-right tabular' },
                ]} />
            </Card>
            <Card title="Users by role" bodyClass="p-0">
              <DataTable rows={d.usersByRole.map((s, i) => ({ ...s, id: i }))}
                columns={[{ key: 'role', header: 'Role' }, { key: 'count', header: 'Users', className: 'text-right tabular' }]} />
            </Card>
          </div>
        </div>
      )}
    </QueryState>
  );
}
