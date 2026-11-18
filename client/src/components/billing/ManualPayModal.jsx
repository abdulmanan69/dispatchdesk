import { useState } from 'react';
import { Copy } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { money } from '../../lib/format.js';
import { useToast } from '../Toast.jsx';
import { Modal } from '../Modal.jsx';
import { Button, Field, Input, Select, Textarea, cx } from '../ui.jsx';

/**
 * Pay for a plan outside the app: the amount, the reference to include, the details of each payment method the admin
 * offers, then "I've paid" with the transaction ID. The plan starts when an admin confirms the payment.
 */
export default function ManualPayModal({ claim, methods = [], note, onClose, onDone }) {
  const toast = useToast();
  const [method, setMethod] = useState(claim.method || methods[0]?.key || '');
  const [transactionRef, setTransactionRef] = useState(claim.transactionRef || '');
  const [extra, setExtra] = useState('');
  const chosen = methods.find((m) => m.key === method);
  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); toast.success('Copied'); } catch { toast.error('Copy failed'); }
  };
  const submit = useApiMutation((body) => api.post(`/api/billing/manual/${claim.id}/submit`, body), {
    invalidate: [['billing']],
    success: 'Thank you. We will confirm your payment soon.',
    onSuccess: () => { onDone?.(); onClose(); },
  });
  const drop = useApiMutation(() => api.del(`/api/billing/manual/${claim.id}`), {
    invalidate: [['billing']], success: 'Payment canceled', onSuccess: () => { onDone?.(); onClose(); },
  });
  const period = claim.months === 12 ? '1 year' : claim.months === 1 ? '1 month' : `${claim.months} months`;

  return (
    <Modal open onClose={onClose} title={`Pay for ${claim.planName}`} size="md"
      footer={<>
        <Button variant="ghost" className="mr-auto text-red-600" loading={drop.isPending} onClick={() => drop.mutate()}>Cancel this payment</Button>
        <Button variant="secondary" onClick={onClose}>Later</Button>
        <Button disabled={!method || transactionRef.trim().length < 3} loading={submit.isPending}
          onClick={() => submit.mutate({ method, transactionRef: transactionRef.trim(), ...(extra.trim() ? { note: extra.trim() } : {}) })}>I've paid</Button>
      </>}>
      <div className="space-y-4 text-sm">
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-line bg-surface-2 p-3">
          <div>
            <p className="text-xs text-muted">Amount</p>
            <p className="text-lg font-medium tabular">{money(claim.amountCents)} <span className="text-xs font-normal text-muted">{claim.currency.toUpperCase()}</span></p>
            <p className="text-xs text-muted">{claim.planName}, {period}{claim.seats > 1 ? `, ${claim.seats} seats` : ''}</p>
          </div>
          <div>
            <p className="text-xs text-muted">Reference (include it with the payment)</p>
            <p className="flex items-center gap-1.5 font-mono text-lg font-medium">{claim.reference}
              <button type="button" aria-label="Copy reference" className="rounded p-1 text-muted hover:bg-surface hover:text-fg" onClick={() => copy(claim.reference)}><Copy className="size-3.5" /></button>
            </p>
          </div>
        </div>

        <div>
          <p className="mb-2 text-[13px] font-medium">1. Pay with one of these</p>
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Payment method">
            {methods.map((m) => (
              <button key={m.key} type="button" role="tab" aria-selected={m.key === method} onClick={() => setMethod(m.key)}
                className={cx('rounded-lg border px-3 py-1.5 text-[13px] transition-ui', m.key === method ? 'border-brand-600 bg-brand-600/10 font-medium text-fg' : 'border-line text-fg-2 hover:bg-surface-2')}>
                {m.label}
              </button>
            ))}
          </div>
          {chosen && (
            <div className="mt-2 rounded-lg border border-line p-3">
              <pre className="whitespace-pre-wrap break-words font-sans text-[13px] text-fg">{chosen.details}</pre>
              <Button size="sm" variant="ghost" icon={Copy} className="mt-1" onClick={() => copy(chosen.details)}>Copy details</Button>
            </div>
          )}
          {note && <p className="mt-2 text-xs text-muted">{note}</p>}
        </div>

        <div>
          <p className="mb-2 text-[13px] font-medium">2. Tell us you paid</p>
          <div className="space-y-3">
            <Field label="Paid with">
              <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                {methods.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
              </Select>
            </Field>
            <Field label="Transaction ID" hint="The bank reference, the USDT transaction hash, or the Taptap Send transfer number">
              <Input value={transactionRef} onChange={(e) => setTransactionRef(e.target.value)} maxLength={200} />
            </Field>
            <Field label="Note (optional)">
              <Textarea rows={2} value={extra} onChange={(e) => setExtra(e.target.value)} maxLength={1000} placeholder="Sender name, date, anything that helps us find the payment" />
            </Field>
          </div>
        </div>
        <p className="text-xs text-muted">Your plan starts when we confirm the payment, usually within one business day. It runs for the period you paid and does not renew by itself.</p>
      </div>
    </Modal>
  );
}
