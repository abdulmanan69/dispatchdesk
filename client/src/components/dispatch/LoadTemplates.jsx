import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookmarkPlus, CopyPlus, Pencil, Plus, Repeat, Trash2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { EQUIPMENT, US_STATES, dollars, label, money } from '../../lib/format.js';
import { Badge, Button, Card, DataTable, EmptyState, Field, IconButton, Input, QueryState, Select, Switch, Textarea, cx } from '../ui.jsx';
import { Modal, useConfirm } from '../Modal.jsx';
import { useToast } from '../Toast.jsx';
import { toCents, fromCents } from './calc.js';
import { BrokerSelect, CarrierPicker } from './Pickers.jsx';
import { formatAt, zoneAbbr, zonedInput } from './zoned.js';

// ---------------------------------------------------------------------------
// Helpers (pure; tested in LoadTemplates.test.jsx)
// ---------------------------------------------------------------------------

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MS = 86_400_000;

const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const dayNumber = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
};
const timeOf = (v) => (typeof v === 'string' && /T\d{2}:\d{2}/.test(v) ? v.slice(11, 16) : null);
const blank = (v) => (v === '' || v === undefined ? null : v);

/** "08:00" -> "8:00 AM". */
export function clock(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Mon, Wed, Fri at 8:00 AM CST · loads 7 days ahead", or "Template only" without a schedule. */
export function recurrenceSummary(t) {
  const days = t.weekdays || [];
  if (!days.length) return 'Template only';
  const which = days.length === 7 ? 'Every day'
    : days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d)) ? 'Weekdays'
      : days.map((d) => WEEKDAY_SHORT[d]).join(', ');
  const abbr = t.pickupTz ? zoneAbbr(t.pickupTz) : '';
  return `${which} at ${clock(t.pickupTime)}${abbr ? ` ${abbr}` : ''} · loads ${t.leadDays} day${t.leadDays === 1 ? '' : 's'} ahead`;
}

/**
 * Load form state -> template body. Appointment windows keep only their facility-local time of day, and the days
 * between the pickup and delivery dates become transitDays. Per-load values (reference, dates, status) are left out.
 */
export function formToTemplate(f) {
  const pickupDay = f.pickupDate || f.pickupWindowStart?.slice(0, 10) || '';
  const deliveryDay = f.deliveryDate || f.deliveryWindowStart?.slice(0, 10) || '';
  const transit = pickupDay && deliveryDay ? dayNumber(deliveryDay) - dayNumber(pickupDay) : null;
  return {
    fields: {
      originCity: f.originCity, originState: f.originState, destCity: f.destCity, destState: f.destState,
      pickupFacility: blank(f.pickupFacility), pickupAddress: blank(f.pickupAddress), deliveryFacility: blank(f.deliveryFacility), deliveryAddress: blank(f.deliveryAddress),
      pickupWindowStart: timeOf(f.pickupWindowStart), pickupWindowEnd: timeOf(f.pickupWindowEnd),
      deliveryWindowStart: timeOf(f.deliveryWindowStart), deliveryWindowEnd: timeOf(f.deliveryWindowEnd),
      transitDays: transit != null && transit >= 0 && transit <= 14 ? transit : null,
      freeTimeHours: blank(f.freeTimeHours), equipment: blank(f.equipment), commodity: blank(f.commodity), weightLbs: blank(f.weightLbs),
      loadedMiles: f.loadedMiles, deadheadMiles: blank(f.deadheadMiles), rateCents: toCents(f.rate) ?? 0,
      detentionRateCents: toCents(f.detentionRate), fuelPricePerGallon: blank(f.fuelPricePerGallon), mpg: blank(f.mpg),
      otherCostsCents: toCents(f.otherCosts), dispatchFeePercent: blank(f.dispatchFeePercent), notes: blank(f.notes),
    },
    carrierId: f.carrierId || null,
    brokerId: f.brokerId || null,
  };
}

