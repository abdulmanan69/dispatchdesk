import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { toLocalInput } from '../../lib/format.js';
import { Button, Field, Input, Select, Textarea, cx } from '../ui.jsx';
import { Modal } from '../Modal.jsx';
import CarrierPicker from './CarrierPicker.jsx';
import { PRIORITIES, RECURRENCES, REMINDERS, TYPES, WHEN_PRESETS } from './followUpUtils.js';

export const FOLLOW_UP_INVALIDATE = [['follow-ups'], ['carrier'], ['queue'], ['dashboard']];

/** Segmented single-choice control (themed, keyboard reachable). */
export function Segmented({ options, value, onChange, label, size = 'md' }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-lg border border-line bg-surface-2 p-0.5">
      {options.map((o) => {
        const Icon = o.icon;
        const on = o.value === value;
        return (
          <button key={String(o.value)} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.value)}
            className={cx('inline-flex items-center gap-1.5 rounded-md transition-ui', size === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-2.5 text-[13px]',
              on ? 'bg-surface font-medium text-fg shadow-sm ring-1 ring-line' : 'text-fg-2 hover:text-fg')}>
            {Icon && <Icon className="size-3.5" aria-hidden />}{o.label}
          </button>
        );
      })}
    </div>
  );
}

const initial = (f) => ({
  carrier: f?.carrier || null,
  type: f?.type || 'call',
  dueAt: toLocalInput(f?.dueAt || WHEN_PRESETS[2].get()),
  preset: f ? null : 'tomorrow',
  priority: f?.priority ?? 0,
  recurrence: f?.recurrence || 'none',
  remindMinutesBefore: f?.remindMinutesBefore ?? 0,
  title: f?.title || '',
  note: f?.note || '',
});

/**
 * Create or edit a follow-up. Pass `followUp` to edit, `carrier` ({ id, companyName }) to lock the carrier,
 * or neither to show the carrier search. `compact` lays it out as a quick-add bar.
 */
export default function FollowUpForm({ followUp, carrier, onDone, compact, formId = 'follow-up-form', hideActions }) {
  const [f, setF] = useState(() => ({ ...initial(followUp), carrier: followUp?.carrier || carrier || null }));
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v?.target ? v.target.value : v }));
  const save = useApiMutation(
    (body) => (followUp ? api.patch(`/api/follow-ups/${followUp.id}`, body) : api.post('/api/follow-ups', body)),
    {
      success: followUp ? 'Follow-up updated' : 'Follow-up scheduled',
      invalidate: FOLLOW_UP_INVALIDATE,
      onSuccess: (d) => {
        if (!followUp) setF((x) => ({ ...initial(null), carrier: carrier || null, type: x.type }));
        onDone?.(d);
      },
    },
  );
  const submit = (e) => {
    e.preventDefault();
    if (!f.carrier) return;
    const body = {
      dueAt: new Date(f.dueAt).toISOString(), type: f.type, priority: Number(f.priority), recurrence: f.recurrence,
      remindMinutesBefore: Number(f.remindMinutesBefore), title: f.title.trim() || null, note: f.note.trim() || null,
    };
    save.mutate(followUp ? body : { ...body, carrierId: f.carrier.id });
  };
  const pickPreset = (p) => setF((x) => ({ ...x, preset: p.key, dueAt: toLocalInput(p.get()) }));
  const lockedCarrier = followUp || carrier;

  const when = (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {WHEN_PRESETS.map((p) => (
          <button key={p.key} type="button" onClick={() => pickPreset(p)} aria-pressed={f.preset === p.key}
            className={cx('h-7 rounded-md border px-2 text-xs transition-ui', f.preset === p.key ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-surface text-fg-2 hover:bg-surface-2')}>
            {p.label}
          </button>
        ))}
      </div>
      <Input type="datetime-local" aria-label="Due date and time" value={f.dueAt} required onChange={(e) => setF((x) => ({ ...x, dueAt: e.target.value, preset: null }))} className="w-60" />
    </div>
  );

  return (
    <form id={formId} onSubmit={submit} className={cx(compact ? 'grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)_minmax(0,1fr)]' : 'space-y-4')}>
      <div className="space-y-3">
        {!lockedCarrier ? (
          <Field label="Carrier" required>{(id) => <CarrierPicker id={id} value={f.carrier} onChange={set('carrier')} />}</Field>
        ) : !compact && <p className="text-sm"><span className="text-muted">Carrier </span><span className="font-medium">{f.carrier?.companyName}</span></p>}
        <Field label="Type"><Segmented label="Type" options={TYPES} value={f.type} onChange={set('type')} size={compact ? 'sm' : 'md'} /></Field>
      </div>
      <div className="space-y-3">
        <Field label="When">{when}</Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Repeat"><Select value={f.recurrence} onChange={set('recurrence')}>{RECURRENCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          <Field label="Remind me"><Select value={String(f.remindMinutesBefore)} onChange={set('remindMinutesBefore')}>{REMINDERS.map(([v, l]) => <option key={v} value={String(v)}>{l}</option>)}</Select></Field>
        </div>
      </div>
      <div className="space-y-3">
        <Field label="Priority"><Segmented label="Priority" options={PRIORITIES} value={Number(f.priority)} onChange={set('priority')} size={compact ? 'sm' : 'md'} /></Field>
        <Field label="Title"><Input value={f.title} onChange={set('title')} maxLength={160} placeholder="Call back about reefer lanes" /></Field>
        <Field label="Note"><Textarea rows={compact ? 2 : 3} value={f.note} onChange={set('note')} maxLength={2000} /></Field>
        {!hideActions && (
          <div className="flex justify-end">
            <Button type="submit" loading={save.isPending} disabled={!f.carrier}>{followUp ? 'Save changes' : 'Schedule follow-up'}</Button>
          </div>
        )}
      </div>
    </form>
  );
}

/** Modal wrapper around FollowUpForm, for editing or adding from anywhere. */
export function FollowUpDialog({ open, onClose, followUp, carrier }) {
  return (
    <Modal open={open} onClose={onClose} size="md" title={followUp ? 'Edit follow-up' : `Schedule follow-up${carrier?.companyName ? ` · ${carrier.companyName}` : ''}`}>
      {open && <FollowUpForm key={followUp?.id || 'new'} followUp={followUp} carrier={carrier} onDone={onClose} formId="follow-up-dialog" />}
    </Modal>
  );
}
