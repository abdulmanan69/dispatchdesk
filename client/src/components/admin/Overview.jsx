import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid } from 'recharts';
import { Users, UserCheck, UserPlus, CreditCard, DollarSign, Truck, UsersRound, Flag, GraduationCap, Store, MessagesSquare } from 'lucide-react';
import { api } from '../../lib/api.js';
import { money, num, label } from '../../lib/format.js';
import { Card, StatCard, QueryState, DataTable, Badge, EmptyState } from '../ui.jsx';
import { ChartBox, ThemedTooltip, useChartTheme, axisProps, shortDate, PALETTE } from '../dashboard/charts.jsx';

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
            <StatCard label="MRR (estimate)" value={money(d.mrrCents, { digits: 0 })} sub="active subs × plan price" icon={DollarSign} tone="green" />
            <StatCard label="Revenue (12 months)" value={money(d.revenue12mCents, { digits: 0 })} sub="paid Stripe invoices" icon={DollarSign} />
            <StatCard label="Carriers" value={num(d.carriers.total)} sub={`${num(d.carriers.new30d)} added in 30 days`} icon={Truck} />
            <StatCard label="Teams" value={num(d.teams)} icon={UsersRound} />
            <StatCard label="Open reports" value={num(d.openReports)} icon={Flag} tone={d.openReports ? 'red' : 'muted'} />
            <StatCard label="Training requests" value={num(d.newTrainingRequests)} sub="new" icon={GraduationCap} to="/app/admin/training" />
            <StatCard label="Marketplace listings" value={num(d.marketplaceListings)} icon={Store} />
            <StatCard label="Community posts" value={num(d.communityPosts)} icon={MessagesSquare} />
          </div>
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
