import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Modal } from '../Modal.jsx';
import { Button, Field, Input, Select, Textarea, Checkbox } from '../ui.jsx';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { EQUIPMENT, US_STATES, label, toDateInput } from '../../lib/format.js';
import { STAGES } from './shared.jsx';

const EMPTY = { companyName: '', dbaName: '', dotNumber: '', mcNumber: '', phone: '', email: '', address: '', city: '', state: '', zip: '', fleetSize: '', drivers: '', authorityStatus: '', authorityDate: '', priority: 0 };

/** Create (carrier undefined) or edit a carrier. */
export default function CarrierForm({ open, onClose, carrier, onSaved }) {
  const editing = !!carrier;
  const navigate = useNavigate();
  const [form, setForm] = useState(() => (carrier ? {
    ...EMPTY, ...Object.fromEntries(Object.keys(EMPTY).map((k) => [k, carrier[k] ?? ''])), authorityDate: toDateInput(carrier.authorityDate),
  } : { ...EMPTY, stage: 'lead', contactName: '', note: '' }));
  const [equipment, setEquipment] = useState(() => new Set(carrier?.equipment ? carrier.equipment.split(',') : []));
  const [dup, setDup] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = useApiMutation(
    (body) => (editing ? api.patch(`/api/carriers/${carrier.id}`, body) : api.post('/api/carriers', body)),
    {
      success: editing ? 'Carrier updated' : 'Carrier added',
      invalidate: [['carriers'], ['pipeline'], ['carrier']],
      onSuccess: (data) => { onSaved?.(data.carrier); onClose(); },
      onError: (err) => {
        if (err.status === 409 && err.details?.duplicates) setDup(err.details);
        else setDup({ message: err.message });
      },
    },
  );

  const submit = (e, allowDuplicate = false) => {
    e?.preventDefault();
    setDup(null);
    const body = { ...form, equipment: [...equipment], priority: Number(form.priority) || 0 };
    if (!body.authorityDate) body.authorityDate = null;
    if (!editing && allowDuplicate) body.allowDuplicate = true;
    save.mutate(body);
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? `Edit ${carrier.companyName}` : 'Add carrier'} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="carrier-form" loading={save.isPending}>{editing ? 'Save changes' : 'Add carrier'}</Button></>}>
      <form id="carrier-form" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        {dup && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 sm:col-span-2 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200" role="alert">
            {dup.duplicates ? (
              <>
                <p className="font-medium">This looks like a carrier you already have:</p>
                <ul className="mt-1 list-disc pl-5">
                  {dup.duplicates.map((d) => (
                    <li key={d.id}><button type="button" className="underline" onClick={() => { onClose(); navigate(`/app/carriers/${d.id}`); }}>{d.companyName}</button> {d.dotNumber && `· DOT ${d.dotNumber}`} {d.mcNumber && `· MC ${d.mcNumber}`}</li>
                  ))}
                </ul>
                {dup.canOverride && <Button size="sm" variant="secondary" className="mt-2" onClick={() => submit(null, true)}>Add anyway (same phone only)</Button>}
              </>
            ) : dup.message}
          </div>
        )}
        <Field label="Company name" required className="sm:col-span-2"><Input value={form.companyName} onChange={set('companyName')} required maxLength={200} /></Field>
        <Field label="DBA name"><Input value={form.dbaName} onChange={set('dbaName')} /></Field>
        <Field label="Phone"><Input type="tel" value={form.phone} onChange={set('phone')} placeholder="(555) 555-0100" /></Field>
        <Field label="USDOT number"><Input inputMode="numeric" value={form.dotNumber} onChange={set('dotNumber')} /></Field>
        <Field label="MC number"><Input value={form.mcNumber} onChange={set('mcNumber')} placeholder="MC-123456" /></Field>
        <Field label="Email" className="sm:col-span-2"><Input type="email" value={form.email} onChange={set('email')} /></Field>
        <Field label="Street address" className="sm:col-span-2"><Input value={form.address} onChange={set('address')} /></Field>
        <Field label="City"><Input value={form.city} onChange={set('city')} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="State">
            <Select value={form.state} onChange={set('state')}><option value="">—</option>{US_STATES.map((s) => <option key={s}>{s}</option>)}</Select>
          </Field>
          <Field label="ZIP"><Input value={form.zip} onChange={set('zip')} /></Field>
        </div>
        <Field label="Fleet size (power units)"><Input type="number" min="0" value={form.fleetSize} onChange={set('fleetSize')} /></Field>
        <Field label="Drivers"><Input type="number" min="0" value={form.drivers} onChange={set('drivers')} /></Field>
        <Field label="Authority status">
          <Select value={form.authorityStatus} onChange={set('authorityStatus')}>
            <option value="">—</option>{['active', 'inactive', 'pending', 'unknown'].map((s) => <option key={s} value={s}>{label(s)}</option>)}
          </Select>
        </Field>
        <Field label="Authority date"><Input type="date" value={form.authorityDate} onChange={set('authorityDate')} /></Field>
        <Field label="Priority">
          <Select value={form.priority} onChange={set('priority')}><option value={0}>Normal</option><option value={1}>High</option><option value={2}>Hot</option></Select>
        </Field>
        {!editing && (
          <Field label="Pipeline stage">
            <Select value={form.stage} onChange={set('stage')}>{STAGES.filter((s) => s.key !== 'archived').map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}</Select>
          </Field>
        )}
        <fieldset className="sm:col-span-2">
          <legend className="mb-1.5 text-[13px] font-medium">Equipment</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {EQUIPMENT.map((eq) => (
              <Checkbox key={eq} label={label(eq)} checked={equipment.has(eq)} onChange={() => setEquipment((s) => { const n = new Set(s); n.has(eq) ? n.delete(eq) : n.add(eq); return n; })} />
            ))}
          </div>
        </fieldset>
        {!editing && (
          <>
            <Field label="Contact name"><Input value={form.contactName} onChange={set('contactName')} /></Field>
            <Field label="First note" className="sm:col-span-2"><Textarea rows={2} value={form.note} onChange={set('note')} /></Field>
          </>
        )}
      </form>
    </Modal>
  );
}
