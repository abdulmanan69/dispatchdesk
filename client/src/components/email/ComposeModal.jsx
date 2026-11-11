import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PenLine, Send, Clock, Save, AlertTriangle, Paperclip, X, Eye, FileText } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useToast } from '../Toast.jsx';
import { Modal, useConfirm } from '../Modal.jsx';
import { Button, Checkbox, Field, Input, Select, Tabs, Textarea, cx } from '../ui.jsx';
import { bytes, label as labelize } from '../../lib/format.js';
import TemplatePicker from '../templates/TemplatePicker.jsx';
import { fieldList, renderTemplate } from '../templates/templateApi.js';

const PURPOSES = [
  ['carrier_intro', 'Carrier introduction'],
  ['follow_up', 'Follow-up'],
  ['broker_intro', 'Broker introduction'],
  ['broker_rate', 'Broker rate negotiation'],
  ['custom', 'Custom (describe in notes)'],
];

/** Same limits the server enforces for attachments. */
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const DOC_LABEL = {
  agreement: 'Agreement', mc_authority: 'MC authority', w9: 'W-9', coi: 'COI', permit: 'Permit', rate_confirmation: 'Rate confirmation', bol: 'BOL', pod: 'POD',
  lumper_receipt: 'Lumper receipt', scale_ticket: 'Scale ticket', fuel_receipt: 'Fuel receipt', other: 'Other',
};
const hasTokens = (s) => /\{\{\s*[a-zA-Z_]+\s*\}\}/.test(s || '');

/** Documents of the carrier and/or load this email is about, for the attachment picker. */
function useAttachableDocuments(carrierId, loadId, enabled) {
  const carrierDocs = useQuery({ queryKey: ['documents', 'carrier', carrierId], queryFn: () => api.get('/api/documents', { carrierId }), enabled: enabled && !!carrierId, staleTime: 30000 });
  const loadDocs = useQuery({ queryKey: ['documents', 'load', loadId], queryFn: () => api.get('/api/documents', { loadId }), enabled: enabled && !!loadId, staleTime: 30000 });
  const items = useMemo(() => {
    const seen = new Set();
    return [...(loadDocs.data?.items || []), ...(carrierDocs.data?.items || [])].filter((d) => (seen.has(d.id) ? false : seen.add(d.id)));
  }, [carrierDocs.data, loadDocs.data]);
  return { items, isLoading: carrierDocs.isLoading || loadDocs.isLoading, isError: carrierDocs.isError || loadDocs.isError };
}

