import { useQuery } from '@tanstack/react-query';
import { Check, Minus } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Button, Loading, ErrorState } from '../../components/ui.jsx';
import PlanCard from '../../components/billing/PlanCard.jsx';

const lim = (v) => (v < 0 ? 'Unlimited' : v.toLocaleString('en-US'));
const ROWS = [
  ['Carrier records', (p) => lim(p.limits.maxCarriers)],
  ['FMCSA leads saved per day', (p) => lim(p.limits.maxDiscoveryPerDay)],
  ['Generated leads per month', (p) => lim(p.limits.monthlyLeadGenLimit)],
  ['Lead generator profiles', (p) => lim(p.limits.maxLeadGenerators)],
  ['Scheduled lead generation', (p) => p.leadGenAutoRun],
  ['Emails per day', (p) => lim(p.limits.dailyEmailLimit)],
  ['AI dispatcher messages per month', (p) => lim(p.limits.monthlyAiMessages)],
  ['Sequences', (p) => lim(p.limits.maxSequences)],
  ['Automations', (p) => lim(p.limits.maxAutomations)],
  ['CRM, pipeline & prospecting', () => true],
  ['Advanced reporting', (p) => p.advancedReports],
  ['Training entitlement', (p) => p.trainingIncluded],
  ['Team board & permissions', (p) => p.teamFeatures],
];

export default function Pricing() {
  const { user } = useAuth();
  const q = useQuery({ queryKey: ['plans'], queryFn: () => api.get('/api/billing/plans') });

  return (
    <div className="mx-auto max-w-6xl px-4 py-14">
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-3xl font-medium tracking-[-0.01em] sm:text-4xl">Simple plans for dispatchers</h1>
        <p className="mt-3 text-muted">Start free and keep using it as long as you like. Upgrade when you need higher limits, the advanced AI dispatcher, or a team.</p>
      </div>
      {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={q.refetch} /> : (
        <>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {q.data.plans.map((p) => (
              <PlanCard key={p.key} plan={p} highlight={p.key === 'pro'}
                action={<Button className="w-full" variant={p.key === 'pro' ? 'primary' : 'secondary'} to={user ? '/app/billing' : `/register?next=${encodeURIComponent('/app/billing')}`}>
                  {p.key === 'free' ? (user ? 'Open app' : 'Start free') : p.trialDays ? `Start ${p.trialDays}-day trial` : `Choose ${p.name}`}
                </Button>} />
            ))}
          </div>

          <div className="mt-14 overflow-x-auto rounded-xl border border-line bg-surface">
            <table className="w-full min-w-[640px] text-sm">
              <caption className="sr-only">Plan comparison</caption>
              <thead>
                <tr className="border-b border-line text-left">
                  <th className="px-4 py-3 font-medium">Compare plans</th>
                  {q.data.plans.map((p) => <th key={p.key} className="px-4 py-3 text-center font-medium">{p.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {ROWS.map(([name, fn]) => (
                  <tr key={name} className="border-b border-line/70 last:border-0">
                    <td className="px-4 py-2.5 text-muted">{name}</td>
                    {q.data.plans.map((p) => {
                      const v = fn(p);
                      return (
                        <td key={p.key} className="px-4 py-2.5 text-center tabular">
                          {v === true ? <Check className="mx-auto size-4 text-brand-600" aria-label="Included" /> : v === false ? <Minus className="mx-auto size-4 text-muted/50" aria-label="Not included" /> : v}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-8 grid gap-6 text-sm text-muted sm:grid-cols-3">
            <p><span className="font-medium text-fg">Payments.</span> Card payments are processed securely by Stripe. We never see or store your card number.</p>
            <p><span className="font-medium text-fg">Taxes.</span> Prices are in USD and exclude applicable taxes.</p>
            <p><span className="font-medium text-fg">Cancel anytime.</span> Paid plans stay active until the end of the billing period, then you return to Free — your data stays.</p>
          </div>
          {!q.data.paymentsEnabled && <p className="mt-6 text-center text-xs text-muted">Online checkout is not enabled on this installation yet.</p>}
        </>
      )}
    </div>
  );
}