/**
 * A template as the `initial` of the load form for pickup day `ymd`: windows become facility-local wall times on that
 * day (an end time earlier than its start runs into the next day), delivery lands transitDays later.
 */
export function templateToInitial(t, ymd) {
  const { pickupWindowStart, pickupWindowEnd, deliveryWindowStart, deliveryWindowEnd, transitDays, ...rest } = t.fields || {};
  const pickupStart = t.pickupTime || pickupWindowStart || null;
  const deliveryDay = transitDays != null ? addDays(ymd, transitDays) : deliveryWindowStart ? ymd : '';
  const at = (day, time) => (day && time ? `${day}T${time}` : null);
  const until = (day, start, end) => (day && end ? `${start && end <= start ? addDays(day, 1) : day}T${end}` : null);
  return {
    ...rest,
    status: 'planned',
    pickupDate: ymd,
    deliveryDate: deliveryDay,
    pickupWindowStart: at(ymd, pickupStart),
    pickupWindowEnd: pickupStart ? until(ymd, pickupStart, pickupWindowEnd) : null,
    deliveryWindowStart: at(deliveryDay, deliveryWindowStart),
    deliveryWindowEnd: deliveryWindowStart ? until(deliveryDay, deliveryWindowStart, deliveryWindowEnd) : null,
    carrierId: t.carrierId || null,
    brokerId: t.brokerId || null,
    carrierLabel: t.carrier?.companyName || '',
  };
}

const laneText = (f = {}) => (f.originCity ? `${f.originCity}, ${f.originState} → ${f.destCity}, ${f.destState}` : '');
const useTemplates = (enabled = true) => useQuery({ queryKey: ['load-templates'], queryFn: () => api.get('/api/load-templates'), enabled });

// ---------------------------------------------------------------------------
// Load form: "Save as template" and "From template"
// ---------------------------------------------------------------------------

/** Save the load form as a template (name only; the schedule is set under Dedicated lanes). */
export function SaveTemplateButton({ form, className }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const save = useApiMutation(() => api.post('/api/load-templates', { name, ...formToTemplate(form) }), {
    invalidate: [['load-templates']],
    onSuccess: () => {
      setOpen(false);
      toast.success(`Template "${name}" saved`, { action: { label: 'Open dedicated lanes', href: '/app/loads?section=lanes' } });
    },
  });
  const start = () => {
    if (!form.originCity?.trim() || !form.originState || !form.destCity?.trim() || !form.destState || !form.rate || !form.loadedMiles) {
      toast.error('Fill in the lane, rate and loaded miles before saving a template');
      return;
    }
    setName(laneText(form).slice(0, 80));
    setOpen(true);
  };
  return (
    <>
      <Button variant="secondary" icon={BookmarkPlus} onClick={start} className={className}>Save as template</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Save as template" size="sm"
        footer={<>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="submit" form="load-template-form" loading={save.isPending}>Save template</Button>
        </>}>
        <form id="load-template-form" onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); save.mutate(); }} className="space-y-3">
          <Field label="Template name" required hint="Keeps the lane, facilities, appointment times, rate, equipment, carrier and broker. Dates, reference and status stay with each load.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
          </Field>
          <p className="text-xs text-muted">To create this load every week, add a schedule under Loads, Dedicated lanes.</p>
        </form>
      </Modal>
    </>
  );
}

