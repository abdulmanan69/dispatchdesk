import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.jsx';
import { Modal } from '../../components/Modal.jsx';
import { Button, Field, Input, Select, Tabs, Textarea, cx } from '../../components/ui.jsx';
import CarrierPicker from '../../components/followups/CarrierPicker.jsx';
import { Segmented } from '../../components/followups/FollowUpForm.jsx';
import { TEMPLATE_CATEGORIES, fieldList, invalidateFor, renderTemplate, useMergeFields } from '../../components/templates/templateApi.js';
import { smsInfo } from '../../components/templates/merge.js';

const TEXT_MAX = 1000;
const EMPTY = { name: '', category: 'carrier', subject: '', body: '' };

/** Debounced preview through the server merge engine (sample data or a real carrier the user can see). */
function useLivePreview({ channel, subject, body, source, carrierId, active }) {
  const [state, setState] = useState({ data: null, loading: false, error: null });
  useEffect(() => {
    if (!active || !body.trim() || (source === 'carrier' && !carrierId)) { setState({ data: null, loading: false, error: null }); return undefined; }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      renderTemplate(source === 'sample' ? { channel, subject, body, sample: true } : { channel, subject, body, carrierId })
        .then((data) => { if (!cancelled) setState({ data, loading: false, error: null }); })
        .catch((error) => { if (!cancelled) setState({ data: null, loading: false, error }); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [channel, subject, body, source, carrierId, active]);
  return state;
}

/**
 * Create or edit one template. Email templates save through /api/email/templates, text templates through
 * /api/templates/text. Merge-field chips insert at the cursor of the field you last used (subject or message).
 */
export default function TemplateEditor({ channel, template, onClose }) {
  const toast = useToast();
  const qc = useQueryClient();
  const isEmail = channel === 'email';
  const original = useMemo(() => (template ? { name: template.name, category: template.category, subject: template.subject || '', body: template.body } : EMPTY), [template]);
  const [form, setForm] = useState(original);
  const [view, setView] = useState('edit');
  const [source, setSource] = useState('sample');
  const [carrier, setCarrier] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const subjectRef = useRef(null);
  const bodyRef = useRef(null);
  const lastField = useRef('body');
  const fields = useMergeFields();
  const preview = useLivePreview({ channel, subject: form.subject, body: form.body, source, carrierId: carrier?.id, active: view === 'preview' });

  const groups = useMemo(() => {
    const list = (fields.data?.fields || []).filter((f) => f.channels.includes(isEmail ? 'email' : 'sms'));
    return (fields.data?.groups || []).map((g) => ({ ...g, fields: list.filter((f) => f.group === g.key) })).filter((g) => g.fields.length);
  }, [fields.data, isEmail]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const insert = (key) => {
    const target = isEmail && lastField.current === 'subject' ? 'subject' : 'body';
    const el = target === 'subject' ? subjectRef.current : bodyRef.current;
    const token = `{{${key}}}`;
    const value = form[target];
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    setForm((f) => ({ ...f, [target]: value.slice(0, start) + token + value.slice(end) }));
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(start + token.length, start + token.length); } });
  };

  const dirty = form.name !== original.name || form.category !== original.category || form.body !== original.body || (isEmail && form.subject !== original.subject);
  const tooLong = !isEmail && form.body.length > TEXT_MAX;
  const valid = form.name.trim() && form.body.trim() && (!isEmail || form.subject.trim()) && !tooLong;

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      const base = isEmail ? '/api/email/templates' : '/api/templates/text';
      const payload = { name: form.name.trim(), category: form.category, body: form.body, ...(isEmail ? { subject: form.subject.trim() } : {}) };
      if (template) {
        // Send only what changed, so an untouched field is never re-validated or reset.
        const changed = Object.fromEntries(Object.entries(payload).filter(([k, v]) => v !== (k === 'name' || k === 'subject' ? original[k].trim() : original[k])));
        if (Object.keys(changed).length) await api.patch(`${base}/${template.id}`, changed);
      } else {
        await api.post(base, payload);
      }
      await Promise.all(invalidateFor(channel).map((k) => qc.invalidateQueries({ queryKey: k })));
      toast.success(template ? 'Template saved' : 'Template created');
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const info = smsInfo(form.body);
  const shown = preview.data;
  const warnings = shown ? [...(shown.unknown || [])] : [];
  const unresolved = shown?.unresolved || [];

  return (
    <Modal open onClose={onClose} size="lg" title={template ? `Edit ${isEmail ? 'email' : 'text'} template` : `New ${isEmail ? 'email' : 'text'} template`}
      footer={<>
        {dirty && <span className="mr-auto self-center text-xs text-muted">Unsaved changes</span>}
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={saving} disabled={!valid || (template && !dirty)} onClick={save}>{template ? 'Save template' : 'Create template'}</Button>
      </>}>
      <div className="space-y-4">
        <Tabs value={view} onChange={setView} tabs={[{ value: 'edit', label: 'Edit' }, { value: 'preview', label: 'Preview' }]} />
        {view === 'edit' ? (
          <div className="space-y-3.5">
            <div className="grid gap-3 sm:grid-cols-[1fr_190px]">
              <Field label="Name" required><Input value={form.name} onChange={set('name')} maxLength={120} placeholder={isEmail ? 'Follow-up after voicemail' : 'Check call'} /></Field>
              <Field label="Category">
                {/* Both channels accept every category (/api/templates/text and /api/email/templates). */}
                <Select value={form.category} onChange={set('category')}>
                  {TEMPLATE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                </Select>
              </Field>
            </div>
            {isEmail && (
              <Field label="Subject" required>
                <Input ref={subjectRef} value={form.subject} onChange={set('subject')} onFocus={() => { lastField.current = 'subject'; }} maxLength={300} placeholder="Dispatch help for {{company}}" />
              </Field>
            )}
            <Field label="Message" required error={tooLong ? `Keep text templates under ${TEXT_MAX} characters` : undefined}
              hint={isEmail ? 'Your signature and an unsubscribe link are added when it is sent. Place {{signature}} to put the signature somewhere else.' : `${info.chars} characters${info.segments > 1 ? ` · about ${info.segments} texts` : ''}${info.unicode ? ' · special characters make each text shorter' : ''}. Merge fields change the final length.`}>
              <Textarea ref={bodyRef} rows={isEmail ? 12 : 6} value={form.body} onChange={set('body')} onFocus={() => { lastField.current = 'body'; }}
                className="font-mono text-[13px] leading-6" placeholder={isEmail ? 'Hi {{first_name}},\n\n…' : 'Hi {{first_name}}, this is {{my_name}}…'} />
            </Field>
            <div>
              <p className="mb-2 text-xs text-muted">Insert a merge field{isEmail ? ' into the subject or message (where your cursor was)' : ''}:</p>
              {fields.isLoading ? <p className="text-xs text-muted">Loading fields…</p> : (
                <div className="space-y-2">
                  {groups.map((g) => (
                    <div key={g.key} className="flex flex-wrap items-center gap-1.5">
                      <span className="w-full text-[11.5px] font-medium text-fg-2 sm:w-28">{g.label}</span>
                      {g.fields.map((f) => (
                        <button key={f.key} type="button" title={f.label} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(f.key)}
                          className="rounded-md border border-line-strong px-1.5 py-0.5 font-mono text-[11.5px] text-fg-2 transition-ui hover:bg-surface-2 hover:text-fg">
                          {`{{${f.key}}}`}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Segmented label="Preview with" size="sm" value={source} onChange={setSource} options={[{ value: 'sample', label: 'Sample data' }, { value: 'carrier', label: 'A carrier' }]} />
              {source === 'carrier' && <div className="w-full sm:w-72"><CarrierPicker value={carrier} onChange={setCarrier} autoFocus={!carrier} /></div>}
            </div>
            <div className={cx('rounded-lg border border-line bg-surface-2/40 p-4', preview.loading && 'opacity-70')} aria-live="polite">
              {!form.body.trim() ? <p className="text-sm text-muted">Write a message to preview it.</p>
                : source === 'carrier' && !carrier ? <p className="text-sm text-muted">Pick a carrier to see the message with their details.</p>
                  : preview.error ? <p className="text-sm text-red-600 dark:text-red-400">{preview.error.message}</p>
                    : !shown ? <p className="text-sm text-muted">Filling in merge fields…</p> : (
                      <div className="space-y-3 text-sm">
                        {isEmail && <div><span className="text-muted">Subject: </span><span className="font-medium">{shown.subject}</span></div>}
                        <div className="whitespace-pre-wrap break-words">{shown.body}</div>
                        {isEmail && shown.signature && <div className="whitespace-pre-wrap break-words text-fg-2">{shown.signature}</div>}
                        {!isEmail && <p className="text-xs text-muted">{smsInfo(shown.body).chars} characters after merge fields</p>}
                      </div>
                    )}
            </div>
            {source === 'sample' && <p className="text-xs text-muted">Sample data is made up for the preview. Your own name, phone and email are used where you have them.</p>}
            {warnings.length > 0 && <p className="text-[13px] text-amber-700 dark:text-amber-300">Not a merge field: {fieldList(warnings)}. Check the spelling.</p>}
            {unresolved.length > 0 && source === 'carrier' && <p className="text-[13px] text-amber-700 dark:text-amber-300">This carrier has no value for {fieldList(unresolved)}. Load and invoice fields fill in when you use the template from a load or invoice.</p>}
          </div>
        )}
        {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">{error}</p>}
      </div>
    </Modal>
  );
}
