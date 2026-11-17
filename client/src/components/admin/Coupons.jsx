import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Ticket } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { date, money } from '../../lib/format.js';
import { Modal } from '../Modal.jsx';
import { Badge, Button, Card, DataTable, EmptyState, Field, Input, QueryState, Select, Textarea, Switch } from '../ui.jsx';

const DURATION_TEXT = { once: 'first payment', forever: 'every payment', repeating: (m) => `${m} month${m === 1 ? '' : 's'}` };

export function couponValue(c) {
  if (c.kind === 'plan') return `${c.planName || c.planKey} ${c.planMonths ? `for ${c.planMonths} month${c.planMonths === 1 ? '' : 's'}` : 'with no end date'}, free`;
  const off = c.percentOff ? `${c.percentOff}% off` : `${money(c.amountOffCents)} off`;
  const span = c.duration === 'repeating' ? DURATION_TEXT.repeating(c.durationMonths) : DURATION_TEXT[c.duration];
  return `${off}, ${span}`;
}

const status = (c) => (!c.active ? ['Off', 'gray'] : c.expiresAt && new Date(c.expiresAt) <= new Date() ? ['Expired', 'gray']
  : c.maxRedemptions != null && (c.used ?? 0) >= c.maxRedemptions ? ['Used up', 'gray'] : ['Active', 'green']);

const BLANK = { kind: 'discount', code: '', description: '', off: 'percent', percentOff: '20', amountOff: '', duration: 'once', durationMonths: '3', planKey: 'pro', planMonths: '1', maxRedemptions: '', expiresAt: '' };

function NewCode({ plans, onClose }) {
  const [f, setF] = useState(BLANK);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const create = useApiMutation((body) => api.post('/api/admin/coupons', body), { success: (d) => `Code ${d.coupon.code} created`, invalidate: [['admin', 'coupons']], onSuccess: onClose });
  const submit = () => create.mutate({
    kind: f.kind, code: f.code.trim(), description: f.description.trim() || undefined,
    ...(f.kind === 'discount'
      ? { ...(f.off === 'percent' ? { percentOff: Number(f.percentOff) } : { amountOffCents: Math.round(Number(f.amountOff) * 100) }), duration: f.duration, ...(f.duration === 'repeating' ? { durationMonths: Number(f.durationMonths) } : {}) }
      : { planKey: f.planKey, planMonths: f.planMonths ? Number(f.planMonths) : null }),
    maxRedemptions: f.maxRedemptions ? Number(f.maxRedemptions) : undefined,
    expiresAt: f.expiresAt ? new Date(`${f.expiresAt}T23:59:59`).toISOString() : undefined,
  });
  return (
    <Modal open onClose={onClose} title="New code" size="md"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={create.isPending} disabled={!f.code.trim()} onClick={submit}>Create code</Button></>}>
      <div className="space-y-4">
        <Field label="Type">
          <Select value={f.kind} onChange={set('kind')}>
            <option value="discount">Discount at checkout (Stripe)</option>
            <option value="plan">Free plan months (redeemed in the app, no payment)</option>
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code" hint="Letters, numbers, - and _"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/\s+/g, '') })} maxLength={40} placeholder="LAUNCH20" /></Field>
          <Field label="Internal note"><Input value={f.description} onChange={set('description')} maxLength={120} placeholder="Facebook group launch" /></Field>
        </div>
        {f.kind === 'discount' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Discount">
              <Select value={f.off} onChange={set('off')}><option value="percent">Percent off</option><option value="amount">Dollar amount off</option></Select>
            </Field>
            {f.off === 'percent'
              ? <Field label="Percent off"><Input type="number" min="1" max="100" value={f.percentOff} onChange={set('percentOff')} /></Field>
              : <Field label="Amount off ($)"><Input type="number" min="1" step="0.01" value={f.amountOff} onChange={set('amountOff')} /></Field>}
            <Field label="Applies to">
              <Select value={f.duration} onChange={set('duration')}>
                <option value="once">The first payment</option><option value="repeating">A number of months</option><option value="forever">Every payment</option>
              </Select>
            </Field>
            {f.duration === 'repeating' && <Field label="Months"><Input type="number" min="1" max="36" value={f.durationMonths} onChange={set('durationMonths')} /></Field>}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Plan">
              <Select value={f.planKey} onChange={set('planKey')}>{plans.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</Select>
            </Field>
            <Field label="For how long">
              <Select value={f.planMonths} onChange={set('planMonths')}>
                {[['1', '1 month'], ['3', '3 months'], ['6', '6 months'], ['12', '12 months'], ['', 'No end date']].map(([v, l]) => <option key={l} value={v}>{l}</option>)}
              </Select>
            </Field>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Max uses" hint="Blank: no limit"><Input type="number" min="1" value={f.maxRedemptions} onChange={set('maxRedemptions')} /></Field>
          <Field label="Expires on" hint="Blank: never"><Input type="date" value={f.expiresAt} onChange={set('expiresAt')} /></Field>
        </div>
        {f.kind === 'discount' && <p className="text-xs text-muted">Customers type the code on the Stripe checkout page when they upgrade.</p>}
        {f.kind === 'plan' && <p className="text-xs text-muted">Users enter the code under Billing → Have a code? Each user can use a code once.</p>}
      </div>
    </Modal>
  );
}

/** Admin → Codes: discount codes for checkout and codes for free plan months. */
export default function Coupons() {
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['admin', 'coupons'], queryFn: () => api.get('/api/admin/coupons') });
  const plans = useQuery({ queryKey: ['admin', 'plans'], queryFn: () => api.get('/api/admin/plans') });
  const toggle = useApiMutation(({ id, active }) => api.patch(`/api/admin/coupons/${id}`, { active }), { success: (d) => (d.coupon.active ? 'Code turned on' : 'Code turned off'), invalidate: [['admin', 'coupons']] });
  const paid = (plans.data?.plans || []).filter((p) => p.key !== 'free' && p.active);
  return (
    <Card title="Codes" bodyClass="p-0" actions={<Button size="sm" icon={Plus} onClick={() => setCreating(true)}>New code</Button>}>
      <QueryState query={q}>
        {(d) => (
          <DataTable rows={d.coupons}
            empty={<EmptyState icon={Ticket} title="No codes yet">Create a discount code for checkout, or a code that unlocks a plan for free months.</EmptyState>}
            columns={[
              { key: 'code', header: 'Code', render: (c) => <div><p className="font-mono font-medium">{c.code}</p>{c.description && <p className="text-xs text-muted">{c.description}</p>}</div> },
              { key: 'kind', header: 'Type', render: (c) => (c.kind === 'plan' ? 'Free months' : 'Discount') },
              { key: 'value', header: 'Gives', render: (c) => couponValue(c) },
              { key: 'used', header: 'Used', className: 'tabular', render: (c) => `${c.used ?? '—'}${c.maxRedemptions != null ? ` / ${c.maxRedemptions}` : ''}` },
              { key: 'expires', header: 'Expires', render: (c) => (c.expiresAt ? date(c.expiresAt) : 'Never') },
              { key: 'status', header: 'Status', render: (c) => { const [t, color] = status(c); return <Badge color={color}>{t}</Badge>; } },
              { key: 'on', header: <span className="sr-only">On or off</span>, render: (c) => <Switch checked={c.active} onChange={(v) => toggle.mutate({ id: c.id, active: v })} label={<span className="sr-only">{c.active ? 'Turn off' : 'Turn on'} {c.code}</span>} /> },
            ]} />
        )}
      </QueryState>
      {creating && <NewCode plans={paid} onClose={() => setCreating(false)} />}
    </Card>
  );
}