/** Debounced server preview of the merged subject and body (only when the text has merge fields). */
function usePreview({ subject, body, context, active }) {
  const [state, setState] = useState({ data: null, loading: false, error: null });
  const ctxKey = JSON.stringify(context);
  useEffect(() => {
    if (!active || !(hasTokens(subject) || hasTokens(body))) { setState({ data: null, loading: false, error: null }); return undefined; }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      renderTemplate({ channel: 'email', subject, body, ...context })
        .then((data) => { if (!cancelled) setState({ data, loading: false, error: null }); })
        .catch((error) => { if (!cancelled) setState({ data: null, loading: false, error }); });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [subject, body, ctxKey, active]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

/**
 * Email composer used inline (Email → Compose) and in a modal (carrier, broker, load and follow-up pages).
 * Templates fill in merge fields for the carrier/broker/load in context, the preview shows exactly what will be
 * sent, and documents of the carrier or load can be attached (up to 5 files, 10 MB). The server checks opt-outs,
 * limits and attachment access, and reports the real send outcome.
 *
 * doneOption { label, defaultChecked } shows a checkbox (e.g. "Mark the follow-up done"); onDone(res, { done }).
 */
export function ComposeForm({
  carrierId, brokerId, loadId, invoiceId, extra, toEmail = '', subject = '', body = '', documentIds = [], templateCategory,
  onDone, compact, doneOption,
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [form, setForm] = useState({ accountId: '', toEmail, subject, body, templateId: '' });
  const [scheduleAt, setScheduleAt] = useState('');
  const [showSchedule, setShowSchedule] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [ai, setAi] = useState({ purpose: brokerId ? 'broker_intro' : 'carrier_intro', notes: '', tone: 'professional' });
  const [aiGenerated, setAiGenerated] = useState(false);
  const [failure, setFailure] = useState(null);
  const [view, setView] = useState('write');
  const [docs, setDocs] = useState(() => (documentIds || []).slice(0, MAX_ATTACHMENTS));
  const [docsOpen, setDocsOpen] = useState(false);
  const [done, setDone] = useState(doneOption?.defaultChecked ?? true);

  useEffect(() => { setForm((f) => ({ ...f, toEmail, subject, body })); }, [toEmail, subject, body]);

  const context = useMemo(() => ({ carrierId: carrierId || undefined, brokerId: brokerId || undefined, loadId: loadId || undefined, invoiceId: invoiceId || undefined, extra }), [carrierId, brokerId, loadId, invoiceId, extra]);
  const accounts = useQuery({ queryKey: ['email', 'accounts'], queryFn: () => api.get('/api/email/accounts') });
  const connected = (accounts.data?.items || []).filter((a) => a.status === 'connected');
  const canAttach = !!(carrierId || loadId);
  const attachable = useAttachableDocuments(carrierId, loadId, canAttach && (docsOpen || docs.length > 0));
  const docById = useMemo(() => new Map(attachable.items.map((d) => [d.id, d])), [attachable.items]);
  const chosen = docs.map((id) => docById.get(id)).filter(Boolean);
  const totalBytes = chosen.reduce((n, d) => n + (d.sizeBytes || 0), 0);
  const preview = usePreview({ subject: form.subject, body: form.body, context, active: true });
  const warn = preview.data ? { unknown: preview.data.unknown || [], unresolved: preview.data.unresolved || [], fallbacks: preview.data.fallbacks || [] } : null;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const draftAi = useApiMutation((v) => api.post('/api/ai/draft-email', v), {
    onSuccess: (d) => { setForm((f) => ({ ...f, subject: d.subject, body: d.body })); setAiGenerated(true); setAiOpen(false); toast.info('AI draft inserted. Review it before sending.'); },
  });

  const toggleDoc = (id, on) => {
    setDocs((list) => {
      if (!on) return list.filter((x) => x !== id);
      if (list.includes(id)) return list;
      if (list.length >= MAX_ATTACHMENTS) { toast.info(`Attach up to ${MAX_ATTACHMENTS} files per email`); return list; }
      const size = (docById.get(id)?.sizeBytes || 0) + list.reduce((n, x) => n + (docById.get(x)?.sizeBytes || 0), 0);
      if (size > MAX_ATTACHMENT_BYTES) { toast.info('Attachments are limited to 10 MB per email'); return list; }
      return [...list, id];
    });
  };

  const submit = useApiMutation(async (mode) => {
    let { subject: subj, body: text } = form;
    // Fill merge fields with the full context (load, invoice, links) so what is sent matches the preview.
    if (hasTokens(subj) || hasTokens(text)) {
      const r = await renderTemplate({ channel: 'email', subject: subj, body: text, ...context });
      const left = [...(r.unknown || []), ...(r.unresolved || [])];
      if (mode !== 'draft' && left.length) {
        // No promise about how they go out: known fields without a value are left blank, typos stay as typed.
        const ok = await confirm({ title: 'Some merge fields are not filled', message: `${fieldList(left)} could not be filled in for this email. Send anyway?`, confirmLabel: mode === 'schedule' ? 'Schedule anyway' : 'Send anyway' });
        if (!ok) return { canceled: true };
      }
      subj = r.subject ?? subj;
      text = r.body;
    }
    return api.post('/api/email/messages', {
      ...form, subject: subj, body: text,
      accountId: form.accountId || undefined,
      templateId: form.templateId || undefined,
      carrierId, brokerId, mode, aiGenerated,
      documentIds: docs.length ? docs : undefined,
      scheduledAt: mode === 'schedule' ? new Date(scheduleAt).toISOString() : undefined,
    });
  }, {
    // Only this carrier's profile when the email is about a known carrier (not every cached carrier).
    invalidate: [['emails'], ['email', 'status'], ['email', 'accounts'], carrierId ? ['carrier', carrierId] : ['carrier']],
    onSuccess: (res) => {
      if (res?.canceled) return;
      if (res.outcome === 'failed') { setFailure(res.message); return; }
      setFailure(null);
      // The server returns the stored attachments as a list ([] when none were kept).
      if (docs.length && !res.email?.attachments?.length) toast.error('The email was saved without attachments. Attach the files from your own mail app.');
      if (res.outcome === 'sent') toast.success('Email accepted by your mail provider.');
      else if (res.outcome === 'deferred') toast.info(res.message);
      else toast.success(res.message);
      onDone?.(res, { done: doneOption ? done && res.outcome !== 'draft' : false });
      if (!onDone) { setForm({ accountId: form.accountId, toEmail: '', subject: '', body: '', templateId: '' }); setAiGenerated(false); setDocs([]); }
    },
  });

  const canSend = form.subject.trim() && form.body.trim() && (form.toEmail.trim() || carrierId || brokerId);
  const pickTemplate = (r) => {
    setForm((f) => ({ ...f, templateId: r.template.id, subject: r.subject ?? f.subject, body: r.body ?? f.body }));
    setAiGenerated(false);
  };
  const shown = preview.data;

  return (
    <div className="space-y-3.5">
      {accounts.isSuccess && !connected.length && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>No mailbox connected. You can save drafts now; connect a mailbox under <a href="/app/email?tab=mailboxes" target="_blank" rel="noopener" className="font-medium underline">Email → Mailboxes</a> (opens in a new tab, so this draft stays here) to send.</span>
        </div>
      )}
      <div className={cx('grid gap-3', compact ? 'sm:grid-cols-2' : 'sm:grid-cols-3')}>
        <Field label="From">
          <Select value={form.accountId} onChange={set('accountId')} disabled={!connected.length}>
            <option value="">{connected.length ? 'Default mailbox' : 'No mailbox connected'}</option>
            {connected.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </Select>
        </Field>
        <Field label="To" hint={(carrierId || brokerId) && !form.toEmail ? 'Uses the record\'s email if left blank' : undefined}>
          <Input type="email" value={form.toEmail} onChange={set('toEmail')} placeholder="name@company.com" />
        </Field>
        <div className={cx('flex items-end', compact ? 'sm:col-span-2' : '')}>
          <TemplatePicker channel="email" {...context} category={templateCategory} label="Insert template" size="md" onPick={pickTemplate} />
        </div>
      </div>

      <Tabs value={view} onChange={setView} tabs={[{ value: 'write', label: 'Write' }, { value: 'preview', label: 'Preview' }]} />
      {view === 'write' ? (
        <>
          <Field label="Subject" required>
            <Input value={form.subject} onChange={set('subject')} maxLength={300} placeholder="Subject. Merge fields like {{company}} work here too." />
          </Field>
          <Field label="Message" required hint="Merge fields: {{first_name}} {{company}} {{mc}} {{my_name}} {{my_phone}} {{pickup_city}} {{rate}} and more (see Templates). Your signature and an unsubscribe link are added when it is sent.">
            <Textarea rows={compact ? 8 : 11} value={form.body} onChange={set('body')} />
          </Field>
        </>
      ) : (
        <div className="rounded-lg border border-line bg-surface-2/40 p-4" aria-live="polite">
          {!(hasTokens(form.subject) || hasTokens(form.body)) ? (
            <PreviewBody subject={form.subject} body={form.body} />
          ) : preview.loading && !shown ? <p className="text-sm text-muted">Filling in merge fields…</p>
            : preview.error ? <p className="text-sm text-red-600 dark:text-red-400">{preview.error.message}</p>
              : shown ? <PreviewBody subject={shown.subject} body={shown.body} signature={shown.signature} /> : null}
          <p className="mt-3 border-t border-line pt-2 text-xs text-muted">An unsubscribe link is added below your message.</p>
        </div>
      )}

      {warn && (warn.unknown.length > 0 || warn.unresolved.length > 0 || warn.fallbacks.length > 0) && (
        <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {warn.unknown.length > 0 && <p>Not a merge field: {fieldList(warn.unknown)}. Check the spelling.</p>}
          {warn.unresolved.length > 0 && <p>No value here for {fieldList(warn.unresolved)}. Replace {warn.unresolved.length === 1 ? 'it' : 'them'} before sending.</p>}
          {warn.fallbacks.includes('first_name') && <p>No contact name on file, so {'{{first_name}}'} becomes “there”.</p>}
        </div>
      )}

      {canAttach && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" icon={Paperclip} onClick={() => setDocsOpen((v) => !v)} aria-expanded={docsOpen}>
              {docs.length ? `Attachments (${docs.length})` : 'Attach documents'}
            </Button>
            {chosen.map((d) => (
              <span key={d.id} className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 text-xs">
                <FileText className="size-3.5 shrink-0 text-muted" aria-hidden />
                <span className="truncate">{d.originalName}</span>
                <span className="shrink-0 text-muted">{bytes(d.sizeBytes)}</span>
                <button type="button" onClick={() => toggleDoc(d.id, false)} aria-label={`Remove ${d.originalName}`} className="rounded text-muted hover:text-fg"><X className="size-3.5" /></button>
              </span>
            ))}
            {docs.length > 0 && <span className="text-xs text-muted">{bytes(totalBytes)} of 10 MB</span>}
          </div>
          {docsOpen && (
            <div className="rounded-lg border border-line p-2">
              {attachable.isLoading ? <p className="px-1 py-2 text-sm text-muted">Loading documents…</p>
                : attachable.isError ? <p className="px-1 py-2 text-sm text-red-600 dark:text-red-400">Could not load documents</p>
                  : !attachable.items.length ? <p className="px-1 py-2 text-sm text-muted">No documents on file yet. Upload them on the carrier or load page first.</p> : (
                    <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                      {attachable.items.map((d) => (
                        <li key={d.id} className="flex items-center justify-between gap-3 rounded-md px-1.5 py-1 hover:bg-surface-2/60">
                          <Checkbox className="min-w-0" checked={docs.includes(d.id)} onChange={(e) => toggleDoc(d.id, e.target.checked)}
                            label={<span className="min-w-0 truncate"><span className="text-muted">{DOC_LABEL[d.type] || labelize(d.type)} · </span>{d.originalName}</span>} />
                          <span className="shrink-0 text-xs text-muted">{bytes(d.sizeBytes)}{d.expiresAt && new Date(d.expiresAt) < new Date() ? ' · expired' : ''}</span>
                        </li>
                      ))}
                    </ul>
                  )}
              <p className="px-1.5 pt-1.5 text-xs text-muted">Up to {MAX_ATTACHMENTS} files and 10 MB per email.</p>
            </div>
          )}
        </div>
      )}

      {aiOpen && (
        <div className="space-y-3 rounded-md border border-line bg-surface-2/50 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Purpose">
              <Select value={ai.purpose} onChange={(e) => setAi({ ...ai, purpose: e.target.value })}>
                {PURPOSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </Field>
            <Field label="Tone">
              <Select value={ai.tone} onChange={(e) => setAi({ ...ai, tone: e.target.value })}>
                {['professional', 'friendly', 'direct'].map((t) => <option key={t} value={t}>{labelize(t)}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Notes for the AI" hint="Lanes, equipment, offer details. The AI will not invent rates.">
            <Textarea rows={2} value={ai.notes} onChange={(e) => setAi({ ...ai, notes: e.target.value })} />
          </Field>
          <div className="flex gap-2">
            <Button size="sm" icon={PenLine} loading={draftAi.isPending} onClick={() => draftAi.mutate({ ...ai, carrierId, brokerId, notes: ai.notes || undefined })}>Generate draft</Button>
            <Button size="sm" variant="ghost" onClick={() => setAiOpen(false)}>Close</Button>
          </div>
        </div>
      )}

      {failure && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          <strong>Not sent.</strong> {failure} The email is saved under Failed, and you can retry it there.
        </div>
      )}

      {showSchedule && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Send at (your local time)">
            <Input type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
          </Field>
          <Button icon={Clock} disabled={!canSend || !scheduleAt || !connected.length} loading={submit.isPending && submit.variables === 'schedule'} onClick={() => submit.mutate('schedule')}>Schedule</Button>
          <Button variant="ghost" onClick={() => setShowSchedule(false)}>Cancel</Button>
        </div>
      )}

      {doneOption && <Checkbox label={doneOption.label} checked={done} onChange={(e) => setDone(e.target.checked)} />}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button icon={Send} disabled={!canSend || !connected.length} loading={submit.isPending && submit.variables === 'send'} onClick={() => submit.mutate('send')}>Send now</Button>
        {!showSchedule && <Button variant="secondary" icon={Clock} disabled={!connected.length} onClick={() => setShowSchedule(true)}>Schedule…</Button>}
        <Button variant="secondary" icon={Save} loading={submit.isPending && submit.variables === 'draft'} onClick={() => submit.mutate('draft')}>Save draft</Button>
        {view === 'write' && (hasTokens(form.subject) || hasTokens(form.body)) && <Button variant="ghost" icon={Eye} onClick={() => setView('preview')}>Preview</Button>}
        {!aiOpen && <Button variant="ghost" icon={PenLine} onClick={() => setAiOpen(true)} className="ml-auto">AI draft</Button>}
      </div>
    </div>
  );
}

function PreviewBody({ subject, body, signature }) {
  return (
    <div className="space-y-3 text-sm">
      <div><span className="text-muted">Subject: </span><span className="font-medium">{subject || <span className="text-muted">(no subject)</span>}</span></div>
      <div className="whitespace-pre-wrap break-words text-fg">{body || <span className="text-muted">(empty message)</span>}</div>
      {signature && <div className="whitespace-pre-wrap break-words text-fg-2">{signature}</div>}
    </div>
  );
}

/**
 * Compose in a modal. Extra optional props: loadId, invoiceId, extra (merge values), documentIds (preselected
 * attachments), templateCategory, doneOption and onSent(res, { done }) for callers that complete a task on send.
 */
export default function ComposeModal({ open, onClose, carrierId, brokerId, loadId, invoiceId, extra, toEmail, subject, body, documentIds, templateCategory, doneOption, onSent }) {
  return (
    <Modal open={open} onClose={onClose} title="Compose email" size="lg">
      {open && (
        <ComposeForm compact carrierId={carrierId} brokerId={brokerId} loadId={loadId} invoiceId={invoiceId} extra={extra}
          toEmail={toEmail || ''} subject={subject || ''} body={body || ''} documentIds={documentIds} templateCategory={templateCategory} doneOption={doneOption}
          onDone={(res, meta) => { onSent?.(res, meta); onClose?.(); }} />
      )}
    </Modal>
  );
}
