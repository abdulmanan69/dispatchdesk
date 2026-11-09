import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { money } from '../../lib/format.js';
import { Modal } from '../Modal.jsx';
import { Button, Field, Input, Select } from '../ui.jsx';

const DURATIONS = [['1', '1 month'], ['3', '3 months'], ['6', '6 months'], ['12', '12 months'], ['', 'No end date']];

/** Give a user a paid plan without payment. `user` is optional; without it the admin searches by email. */
export default function GrantPlanModal({ user: fixedUser, onClose }) {
  const [q, setQ] = useState('');
  const [user, setUser] = useState(fixedUser || null);
  const [planKey, setPlanKey] = useState('pro');
  const [months, setMonths] = useState('1');
  const [seats, setSeats] = useState('');
  const plans = useQuery({ queryKey: ['admin', 'plans'], queryFn: () => api.get('/api/admin/plans') });
  const found = useQuery({
    queryKey: ['admin', 'users', 'grant-search', q],
    queryFn: () => api.get('/api/admin/users', { q, pageSize: 8 }),
    enabled: !fixedUser && q.trim().length >= 2,
  });
  const grant = useApiMutation((body) => api.post('/api/admin/subscriptions/grant', body), {
    success: (d) => `${user.name} is now on ${plans.data?.plans.find((p) => p.key === d.subscription.planKey)?.name || d.subscription.planKey}`,
    invalidate: [['admin', 'subs'], ['admin', 'users'], ['billing']],
    onSuccess: onClose,
  });
  const paid = (plans.data?.plans || []).filter((p) => p.key !== 'free' && p.active);
  const plan = paid.find((p) => p.key === planKey);

  return (
    <Modal open onClose={onClose} title="Grant a plan" size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={!user || !plan} loading={grant.isPending}
          onClick={() => grant.mutate({ userId: user.id, planKey, months: months ? Number(months) : null, ...(plan?.perSeat && seats ? { seats: Number(seats) } : {}) })}>Grant plan</Button></>}>
      <div className="space-y-4">
        <p className="text-sm text-fg-2">The user gets the plan's limits right away, with no payment. It ends on the date you choose, or when you revoke it in Subscriptions.</p>
        {fixedUser ? (
          <p className="text-sm"><span className="text-muted">User </span><span className="font-medium">{fixedUser.name}</span> <span className="text-muted">{fixedUser.email}</span></p>
        ) : (
          <Field label="User" hint={user ? `${user.name} · ${user.email}` : 'Search by name or email'}>
            <div>
              <Input value={q} onChange={(e) => { setQ(e.target.value); setUser(null); }} placeholder="name@company.com" />
              {!user && (found.data?.items || []).length > 0 && (
                <ul className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-line bg-surface p-1">
                  {found.data.items.map((u) => (
                    <li key={u.id}>
                      <button type="button" className="w-full rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-surface-2" onClick={() => { setUser(u); setQ(u.email); }}>
                        <span className="font-medium">{u.name}</span> <span className="text-muted">{u.email}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Field>
        )}
        <Field label="Plan">
          <Select value={planKey} onChange={(e) => setPlanKey(e.target.value)}>
            {paid.map((p) => <option key={p.key} value={p.key}>{p.name} · {money(p.priceCents)}/{p.interval}{p.perSeat ? ' per seat' : ''}</option>)}
          </Select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="For how long">
            <Select value={months} onChange={(e) => setMonths(e.target.value)}>{DURATIONS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}</Select>
          </Field>
          {plan?.perSeat && (
            <Field label="Seats" hint={`At least ${plan.minSeats}`}><Input type="number" min={plan.minSeats} value={seats} onChange={(e) => setSeats(e.target.value)} placeholder={String(plan.minSeats)} /></Field>
          )}
        </div>
      </div>
    </Modal>
  );
}
