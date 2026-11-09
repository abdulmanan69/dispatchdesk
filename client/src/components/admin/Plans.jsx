import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useToast } from '../Toast.jsx';
import { money } from '../../lib/format.js';
import { Modal } from '../Modal.jsx';
import { Card, QueryState, Badge, Button, Field, Input, Select, Switch, Textarea } from '../ui.jsx';

const LIMITS = [
  ['maxCarriers', 'Carrier records'], ['maxDiscoveryPerDay', 'FMCSA leads saved / day'], ['dailyEmailLimit', 'Emails / day'],
  ['monthlyAiMessages', 'AI messages / month'], ['maxSequences', 'Sequences'], ['maxAutomations', 'Automations'],
  ['monthlyLeadGenLimit', 'Generated leads / month'], ['maxLeadGenerators', 'Lead generator profiles'],
];

function PlanEditor({ plan, onClose }) {
  const toast = useToast();
  const [f, setF] = useState({
    name: plan.name, description: plan.description || '', price: (plan.priceCents / 100).toFixed(2), interval: plan.interval,
    trialDays: plan.trialDays, minSeats: plan.minSeats, stripePriceId: plan.stripePriceId || '', active: plan.active,
    advancedReports: plan.advancedReports, trainingIncluded: plan.trainingIncluded, teamFeatures: plan.teamFeatures, leadGenAutoRun: plan.leadGenAutoRun,
    ...Object.fromEntries(LIMITS.map(([k]) => [k, plan[k]])),
  });
  const save = useApiMutation((body) => api.patch(`/api/admin/plans/${plan.id}`, body), {
    invalidate: [['admin', 'plans'], ['plans']],
    onSuccess: (d) => { toast.success('Plan saved'); if (d.note) toast.info(d.note); onClose(); },
  });
  const submit = (e) => {
    e.preventDefault();
    save.mutate({
      name: f.name, description: f.description, priceCents: Math.round(Number(f.price) * 100), interval: f.interval,
      trialDays: Number(f.trialDays), minSeats: Number(f.minSeats), stripePriceId: f.stripePriceId, active: f.active,
      advancedReports: f.advancedReports, trainingIncluded: f.trainingIncluded, teamFeatures: f.teamFeatures, leadGenAutoRun: f.leadGenAutoRun,
      ...Object.fromEntries(LIMITS.map(([k]) => [k, Number(f[k])])),
    });
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal open onClose={onClose} title={`Edit plan: ${plan.name}`} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="plan-form" loading={save.isPending}>Save plan</Button></>}>
      <form id="plan-form" className="grid gap-4 sm:grid-cols-2" onSubmit={submit}>
        <Field label="Name" required><Input value={f.name} onChange={set('name')} required /></Field>
        <Field label="Stripe price ID" hint="From Stripe → Products. Required for checkout."><Input value={f.stripePriceId} onChange={set('stripePriceId')} placeholder="price_..." disabled={plan.key === 'free'} /></Field>
        <Field label="Description" className="sm:col-span-2"><Textarea rows={2} value={f.description} onChange={set('description')} /></Field>
        <Field label="Displayed price (USD)" hint="Display only — Stripe charges the linked price"><Input type="number" min="0" step="0.01" value={f.price} onChange={set('price')} /></Field>
        <Field label="Billing interval"><Select value={f.interval} onChange={set('interval')}><option value="month">Monthly</option><option value="year">Yearly</option></Select></Field>
        <Field label="Trial days"><Input type="number" min="0" max="365" value={f.trialDays} onChange={set('trialDays')} /></Field>
        <Field label="Minimum seats"><Input type="number" min="1" value={f.minSeats} onChange={set('minSeats')} /></Field>
        <div className="sm:col-span-2"><p className="mb-2 text-[13px] font-medium">Limits <span className="font-normal text-muted">(-1 = unlimited)</span></p>
          <div className="grid gap-3 sm:grid-cols-3">
            {LIMITS.map(([k, l]) => <Field key={k} label={l}><Input type="number" min="-1" value={f[k]} onChange={set(k)} /></Field>)}
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:col-span-2">
          <Switch checked={f.advancedReports} onChange={(v) => setF({ ...f, advancedReports: v })} label="Advanced reporting" />
          <Switch checked={f.trainingIncluded} onChange={(v) => setF({ ...f, trainingIncluded: v })} label="Training entitlement" />
          <Switch checked={f.teamFeatures} onChange={(v) => setF({ ...f, teamFeatures: v })} label="Team features" />
          <Switch checked={f.leadGenAutoRun} onChange={(v) => setF({ ...f, leadGenAutoRun: v })} label="Scheduled lead generator runs" />
          <Switch checked={f.active} disabled={plan.key === 'free'} onChange={(v) => setF({ ...f, active: v })} label="Active (shown on pricing page)" />
        </div>
      </form>
    </Modal>
  );
}

export default function AdminPlans() {
  const [editing, setEditing] = useState(null);
  const q = useQuery({ queryKey: ['admin', 'plans'], queryFn: () => api.get('/api/admin/plans') });
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">Prices and limits are configurable. Plan limits take effect immediately. To charge customers, create a recurring price in your Stripe dashboard and paste its price ID here.</p>
      <QueryState query={q}>
        {(d) => (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {d.plans.map((p) => (
              <Card key={p.id} title={<div className="flex items-center gap-2"><span className="text-sm font-medium">{p.name}</span>{!p.active && <Badge>Inactive</Badge>}</div>}
                actions={<Button variant="ghost" size="sm" icon={Pencil} onClick={() => setEditing(p)}>Edit</Button>}>
                <p className="text-xl font-medium tabular">{money(p.priceCents)} <span className="text-sm font-normal text-muted">/{p.interval}{p.perSeat ? ' per seat' : ''}</span></p>
                <p className="mt-1 text-xs">{p.key === 'free' ? <span className="text-muted">No checkout needed</span> : p.stripePriceId ? <span className="font-mono text-muted">{p.stripePriceId}</span> : <span className="text-amber-700 dark:text-amber-300">No Stripe price linked — checkout disabled</span>}</p>
                <dl className="mt-3 space-y-1 text-xs">
                  {LIMITS.map(([k, l]) => <div key={k} className="flex justify-between"><dt className="text-muted">{l}</dt><dd className="tabular">{p[k] < 0 ? '∞' : p[k].toLocaleString('en-US')}</dd></div>)}
                  <div className="flex justify-between"><dt className="text-muted">Subscriptions</dt><dd className="tabular">{p._count.subscriptions}</dd></div>
                </dl>
              </Card>
            ))}
          </div>
        )}
      </QueryState>
      {editing && <PlanEditor plan={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
