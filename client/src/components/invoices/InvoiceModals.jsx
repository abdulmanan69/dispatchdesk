import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Send, Search } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { bytes, date, label, money, toDateInput } from '../../lib/format.js';
import { Badge, Button, Checkbox, ComboInput, EmptyState, Field, Input, Loading, Select, Textarea, cx } from '../ui.jsx';
import { Modal } from '../Modal.jsx';
import { useToast } from '../Toast.jsx';
import TemplatePicker from '../templates/TemplatePicker.jsx';

export const INVOICE_COLOR = { draft: 'gray', sent: 'blue', partial: 'amber', paid: 'green', void: 'red' };
export const INVOICE_STATUS = { draft: 'Draft', sent: 'Sent', partial: 'Partly paid', paid: 'Paid', void: 'Void' };
const PAY_METHODS = ['ACH', 'Check', 'Zelle', 'Comcheck', 'Wire', 'Factoring advance', 'Quick pay'];
const DOC_LABEL = { rate_confirmation: 'Rate con', bol: 'BOL', pod: 'POD', lumper_receipt: 'Lumper receipt', scale_ticket: 'Scale ticket', fuel_receipt: 'Fuel receipt', other: 'Other' };
const MAX_ATTACH = 5;
const MAX_BYTES = 10 * 1024 * 1024;

/** Email the invoice from the user's mailbox (POST /api/invoices/:id/send), with the load's POD/BOL attached. */
export function SendInvoiceModal({ invoice, documents = [], onClose, onSent }) {
  const toast = useToast();
  const preselect = useMemo(() => documents.filter((d) => ['pod', 'bol'].includes(d.type)).slice(0, MAX_ATTACH).map((d) => d.id), [documents]);
  const [f, setF] = useState({ toEmail: invoice.billToEmail || '', subject: '', body: '' });
  const [docs, setDocs] = useState(preselect);
  useEffect(() => setDocs(preselect), [preselect]);
  const size = docs.reduce((n, id) => n + (documents.find((d) => d.id === id)?.sizeBytes || 0), 0);
  const send = useApiMutation((body) => api.post(`/api/invoices/${invoice.id}/send`, body), {
    invalidate: [['invoices'], ['load'], ['loads']],
    onSuccess: (d) => {
      toast.success(d.outcome === 'sent' ? `Invoice #${invoice.number} sent from your mailbox` : d.message || 'Invoice queued to send');
      onSent?.(d.invoice);
      onClose();
    },
  });
  const toggle = (id, on) => setDocs((cur) => (on ? (cur.length >= MAX_ATTACH ? cur : [...cur, id]) : cur.filter((x) => x !== id)));
  return (
    <Modal open onClose={onClose} title={`Email invoice #${invoice.number}`} size="lg"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button icon={Send} loading={send.isPending} disabled={!f.toEmail.trim() || size > MAX_BYTES}
          onClick={() => send.mutate({ toEmail: f.toEmail.trim(), subject: f.subject.trim() || undefined, body: f.body.trim() || undefined, documentIds: docs })}>Send</Button>
      </>}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="To" required><Input type="email" value={f.toEmail} onChange={(e) => setF({ ...f, toEmail: e.target.value })} placeholder="ap@broker.com" /></Field>
          <TemplatePicker channel="email" invoiceId={invoice.id} loadId={invoice.loadId || undefined} category={invoice.kind === 'freight' ? 'broker' : 'carrier'} label="Use a template" size="md"
            onPick={(r) => setF((x) => ({ ...x, subject: r.subject ?? x.subject, body: r.body ?? x.body }))} />
        </div>
        <Field label="Subject" hint={`Blank: “Invoice #${invoice.number}${invoice.meta?.reference ? ` · load ${invoice.meta.reference}` : ''}”`}>
          <Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} maxLength={300} />
        </Field>
        <Field label="Message" hint="Blank: the invoice itself (lines, total, balance, due date and remit-to). Your signature is added when it is sent.">
          <Textarea rows={6} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        </Field>
        <div className="space-y-1.5">
          <p className="text-[13px] font-medium">Attach from the load</p>
          {!documents.length ? <p className="text-sm text-muted">No documents on this load. Upload the POD and BOL on the load first if the broker needs them.</p> : (
            <ul className="space-y-1 rounded-md border border-line p-2">
              {documents.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3">
                  <Checkbox className="min-w-0" checked={docs.includes(d.id)} onChange={(e) => toggle(d.id, e.target.checked)}
                    label={<span className="min-w-0 truncate"><span className="text-muted">{DOC_LABEL[d.type] || label(d.type)} · </span>{d.originalName}</span>} />
                  <span className="shrink-0 text-xs text-muted">{bytes(d.sizeBytes)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className={cx('text-xs', size > MAX_BYTES ? 'text-c-red' : 'text-muted')}>{docs.length} of {MAX_ATTACH} files · {bytes(size)} of 10 MB</p>
        </div>
      </div>
    </Modal>
  );
}

/** Record money received (partial or the full balance). */
export function PaymentModal({ invoice, onClose }) {
  const [f, setF] = useState({ amount: (invoice.balanceCents / 100).toFixed(2), paidAt: toDateInput(new Date()), method: '', reference: '' });
  const pay = useApiMutation((body) => api.post(`/api/invoices/${invoice.id}/payments`, body), {
    success: (d) => (d.invoice.status === 'paid' ? `Invoice #${invoice.number} paid in full` : 'Payment recorded'),
    invalidate: [['invoices'], ['load'], ['loads'], ['broker']], onSuccess: onClose,
  });
  const cents = Math.round(Number(f.amount || 0) * 100);
  return (
    <Modal open onClose={onClose} title={`Record payment · #${invoice.number}`} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={pay.isPending} disabled={cents <= 0 || cents > invoice.balanceCents || !f.paidAt}
          onClick={() => pay.mutate({ amountCents: cents, paidAt: f.paidAt ? new Date(`${f.paidAt}T12:00:00`).toISOString() : undefined, method: f.method || null, reference: f.reference || null })}>Record payment</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-muted">Open balance {money(invoice.balanceCents)} of {money(invoice.amountCents)}.</p>
        <Field label="Amount received ($)" error={cents > invoice.balanceCents ? 'More than the open balance' : undefined}>
          <Input type="number" min="0.01" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </Field>
        <Field label="Date received" error={!f.paidAt ? 'Enter the date the payment arrived' : undefined}><Input type="date" value={f.paidAt} onChange={(e) => setF({ ...f, paidAt: e.target.value })} /></Field>
        <Field label="Method"><ComboInput options={PAY_METHODS} value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} maxLength={40} /></Field>
        <Field label="Reference" hint="Check number, ACH trace or Comcheck code"><Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} maxLength={80} /></Field>
      </div>
    </Modal>
  );
}

