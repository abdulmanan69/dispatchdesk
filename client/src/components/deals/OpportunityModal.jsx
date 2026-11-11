import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, Trash2, Phone, Mail, ExternalLink, FileSignature } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { dateTime, label, phoneFmt, relative, PRESETS } from '../../lib/format.js';
import { Badge, Button, Checkbox, ComboInput, Field, Input, Loading, ErrorState, Select, Textarea } from '../ui.jsx';
import { Modal, useConfirm } from '../Modal.jsx';
import { CarrierPicker } from '../dispatch/Pickers.jsx';
import { fromCents, toCents } from '../dispatch/calc.js';
import ComposeModal from '../email/ComposeModal.jsx';
import CarrierTimeInput from '../calling/CarrierTimeInput.jsx';
import { tzOf } from '../calling/callWindow.js';
import OnboardingLinkModal from '../onboarding/OnboardingLinkModal.jsx';
import OnboardingPanel from '../onboarding/OnboardingPanel.jsx';

export const OPP_STATUSES = ['open', 'negotiating', 'trial', 'won', 'lost'];
export const OPP_COLOR = { open: 'blue', negotiating: 'amber', trial: 'violet', won: 'green', lost: 'red' };
const inv = [['opportunities'], ['customers'], ['pipeline'], ['carriers'], ['dashboard'], ['follow-ups']];

/**
 * Opportunity fields. `timezone` is the carrier's zone (tzOf): the next follow-up is typed in the carrier's local time
 * when it differs from yours ("call me back Tuesday at 10" means their 10), and f.nextFollowUpAt holds an ISO string.
 */
function OppFields({ f, setF, timezone }) {
  const on = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Estimated monthly value ($)" hint="Expected dispatch revenue per month"><Input type="number" min="0" step="1" value={f.value} onChange={on('value')} /></Field>
      <Field label="Dispatch fee (%)"><Input type="number" min="0" max="100" step="0.1" value={f.dispatchFeePercent} onChange={on('dispatchFeePercent')} /></Field>
      <Field label="Probability (%)"><Input type="number" min="0" max="100" step="5" value={f.probability} onChange={on('probability')} /></Field>
      <Field label="Next follow-up" hint="Adds a call follow-up with a reminder (Follow-ups page, call queue). Clearing it cancels that follow-up.">
        {(id) => <CarrierTimeInput id={id} value={f.nextFollowUpAt} onChange={(v) => setF({ ...f, nextFollowUpAt: v })} timezone={timezone} aria-label="Next follow-up" />}
      </Field>
      <Field label="Notes" className="sm:col-span-2"><Textarea rows={3} value={f.notes} onChange={on('notes')} maxLength={5000} /></Field>
    </div>
  );
}

/** ISO string for the follow-up input ('' when unset or invalid). */
const isoOrEmpty = (v) => {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : '';
};

const toBody = (f) => ({
  estimatedValueCents: toCents(f.value) ?? 0,
  dispatchFeePercent: f.dispatchFeePercent === '' ? null : f.dispatchFeePercent,
  probability: f.probability === '' ? null : f.probability,
  nextFollowUpAt: isoOrEmpty(f.nextFollowUpAt) || null,
  notes: f.notes || null,
});

export function NewOpportunityModal({ open, onClose, carrier }) {
  const [carrierId, setCarrierId] = useState(carrier?.id || null);
  // The picked carrier (state, stored time zone) sets the zone the follow-up time is typed in.
  const [picked, setPicked] = useState(carrier || null);
  const [f, setF] = useState({ value: '', dispatchFeePercent: '', probability: '25', nextFollowUpAt: '', notes: '' });
  useEffect(() => { if (open) { setCarrierId(carrier?.id || null); setPicked(carrier || null); setF({ value: '', dispatchFeePercent: '', probability: '25', nextFollowUpAt: '', notes: '' }); } }, [open, carrier]);
  const create = useApiMutation((body) => api.post('/api/opportunities', body), { success: 'Opportunity created', invalidate: inv, onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} title="New opportunity"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={create.isPending} disabled={!carrierId} onClick={() => create.mutate({ carrierId, ...toBody(f) })}>Create opportunity</Button></>}>
      <div className="space-y-3">
        <Field label="Carrier" required hint="Opening an opportunity moves the carrier to the Opportunities stage.">
          <CarrierPicker value={carrierId} initialLabel={carrier?.companyName} onChange={(v, c) => { setCarrierId(v); setPicked(v ? c || null : null); }} />
        </Field>
        <OppFields f={f} setF={setF} timezone={tzOf(picked)} />
      </div>
    </Modal>
  );
}

