import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2, Printer, Send, CircleDollarSign, Ban, CheckCheck, Download, Landmark } from 'lucide-react';
import { api } from '../../lib/api.js';
import { errorToast, useApiMutation } from '../../lib/hooks.js';
import { date, money, toDateInput } from '../../lib/format.js';
import { Badge, Button, ErrorState, Field, IconButton, Input, Loading, Select, Switch, Textarea } from '../ui.jsx';
import { Modal, useConfirm } from '../Modal.jsx';
import { useToast } from '../Toast.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { openPrintable } from './print.js';
import { FactoringSummary, PAYMENT_KIND_LABEL, PaymentModal, SendInvoiceModal, SendToFactoringModal, StatusBadge } from './InvoiceModals.jsx';

const LINE_KINDS = [
  ['linehaul', 'Line haul'], ['detention', 'Detention'], ['lumper', 'Lumper reimbursement'], ['layover', 'Layover'], ['tonu', 'TONU'], ['fee', 'Dispatch fee'], ['other', 'Other'],
];
const PRESET_LINES = [
  { kind: 'lumper', description: 'Lumper reimbursement (receipt attached)' },
  { kind: 'detention', description: 'Detention' },
  { kind: 'layover', description: 'Layover' },
  { kind: 'other', description: '' },
];

