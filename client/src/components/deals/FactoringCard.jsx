import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Landmark, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { date, money } from '../../lib/format.js';
import { Badge, Button, Card, Field, Input, Select, Textarea } from '../ui.jsx';
import { Modal, useConfirm } from '../Modal.jsx';

const RECOURSE = [['', 'Not recorded'], ['yes', 'Recourse'], ['no', 'Non-recourse']];
const recourseValue = (v) => (v === true ? 'yes' : v === false ? 'no' : '');
const str = (v) => (v == null ? '' : String(v));
const pctOrNull = (v) => (String(v).trim() === '' ? null : Number(v));
const EXAMPLE_CENTS = 200000; // the worked example under the terms: a $2,000 invoice

const formOf = (customer) => ({
  companyId: customer.factoringCompanyId || '',
  clientNo: customer.factoringClientNo || '',
  advancePct: str(customer.factoringAdvancePct),
  feePct: str(customer.factoringFeePct),
  recourse: recourseValue(customer.factoringRecourse),
});

/** Advance, fee and reserve on an example invoice, in the words of the factoring cost tool. */
export function termsExample(advancePct, feePct, amountCents = EXAMPLE_CENTS) {
  const a = pctOrNull(advancePct);
  const f = pctOrNull(feePct);
  if (a == null || f == null || Number.isNaN(a) || Number.isNaN(f) || a + f > 100) return null;
  const advance = Math.round((amountCents * a) / 100);
  const fee = Math.round((amountCents * f) / 100);
  return `On a ${money(amountCents, { digits: 0 })} invoice: ${money(advance)} advance, ${money(fee)} factoring fee, ${money(amountCents - advance - fee)} reserve released later.`;
}

const EMPTY_COMPANY = { name: '', submitEmail: '', remitTo: '', phone: '', website: '', notes: '' };

/** Add or edit a factoring company (kept per owner, shared by that owner's carriers). */
export function FactoringCompanyModal({ company, ownerId, onClose, onSaved }) {
  const confirm = useConfirm();
  const [f, setF] = useState(() => (company ? Object.fromEntries(Object.keys(EMPTY_COMPANY).map((k) => [k, company[k] || ''])) : EMPTY_COMPANY));
  // A new company is picked in the card's form (still to be saved): reloading the customer would reset that form.
  const inval = company ? [['factoring-companies'], ['customer'], ['customers'], ['carrier']] : [['factoring-companies']];
  const save = useApiMutation(
    (body) => (company ? api.patch(`/api/factoring-companies/${company.id}`, body) : api.post('/api/factoring-companies', { ...body, ...(ownerId ? { ownerId } : {}) })),
    { success: company ? 'Factoring company saved' : 'Factoring company added', invalidate: inval, onSuccess: (d) => { onSaved?.(d.company); onClose(); } },
  );
  const remove = useApiMutation(() => api.del(`/api/factoring-companies/${company.id}`), { success: 'Factoring company deleted', invalidate: inval, onSuccess: () => { onSaved?.(null); onClose(); } });
  const on = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = (e) => {
    e.preventDefault();
    save.mutate({
      name: f.name.trim(), submitEmail: f.submitEmail.trim() || null, remitTo: f.remitTo.trim() || null,
      phone: f.phone.trim() || null, website: f.website.trim() || null, notes: f.notes.trim() || null,
    });
  };
  const used = company?.carrierCount || 0;
  return (
    <Modal open onClose={onClose} title={company ? 'Edit factoring company' : 'Add factoring company'}
      footer={<>
        {company && (
          <Button variant="ghost" icon={Trash2} className="mr-auto text-c-red" loading={remove.isPending}
            onClick={async () => { if (await confirm({ title: 'Delete this factoring company?', message: used ? `${used} carrier${used === 1 ? '' : 's'} use it and will show as not factoring. Their invoices are kept.` : 'No carrier uses it.', danger: true, confirmLabel: 'Delete' })) remove.mutate(); }}>Delete</Button>
        )}
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" form="factoring-company-form" loading={save.isPending} disabled={!f.name.trim()}>Save</Button>
      </>}>
      <form id="factoring-company-form" className="grid gap-3 sm:grid-cols-2" onSubmit={submit}>
        <Field label="Name" required className="sm:col-span-2"><Input value={f.name} onChange={on('name')} maxLength={120} placeholder="e.g. Apex Capital" /></Field>
        <Field label="Submission email" hint="Where invoice packets are emailed" className="sm:col-span-2"><Input type="email" value={f.submitEmail} onChange={on('submitEmail')} maxLength={254} placeholder="invoices@factor.com" /></Field>
        <Field label="Remit-to address" hint="Printed on this carrier’s invoices under a notice of assignment" className="sm:col-span-2"><Textarea rows={3} value={f.remitTo} onChange={on('remitTo')} maxLength={500} placeholder={'PO Box 961029\nFort Worth, TX 76161'} /></Field>
        <Field label="Phone"><Input type="tel" value={f.phone} onChange={on('phone')} maxLength={40} /></Field>
        <Field label="Website"><Input type="url" value={f.website} onChange={on('website')} maxLength={300} placeholder="https://" /></Field>
        <Field label="Notes" className="sm:col-span-2"><Textarea rows={2} value={f.notes} onChange={on('notes')} maxLength={2000} /></Field>
      </form>
    </Modal>
  );
}

/**
 * Factoring on a customer profile: who buys the carrier's invoices (or "Does not factor"), its client number, advance
 * and fee, recourse, and whether the notice of assignment is on file. `onDocuments` opens the Documents tab.
 */