/** "From template": pick a template and a pickup date; the form fills with that load. */
export function TemplatePickerButton({ onPick }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const [day, setDay] = useState('');
  const q = useTemplates(open);
  const items = q.data?.items || [];
  useEffect(() => {
    if (!open) return;
    setDay(zonedInput(new Date(), user?.timezone).slice(0, 10));
  }, [open, user?.timezone]);
  useEffect(() => {
    if (open && !id && items.length) setId(items[0].id);
  }, [open, id, items]);
  const chosen = items.find((t) => t.id === id);
  const use = () => {
    if (!chosen || !day) return;
    onPick(templateToInitial(chosen, day), chosen);
    setOpen(false);
  };
  return (
    <>
      <Button size="sm" variant="secondary" icon={CopyPlus} onClick={() => setOpen(true)}>From template</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="New load from template" size="sm"
        footer={<>
          <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={use} disabled={!chosen || !day}>Use template</Button>
        </>}>
        <QueryState query={q}>
          {() => (items.length ? (
            <div className="space-y-3">
              <Field label="Template">
                <Select value={id} onChange={(e) => setId(e.target.value)}>
                  {items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </Select>
              </Field>
              {chosen && <p className="text-xs text-muted">{[laneText(chosen.fields), money(chosen.fields.rateCents, { digits: 0 }), chosen.carrier?.companyName].filter(Boolean).join(' · ')}</p>}
              <Field label="Pickup date" hint="Appointment times from the template are placed on this day, in each facility's time zone.">
                <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
              </Field>
            </div>
          ) : (
            <EmptyState icon={BookmarkPlus} title="No templates yet">Fill in a load and use Save as template to reuse it here.</EmptyState>
          ))}
        </QueryState>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Dedicated lanes (Loads page tab)
// ---------------------------------------------------------------------------

const EDIT_EMPTY = {
  name: '', originCity: '', originState: '', destCity: '', destState: '', pickupFacility: '', deliveryFacility: '', rate: '', loadedMiles: '',
  equipment: '', commodity: '', weightLbs: '', notes: '', carrierId: null, brokerId: null,
  weekdays: [], pickupTime: '', pickupUntil: '', deliveryTime: '', deliveryUntil: '', transitDays: '', leadDays: '7', active: true,
};

function toEditor(t) {
  if (!t?.id) return { ...EDIT_EMPTY, weekdays: [1, 2, 3, 4, 5], pickupTime: '08:00', transitDays: '1' };
  const f = t.fields || {};
  const s = (v) => (v == null ? '' : String(v));
  return {
    ...EDIT_EMPTY,
    name: t.name, originCity: s(f.originCity), originState: s(f.originState), destCity: s(f.destCity), destState: s(f.destState),
    pickupFacility: s(f.pickupFacility), deliveryFacility: s(f.deliveryFacility), rate: fromCents(f.rateCents), loadedMiles: s(f.loadedMiles),
    equipment: s(f.equipment), commodity: s(f.commodity), weightLbs: s(f.weightLbs), notes: s(f.notes), carrierId: t.carrierId, brokerId: t.brokerId,
    weekdays: t.weekdays || [], pickupTime: s(t.pickupTime || f.pickupWindowStart), pickupUntil: s(f.pickupWindowEnd),
    deliveryTime: s(f.deliveryWindowStart), deliveryUntil: s(f.deliveryWindowEnd), transitDays: s(f.transitDays), leadDays: s(t.leadDays ?? 7), active: t.active,
  };
}

/** Editor state -> API body. Fields the editor does not show (fuel, MPG, fee, deadhead…) keep their saved values. */
export function editorToBody(e, existing = null) {
  const { pickupTz: _p, deliveryTz: _d, ...kept } = existing?.fields || {};
  return {
    name: e.name.trim(),
    fields: {
      ...kept,
      originCity: e.originCity, originState: e.originState, destCity: e.destCity, destState: e.destState,
      pickupFacility: blank(e.pickupFacility), deliveryFacility: blank(e.deliveryFacility),
      rateCents: toCents(e.rate) ?? 0, loadedMiles: e.loadedMiles, equipment: blank(e.equipment), commodity: blank(e.commodity), weightLbs: blank(e.weightLbs), notes: blank(e.notes),
      pickupWindowStart: blank(e.pickupTime), pickupWindowEnd: blank(e.pickupUntil), deliveryWindowStart: blank(e.deliveryTime), deliveryWindowEnd: blank(e.deliveryUntil),
      transitDays: blank(e.transitDays),
    },
    carrierId: e.carrierId || null,
    brokerId: e.brokerId || null,
    weekdays: e.weekdays,
    pickupTime: blank(e.pickupTime),
    leadDays: Number(e.leadDays) || 7,
    active: e.active,
  };
}

function WeekdayToggles({ value, onChange }) {
  const toggle = (d) => onChange(value.includes(d) ? value.filter((x) => x !== d) : [...value, d].sort((a, b) => a - b));
  return (
    <div role="group" aria-label="Pickup days" className="flex flex-wrap gap-1">
      {WEEKDAY_SHORT.map((d, i) => (
        <button key={d} type="button" aria-pressed={value.includes(i)} aria-label={WEEKDAY_LONG[i]} onClick={() => toggle(i)}
          className={cx('h-8 w-11 rounded-md border text-[13px] font-medium transition-ui', value.includes(i) ? 'border-brand-600 bg-brand-600 text-white' : 'border-line-strong bg-surface text-fg-2 hover:bg-surface-2')}>
          {d}
        </button>
      ))}
    </div>
  );
}

function LaneEditor({ template, open, onClose }) {
  const toast = useToast();
  const editing = !!template?.id;
  const [e, setE] = useState(EDIT_EMPTY);
  const [pickerKey, setPickerKey] = useState(0);
  useEffect(() => {
    if (open) { setE(toEditor(template)); setPickerKey((k) => k + 1); }
  }, [open, template]);
  const on = (k) => (ev) => setE({ ...e, [k]: ev.target.value });
  const save = useApiMutation((body) => (editing ? api.patch(`/api/load-templates/${template.id}`, body) : api.post('/api/load-templates', body)), {
    invalidate: [['load-templates'], ['loads']],
    onSuccess: (d) => {
      const n = d?.generated || 0;
      toast.success(`${editing ? 'Saved' : 'Dedicated lane added'}${n ? `. ${n} planned load${n === 1 ? '' : 's'} created.` : ''}`);
      onClose();
    },
  });
  const submit = (ev) => { ev.preventDefault(); ev.stopPropagation(); save.mutate(editorToBody(e, template)); };
  const scheduled = e.weekdays.length > 0;
  return (
    <Modal open={open} onClose={onClose} title={editing ? 'Edit template' : 'New dedicated lane'} size="lg"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" form="lane-editor" loading={save.isPending}>{editing ? 'Save changes' : 'Add lane'}</Button>
      </>}>
      <form id="lane-editor" onSubmit={submit} className="space-y-4">
        <Field label="Name" required><Input value={e.name} onChange={on('name')} maxLength={80} required placeholder="Walmart DC, Dallas to Atlanta" /></Field>
        <fieldset className="grid gap-3 sm:grid-cols-4">
          <legend className="mb-1 text-xs font-medium text-muted">Lane</legend>
          <Field label="Origin city" required><Input value={e.originCity} onChange={on('originCity')} required maxLength={100} /></Field>
          <Field label="Origin state" required><Select value={e.originState} onChange={on('originState')} required><option value="">—</option>{US_STATES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
          <Field label="Destination city" required><Input value={e.destCity} onChange={on('destCity')} required maxLength={100} /></Field>
          <Field label="Destination state" required><Select value={e.destState} onChange={on('destState')} required><option value="">—</option>{US_STATES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
          <Field label="Pickup facility" className="sm:col-span-2"><Input value={e.pickupFacility} onChange={on('pickupFacility')} maxLength={120} /></Field>
          <Field label="Delivery facility" className="sm:col-span-2"><Input value={e.deliveryFacility} onChange={on('deliveryFacility')} maxLength={120} /></Field>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Rate ($)" required><Input type="number" min="0" step="0.01" inputMode="decimal" value={e.rate} onChange={on('rate')} required /></Field>
          <Field label="Loaded miles" required><Input type="number" min="1" step="1" inputMode="numeric" value={e.loadedMiles} onChange={on('loadedMiles')} required /></Field>
          <Field label="Equipment"><Select value={e.equipment} onChange={on('equipment')}><option value="">—</option>{EQUIPMENT.map((x) => <option key={x} value={x}>{label(x)}</option>)}</Select></Field>
          <Field label="Commodity"><Input value={e.commodity} onChange={on('commodity')} maxLength={120} /></Field>
          <Field label="Weight (lbs)"><Input type="number" min="0" step="1" value={e.weightLbs} onChange={on('weightLbs')} /></Field>
          <Field label="Broker"><BrokerSelect value={e.brokerId} onChange={(v) => setE((x) => ({ ...x, brokerId: v }))} /></Field>
        </div>
        <Field label="Carrier" hint="Carrier that hauls this lane. Leave empty to assign each load yourself.">
          <CarrierPicker key={pickerKey} value={e.carrierId} initialLabel={template?.carrier?.companyName || ''} onChange={(v) => setE((x) => ({ ...x, carrierId: v }))} />
        </Field>

        <fieldset className="space-y-3 rounded-lg border border-line p-3">
          <legend className="px-1 text-xs font-medium text-muted">Weekly schedule</legend>
          <Field label="Pickup days" hint={scheduled ? 'Days in the pickup facility\'s time zone.' : 'No days picked: this stays a template you fill in by hand.'}>
            {() => <WeekdayToggles value={e.weekdays} onChange={(weekdays) => setE((x) => ({ ...x, weekdays }))} />}
          </Field>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Pickup time" required={scheduled} hint="Facility local time"><Input type="time" value={e.pickupTime} onChange={on('pickupTime')} required={scheduled} /></Field>
            <Field label="Pickup until"><Input type="time" value={e.pickupUntil} onChange={on('pickupUntil')} /></Field>
            <Field label="Delivery time"><Input type="time" value={e.deliveryTime} onChange={on('deliveryTime')} /></Field>
            <Field label="Delivery until"><Input type="time" value={e.deliveryUntil} onChange={on('deliveryUntil')} /></Field>
            <Field label="Transit days" hint="Delivery this many days after pickup"><Input type="number" min="0" max="14" step="1" value={e.transitDays} onChange={on('transitDays')} /></Field>
            <Field label="Create loads ahead (days)" hint="1 to 30"><Input type="number" min="1" max="30" step="1" value={e.leadDays} onChange={on('leadDays')} disabled={!scheduled} /></Field>
            <div className="flex items-end pb-2 sm:col-span-2">
              <Switch checked={e.active} onChange={(active) => setE((x) => ({ ...x, active }))} label={e.active ? 'Active' : 'Paused'} />
            </div>
          </div>
          <p className="text-xs text-muted">Planned loads are created every hour for the days ahead. Changes apply to loads created from now on; loads already created stay as they are.</p>
        </fieldset>
        <Field label="Notes"><Textarea rows={3} value={e.notes} onChange={on('notes')} maxLength={5000} /></Field>
      </form>
    </Modal>
  );
}

/** Templates and recurring dedicated lanes: schedule, next pickup, active switch, edit and delete. */
export default function DedicatedLanes() {
  const toast = useToast();
  const confirm = useConfirm();
  const q = useTemplates();
  const [editing, setEditing] = useState(null);
  const toggle = useApiMutation(({ t, active }) => api.patch(`/api/load-templates/${t.id}`, { active }), {
    invalidate: [['load-templates'], ['loads']],
    onSuccess: (d, { active }) => {
      const n = d?.generated || 0;
      toast.success(active ? `Lane active${n ? `. ${n} planned load${n === 1 ? '' : 's'} created.` : ''}` : 'Lane paused');
    },
  });
  const remove = useApiMutation((t) => api.del(`/api/load-templates/${t.id}`), { success: 'Template deleted', invalidate: [['load-templates']] });
  const onDelete = async (t) => {
    if (await confirm({ title: 'Delete template?', message: `${t.name} will be removed. Loads it already created stay on the board.`, danger: true })) remove.mutate(t);
  };
  const next = (t) => (t.recurring && t.active && t.nextPickupAt ? formatAt(t.nextPickupAt, t.pickupTz) : '—');
  const through = (t) => (t.recurring && t.generatedTo ? formatAt(new Date(new Date(t.generatedTo).getTime() - 1), t.pickupTz).replace(/,.*$/, '') : null);
  const activeSwitch = (t) => (
    <span onClick={(ev) => ev.stopPropagation()}>
      <Switch checked={t.active} disabled={toggle.isPending || !t.recurring} onChange={(active) => toggle.mutate({ t, active })}
        label={<span className="sr-only">{t.active ? `Pause ${t.name}` : `Resume ${t.name}`}</span>} />
    </span>
  );
  const actions = (t) => (
    <span className="flex justify-end">
      <IconButton icon={Pencil} label={`Edit ${t.name}`} onClick={() => setEditing(t)} />
      <IconButton icon={Trash2} label={`Delete ${t.name}`} onClick={() => onDelete(t)} className="hover:text-red-600" />
    </span>
  );
  const schedule = (t) => (
    <span className="text-sm">
      {t.recurring ? <span className="inline-flex items-center gap-1"><Repeat className="size-3.5 text-muted" aria-hidden />{recurrenceSummary(t)}</span> : <Badge>Template only</Badge>}
      {through(t) && <span className="block text-xs text-muted">Loads created through {through(t)}</span>}
    </span>
  );
  return (
    <Card bodyClass="p-0" title="Dedicated lanes and templates" actions={<Button size="sm" icon={Plus} onClick={() => setEditing({})}>New dedicated lane</Button>}>
      <p className="border-b border-line px-4 py-2.5 text-xs text-muted">
        A dedicated lane creates planned loads ahead on the days you pick. Templates without days fill the new load form from New load, From template.
      </p>
      <QueryState query={q}>
        {(data) => (
          <>
            <DataTable rows={data.items}
              empty={<EmptyState icon={Repeat} title="No templates yet" action={<Button icon={Plus} onClick={() => setEditing({})}>New dedicated lane</Button>}>Save a load as a template from the load form, or set up a lane that repeats every week.</EmptyState>}
              mobileRow={(t) => (
                <div className="space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{t.name}</p>
                      <p className="truncate text-xs text-muted">{[laneText(t.fields), money(t.fields.rateCents, { digits: 0 }), t.carrier?.companyName].filter(Boolean).join(' · ')}</p>
                    </div>
                    {t.recurring && activeSwitch(t)}
                  </div>
                  {schedule(t)}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted">Next pickup: {next(t)}</span>
                    {actions(t)}
                  </div>
                </div>
              )}
              columns={[
                { key: 'name', header: 'Template', render: (t) => (
                  <div className="min-w-44">
                    <div className="font-medium">{t.name}</div>
                    <div className="text-xs text-muted">{[laneText(t.fields), t.carrier?.companyName].filter(Boolean).join(' · ')}</div>
                  </div>
                ) },
                { key: 'rate', header: 'Rate', className: 'text-right', render: (t) => (
                  <span className="tabular">{money(t.fields.rateCents, { digits: 0 })}{t.fields.loadedMiles > 0 && <span className="block text-xs text-muted">{dollars(t.fields.rateCents / 100 / t.fields.loadedMiles)}/mi</span>}</span>
                ) },
                { key: 'schedule', header: 'Schedule', render: schedule },
                { key: 'next', header: 'Next pickup', render: (t) => <span className="whitespace-nowrap text-sm">{next(t)}</span> },
                { key: 'active', header: 'Active', render: (t) => (t.recurring ? activeSwitch(t) : <span className="text-muted">—</span>) },
                { key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right', render: actions },
              ]} />
            <p className="border-t border-line px-4 py-2 text-xs text-muted">{data.items.length} of {data.max} templates</p>
          </>
        )}
      </QueryState>
      <LaneEditor open={!!editing} template={editing?.id ? editing : null} onClose={() => setEditing(null)} />
    </Card>
  );
}