/** The signed-in user's invoice logo as a data: URL, or null (same query key and data as Settings, Invoice branding). */
async function fetchInvoiceLogo({ signal }) {
  try {
    const blob = await (await api.get('/api/settings/invoice-logo', undefined, { raw: true, signal })).blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
}

const toRow = (l) =>({ kind: l.kind || 'other', description: l.description || '', quantity: String(l.quantity ?? 1), unit: String((l.unitCents ?? 0) / 100) });
const rowCents = (r) => Math.round((Number(r.quantity) || 0) * Math.round((Number(r.unit) || 0) * 100));

/** Invoice detail and editor (line items while it is a draft), with print, email, payments and void. */
export default function InvoiceEditor({ id, onClose }) {
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['invoices', 'one', id], queryFn: () => api.get(`/api/invoices/${id}`), enabled: !!id });
  const inv = q.data?.invoice;
  const { user } = useAuth();
  // Printouts carry the invoice owner's logo; the preview shows it only on the signed-in user's own invoices.
  const own = !!inv && inv.ownerId === user?.id;
  const logo = useQuery({ queryKey: ['settings', 'invoice-logo'], queryFn: fetchInvoiceLogo, staleTime: 5 * 60_000, enabled: own, retry: false });
  const [rows, setRows] = useState([]);
  const [f, setF] = useState({});
  const [sending, setSending] = useState(false);
  const [paying, setPaying] = useState(false);
  const [factoring, setFactoring] = useState(false);
  const [downloading, setDownloading] = useState(false);
  // The carrier's factoring company and terms (freight invoices of factored carriers), for "Send to factoring" and payments.
  const terms = q.data?.factoringTerms || null;
  useEffect(() => {
    if (!inv) return;
    setRows(inv.items.map(toRow));
    setF({ billToName: inv.billToName, billToEmail: inv.billToEmail || '', dueAt: toDateInput(inv.dueAt), terms: inv.meta?.terms || '', remitTo: inv.meta?.remitTo || '', notes: inv.notes || '', autoRemind: !!inv.meta?.autoRemind });
  }, [inv]);
  const draft = inv?.status === 'draft';
  const total = useMemo(() => rows.reduce((s, r) => s + rowCents(r), 0), [rows]);
  const inval = [['invoices'], ['load'], ['loads']];
  const save = useApiMutation((body) => api.patch(`/api/invoices/${id}`, body), { success: 'Invoice saved', invalidate: inval });
  const markSent = useApiMutation(() => api.post(`/api/invoices/${id}/mark-sent`), { success: 'Marked sent', invalidate: inval });
  const voidIt = useApiMutation(() => api.post(`/api/invoices/${id}/void`), { success: 'Invoice voided', invalidate: inval });
  const remove = useApiMutation(() => api.del(`/api/invoices/${id}`), { success: 'Draft deleted', invalidate: inval, onSuccess: onClose });

  const body = () => ({
    ...(draft ? { items: rows.map((r) => ({ kind: r.kind, description: r.description.trim() || 'Item', quantity: Number(r.quantity) || 0, unitCents: Math.round((Number(r.unit) || 0) * 100) })) } : {}),
    billToName: f.billToName, billToEmail: f.billToEmail || null,
    // Only a due date the user changed is sent (a draft's default due date counts from the day it is sent).
    ...(f.dueAt !== toDateInput(inv.dueAt) ? { dueAt: f.dueAt ? new Date(`${f.dueAt}T12:00:00`).toISOString() : null } : {}),
    terms: f.terms || null, remitTo: f.remitTo || null, notes: f.notes || null, autoRemind: f.autoRemind,
  });
  const setRow = (i, patch) => setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const print = () => { if (!openPrintable(`/api/invoices/${id}/print`)) toast.info('Allow pop-ups for this site to print the invoice.'); };
  const downloadPdf = async () => {
    setDownloading(true);
    try {
      await api.download(`/api/invoices/${id}/pdf`, `invoice-${inv.number}.pdf`);
    } catch (err) {
      errorToast(toast, err);
    } finally {
      setDownloading(false);
    }
  };
  const canFactor = inv?.kind === 'freight' && !!terms?.companyId && ['draft', 'sent', 'partial'].includes(inv.status);
  const saveThen = async (fn) => {
    try {
      await save.mutateAsync(body());
    } catch {
      return; // the error toast is already shown
    }
    fn();
  };

  return (
    <Modal open={!!id} onClose={onClose} size="xl" title={inv ? `Invoice #${inv.number} · ${inv.kind === 'freight' ? 'freight' : 'dispatch fee'}` : 'Invoice'}
      footer={inv && <>
        {draft && <Button variant="ghost" icon={Trash2} className="mr-auto text-c-red" onClick={async () => { if (await confirm({ title: 'Delete this draft?', message: `Draft #${inv.number} will be deleted.`, danger: true })) remove.mutate(); }}>Delete draft</Button>}
        {['sent', 'partial'].includes(inv.status) && inv.paidCents === 0 && <Button variant="ghost" icon={Ban} className="mr-auto" onClick={async () => { if (await confirm({ title: 'Void this invoice?', message: 'It stays on record as void and the load can be invoiced again.', confirmLabel: 'Void', danger: true })) voidIt.mutate(); }}>Void</Button>}
        <Button variant="secondary" icon={Printer} onClick={print}>Print</Button>
        <Button variant="secondary" icon={Download} loading={downloading} onClick={downloadPdf}>Download PDF</Button>
        {inv.status !== 'void' && inv.status !== 'paid' && <Button variant="secondary" loading={save.isPending} onClick={() => save.mutate(body())}>Save</Button>}
        {draft && <Button variant="secondary" icon={CheckCheck} loading={markSent.isPending} onClick={() => saveThen(() => markSent.mutate())}>Mark sent</Button>}
        {['sent', 'partial'].includes(inv.status) && <Button variant="secondary" icon={CircleDollarSign} onClick={() => setPaying(true)}>Record payment</Button>}
        {canFactor && <Button variant="secondary" icon={Landmark} onClick={() => (draft ? saveThen(() => setFactoring(true)) : setFactoring(true))}>Send to factoring</Button>}
        {['draft', 'sent', 'partial'].includes(inv.status) && <Button icon={Send} onClick={() => (draft ? saveThen(() => setSending(true)) : setSending(true))}>{draft ? 'Email invoice' : 'Email again'}</Button>}
      </>}>
      {!id ? null : q.isError ? <ErrorState error={q.error} onRetry={q.refetch} /> : !inv ? <Loading /> : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge invoice={inv} />
            <span className="text-muted">{inv.issuedAt ? `Issued ${date(inv.issuedAt)}` : 'Not issued yet'} · due {date(inv.dueAt)}</span>
            {inv.load && <Link to={`/app/loads?load=${inv.load.id}`} className="text-brand-700 hover:underline dark:text-brand-300">Load {inv.load.referenceNumber || `${inv.load.originCity} → ${inv.load.destCity}`}</Link>}
            {inv.factoring?.submittedAt && <Badge color="teal" title={inv.meta?.factoring?.toEmail || undefined}>Submitted to {inv.factoring.companyName || 'factoring'} · {date(inv.factoring.submittedAt)}</Badge>}
            {!inv.factoring?.submittedAt && inv.kind === 'freight' && terms?.companyName && <span className="text-xs text-muted">Factors with {terms.companyName}</span>}
            {own && logo.data && (
              <span className="ml-auto rounded bg-white px-2 py-1 ring-1 ring-line" title="Your logo, printed at the top of this invoice">
                <img src={logo.data} alt="Your logo" className="block h-7 w-auto max-w-[140px] object-contain" />
              </span>
            )}
          </div>

          <section className="space-y-2">
            <h3 className="text-sm font-medium">Line items</h3>
            <div className="space-y-2">
              {rows.map((r, i) => (
                <div key={i} className="grid gap-2 rounded-md border border-line p-2 sm:grid-cols-[150px_1fr_80px_110px_100px_auto] sm:items-end sm:border-0 sm:p-0">
                  <Field label={i === 0 ? 'Type' : <span className="sm:sr-only">Type</span>}>
                    <Select value={r.kind} disabled={!draft} onChange={(e) => setRow(i, { kind: e.target.value })}>{LINE_KINDS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</Select>
                  </Field>
                  <Field label={i === 0 ? 'Description' : <span className="sm:sr-only">Description</span>}><Input value={r.description} disabled={!draft} onChange={(e) => setRow(i, { description: e.target.value })} maxLength={300} /></Field>
                  <Field label={i === 0 ? 'Qty' : <span className="sm:sr-only">Qty</span>}><Input type="number" min="0" step="0.25" value={r.quantity} disabled={!draft} onChange={(e) => setRow(i, { quantity: e.target.value })} /></Field>
                  <Field label={i === 0 ? 'Rate ($)' : <span className="sm:sr-only">Rate ($)</span>}><Input type="number" step="0.01" value={r.unit} disabled={!draft} onChange={(e) => setRow(i, { unit: e.target.value })} /></Field>
                  <div className="space-y-1 text-right"><p className="text-[13px] text-muted sm:hidden">Amount</p><p className="h-9 text-sm leading-9 tabular font-medium">{money(rowCents(r))}</p></div>
                  {draft ? <IconButton icon={Trash2} label="Remove line" disabled={rows.length <= 1} onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))} className="justify-self-end" /> : <span />}
                </div>
              ))}
            </div>
            {draft && (
              <div className="flex flex-wrap gap-1.5">
                {PRESET_LINES.map((p) => (
                  <Button key={p.kind + p.description} size="sm" variant="ghost" icon={Plus} onClick={() => setRows((cur) => [...cur, { kind: p.kind, description: p.description, quantity: '1', unit: '' }])}>
                    {p.kind === 'other' ? 'Line' : LINE_KINDS.find(([v]) => v === p.kind)[1]}
                  </Button>
                ))}
              </div>
            )}
            <dl className="ml-auto w-full max-w-xs space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-muted">Total</dt><dd className="tabular font-medium">{money(draft ? total : inv.amountCents)}</dd></div>
              {inv.paidCents > 0 && <div className="flex justify-between"><dt className="text-muted">Paid</dt><dd className="tabular">{money(inv.paidCents)}</dd></div>}
              <div className="flex justify-between border-t border-line pt-1 font-medium"><dt>Balance due</dt><dd className="tabular">{money(draft ? total : inv.balanceCents)}</dd></div>
            </dl>
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            <Field label="Bill to"><Input value={f.billToName || ''} disabled={inv.status === 'void'} onChange={(e) => setF({ ...f, billToName: e.target.value })} maxLength={200} /></Field>
            <Field label="Bill-to email"><Input type="email" value={f.billToEmail || ''} disabled={inv.status === 'void'} onChange={(e) => setF({ ...f, billToEmail: e.target.value })} /></Field>
            <Field label="Due date" hint={draft ? 'Counts from the day it is sent unless you change it' : undefined}><Input type="date" value={f.dueAt || ''} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></Field>
            <Field label="Terms"><Input value={f.terms || ''} onChange={(e) => setF({ ...f, terms: e.target.value })} maxLength={80} placeholder="Net 30" /></Field>
            {inv.kind === 'freight' && (
              <div className="sm:col-span-2">
                <Field label="Remit to" hint="The carrier, or its factoring company when there is a notice of assignment"><Textarea rows={3} value={f.remitTo || ''} onChange={(e) => setF({ ...f, remitTo: e.target.value })} maxLength={500} /></Field>
                {terms?.remitTo && inv.status !== 'void' && f.remitTo !== `${terms.companyName}\n${terms.remitTo}` && (
                  <Button size="sm" variant="link" onClick={() => setF({ ...f, remitTo: `${terms.companyName}\n${terms.remitTo}` })}>Use {terms.companyName}’s remit-to</Button>
                )}
              </div>
            )}
            <Field label="Notes on the invoice" className="sm:col-span-2"><Textarea rows={2} value={f.notes || ''} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={2000} /></Field>
            <div className="sm:col-span-2">
              <Switch checked={!!f.autoRemind} onChange={(v) => setF({ ...f, autoRemind: v })} label="Email reminders to the bill-to address when it is 0, 7, 15 and 30 days past due" />
              <p className="ml-11 mt-1 text-xs text-muted">Off: you get in-app reminders only. Reminders go from your own mailbox. Save to apply.</p>
            </div>
          </section>

          <FactoringSummary summary={inv.factoring} />

          {inv.meta?.payments?.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-sm font-medium">Payments</h3>
              <ul className="divide-y divide-line rounded-md border border-line text-sm">
                {inv.meta.payments.map((p, i) => (
                  <li key={i} className="flex flex-wrap justify-between gap-2 px-3 py-2">
                    <span>{p.kind && p.kind !== 'payment' ? <span className="font-medium">{PAYMENT_KIND_LABEL[p.kind] || p.kind} · </span> : null}{date(p.at)}{p.method ? ` · ${p.method}` : ''}{p.reference ? ` · ${p.reference}` : ''}{p.by ? <span className="text-muted"> · {p.by}</span> : null}</span>
                    <span className="tabular font-medium">{money(p.amountCents)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
      {sending && inv && <SendInvoiceModal invoice={inv} documents={q.data.documents} onClose={() => setSending(false)} />}
      {paying && inv && <PaymentModal invoice={inv} terms={terms} onClose={() => setPaying(false)} />}
      {factoring && inv && <SendToFactoringModal invoice={inv} onClose={() => setFactoring(false)} />}
    </Modal>
  );
}
