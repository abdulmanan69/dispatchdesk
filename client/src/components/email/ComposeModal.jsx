import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PenLine, Send, Clock, Save, AlertTriangle } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useToast } from '../Toast.jsx';
import { Modal } from '../Modal.jsx';
import { Button, Field, Input, Select, Textarea, cx } from '../ui.jsx';
import { label as labelize } from '../../lib/format.js';

const PURPOSES = [
  ['carrier_intro', 'Carrier introduction'],
  ['follow_up', 'Follow-up'],
  ['broker_intro', 'Broker introduction'],
  ['broker_rate', 'Broker rate negotiation'],
  ['custom', 'Custom (describe in notes)'],
];

/**
 * Email composer used inline (Email → Compose) and in a modal (carrier/broker pages).
 * The server resolves merge fields, checks opt-outs/limits and reports the real send outcome.
 */
export function ComposeForm({ carrierId, brokerId, toEmail = '', subject = '', body = '', onDone, compact }) {
  const toast = useToast();
  const [form, setForm] = useState({ accountId: '', toEmail, subject, body, templateId: '' });
  const [scheduleAt, setScheduleAt] = useState('');
  const [showSchedule, setShowSchedule] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [ai, setAi] = useState({ purpose: brokerId ? 'broker_intro' : 'carrier_intro', notes: '', tone: 'professional' });
  const [aiGenerated, setAiGenerated] = useState(false);
  const [failure, setFailure] = useState(null);

  useEffect(() => { setForm((f) => ({ ...f, toEmail, subject, body })); }, [toEmail, subject, body]);

  const accounts = useQuery({ queryKey: ['email', 'accounts'], queryFn: () => api.get('/api/email/accounts') });
  const templates = useQuery({ queryKey: ['email', 'templates'], queryFn: () => api.get('/api/email/templates') });
  const connected = (accounts.data?.items || []).filter((a) => a.status === 'connected');

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const applyTemplate = (id) => {
    const t = templates.data?.items?.find((x) => x.id === id);
    setForm((f) => ({ ...f, templateId: id, ...(t ? { subject: t.subject, body: t.body } : {}) }));
  };

  const draftAi = useApiMutation((v) => api.post('/api/ai/draft-email', v), {
    onSuccess: (d) => { setForm((f) => ({ ...f, subject: d.subject, body: d.body })); setAiGenerated(true); setAiOpen(false); toast.info('AI draft inserted — review it before sending.'); },
  });

  const submit = useApiMutation((mode) => api.post('/api/email/messages', {
    ...form,
    accountId: form.accountId || undefined,
    templateId: form.templateId || undefined,
    carrierId, brokerId, mode, aiGenerated,
    scheduledAt: mode === 'schedule' ? new Date(scheduleAt).toISOString() : undefined,
  }), {
    invalidate: [['emails'], ['email', 'status'], ['email', 'accounts'], ['carrier']],
    onSuccess: (res) => {
      if (res.outcome === 'failed') { setFailure(res.message); return; }
      setFailure(null);
      if (res.outcome === 'sent') toast.success('Email accepted by your mail provider.');
      else if (res.outcome === 'deferred') toast.info(res.message);
      else toast.success(res.message);
      onDone?.(res);
      if (!onDone) { setForm({ accountId: form.accountId, toEmail: '', subject: '', body: '', templateId: '' }); setAiGenerated(false); }
    },
  });

  const canSend = form.subject.trim() && form.body.trim() && (form.toEmail.trim() || carrierId || brokerId);

  return (
    <div className="space-y-3.5">
      {accounts.isSuccess && !connected.length && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>No mailbox connected. You can save drafts now; connect a mailbox under <a href="/app/email?tab=mailboxes" className="font-medium underline">Email → Mailboxes</a> to send.</span>
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
        <Field label="Template" className={compact ? 'sm:col-span-2' : ''}>
          <Select value={form.templateId} onChange={(e) => applyTemplate(e.target.value)}>
            <option value="">None</option>
            {(templates.data?.items || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Subject" required>
        <Input value={form.subject} onChange={set('subject')} maxLength={300} placeholder="Subject — merge fields like {{company}} work" />
      </Field>
      <Field label="Message" required hint="Merge fields: {{company}} {{first_name}} {{mc}} {{dot}} {{city}} {{state}} {{sender_name}} {{signature}}. Your signature and an unsubscribe link are added automatically.">
        <Textarea rows={compact ? 8 : 11} value={form.body} onChange={set('body')} />
      </Field>

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
          <Field label="Notes for the AI" hint="Lanes, equipment, offer details — the AI will not invent rates.">
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
          <strong>Not sent.</strong> {failure} The email is saved under Failed — you can retry it there.
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

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button icon={Send} disabled={!canSend || !connected.length} loading={submit.isPending && submit.variables === 'send'} onClick={() => submit.mutate('send')}>Send now</Button>
        {!showSchedule && <Button variant="secondary" icon={Clock} disabled={!connected.length} onClick={() => setShowSchedule(true)}>Schedule…</Button>}
        <Button variant="secondary" icon={Save} loading={submit.isPending && submit.variables === 'draft'} onClick={() => submit.mutate('draft')}>Save draft</Button>
        {!aiOpen && <Button variant="ghost" icon={PenLine} onClick={() => setAiOpen(true)} className="ml-auto">AI draft</Button>}
      </div>
    </div>
  );
}

export default function ComposeModal({ open, onClose, carrierId, brokerId, toEmail, subject, body }) {
  return (
    <Modal open={open} onClose={onClose} title="Compose email" size="lg">
      {open && <ComposeForm compact carrierId={carrierId} brokerId={brokerId} toEmail={toEmail || ''} subject={subject || ''} body={body || ''} onDone={() => onClose?.()} />}
    </Modal>
  );
}
