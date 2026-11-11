import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2, ArrowUp, ArrowDown, Phone, Mail, ClipboardCheck, Save, MessageSquare, Play, UserPlus, X } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { dateTime, label } from '../../lib/format.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Badge, Button, Card, Checkbox, EmptyState, ErrorState, Field, IconButton, Input, Loading, PageHeader, Pagination, Select, Tabs, Textarea } from '../../components/ui.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import CarrierPicker from '../../components/followups/CarrierPicker.jsx';

const DEFAULT_STEPS = [
  { dayOffset: 0, type: 'call', instructions: 'Intro call — confirm equipment, lanes and whether they need a dispatcher.' },
  { dayOffset: 0, type: 'email', subject: 'Dispatch services for {{company}}', body: 'Hi {{first_name}},\n\nI just tried you by phone. I help owner-operators keep trucks loaded with good-paying freight.\n\nWould a 10-minute call this week work?\n' },
  { dayOffset: 1, type: 'text', body: 'Hi {{first_name}}, {{sender_name}} here. I dispatch for small fleets like {{company}}. Open to a quick call this week?' },
  { dayOffset: 3, type: 'call', instructions: 'Second call — reference the email, handle objections.' },
  { dayOffset: 6, type: 'task', instructions: 'Final follow-up — text or call, then archive if no reply.' },
];
const ICON = { call: Phone, email: Mail, text: MessageSquare, task: ClipboardCheck };
// Settings that re-time the upcoming steps of carriers already in the sequence (PUT /api/sequences/:id).
const TIMING = ['respectBusinessHours', 'windowStartHour', 'windowEndHour', 'skipWeekends'];

/** Step fields as the editor holds them; `id` is kept so carriers mid-sequence stay on the same step after an edit. */
const editable = ({ id, dayOffset, type, templateId, subject, body, instructions }) => ({
  ...(id ? { id } : {}), dayOffset: Number(dayOffset), type, templateId: templateId || '', subject: subject || '', body: body || '', instructions: instructions || '',
});

/** "Sequence saved" plus what happened to carriers already in it (PUT returns remapped { moved, completed, retimed }). */
function savedMessage(d) {
  const r = d?.remapped;
  const parts = [
    r?.moved && `${r.moved} moved with their step`,
    r?.completed && `${r.completed} finished (their remaining steps were removed)`,
    r?.retimed && `${r.retimed} re-timed`,
  ].filter(Boolean);
  return parts.length ? `Sequence saved. Carriers in it: ${parts.join(', ')}.` : 'Sequence saved';
}