export default function FactoringCard({ customer, onDocuments }) {
  const companies = useQuery({ queryKey: ['factoring-companies', 'customer', customer.id], queryFn: ({ signal }) => api.get('/api/factoring-companies', { customerId: customer.id }, { signal }) });
  const [f, setF] = useState(() => formOf(customer));
  useEffect(() => setF(formOf(customer)), [customer]);
  const [editing, setEditing] = useState(null); // { company } to edit, { company: null } to add
  const save = useApiMutation((body) => api.patch(`/api/customers/${customer.id}`, body), {
    success: 'Factoring saved', invalidate: [['customer', customer.id], ['customers'], ['carrier', customer.carrierId], ['invoices']],
  });
  const list = companies.data?.items || [];
  const picked = list.find((c) => c.id === f.companyId) || (f.companyId && customer.factoringCompany?.id === f.companyId ? customer.factoringCompany : null);
  const saved = customer.factoringCompany;
  const dirty = JSON.stringify(f) !== JSON.stringify(formOf(customer));
  const example = useMemo(() => termsExample(f.advancePct, f.feePct), [f.advancePct, f.feePct]);
  const tooMuch = pctOrNull(f.advancePct) != null && pctOrNull(f.feePct) != null && pctOrNull(f.advancePct) + pctOrNull(f.feePct) > 100;
  const on = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = (e) => {
    e.preventDefault();
    save.mutate({
      factoringCompanyId: f.companyId || null,
      factoringClientNo: f.clientNo.trim() || null,
      factoringAdvancePct: pctOrNull(f.advancePct),
      factoringFeePct: pctOrNull(f.feePct),
      factoringRecourse: f.recourse === 'yes' ? true : f.recourse === 'no' ? false : null,
    });
  };
  const noa = customer.noa || { onFile: false };
  return (
    <Card title={<span className="inline-flex items-center gap-2 text-sm font-medium"><Landmark className="size-4 text-c-teal" aria-hidden />Factoring</span>}
      actions={saved ? <Badge color="teal" className="max-w-[12rem] truncate">{saved.name}</Badge> : <Badge color="gray">Does not factor</Badge>}>
      <form className="space-y-4" onSubmit={submit}>
        <p className="text-sm text-muted">
          {saved
            ? 'Invoices for this carrier are paid to the factoring company. DispatchDesk fills the remit-to and can send the paperwork for you.'
            : 'Does not factor: the broker pays the carrier directly. Pick the factoring company if this carrier sells its invoices.'}
        </p>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Factoring company">
            <Select value={f.companyId} onChange={on('companyId')} disabled={companies.isLoading}>
              <option value="">Does not factor</option>
              {list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              {picked && !list.some((c) => c.id === picked.id) && <option value={picked.id}>{picked.name}</option>}
            </Select>
          </Field>
          <div className="flex flex-wrap gap-2">
            {picked && <Button variant="secondary" icon={Pencil} onClick={() => setEditing({ company: list.find((c) => c.id === picked.id) || picked })}>Edit company</Button>}
            <Button variant="secondary" icon={Plus} onClick={() => setEditing({ company: null })}>Add factoring company</Button>
          </div>
        </div>

        {picked && (
          <dl className="space-y-1.5 rounded-md border border-line px-3 py-2 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-muted">Submission email</dt><dd className="break-all text-right">{picked.submitEmail || <span className="text-c-amber">Not set</span>}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Remit to</dt><dd className="whitespace-pre-line text-right">{picked.remitTo || '—'}</dd></div>
            {picked.phone && <div className="flex justify-between gap-3"><dt className="text-muted">Phone</dt><dd>{picked.phone}</dd></div>}
            {!picked.submitEmail && <p className="text-xs text-muted">Add the submission email to send invoice packets from DispatchDesk.</p>}
          </dl>
        )}

        {f.companyId && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Client number" hint="The carrier’s account number at the factoring company"><Input value={f.clientNo} onChange={on('clientNo')} maxLength={60} /></Field>
            <Field label="Recourse">
              <Select value={f.recourse} onChange={on('recourse')}>{RECOURSE.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</Select>
            </Field>
            <Field label="Advance (%)" error={tooMuch ? 'Advance plus fee is more than 100%' : undefined}><Input type="number" min="0" max="100" step="0.1" value={f.advancePct} onChange={on('advancePct')} placeholder="e.g. 90" /></Field>
            <Field label="Factoring fee (%)"><Input type="number" min="0" max="100" step="0.1" value={f.feePct} onChange={on('feePct')} placeholder="e.g. 3" /></Field>
            {example && <p className="text-xs text-muted sm:col-span-2">{example}</p>}
          </div>
        )}

        {(f.companyId || noa.onFile) && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Notice of assignment</span>
            {noa.onFile
              ? <Badge color="green">NOA on file{noa.uploadedAt ? ` · ${date(noa.uploadedAt)}` : ''}</Badge>
              : <>
                <Badge color="amber">No NOA uploaded</Badge>
                <span className="text-xs text-muted">Upload it under Documents as a notice of assignment.</span>
                {onDocuments && <Button size="sm" variant="link" onClick={onDocuments}>Open Documents</Button>}
              </>}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={save.isPending} disabled={tooMuch || !dirty}>Save factoring</Button>
          {dirty && <span className="text-xs text-muted">Unsaved changes</span>}
        </div>
      </form>
      {editing && (
        <FactoringCompanyModal company={editing.company} ownerId={customer.ownerId} onClose={() => setEditing(null)}
          onSaved={(c) => {
            if (c && !editing.company) setF((cur) => ({ ...cur, companyId: c.id }));
            if (!c && editing.company?.id === f.companyId) setF((cur) => ({ ...cur, companyId: '' }));
          }} />
      )}
    </Card>
  );
}