/** Detail + edit dialog for one opportunity. */
export function OpportunityModal({ id, onClose }) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['opportunities', 'detail', id], queryFn: () => api.get(`/api/opportunities/${id}`), enabled: !!id });
  const [f, setF] = useState(null);
  const [lost, setLost] = useState({ open: false, reason: '', archive: false });
  const [requesting, setRequesting] = useState(false);
  const [agreement, setAgreement] = useState(false);
  useEffect(() => {
    const o = q.data?.opportunity;
    if (o) setF({ value: fromCents(o.estimatedValueCents), dispatchFeePercent: o.dispatchFeePercent ?? '', probability: String(o.probability), nextFollowUpAt: isoOrEmpty(o.nextFollowUpAt), notes: o.notes || '', status: o.status });
  }, [q.data]);
  const save = useApiMutation((body) => api.patch(`/api/opportunities/${id}`, body), { success: 'Opportunity saved', invalidate: inv });
  const convert = useApiMutation(() => api.post(`/api/opportunities/${id}/convert`, { dispatchFeePercent: f?.dispatchFeePercent === '' ? null : f?.dispatchFeePercent }), {
    success: 'Converted to customer', invalidate: inv, onSuccess: (d) => { onClose(); navigate(`/app/customers/${d.customer.id}`); },
  });
  const remove = useApiMutation(() => api.del(`/api/opportunities/${id}`), { success: 'Opportunity removed', invalidate: inv, onSuccess: onClose });
  const o = q.data?.opportunity;
  const closed = o && ['won', 'lost'].includes(o.status);

  return (
    <Modal open={!!id} onClose={onClose} size="lg" title={o ? o.carrier.companyName : 'Opportunity'}
      footer={o && f && <>
        <Button variant="ghost" icon={Trash2} className="mr-auto text-red-600" onClick={async () => { if (await confirm({ title: 'Remove opportunity?', message: 'The carrier returns to Prospecting. Call and email history is kept.', danger: true, confirmLabel: 'Remove' })) remove.mutate(); }}>Remove</Button>
        {o.status !== 'lost' && o.status !== 'won' && <Button variant="secondary" onClick={() => setLost({ open: true, reason: '', archive: false })}>Mark lost</Button>}
        <Button variant="secondary" loading={save.isPending} onClick={() => save.mutate({ ...toBody(f), status: f.status })}>Save</Button>
        {o.status !== 'won' && <Button icon={BadgeCheck} loading={convert.isPending} onClick={() => convert.mutate()}>Convert to customer</Button>}
      </>}>
      {!id ? null : q.isError ? <ErrorState error={q.error} onRetry={q.refetch} /> : !o || !f ? <Loading /> : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge color={OPP_COLOR[o.status]}>{label(o.status)}</Badge>
            {o.carrier.mcNumber && <span className="text-muted">MC {o.carrier.mcNumber}</span>}
            {o.carrier.dotNumber && <span className="text-muted">DOT {o.carrier.dotNumber}</span>}
            {o.carrier.phone && <a href={`tel:${o.carrier.phone}`} className="inline-flex items-center gap-1 hover:underline"><Phone className="size-3.5" />{phoneFmt(o.carrier.phone)}</a>}
            {o.carrier.email && <span className="inline-flex items-center gap-1 text-muted"><Mail className="size-3.5" />{o.carrier.email}</span>}
            <Link to={`/app/carriers/${o.carrier.id}`} className="ml-auto inline-flex items-center gap-1 text-brand-700 hover:underline dark:text-brand-300">Carrier profile <ExternalLink className="size-3.5" /></Link>
          </div>
          {!closed && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-2/40 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 text-muted">Ready to sign? Send the dispatch agreement to e-sign with a document upload link, or ask for the paperwork in one email from your mailbox.</span>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" icon={FileSignature} onClick={() => setAgreement(true)}>Send agreement to sign</Button>
                <Button size="sm" variant="secondary" icon={Mail} onClick={() => setRequesting(true)}>Request onboarding documents</Button>
              </div>
            </div>
          )}
          <OnboardingPanel carrier={o.carrier} showCreate={false} hideWhenEmpty title="Agreement links" />
          {o.lostReason && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">Lost: {o.lostReason}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Stage">
              <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} disabled={closed && f.status === o.status && o.status === 'won'}>
                {OPP_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
              </Select>
            </Field>
          </div>
          <OppFields f={f} setF={setF} timezone={tzOf(o.carrier)} />

          <section>
            <h3 className="mb-2 text-sm font-medium">Contact history</h3>
            {!q.data.calls.length && !q.data.emails.length && !q.data.activities.length ? <p className="text-sm text-muted">No contact recorded yet.</p> : (
              <ul className="max-h-64 space-y-2 overflow-y-auto pr-1 text-sm">
                {[...q.data.calls.map((c) => ({ id: `c${c.id}`, at: c.calledAt, text: `Call · ${label(c.outcome)}${c.notes ? ` — ${c.notes}` : ''}`, by: c.user?.name })),
                  ...q.data.emails.map((e) => ({ id: `e${e.id}`, at: e.sentAt || e.createdAt, text: `Email · ${e.subject} (${label(e.status)})` })),
                  ...q.data.activities.filter((a) => !['call', 'email'].includes(a.type)).map((a) => ({ id: `a${a.id}`, at: a.createdAt, text: a.summary, by: a.user?.name }))]
                  .sort((x, y) => new Date(y.at) - new Date(x.at)).slice(0, 25).map((h) => (
                    <li key={h.id} className="flex gap-3 border-l-2 border-line pl-3">
                      <span className="w-28 shrink-0 text-xs text-muted">{dateTime(h.at)}</span>
                      <span>{h.text}{h.by && <span className="text-xs text-muted"> · {h.by}</span>}</span>
                    </li>
                  ))}
              </ul>
            )}
            {q.data.followUps.length > 0 && <p className="mt-2 text-xs text-muted">Pending follow-ups: {q.data.followUps.map((fu) => relative(fu.dueAt)).join(', ')}</p>}
          </section>
        </div>
      )}
      <Modal open={lost.open} onClose={() => setLost({ ...lost, open: false })} title="Mark opportunity lost" size="sm"
        footer={<><Button variant="secondary" onClick={() => setLost({ ...lost, open: false })}>Cancel</Button>
          <Button variant="danger" loading={save.isPending} onClick={() => save.mutate({ status: 'lost', lostReason: lost.reason || null, archive: lost.archive }, { onSuccess: () => setLost({ open: false, reason: '', archive: false }) })}>Mark lost</Button></>}>
        <div className="space-y-3">
          <Field label="Reason"><ComboInput options={PRESETS.lostReason} value={lost.reason} onChange={(e) => setLost({ ...lost, reason: e.target.value })} placeholder="e.g. Signed with another dispatcher" maxLength={500} /></Field>
          <Checkbox label="Also archive this carrier" checked={lost.archive} onChange={(e) => setLost({ ...lost, archive: e.target.checked })} />
        </div>
      </Modal>
      {o && (
        <OnboardingLinkModal open={agreement} onClose={() => setAgreement(false)} carrier={o.carrier}
          feePercent={f?.dispatchFeePercent === '' || f?.dispatchFeePercent == null ? null : f.dispatchFeePercent} />
      )}
      {o && (
        <ComposeModal open={requesting} onClose={() => setRequesting(false)} carrierId={o.carrier.id} toEmail={o.carrier.email || ''} templateCategory="carrier"
          subject="Getting set up: documents for dispatch" body={onboardingBody(f?.dispatchFeePercent)} />
      )}
    </Modal>
  );
}

/** One email asking a carrier that is ready to sign for its onboarding paperwork (the user reviews and sends it). */
export function onboardingBody(feePercent) {
  const fee = feePercent !== '' && feePercent != null ? ` at the ${feePercent}% dispatch fee we discussed` : '';
  return [
    'Hi {{first_name}},',
    '',
    `Thanks for talking with us. To start dispatching your truck${fee}, please send:`,
    '- The signed dispatch agreement',
    '- W-9',
    '- Certificate of insurance',
    '- MC authority letter',
    '- Your factoring company and notice of assignment, if you factor',
    '',
    'A photo or PDF reply to this email is fine. Thank you.',
  ].join('\n');
}