export default function SequenceEditor() {
  const { id } = useParams();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { can } = useAuth();
  const canEdit = can('automation.use');
  const [tab, setTab] = useState('steps');
  const q = useQuery({ queryKey: ['sequences', id], queryFn: () => api.get(`/api/sequences/${id}`), enabled: !isNew });
  const templates = useQuery({ queryKey: ['email', 'templates'], queryFn: () => api.get('/api/email/templates'), retry: false });
  const [form, setForm] = useState(null);

  useEffect(() => {
    if (isNew) setForm({ name: '', description: '', active: true, respectBusinessHours: true, windowStartHour: 9, windowEndHour: 17, skipWeekends: true, maxEmailsPerDay: 50, steps: DEFAULT_STEPS });
    else if (q.data) {
      const s = q.data.sequence;
      setForm({ ...s, description: s.description || '', steps: s.steps.map(editable) });
    }
  }, [isNew, q.data]);

  const save = useApiMutation((body) => (isNew ? api.post('/api/sequences', body) : api.put(`/api/sequences/${id}`, body)), {
    success: savedMessage,
    invalidate: [['sequences'], ['queue']],
    onSuccess: (d) => { if (isNew) navigate(`/app/sequences/${d.sequence.id}`, { replace: true }); },
  });
  const del = useApiMutation(() => api.del(`/api/sequences/${id}`), { success: 'Sequence deleted', invalidate: [['sequences']], onSuccess: () => navigate('/app/sequences') });

  if (!isNew && q.isLoading) return <Loading />;
  if (!isNew && q.isError) return <ErrorState error={q.error} onRetry={q.refetch} />;
  if (!form) return <Loading />;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setStep = (i, patch) => setForm((f) => ({ ...f, steps: f.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const moveStep = (i, d) => setForm((f) => {
    const steps = [...f.steps];
    const j = i + d;
    if (j < 0 || j >= steps.length) return f;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    // Keep days non-decreasing after reorder.
    const days = steps.map((s) => s.dayOffset).sort((a, b) => a - b);
    return { ...f, steps: steps.map((s, k) => ({ ...s, dayOffset: days[k] })) };
  });
  const addStep = () => setForm((f) => ({ ...f, steps: [...f.steps, { dayOffset: (f.steps.at(-1)?.dayOffset ?? -1) + 1, type: 'call', instructions: '', subject: '', body: '', templateId: '' }] }));

  const submit = async (e) => {
    e.preventDefault();
    const steps = form.steps.map((s) => ({ ...s, dayOffset: Number(s.dayOffset), templateId: s.type === 'email' ? s.templateId || null : null }));
    // Carriers already in the sequence keep their place; say so before changing the steps or send hours under them.
    const mid = isNew ? 0 : q.data?.midSequence || 0;
    const stepsChanged = !isNew && JSON.stringify(form.steps.map(editable)) !== JSON.stringify(q.data.sequence.steps.map(editable));
    const timingChanged = !isNew && TIMING.some((k) => String(form[k]) !== String(q.data.sequence[k]));
    if (mid > 0 && (stepsChanged || timingChanged) && !(await confirm({
      title: stepsChanged ? 'Change the steps of a running sequence?' : 'Change the timing of a running sequence?',
      message: `${mid.toLocaleString('en-US')} ${mid === 1 ? 'carrier is' : 'carriers are'} mid-sequence. ${stepsChanged
        ? 'Each stays on the step it is on; a removed step moves it to the next one, and new days and hours apply to its upcoming steps.'
        : 'The new hours and weekend setting apply to their upcoming steps.'}`,
      confirmLabel: 'Save changes',
    }))) return;
    save.mutate({
      name: form.name, description: form.description, active: form.active, respectBusinessHours: form.respectBusinessHours,
      windowStartHour: Number(form.windowStartHour), windowEndHour: Number(form.windowEndHour), skipWeekends: form.skipWeekends, maxEmailsPerDay: Number(form.maxEmailsPerDay), steps,
    });
  };

  const tmplItems = templates.data?.items || [];

  return (
    <div className="max-w-5xl">
      <PageHeader breadcrumb={<Link to="/app/sequences" className="hover:underline">Sequences</Link>} title={isNew ? 'New sequence' : form.name || 'Sequence'}
        actions={!isNew && <>
          {canEdit && <Button variant="secondary" icon={Trash2} onClick={async () => { if (await confirm({ title: 'Delete sequence?', message: 'All enrollments in this sequence are removed. Logged calls and sent emails stay.', danger: true })) del.mutate(); }}>Delete</Button>}
          <Button icon={Play} to={q.data.enrollments.active ? `/app/dialer?sequenceId=${id}` : undefined} disabled={!q.data.enrollments.active} title={q.data.enrollments.active ? undefined : 'Enroll carriers first'}>Start</Button>
        </>} />
      {!isNew && (
        <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[
          { value: 'steps', label: 'Steps & settings' },
          { value: 'enrollments', label: 'Enrollments', count: Object.values(q.data.enrollments).reduce((a, b) => a + b, 0) },
        ]} />
      )}
      {tab === 'enrollments' && !isNew ? <Enrollments id={id} stats={q.data} /> : (
        <form onSubmit={submit} className="space-y-4">
          <Card title="Settings">
            <fieldset disabled={!canEdit} className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" required><Input value={form.name} onChange={(e) => set('name', e.target.value)} required maxLength={120} /></Field>
              <Field label="Max emails per day"><Input type="number" min="1" max="2000" value={form.maxEmailsPerDay} onChange={(e) => set('maxEmailsPerDay', e.target.value)} /></Field>
              <Field label="Description" className="sm:col-span-2"><Textarea rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} /></Field>
              <div className="space-y-2 sm:col-span-2">
                <Checkbox label="Active (new enrollments allowed, steps run)" checked={form.active} onChange={(e) => set('active', e.target.checked)} />
                <Checkbox label="Respect business hours in the carrier's time zone" checked={form.respectBusinessHours} onChange={(e) => set('respectBusinessHours', e.target.checked)} />
                <Checkbox label="Skip weekends" checked={form.skipWeekends} onChange={(e) => set('skipWeekends', e.target.checked)} />
              </div>
              {form.respectBusinessHours && (
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Window start (local hour)"><Input type="number" min="0" max="23" value={form.windowStartHour} onChange={(e) => set('windowStartHour', e.target.value)} /></Field>
                  <Field label="Window end (local hour)"><Input type="number" min="1" max="24" value={form.windowEndHour} onChange={(e) => set('windowEndHour', e.target.value)} /></Field>
                </div>
              )}
            </fieldset>
          </Card>

          <Card title="Steps" actions={canEdit && <Button size="sm" variant="secondary" icon={Plus} onClick={addStep}>Add step</Button>}>
            <ol className="space-y-3">
              {form.steps.map((s, i) => {
                const Icon = ICON[s.type];
                return (
                  <li key={i} className="rounded-md border border-line p-3">
                    <fieldset disabled={!canEdit} className="space-y-3">
                      <div className="flex flex-wrap items-end gap-2">
                        <span className="mb-2 inline-flex size-7 items-center justify-center rounded-full bg-surface-2 text-xs font-medium tabular">{i + 1}</span>
                        <Field label="Day"><Input type="number" min="1" max="366" value={Number(s.dayOffset) + 1} onChange={(e) => setStep(i, { dayOffset: Math.max(0, Number(e.target.value) - 1) })} className="w-20" /></Field>
                        <Field label="Type">
                          <Select value={s.type} onChange={(e) => setStep(i, { type: e.target.value })} className="w-32">
                            <option value="call">Call</option><option value="email">Email</option><option value="text">Text</option><option value="task">Task</option>
                          </Select>
                        </Field>
                        <Icon className="mb-2.5 size-4 text-muted" aria-hidden />
                        <div className="ml-auto flex">
                          <IconButton icon={ArrowUp} label="Move step up" onClick={() => moveStep(i, -1)} disabled={i === 0} />
                          <IconButton icon={ArrowDown} label="Move step down" onClick={() => moveStep(i, 1)} disabled={i === form.steps.length - 1} />
                          <IconButton icon={Trash2} label="Remove step" onClick={() => setForm((f) => ({ ...f, steps: f.steps.filter((_, j) => j !== i) }))} disabled={form.steps.length === 1} />
                        </div>
                      </div>
                      {s.type === 'email' ? (
                        <div className="space-y-2">
                          <Field label="Template" hint={templates.isError ? 'Templates unavailable — write the email below.' : 'Choose a saved template, or write the email below.'}>
                            <Select value={s.templateId} onChange={(e) => setStep(i, { templateId: e.target.value })}>
                              <option value="">Write custom email</option>
                              {tmplItems.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </Select>
                          </Field>
                          {!s.templateId && <>
                            <Field label="Subject"><Input value={s.subject} onChange={(e) => setStep(i, { subject: e.target.value })} /></Field>
                            <Field label="Body" hint="Merge fields such as {{company}} and {{first_name}} are filled when the email is sent."><Textarea rows={5} value={s.body} onChange={(e) => setStep(i, { body: e.target.value })} /></Field>
                          </>}
                        </div>
                      ) : s.type === 'text' ? (
                        <Field label="Text message" hint="You send it yourself from Google Voice or your phone. {{first_name}}, {{company}} and {{sender_name}} are filled in.">
                          <Textarea rows={3} value={s.body} maxLength={1000} onChange={(e) => setStep(i, { body: e.target.value })} />
                        </Field>
                      ) : (
                        <Field label={s.type === 'call' ? 'Call notes / script reminder' : 'Task instructions'}><Input value={s.instructions} onChange={(e) => setStep(i, { instructions: e.target.value })} /></Field>
                      )}
                    </fieldset>
                  </li>
                );
              })}
            </ol>
            <p className="mt-3 text-xs text-muted">Call, text and task steps appear in Prospecting and the power dialer on their day. Calls and texts are always started by you. Email steps send only when a mailbox is connected, the carrier has an email, and isn't marked do-not-email or unsubscribed.</p>
          </Card>
          {canEdit && <div className="flex justify-end"><Button type="submit" icon={Save} loading={save.isPending}>{isNew ? 'Create sequence' : 'Save changes'}</Button></div>}
        </form>
      )}
    </div>
  );
}

function Enrollments({ id, stats }) {
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['sequences', id, 'enrollments', status, page], queryFn: () => api.get(`/api/sequences/${id}/enrollments`, { status, page, pageSize: 25 }) });
  // stepIndex = the step on screen, so a stale click gets 409 instead of completing the next step.
  const act = useApiMutation(({ eid, action, stepIndex }) => api.post(`/api/sequences/enrollments/${eid}/${action}`, stepIndex != null ? { stepIndex } : undefined), { success: 'Updated', invalidate: [['sequences'], ['queue']] });
  const [enrolling, setEnrolling] = useState(false);
  const color = { active: 'green', paused: 'amber', completed: 'brand', stopped: 'gray' };
  return (
    <Card bodyClass="p-0" title={<div className="flex flex-wrap items-center gap-2 text-xs text-muted">
      {Object.keys(stats.emails).length > 0 && <span>Emails: {Object.entries(stats.emails).map(([k, v]) => `${v} ${k}`).join(' · ')}</span>}
    </div>} actions={<div className="flex flex-wrap items-center gap-2">
      {stats.sequence?.active && <Button size="sm" variant="secondary" icon={UserPlus} onClick={() => setEnrolling(true)}>Enroll carriers</Button>}
      <Select aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-36">
        {['active', 'paused', 'completed', 'stopped'].map((s) => <option key={s} value={s}>{label(s)} ({stats.enrollments[s] || 0})</option>)}
      </Select>
    </div>}>
      {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} /> : !q.data.items.length ? <EmptyState title={`No ${status} enrollments`}>Enroll carriers here, from the carrier list (bulk action) or from a carrier's page.</EmptyState> : (
        <ul className="divide-y divide-line">
          {q.data.items.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <Link to={`/app/carriers/${e.carrier.id}`} className="min-w-40 flex-1 font-medium hover:underline">{e.carrier.companyName}</Link>
              <Badge color={color[e.status]}>{label(e.status)}</Badge>
              <span className="text-muted">{e.step ? `Step ${e.step.order}: ${label(e.step.type)} · ${dateTime(e.nextStepAt)}` : e.stopReason ? label(e.stopReason) : 'Finished'}</span>
              {e.status === 'active' && <>
                {e.step?.type !== 'email' && <Button size="sm" variant="secondary" onClick={() => act.mutate({ eid: e.id, action: 'complete-step', stepIndex: e.currentStep })}>Step done</Button>}
                <Button size="sm" variant="ghost" onClick={() => act.mutate({ eid: e.id, action: 'pause' })}>Pause</Button>
              </>}
              {e.status === 'paused' && <Button size="sm" variant="secondary" onClick={() => act.mutate({ eid: e.id, action: 'resume' })}>Resume</Button>}
              {['active', 'paused'].includes(e.status) && <Button size="sm" variant="ghost" onClick={() => act.mutate({ eid: e.id, action: 'stop' })}>Stop</Button>}
            </li>
          ))}
        </ul>
      )}
      {q.data && <div className="px-3"><Pagination page={q.data.page} pages={q.data.pages} total={q.data.total} onPage={setPage} /></div>}
      <EnrollCarriersModal open={enrolling} sequenceId={id} onClose={() => setEnrolling(false)} />
    </Card>
  );
}

