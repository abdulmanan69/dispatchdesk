import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, FileText, Info } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { money, date, label } from '../../lib/format.js';
import { Card, PageHeader, Badge, Button, Loading, ErrorState, EmptyState, DataTable, Input, cx } from '../../components/ui.jsx';
import PlanCard from '../../components/billing/PlanCard.jsx';

const STATUS_COLOR = { active: 'green', trialing: 'blue', past_due: 'amber', incomplete: 'amber', unpaid: 'red', canceled: 'gray' };

function Meter({ label: name, used, limit }) {
  const unlimited = limit < 0;
  const ratio = unlimited || !limit ? 0 : Math.min(1, used / limit);
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span>{name}</span>
        <span className="tabular text-muted">{used.toLocaleString('en-US')} / {unlimited ? '∞' : limit.toLocaleString('en-US')}</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label={name} aria-valuenow={used} aria-valuemin={0} aria-valuemax={unlimited ? undefined : limit}>
        <div className={cx('h-full rounded-full', ratio >= 0.9 ? 'bg-red-500' : ratio >= 0.7 ? 'bg-signal-500' : 'bg-brand-500')} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

export default function Billing() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const checkout = params.get('checkout');
  const [polls, setPolls] = useState(0);
  const [seats, setSeats] = useState('');

  const me = useQuery({
    queryKey: ['billing', 'me'],
    queryFn: () => api.get('/api/billing/me'),
    // After returning from Stripe, refresh a few times while the webhook arrives.
    refetchInterval: checkout === 'success' && polls < 10 ? 3000 : false,
  });
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api.get('/api/billing/plans') });
  useEffect(() => { if (checkout === 'success' && me.dataUpdatedAt) setPolls((n) => n + 1); }, [me.dataUpdatedAt, checkout]);

  const go = (r) => { if (r?.url) window.location.assign(r.url); };
  const startCheckout = useApiMutation((planKey) => api.post('/api/billing/checkout', { planKey, seats: seats ? Number(seats) : undefined }), { onSuccess: go });
  const portal = useApiMutation(() => api.post('/api/billing/portal'), { onSuccess: go });
  const cancel = useApiMutation(() => api.post('/api/billing/cancel'), { success: 'Cancellation scheduled for the end of the billing period', invalidate: [['billing']] });
  const resume = useApiMutation(() => api.post('/api/billing/resume'), { success: 'Subscription will continue', invalidate: [['billing']] });
  const change = useApiMutation((planKey) => api.post('/api/billing/change-plan', { planKey }), { success: 'Plan change sent to Stripe', invalidate: [['billing']] });

  if (me.isLoading || plans.isLoading) return <Loading />;
  if (me.isError) return <ErrorState error={me.error} onRetry={me.refetch} />;
  const d = me.data;
  const sub = d.subscription;
  const payable = d.stripeMode !== 'unconfigured';
  const activated = checkout === 'success' && sub && ['active', 'trialing'].includes(sub.status);

  const actionFor = (p) => {
    if (p.key === d.plan.key) return <Button variant="secondary" className="w-full" disabled>Current plan</Button>;
    if (sub?.granted) return null; // plan given by an admin: no checkout changes from here
    if (p.key === 'free') return sub && sub.isOwner && !sub.cancelAtPeriodEnd ? <Button variant="secondary" className="w-full" onClick={onCancel}>Downgrade to Free</Button> : null;
    if (!p.purchasable || !payable) return <Button variant="secondary" className="w-full" disabled title="This plan is not available for online checkout yet">Not available yet</Button>;
    if (sub?.isOwner) {
      return <Button variant="secondary" className="w-full" loading={change.isPending && change.variables === p.key} onClick={async () => {
        if (await confirm({ title: `Switch to ${p.name}?`, message: 'Stripe prorates the difference on your next invoice. Your plan updates once Stripe confirms the change.', confirmLabel: 'Switch plan' })) change.mutate(p.key);
      }}>Switch to {p.name}</Button>;
    }
    if (sub?.managedByTeam) return null;
    if (p.perSeat && user.team?.role !== 'owner') return <Button variant="secondary" className="w-full" to="/app/team">Create a team first</Button>;
    return <Button className="w-full" loading={startCheckout.isPending && startCheckout.variables === p.key} onClick={() => startCheckout.mutate(p.key)}>
      {p.trialDays ? `Start ${p.trialDays}-day trial` : `Upgrade to ${p.name}`}
    </Button>;
  };

  async function onCancel() {
    if (await confirm({ title: 'Cancel subscription?', message: 'Your plan stays active until the end of the current billing period, then your account moves to Free. Your data is kept.', confirmLabel: 'Cancel subscription', danger: true })) cancel.mutate();
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Billing" subtitle="Your plan, usage, invoices and payment settings" />

      {checkout === 'success' && (
        <div className={cx('flex items-start gap-2 rounded-lg border px-4 py-3 text-sm', activated ? 'border-green-200 bg-green-50 text-green-900 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200' : 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200')}>
          <Info className="mt-0.5 size-4 shrink-0" />
          <div className="flex-1">{activated ? 'Your subscription is active. Thank you!' : polls >= 10 ? 'Stripe has not confirmed the subscription yet. It activates automatically as soon as Stripe sends confirmation — check back in a few minutes.' : 'Checkout finished. Waiting for Stripe to confirm your subscription…'}</div>
          <button type="button" className="text-xs underline" onClick={() => setParams({})}>Dismiss</button>
        </div>
      )}
      {checkout === 'canceled' && (
        <div className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3 text-sm">
          Checkout was canceled. No charge was made.
          <button type="button" className="text-xs underline" onClick={() => setParams({})}>Dismiss</button>
        </div>
      )}
      {!payable && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Online payments are not configured on this installation. An administrator needs to add Stripe keys before plans can be purchased.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Current plan" className="lg:col-span-1">
          <div className="flex items-center gap-2">
            <span className="text-2xl font-medium">{d.plan.name}</span>
            {sub && <Badge color={STATUS_COLOR[sub.status]}>{label(sub.status)}</Badge>}
          </div>
          <p className="mt-1 text-sm text-muted">{d.plan.description}</p>
          {sub ? (
            <dl className="mt-4 space-y-1.5 text-sm">
              {sub.trialEndsAt && sub.status === 'trialing' && <div className="flex justify-between"><dt className="text-muted">Trial ends</dt><dd>{date(sub.trialEndsAt)}</dd></div>}
              <div className="flex justify-between"><dt className="text-muted">{sub.cancelAtPeriodEnd || sub.granted ? 'Ends on' : 'Renews on'}</dt><dd>{sub.currentPeriodEnd ? date(sub.currentPeriodEnd) : 'No end date'}</dd></div>
              {sub.seats > 1 && <div className="flex justify-between"><dt className="text-muted">Seats</dt><dd className="tabular">{sub.seats}</dd></div>}
              {sub.granted && <p className="text-xs text-muted">Given to you by an administrator{sub.currentPeriodEnd ? '' : ' with no end date'}. No payment is taken.</p>}
              {sub.managedByTeam && <p className="text-xs text-muted">Provided by your team. The team owner manages this subscription.</p>}
            </dl>
          ) : <p className="mt-4 text-sm text-muted">Free forever. Upgrade any time for higher limits.</p>}
          {d.pendingSubscription && !sub && (
            <p className="mt-3 rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">A {label(d.pendingSubscription.planKey)} checkout started {date(d.pendingSubscription.createdAt)} is {label(d.pendingSubscription.status).toLowerCase()} — it activates only when Stripe confirms payment.</p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            {sub?.isOwner && sub.hasPortal && <Button variant="secondary" size="sm" icon={ExternalLink} loading={portal.isPending} onClick={() => portal.mutate()}>Payment methods & invoices</Button>}
            {sub?.isOwner && !sub.cancelAtPeriodEnd && <Button variant="ghost" size="sm" className="text-red-600" loading={cancel.isPending} onClick={onCancel}>Cancel subscription</Button>}
            {sub?.isOwner && sub.cancelAtPeriodEnd && <Button size="sm" loading={resume.isPending} onClick={() => resume.mutate()}>Keep my subscription</Button>}
          </div>
        </Card>

        <Card title="Usage" className="lg:col-span-2" actions={<span className="text-xs text-muted">Resets daily / monthly where noted</span>}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Meter label="Carrier records" used={d.usage.carriers} limit={d.plan.limits.maxCarriers} />
            <Meter label="Emails sent today" used={d.usage.emailsToday} limit={d.plan.limits.dailyEmailLimit} />
            <Meter label="AI messages this month" used={d.usage.aiMonth} limit={d.plan.limits.monthlyAiMessages} />
            <Meter label="FMCSA leads saved today" used={d.usage.discoveryToday} limit={d.plan.limits.maxDiscoveryPerDay} />
            <Meter label="Generated leads this month" used={d.usage.leadGenMonth} limit={d.plan.limits.monthlyLeadGenLimit} />
            <Meter label="Lead generator profiles" used={d.usage.leadGenerators} limit={d.plan.limits.maxLeadGenerators} />
            <Meter label="Sequences" used={d.usage.sequences} limit={d.plan.limits.maxSequences} />
            <Meter label="Automations" used={d.usage.automations} limit={d.plan.limits.maxAutomations} />
          </div>
        </Card>
      </div>

      <section>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-base font-medium">Plans</h2>
          {user.team?.role === 'owner' && !sub && (
            <label className="flex items-center gap-2 text-sm text-muted">Team seats
              <Input type="number" min={2} value={seats} onChange={(e) => setSeats(e.target.value)} placeholder="auto" className="w-24" />
            </label>
          )}
        </div>
        {plans.isError ? <ErrorState error={plans.error} onRetry={plans.refetch} /> : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {plans.data.plans.map((p) => <PlanCard key={p.key} plan={p} current={p.key === d.plan.key} highlight={p.key === 'pro' && d.plan.key === 'free'} action={actionFor(p)} />)}
          </div>
        )}
        <p className="mt-3 text-xs text-muted">Prices exclude applicable taxes. Payments are processed by Stripe{d.stripeMode === 'test' ? ' (test mode — use Stripe test cards)' : ''}.</p>
      </section>

      <Card title="Payment history" bodyClass="p-0">
        <DataTable
          rows={d.payments}
          empty={<EmptyState icon={FileText} title="No payments yet">Invoices appear here once Stripe confirms a payment.</EmptyState>}
          columns={[
            { key: 'date', header: 'Date', render: (p) => date(p.paidAt || p.createdAt) },
            { key: 'description', header: 'Description', render: (p) => p.description || 'Subscription' },
            { key: 'period', header: 'Period', render: (p) => (p.periodStart ? `${date(p.periodStart)} – ${date(p.periodEnd)}` : '—') },
            { key: 'amount', header: 'Amount', className: 'text-right tabular', render: (p) => money(p.amountCents, { currency: p.currency.toUpperCase() }) },
            { key: 'status', header: 'Status', render: (p) => <Badge color={p.status === 'paid' ? 'green' : 'red'}>{label(p.status)}</Badge> },
            { key: 'invoice', header: '', render: (p) => (p.invoiceUrl ? <a href={p.invoiceUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-brand-700 hover:underline dark:text-brand-300">Invoice</a> : null) },
          ]}
        />
      </Card>
    </div>
  );
}
