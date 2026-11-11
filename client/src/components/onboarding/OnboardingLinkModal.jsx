import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, Link2, MessageSquare, Plus, RotateCcw } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { dateTime } from '../../lib/format.js';
import { useToast } from '../Toast.jsx';
import { Modal } from '../Modal.jsx';
import { Button, Checkbox, Field, Input, Loading, ErrorState, Select, Textarea } from '../ui.jsx';
import { DEFAULT_DOCS, LINK_DAYS, ONBOARDING_DOCS, insertAt } from './onboardingLinks.js';

const SENT = new Set(['sent', 'scheduled', 'deferred']);

/**
 * Create a carrier onboarding link: the dispatch agreement (edited from the dispatcher's saved template, with merge
 * fields), the fee, the documents to ask for and how long the link works. The link is shown once; the dispatcher
 * copies it, texts it or has it emailed from their own mailbox.
 */
export default function OnboardingLinkModal({ open, onClose, carrier, feePercent }) {
  const toast = useToast();
  const bodyRef = useRef(null);
  const template = useQuery({ queryKey: ['onboarding-links', 'template'], queryFn: () => api.get('/api/onboarding-links/template'), enabled: open });
  const accounts = useQuery({ queryKey: ['email', 'accounts'], queryFn: () => api.get('/api/email/accounts'), enabled: open });
  const hasMailbox = (accounts.data?.items || []).some((a) => a.status === 'connected');
  const [f, setF] = useState(null);
  const [created, setCreated] = useState(null);

  useEffect(() => {
    if (!open) { setF(null); setCreated(null); return; }
    if (template.data && !f) {
      setF({
        title: template.data.title, body: template.data.body, fee: feePercent ?? '', docs: DEFAULT_DOCS, days: String(template.data.days?.default || 14),
        sendEmail: false, toEmail: carrier?.email || '',
      });
    }
  }, [open, template.data, f, feePercent, carrier]);

  const create = useApiMutation((body) => api.post('/api/onboarding-links', body), {
    invalidate: [['onboarding-links', carrier?.id], ['onboarding-links', 'template']],
    onSuccess: (d) => setCreated(d),
  });

  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const toggleDoc = (kind, on) => setF((x) => ({ ...x, docs: on ? [...new Set([...x.docs, kind])] : x.docs.filter((d) => d !== kind) }));
  const insertField = (key) => {
    const el = bodyRef.current;
    const { value, cursor } = insertAt(f.body, `{{${key}}}`, el?.selectionStart, el?.selectionEnd);
    setF((x) => ({ ...x, body: value }));
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(cursor, cursor); } });
  };
  const copy = async (text, what) => {
    try { await navigator.clipboard.writeText(text); toast.success(`${what} copied`); } catch { toast.error('Copy failed. Select the text and copy it by hand.'); }
  };
  const submit = () => create.mutate({
    carrierId: carrier.id,
    agreementTitle: f.title.trim() || null,
    agreementBody: f.body,
    feePercent: f.fee === '' ? null : Number(f.fee),
    requestedDocs: ONBOARDING_DOCS.map(([k]) => k).filter((k) => f.docs.includes(k)),
    days: Number(f.days),
    sendEmail: !!(f.sendEmail && hasMailbox && f.toEmail.trim()),
    toEmail: f.sendEmail && f.toEmail.trim() ? f.toEmail.trim() : null,
  });

  const t = template.data;
  const email = created?.email;
  return (
    <Modal open={open} onClose={onClose} size="lg" title={created ? 'Agreement link ready' : `Send agreement to ${carrier?.companyName || 'carrier'}`}
      footer={created ? <><Button variant="secondary" icon={Plus} onClick={() => setCreated(null)}>New link</Button><Button onClick={onClose}>Done</Button></> : <>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button icon={Link2} loading={create.isPending} disabled={!f || f.body.trim().length < 50} onClick={submit}>Create link</Button>
      </>}>
      {created ? (
        <div className="space-y-4">
          <p className="text-sm text-fg-2">Send this link to {carrier.companyName}. They can read and sign the agreement and upload documents from their phone. The link is shown only now; create a new one if it gets lost.</p>
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-2">
            <code className="min-w-0 flex-1 truncate px-1 font-mono text-xs">{created.link}</code>
            <Button size="sm" variant="secondary" icon={Copy} onClick={() => copy(created.link, 'Link')}>Copy</Button>
          </div>
          {email && (SENT.has(email.outcome) ? (
            <p className="flex items-start gap-2 rounded-lg bg-c-green-soft px-3 py-2 text-sm text-c-green"><CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />{email.outcome === 'sent' ? 'Emailed' : 'Email queued'} to {created.message.toEmail}.</p>
          ) : (
            <p className="flex items-start gap-2 rounded-lg bg-c-amber-soft px-3 py-2 text-sm text-c-amber"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />Not emailed: {email.message}</p>
          ))}
          <div className="grid gap-2 sm:grid-cols-3">
            <Button variant="secondary" icon={MessageSquare} href={created.message.sms}>Text message</Button>
            <Button variant="secondary" icon={Copy} onClick={() => copy(created.message.text, 'Message')}>Copy message</Button>
            <Button variant="secondary" icon={ExternalLink} href={created.link} target="_blank" rel="noopener noreferrer">Open the page</Button>
          </div>
          <p className="text-xs text-muted">Works until {dateTime(created.onboardingLink.expiresAt)}. You are notified when the carrier signs; the signed record is under Dispatch agreement on the carrier.</p>
        </div>
      ) : template.isError ? <ErrorState error={template.error} onRetry={template.refetch} /> : !f || !t ? <Loading /> : (
        <div className="space-y-4">
          <p className="flex items-start gap-2 rounded-lg border border-c-amber/30 bg-c-amber-soft px-3 py-2 text-[13px] text-c-amber">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>This is a template, not legal advice. Have your own agreement reviewed by an attorney.</span>
          </p>
          <Field label="Agreement title"><Input value={f.title} onChange={set('title')} maxLength={150} /></Field>
          <Field label="Agreement" hint="Saved as your template for the next carrier. Merge fields are filled in for this carrier when you create the link.">
            {(id) => (
              <div className="space-y-2">
                <Textarea id={id} ref={bodyRef} rows={12} value={f.body} onChange={set('body')} maxLength={30000} className="font-mono text-[12.5px] leading-relaxed" />
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted">Insert:</span>
                  {t.fields.map((m) => (
                    <button key={m.key} type="button" title={m.label} onClick={() => insertField(m.key)}
                      className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11.5px] text-fg-2 transition-ui hover:border-brand-500 hover:text-fg">{`{{${m.key}}}`}</button>
                  ))}
                  {f.body !== t.defaultBody && (
                    <Button size="sm" variant="link" icon={RotateCcw} className="ml-auto" onClick={() => setF((x) => ({ ...x, body: t.defaultBody }))}>Use the built-in template</Button>
                  )}
                </div>
              </div>
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Dispatch fee (%)" hint="Of gross line haul. Fills {{fee_percent}}.">
              <Input type="number" min="0" max="100" step="0.1" inputMode="decimal" value={f.fee} onChange={set('fee')} />
            </Field>
            <Field label="Link works for">
              <Select value={f.days} onChange={set('days')}>{LINK_DAYS.map((d) => <option key={d} value={String(d)}>{d} days</option>)}</Select>
            </Field>
          </div>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-[13px] font-medium">Documents to ask for</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {ONBOARDING_DOCS.map(([k, text]) => (
                <Checkbox key={k} label={text} checked={f.docs.includes(k)} onChange={(e) => toggleDoc(k, e.target.checked)} />
              ))}
            </div>
          </fieldset>
          <div className="space-y-2 rounded-lg border border-line p-3">
            <Checkbox label={<span className="font-medium">Email it from my mailbox</span>} checked={f.sendEmail && hasMailbox} disabled={!hasMailbox}
              onChange={(e) => setF((x) => ({ ...x, sendEmail: e.target.checked }))} />
            {!hasMailbox && !accounts.isLoading && <p className="text-xs text-muted">Connect a mailbox under Email to send it from here. You can still copy or text the link.</p>}
            {f.sendEmail && hasMailbox && (
              <Field label="To"><Input type="email" value={f.toEmail} onChange={set('toEmail')} placeholder="owner@carrier.com" maxLength={254} /></Field>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
