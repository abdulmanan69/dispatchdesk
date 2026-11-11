import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Mail, Eye, AlertTriangle, ArrowLeft } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { Modal } from '../Modal.jsx';
import { Badge, Button, Field, Input, Textarea } from '../ui.jsx';
import TemplatePicker from '../templates/TemplatePicker.jsx';
import { fieldList } from '../templates/templateApi.js';
import { insertAtCursor } from './bulkSelection.js';

const TOKENS = ['company', 'first_name', 'mc', 'dot', 'city', 'state', 'equipment', 'my_name', 'my_phone', 'signature'];

/** "About 18 can go out today (mailbox 50 a day, plan 20 a day)" from the server's capacity numbers. */
export function capacityLine(cap, n) {
  if (!cap) return '';
  const limits = [cap.mailbox?.dailyLimit != null && `mailbox ${cap.mailbox.dailyLimit} a day`, cap.planLeftToday != null && `${cap.planLeftToday} left on your plan today`].filter(Boolean).join(', ');
  const cooldown = cap.mailbox?.cooldownSeconds ? ` Emails go out ${cap.mailbox.cooldownSeconds} seconds apart.` : '';
  if (n <= cap.sendableToday) return `All ${n} can go out today (${limits}).${cooldown}`;
  return `About ${cap.sendableToday} can go out today (${limits}); the rest go out on the next days.${cooldown}`;
}

/**
 * Email the selected carriers (a page selection or "all matching") with a template or a written message.
 * Merge fields are filled per carrier on the server. Preview first: who gets it, who is skipped and why, today's
 * capacity and three rendered samples. Queued emails go out from the user's own mailbox within its limits.
 *
 * target: { ids } | { filter }   count: how many carriers are selected
 */