/** Pick a delivered load and the invoice kind; creates a draft prefilled from the load. */
export function CreateInvoiceModal({ onClose, onCreated }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [kind, setKind] = useState('freight');
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const loads = useQuery({ queryKey: ['invoices', 'loads', term], queryFn: ({ signal }) => api.get('/api/invoices/loads', { q: term || undefined }, { signal }) });
  const create = useApiMutation((loadId) => api.post('/api/invoices', { loadId, kind }), {
    success: (d) => `Draft invoice #${d.invoice.number} created`, invalidate: [['invoices']],
    onSuccess: (d) => onCreated(d.invoice.id),
    onError: (err) => {
      if (err.status === 409 && err.details?.invoiceId) { toast.info(err.message); onCreated(err.details.invoiceId); } else toast.error(err);
    },
  });
  return (
    <Modal open onClose={onClose} title="New invoice" size="lg">
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_220px]">
          <Field label="Find a delivered load"><Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Reference or city" /></Field>
          <Field label="Invoice">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="freight">Freight, to the broker</option>
              <option value="dispatch_fee">Dispatch fee, to the carrier</option>
            </Select>
          </Field>
        </div>
        {loads.isLoading ? <Loading /> : !loads.data?.items.length ? (
          <EmptyState icon={Search} title="No delivered loads found">Mark a load delivered (or record a TONU) to invoice it.</EmptyState>
        ) : (
          <ul className="max-h-[50vh] divide-y divide-line overflow-y-auto rounded-md border border-line">
            {loads.data.items.map((l) => {
              const existing = l.invoices.find((i) => i.kind === kind);
              return (
                <li key={l.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="truncate font-medium">{l.originCity}, {l.originState} → {l.destCity}, {l.destState}{l.referenceNumber ? ` · #${l.referenceNumber}` : ''}</p>
                    <p className="truncate text-xs text-muted">{[l.broker?.companyName || 'No broker', l.carrier?.companyName, l.deliveryDate && `delivered ${date(l.deliveryDate)}`, money(l.rateCents, { digits: 0 })].filter(Boolean).join(' · ')}</p>
                  </div>
                  {existing ? (
                    <Button size="sm" variant="secondary" onClick={() => onCreated(existing.id)}>Open #{existing.number}</Button>
                  ) : (
                    <Button size="sm" loading={create.isPending && create.variables === l.id} disabled={kind === 'freight' ? !l.broker : !l.carrier} onClick={() => create.mutate(l.id)}>Create draft</Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}

export function StatusBadge({ invoice }) {
  if (invoice.overdue) return <Badge color="red">{invoice.daysOverdue} day{invoice.daysOverdue === 1 ? '' : 's'} overdue</Badge>;
  return <Badge color={INVOICE_COLOR[invoice.status]}>{INVOICE_STATUS[invoice.status] || label(invoice.status)}</Badge>;
}
