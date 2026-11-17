import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { date, label, money, toDateInput } from '../../lib/format.js';
import { Badge, Button, Field, Input, Loading, ErrorState, Select } from '../ui.jsx';
import { Modal, useConfirm } from '../Modal.jsx';

export const FEE_METHODS = ['zelle', 'ach', 'check', 'cash', 'card', 'other'];
const METHOD_LABEL = { zelle: 'Zelle', ach: 'ACH', check: 'Check', cash: 'Cash', card: 'Card', other: 'Other' };

/** A week's fee collection as a badge: Paid, Owes $x (partly paid), Unpaid, or nothing when the week has no fee. */
export function FeeBadge({ fees }) {
  if (!fees || fees.status === 'none') return <span className="text-xs text-muted">—</span>;
  if (fees.status === 'paid') return <Badge color="green">Paid</Badge>;
  if (fees.status === 'partial') return <Badge color="amber">Owes {money(fees.owedCents)}</Badge>;
  return <Badge color="gray">Unpaid</Badge>;
}

/**
 * Dispatch fee payments for one statement week: what is owed, what was collected (recorded here plus payments on
 * per-load fee invoices), the recorded payments, and a form to record one.
 */
export function FeePaymentsModal({ customerId, week, title, onClose }) {
  const confirm = useConfirm();
  const key = ['customer', customerId, 'statement', week];
  const q = useQuery({ queryKey: key, queryFn: () => api.get(`/api/customers/${customerId}/statements/${week}`) });
  const fees = q.data?.fees;
  const [f, setF] = useState(null);
  const form = f || { amount: fees ? (fees.owedCents / 100).toFixed(2) : '', paidAt: toDateInput(new Date()), method: '', reference: '', note: '' };
  const set = (k) => (e) => setF({ ...form, [k]: e.target.value });
  const inv = [['customer', customerId]];
  const record = useApiMutation((body) => api.post(`/api/customers/${customerId}/statements/${week}/payments`, body), {
    success: 'Payment recorded', invalidate: inv, onSuccess: () => setF(null), // the form refills with what is still owed
  });
  const remove = useApiMutation((id) => api.del(`/api/customers/${customerId}/fee-payments/${id}`), { success: 'Payment removed', invalidate: inv });
  const cents = Math.round(Number(form.amount || 0) * 100);

  return (
    <Modal open onClose={onClose} title={title} size="md"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        <Button loading={record.isPending} disabled={!fees || cents <= 0 || !form.paidAt}
          onClick={() => record.mutate({
            amountCents: cents, paidAt: new Date(`${form.paidAt}T12:00:00`).toISOString(),
            method: form.method || undefined, reference: form.reference.trim() || undefined, note: form.note.trim() || undefined,
          })}>Record payment</Button>
      </>}>
      {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={q.refetch} /> : (
        <div className="space-y-4">
          <dl className="grid grid-cols-3 gap-2 rounded-lg border border-line p-3 text-sm">
            <div><dt className="text-xs text-muted">Dispatch fee</dt><dd className="tabular">{money(fees.feeCents)}</dd></div>
            <div><dt className="text-xs text-muted">Collected</dt><dd className="tabular">{money(fees.collectedCents)}</dd></div>
            <div><dt className="text-xs text-muted">Still owed</dt><dd className="tabular font-medium">{money(fees.owedCents)}</dd></div>
          </dl>
          {fees.invoicePaidCents > 0 && <p className="text-xs text-muted">Includes {money(fees.invoicePaidCents)} paid on dispatch fee invoices for this week’s loads.</p>}
          {fees.payments.length > 0 && (
            <ul className="divide-y divide-line rounded-lg border border-line text-sm">
              {fees.payments.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="tabular font-medium">{money(p.amountCents)}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted">
                    {[date(p.paidAt), p.method && (METHOD_LABEL[p.method] || label(p.method)), p.reference, p.note].filter(Boolean).join(' · ')}
                  </span>
                  <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Remove the ${money(p.amountCents)} payment`} loading={remove.isPending && remove.variables === p.id}
                    onClick={async () => { if (await confirm({ title: 'Remove this payment?', message: `${money(p.amountCents)} paid ${date(p.paidAt)} will no longer count toward this week.`, confirmLabel: 'Remove', danger: true })) remove.mutate(p.id); }} />
                </li>
              ))}
            </ul>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Amount received ($)" required><Input type="number" min="0.01" step="0.01" value={form.amount} onChange={set('amount')} /></Field>
            <Field label="Date received" required><Input type="date" value={form.paidAt} onChange={set('paidAt')} /></Field>
            <Field label="Method">
              <Select value={form.method} onChange={set('method')}>
                <option value="">Not recorded</option>
                {FEE_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
              </Select>
            </Field>
            <Field label="Reference" hint="Zelle confirmation, check number"><Input value={form.reference} onChange={set('reference')} maxLength={100} /></Field>
          </div>
          <Field label="Note"><Input value={form.note} onChange={set('note')} maxLength={500} /></Field>
        </div>
      )}
    </Modal>
  );
}
