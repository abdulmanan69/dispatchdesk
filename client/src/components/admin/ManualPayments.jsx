import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { money, date } from '../../lib/format.js';
import { Modal, useConfirm } from '../Modal.jsx';
import { Badge, Button, Card, DataTable, EmptyState, Field, QueryState, Select, Textarea } from '../ui.jsx';

const STATUS = { submitted: ['To check', 'amber'], awaiting: ['Not reported yet', 'gray'], approved: ['Approved', 'green'], rejected: ['Rejected', 'red'] };
const METHOD = { bank: 'Bank wire', usdt: 'USDT', taptapsend: 'Taptap Send' };

/**
 * Admin → Payments: plans paid manually. Check that the money arrived (bank, USDT wallet, Taptap Send) with the
 * transaction ID and reference, then approve (the plan starts for the paid period) or reject with a reason.
 */
export default function ManualPayments() {
  const confirm = useConfirm();
  const [status, setStatus] = useState('submitted');
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState('');
  const q = useQuery({ queryKey: ['admin', 'manual-payments', status], queryFn: () => api.get(`/api/admin/manual-payments?status=${status}`) });
  const approve = useApiMutation((id) => api.post(`/api/admin/manual-payments/${id}/approve`), {
    invalidate: [['admin', 'manual-payments'], ['admin', 'subs'], ['admin', 'payments'], ['admin', 'stats']],
    success: (r) => `Approved. The plan runs until ${date(r.endsAt)}.`,
  });
  const reject = useApiMutation(({ id, reason: why }) => api.post(`/api/admin/manual-payments/${id}/reject`, { reason: why }), {
    invalidate: [['admin', 'manual-payments']], success: 'Rejected. The customer was told why.',
    onSuccess: () => { setRejecting(null); setReason(''); },
  });

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">Customers who pay by bank wire, USDT or Taptap Send report the payment here. Check that the money arrived with the same reference or transaction ID, then approve it to start their plan.</p>
      <Card title="Manual payments" bodyClass="p-0" actions={
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Show" className="w-44">
          <option value="submitted">To check{q.data?.counts?.submitted ? ` (${q.data.counts.submitted})` : ''}</option>
          <option value="awaiting">Not reported yet</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="all">All</option>
        </Select>}>
        <QueryState query={q}>
          {(d) => (
            <DataTable
              rows={d.items}
              empty={<EmptyState title={status === 'submitted' ? 'Nothing to check' : 'No payments'}>{status === 'submitted' ? 'Reported payments appear here.' : 'Nothing with this status.'}</EmptyState>}
              columns={[
                { key: 'when', header: 'Reported', render: (r) => <span className="text-xs">{date(r.submittedAt || r.createdAt)}</span> },
                { key: 'user', header: 'Customer', render: (r) => <div className="min-w-0"><p className="truncate font-medium">{r.user?.name}</p><p className="truncate text-xs text-muted">{r.user?.email}</p></div> },
                { key: 'plan', header: 'Plan', render: (r) => <span>{r.planName}{r.seats > 1 ? ` · ${r.seats} seats` : ''} · {r.months === 12 ? '1 year' : `${r.months} month${r.months === 1 ? '' : 's'}`}</span> },
                { key: 'amount', header: 'Amount', render: (r) => <span className="tabular">{money(r.amountCents)}</span> },
                { key: 'pay', header: 'Payment', render: (r) => (
                  <div className="max-w-xs text-xs">
                    <p><span className="font-mono">{r.reference}</span>{r.method ? ` · ${METHOD[r.method] || r.method}` : ''}</p>
                    {r.transactionRef && <p className="break-all font-mono text-muted">{r.transactionRef}</p>}
                    {r.note && <p className="text-muted">{r.note}</p>}
                    {r.rejectReason && <p className="text-red-600">{r.rejectReason}</p>}
                  </div>
                ) },
                { key: 'status', header: 'Status', render: (r) => <Badge color={STATUS[r.status]?.[1] || 'gray'}>{STATUS[r.status]?.[0] || r.status}</Badge> },
                { key: 'act', header: '', render: (r) => (['submitted', 'awaiting'].includes(r.status) ? (
                  <div className="flex justify-end gap-1">
                    <Button size="sm" icon={Check} loading={approve.isPending && approve.variables === r.id} onClick={async () => {
                      if (await confirm({ title: `Approve ${money(r.amountCents)} from ${r.user?.name || r.user?.email}?`, message: `Only approve after you see this payment (${r.reference}${r.transactionRef ? `, ${r.transactionRef}` : ''}) in your account. ${r.planName} starts right away.`, confirmLabel: 'Approve payment' })) approve.mutate(r.id);
                    }}>Approve</Button>
                    <Button size="sm" variant="ghost" icon={X} className="text-red-600" onClick={() => setRejecting(r)}>Reject</Button>
                  </div>
                ) : null) },
              ]}
            />
          )}
        </QueryState>
      </Card>
      {rejecting && (
        <Modal open onClose={() => setRejecting(null)} title={`Reject ${rejecting.reference}?`} size="sm"
          footer={<><Button variant="secondary" onClick={() => setRejecting(null)}>Cancel</Button>
            <Button variant="danger" disabled={reason.trim().length < 3} loading={reject.isPending} onClick={() => reject.mutate({ id: rejecting.id, reason: reason.trim() })}>Reject payment</Button></>}>
          <Field label="Reason (the customer sees it)">
            <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="No payment with this transaction ID arrived in our account." />
          </Field>
        </Modal>
      )}
    </div>
  );
}
