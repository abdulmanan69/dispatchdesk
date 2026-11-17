import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { money } from '../../lib/format.js';
import { useToast } from '../Toast.jsx';
import { Modal } from '../Modal.jsx';
import { Button, Field, Select, Switch, Textarea } from '../ui.jsx';

const DURATIONS = [['1', '1 month'], ['3', '3 months'], ['6', '6 months'], ['12', '12 months'], ['', 'No end date']];

/**
 * Gift a paid plan to the selected users, free of charge. With "Notify" on they get an email and, the next time they
 * open the app, a welcome card naming the plan, how long it lasts and the admin's message. Users who already pay
 * through Stripe are skipped (their plan is not touched).
 */
export default function GiftPlanModal({ users, onClose, onDone }) {
  const toast = useToast();
  const [planKey, setPlanKey] = useState('pro');
  const [months, setMonths] = useState('1');
  const [notify, setNotify] = useState(true);
  const [message, setMessage] = useState('');
  const plans = useQuery({ queryKey: ['admin', 'plans'], queryFn: () => api.get('/api/admin/plans') });
  const paid = (plans.data?.plans || []).filter((p) => p.key !== 'free' && p.active);
  const plan = paid.find((p) => p.key === planKey);
  const gift = useApiMutation((body) => api.post('/api/admin/subscriptions/gift', body), {
    invalidate: [['admin', 'subs'], ['admin', 'users']],
    onSuccess: (d) => {
      const skipped = d.skipped?.length ? ` ${d.skipped.length} skipped (already paying through Stripe).` : '';
      toast.success(`${plan?.name || 'Plan'} gifted to ${d.granted} user${d.granted === 1 ? '' : 's'}.${skipped}`);
      onDone?.();
      onClose();
    },
  });
  const who = users.length === 1 ? users[0].name : `${users.length} users`;

  return (
    <Modal open onClose={onClose} title={`Gift a plan to ${who}`} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={!plan || !users.length} loading={gift.isPending}
          onClick={() => gift.mutate({ userIds: users.map((u) => u.id), planKey, months: months ? Number(months) : null, notify, message: notify && message.trim() ? message.trim() : undefined })}>Send gift</Button></>}>
      <div className="space-y-4">
        <p className="text-sm text-fg-2">They get the plan's limits right away with no payment. It ends on the date you choose, or when you revoke it in Subscriptions.</p>
        {users.length > 1 && <p className="max-h-20 overflow-y-auto text-xs text-muted">{users.map((u) => u.email).join(', ')}</p>}
        <Field label="Plan">
          <Select value={planKey} onChange={(e) => setPlanKey(e.target.value)}>
            {paid.map((p) => <option key={p.key} value={p.key}>{p.name} · {money(p.priceCents)}/{p.interval}{p.perSeat ? ' per seat' : ''}</option>)}
          </Select>
        </Field>
        <Field label="For how long">
          <Select value={months} onChange={(e) => setMonths(e.target.value)}>{DURATIONS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}</Select>
        </Field>
        <Switch checked={notify} onChange={setNotify} label={<span className="text-[13px] font-medium">Tell them about the gift (email and a welcome card in the app)</span>} />
        {notify && (
          <Field label="Message (optional)" hint="Shown in the email and the welcome card">
            <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} placeholder="Thanks for being one of our first dispatchers." />
          </Field>
        )}
      </div>
    </Modal>
  );
}