export default function BulkEmailModal({ open, onClose, target, count, onDone }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [templateId, setTemplateId] = useState(null);
  const [review, setReview] = useState(null);
  const bodyRef = useRef(null);
  useEffect(() => { if (open) { setSubject(''); setBody(''); setTemplateId(null); setReview(null); } }, [open]);

  const payload = () => ({ ...target, subject, body, templateId: templateId || undefined });
  const preview = useApiMutation((p) => api.post('/api/carriers/bulk/email', { ...p, dryRun: true }), { onSuccess: setReview });
  const send = useApiMutation((p) => api.post('/api/carriers/bulk/email', p), {
    invalidate: [['carriers'], ['email'], ['carrier']],
    success: (d) => d.message,
    onSuccess: () => { onDone?.(); onClose(); },
  });

  const insert = (token) => {
    const { value, caret } = insertAtCursor(bodyRef.current, body, `{{${token}}}`);
    setBody(value);
    requestAnimationFrame(() => { const el = bodyRef.current; if (el) { el.focus(); el.setSelectionRange(caret, caret); } });
  };

  // Fields with no value for at least one recipient (the server leaves those emails out of the queue).
  const unresolved = [...new Set([...(review?.missingFields || []), ...(review?.samples || []).flatMap((s) => [...(s.unresolved || []), ...(s.unknown || [])])])];
  const canPreview = subject.trim() && body.trim() && !preview.isPending;

  return (
    <Modal open={open} onClose={onClose} size="lg" title={`Email ${count.toLocaleString('en-US')} carrier${count === 1 ? '' : 's'}`}
      footer={review ? (
        <>
          <Button variant="ghost" icon={ArrowLeft} onClick={() => setReview(null)}>Edit message</Button>
          <span className="flex-1" />
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button icon={Mail} disabled={!review.recipients || !review.mailbox} loading={send.isPending} onClick={() => send.mutate(payload())}>
            Queue {review.recipients} email{review.recipients === 1 ? '' : 's'}
          </Button>
        </>
      ) : (
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button icon={Eye} disabled={!canPreview} loading={preview.isPending} onClick={() => preview.mutate(payload())}>Preview</Button>
        </>
      )}>
      {!review ? (
        <div className="space-y-4">
          <p className="text-sm text-fg-2">Each carrier gets its own email from your mailbox, with fields like {'{{company}}'} and {'{{first_name}}'} filled in for them. Nothing is sent until you confirm on the next step.</p>
          <div className="flex flex-wrap items-center gap-2">
            <TemplatePicker channel="email" category="carrier" label="Use a template"
              onPick={({ subject: s, body: b, template }) => { setSubject(s || ''); setBody(b || ''); setTemplateId(template?.id || null); }} />
            {templateId && <span className="text-xs text-muted">Template text loaded; edit it below if needed.</span>}
          </div>
          <Field label="Subject" required><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} placeholder="Dispatch for {{company}}" /></Field>
          <Field label="Message" required hint="Your signature is added at the end unless the message has {{signature}}.">
            <Textarea ref={bodyRef} rows={10} value={body} onChange={(e) => setBody(e.target.value)} maxLength={20000} placeholder={'Hi {{first_name}},\n\n…'} />
          </Field>
          <div>
            <p className="mb-1.5 text-[13px] font-medium">Insert a field</p>
            <div className="flex flex-wrap gap-1.5">
              {TOKENS.map((t) => (
                <button key={t} type="button" onClick={() => insert(t)} className="rounded-md border border-line px-2 py-1 font-mono text-xs text-fg-2 transition-ui hover:bg-surface-2 hover:text-fg">{`{{${t}}}`}</button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-line px-3 py-2"><p className="text-xs text-muted">Will receive it</p><p className="text-xl font-medium tabular">{review.recipients}</p></div>
            <div className="rounded-lg border border-line px-3 py-2"><p className="text-xs text-muted">Skipped</p><p className="text-xl font-medium tabular">{review.skippedCount + review.inaccessible}</p></div>
            <div className="rounded-lg border border-line px-3 py-2"><p className="text-xs text-muted">From</p><p className="truncate text-sm font-medium">{review.mailbox?.fromEmail || 'No mailbox connected'}</p></div>
          </div>
          {!review.mailbox && (
            <p className="flex items-start gap-2 rounded-lg border border-c-amber/30 bg-c-amber-soft px-3 py-2 text-[13px] text-fg-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-c-amber" aria-hidden />
              <span>No mailbox is connected, so nothing can be sent yet. <Link to="/app/email" className="font-medium text-fg underline-offset-2 hover:underline" onClick={onClose}>Connect your mailbox</Link>, then come back.</span>
            </p>
          )}
          {review.mailbox && review.recipients > 0 && <p className="text-sm text-fg-2">{capacityLine(review.capacity, review.recipients)}</p>}
          {unresolved.length > 0 && (
            <p className="flex items-start gap-2 rounded-lg border border-c-amber/30 bg-c-amber-soft px-3 py-2 text-[13px] text-fg-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-c-amber" aria-hidden />
              <span>{fieldList(unresolved)} {unresolved.length === 1 ? 'has' : 'have'} no value for some carriers. Their emails are not queued; go back to edit the message.</span>
            </p>
          )}
          {(review.skippedCount > 0 || review.inaccessible > 0) && (
            <details className="rounded-lg border border-line px-3 py-2 text-sm">
              <summary className="cursor-pointer text-fg-2">Who is skipped and why</summary>
              <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                {review.inaccessible > 0 && <li className="text-muted">{review.inaccessible} carrier{review.inaccessible === 1 ? '' : 's'} you can only view</li>}
                {review.skipped.map((s) => <li key={s.id} className="flex justify-between gap-3"><span className="truncate">{s.name}</span><span className="shrink-0 text-xs text-muted">{s.reason}</span></li>)}
                {review.skippedCount > review.skipped.length && <li className="text-xs text-muted">and {review.skippedCount - review.skipped.length} more</li>}
              </ul>
            </details>
          )}
          {review.samples.length > 0 && (
            <div className="space-y-3">
              <p className="text-[13px] font-medium">Samples</p>
              {review.samples.map((s) => (
                <article key={s.carrierId} className="rounded-lg border border-line">
                  <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2 text-xs text-muted">
                    <span>To {s.name} · {s.toEmail}</span>
                    {(s.unresolved?.length > 0 || s.unknown?.length > 0) && <Badge color="amber">Missing fields</Badge>}
                  </header>
                  <div className="space-y-2 px-3 py-2 text-sm">
                    <p className="font-medium">{s.subject}</p>
                    <p className="whitespace-pre-wrap break-words text-fg-2">{s.body}{s.signature ? `\n\n${s.signature}` : ''}</p>
                  </div>
                </article>
              ))}
            </div>
          )}
          {!review.recipients && <p className="text-sm text-muted">None of the selected carriers can get this email.</p>}
        </div>
      )}
    </Modal>
  );
}