const ENROLL_PICK_MAX = 50;

/** Pick carriers one by one and enroll them; bulk enrollment stays in the carrier list. */
function EnrollCarriersModal({ open, sequenceId, onClose }) {
  const toast = useToast();
  const [picked, setPicked] = useState([]);
  const close = () => { setPicked([]); onClose(); };
  const enroll = useApiMutation(() => api.post(`/api/sequences/${sequenceId}/enroll`, { carrierIds: picked.map((c) => c.id) }), {
    invalidate: [['sequences'], ['queue'], ['carrier'], ['carriers'], ['pipeline']],
    onSuccess: (d) => {
      const skipped = (d.skipped || 0) + (d.inaccessible || 0);
      toast.success(`Enrolled ${d.enrolled}${skipped ? `, ${skipped} skipped (already enrolled or read-only)` : ''}`,
        d.enrolled ? { action: { label: 'Start dialer', href: `/app/dialer?sequenceId=${sequenceId}` } } : undefined);
      close();
    },
  });
  const add = (c) => { if (c) setPicked((p) => (p.some((x) => x.id === c.id) ? p : [...p, c].slice(0, ENROLL_PICK_MAX))); };
  return (
    <Modal open={open} onClose={close} title="Enroll carriers" size="sm"
      footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button disabled={!picked.length} loading={enroll.isPending} onClick={() => enroll.mutate()}>Enroll {picked.length || ''}</Button></>}>
      <div className="space-y-3">
        <Field label="Find a carrier" hint={`Add up to ${ENROLL_PICK_MAX}. To enroll many at once, select them in the carrier list and choose Enroll in sequence.`}>
          {(fid) => <CarrierPicker key={picked.length} id={fid} value={null} onChange={add} autoFocus />}
        </Field>
        {picked.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Carriers to enroll">
            {picked.map((c) => (
              <li key={c.id} className="inline-flex max-w-full items-center gap-1 rounded-full bg-surface-2 py-0.5 pl-2.5 pr-1 text-xs">
                <span className="truncate">{c.companyName}</span>
                <button type="button" aria-label={`Remove ${c.companyName}`} onClick={() => setPicked((p) => p.filter((x) => x.id !== c.id))} className="rounded-full p-0.5 text-muted hover:bg-surface hover:text-fg"><X className="size-3.5" /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
