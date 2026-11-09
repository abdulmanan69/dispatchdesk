import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { dollars, label, num, pct, toDateInput, EQUIPMENT, US_STATES, PRESETS } from '../../lib/format.js';
import { Button, ComboInput, Field, Input, Select, Textarea } from '../ui.jsx';
import { Modal } from '../Modal.jsx';
import { calculateLoad, toCents, fromCents, LOAD_STATUSES } from './calc.js';
import { BrokerSelect, CarrierPicker } from './Pickers.jsx';

const EMPTY = {
  referenceNumber: '', originCity: '', originState: '', destCity: '', destState: '', pickupDate: '', deliveryDate: '',
  equipment: '', commodity: '', weightLbs: '', loadedMiles: '', deadheadMiles: '', rate: '', detentionHours: '', detentionRate: '',
  fuelPricePerGallon: '', mpg: '', otherCosts: '', dispatchFeePercent: '', status: 'planned', notes: '', brokerId: null, carrierId: null,
};

// Plain YYYY-MM-DD strings (form state, parser output) are kept as-is to avoid time-zone shifts.
const dateIn = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : toDateInput(v));

/** Map an API load (cents) or parsed fields into form state (dollars strings). */
export function loadToForm(load = {}) {
  return {
    ...EMPTY,
    ...Object.fromEntries(Object.entries(load).filter(([k, v]) => k in EMPTY && v != null).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v])),
    pickupDate: dateIn(load.pickupDate),
    deliveryDate: dateIn(load.deliveryDate),
    rate: fromCents(load.rateCents),
    detentionRate: fromCents(load.detentionRateCents),
    otherCosts: fromCents(load.otherCostsCents),
    brokerId: load.brokerId ?? null,
    carrierId: load.carrierId ?? null,
  };
}

const blankNull = (v) => (v === '' ? null : v);
/** Form state → API body. */
export function formToBody(f) {
  return {
    referenceNumber: blankNull(f.referenceNumber), originCity: f.originCity, originState: f.originState, destCity: f.destCity, destState: f.destState,
    pickupDate: f.pickupDate ? new Date(`${f.pickupDate}T12:00:00`).toISOString() : null,
    deliveryDate: f.deliveryDate ? new Date(`${f.deliveryDate}T12:00:00`).toISOString() : null,
    equipment: blankNull(f.equipment), commodity: blankNull(f.commodity), weightLbs: blankNull(f.weightLbs),
    loadedMiles: f.loadedMiles, deadheadMiles: blankNull(f.deadheadMiles), rateCents: toCents(f.rate) ?? 0,
    detentionHours: blankNull(f.detentionHours), detentionRateCents: toCents(f.detentionRate),
    fuelPricePerGallon: blankNull(f.fuelPricePerGallon), mpg: blankNull(f.mpg), otherCostsCents: toCents(f.otherCosts),
    dispatchFeePercent: blankNull(f.dispatchFeePercent), status: f.status, notes: blankNull(f.notes),
    brokerId: f.brokerId || null, carrierId: f.carrierId || null,
  };
}

export function formCalc(f) {
  return calculateLoad({
    rateCents: toCents(f.rate), loadedMiles: f.loadedMiles, deadheadMiles: f.deadheadMiles, detentionHours: f.detentionHours,
    detentionRateCents: toCents(f.detentionRate), fuelPricePerGallon: f.fuelPricePerGallon, mpg: f.mpg, otherCostsCents: toCents(f.otherCosts),
    dispatchFeePercent: f.dispatchFeePercent,
  });
}

export function CalcSummary({ calc, compact }) {
  const rows = [
    ['Rate per mile', calc.ratePerMile != null ? `${dollars(calc.ratePerMile)}/mi` : '—', true],
    ['All-in RPM (incl. deadhead)', calc.allInRatePerMile != null ? `${dollars(calc.allInRatePerMile)}/mi` : '—'],
    ['Total miles', num(calc.totalMiles)],
    ['Deadhead share', pct(calc.deadheadPercent)],
    ['Detention pay', dollars(calc.detentionPayCents / 100)],
    ['Gross revenue', dollars(calc.grossCents / 100), true],
    ['Fuel cost', calc.fuelIncluded ? `${dollars(calc.fuelCostCents / 100)} (${num(calc.fuelGallons, 1)} gal)` : 'Add MPG + fuel price'],
    ['Other costs', dollars(calc.otherCostsCents / 100)],
    ['Est. profit before dispatch fee', dollars(calc.estProfitCents / 100), true],
    ['Dispatch fee', calc.dispatchFeeCents != null ? dollars(calc.dispatchFeeCents / 100) : '—'],
    ['Carrier net', dollars(calc.carrierNetCents / 100), true],
    ['Profit per mile', calc.profitPerMile != null ? `${dollars(calc.profitPerMile)}/mi` : '—'],
  ];
  return (
    <dl className={compact ? 'grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm' : 'divide-y divide-line text-sm'}>
      {rows.map(([k, v, strong]) => (
        <div key={k} className={compact ? '' : 'flex items-center justify-between gap-3 py-2'}>
          <dt className="text-muted">{k}</dt>
          <dd className={`tabular ${strong ? 'font-medium' : ''} ${compact ? '' : 'text-right'}`}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function LoadFields({ form, set }) {
  const f = form;
  const on = (k) => (e) => set({ ...f, [k]: e.target.value });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <fieldset className="grid gap-3 sm:col-span-2 sm:grid-cols-4">
        <legend className="mb-1 text-xs font-medium text-muted sm:col-span-4">Lane</legend>
        <Field label="Origin city" required><Input value={f.originCity} onChange={on('originCity')} required maxLength={100} /></Field>
        <Field label="Origin state" required>
          <Select value={f.originState} onChange={on('originState')} required><option value="">—</option>{US_STATES.map((s) => <option key={s}>{s}</option>)}</Select>
        </Field>
        <Field label="Destination city" required><Input value={f.destCity} onChange={on('destCity')} required maxLength={100} /></Field>
        <Field label="Destination state" required>
          <Select value={f.destState} onChange={on('destState')} required><option value="">—</option>{US_STATES.map((s) => <option key={s}>{s}</option>)}</Select>
        </Field>
      </fieldset>
      <Field label="Pickup date"><Input type="date" value={f.pickupDate} onChange={on('pickupDate')} /></Field>
      <Field label="Delivery date"><Input type="date" value={f.deliveryDate} min={f.pickupDate || undefined} onChange={on('deliveryDate')} /></Field>
      <Field label="Total rate ($)" required><Input type="number" min="0" step="0.01" inputMode="decimal" value={f.rate} onChange={on('rate')} required /></Field>
      <Field label="Loaded miles" required><Input type="number" min="1" step="1" inputMode="numeric" value={f.loadedMiles} onChange={on('loadedMiles')} required /></Field>
      <Field label="Deadhead miles"><Input type="number" min="0" step="1" value={f.deadheadMiles} onChange={on('deadheadMiles')} /></Field>
      <Field label="Equipment">
        <Select value={f.equipment || ''} onChange={on('equipment')}><option value="">—</option>{EQUIPMENT.map((e) => <option key={e} value={e}>{label(e)}</option>)}</Select>
      </Field>
      <Field label="Commodity"><ComboInput options={PRESETS.commodity} placeholder="Pick or type" value={f.commodity} onChange={on('commodity')} maxLength={120} /></Field>
      <Field label="Weight (lbs)"><Input type="number" min="0" step="1" value={f.weightLbs} onChange={on('weightLbs')} /></Field>
      <Field label="Detention hours"><Input type="number" min="0" step="0.25" value={f.detentionHours} onChange={on('detentionHours')} /></Field>
      <Field label="Detention rate ($/hr)"><ComboInput options={PRESETS.detentionRate} type="number" min="0" step="0.01" value={f.detentionRate} onChange={on('detentionRate')} /></Field>
      <Field label="Fuel price ($/gal)" hint="Enter today's diesel price you pay — not filled in automatically."><Input type="number" min="0" step="0.001" value={f.fuelPricePerGallon} onChange={on('fuelPricePerGallon')} /></Field>
      <Field label="Truck MPG"><ComboInput options={PRESETS.mpg} type="number" min="1" step="0.1" value={f.mpg} onChange={on('mpg')} /></Field>
      <Field label="Other costs ($)" hint="Tolls, lumper, permits…"><Input type="number" min="0" step="0.01" value={f.otherCosts} onChange={on('otherCosts')} /></Field>
      <Field label="Dispatch fee (%)"><ComboInput options={PRESETS.feePercent} type="number" min="0" max="100" step="0.1" value={f.dispatchFeePercent} onChange={on('dispatchFeePercent')} /></Field>
    </div>
  );
}

/** Create / edit a load in a modal. `initial` may be an API load or parsed fields. */
export default function LoadFormModal({ open, onClose, load, initial, onSaved }) {
  const editing = !!load?.id;
  const [form, setForm] = useState(EMPTY);
  useEffect(() => { if (open) setForm(loadToForm(load || initial || {})); }, [open, load, initial]);
  const calc = useMemo(() => formCalc(form), [form]);
  const save = useApiMutation(
    (body) => (editing ? api.patch(`/api/loads/${load.id}`, body) : api.post('/api/loads', body)),
    { success: editing ? 'Load updated' : 'Load saved', invalidate: [['loads'], ['broker'], ['customer'], ['brokers']], onSuccess: (data) => { onSaved?.(data.load); onClose(); } },
  );
  const submit = (e) => { e.preventDefault(); save.mutate(formToBody(form)); };
  return (
    <Modal open={open} onClose={onClose} title={editing ? 'Edit load' : 'New load'} size="xl"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" form="load-form" loading={save.isPending}>{editing ? 'Save changes' : 'Save load'}</Button>
      </>}>
      <form id="load-form" onSubmit={submit} className="grid gap-5 lg:grid-cols-[1fr_280px]">
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Reference #"><Input value={form.referenceNumber} onChange={(e) => setForm({ ...form, referenceNumber: e.target.value })} maxLength={60} /></Field>
            <Field label="Status">
              <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>{LOAD_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</Select>
            </Field>
            <Field label="Broker"><BrokerSelect value={form.brokerId} onChange={(v) => setForm({ ...form, brokerId: v })} /></Field>
          </div>
          <Field label="Assigned carrier" hint="Carrier hauling this load (usually one of your customers).">
            <CarrierPicker value={form.carrierId} initialLabel={load?.carrier?.companyName || initial?.carrierLabel || ''} onChange={(v) => setForm((f) => ({ ...f, carrierId: v }))} />
          </Field>
          <LoadFields form={form} set={setForm} />
          <Field label="Notes"><Textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={5000} /></Field>
        </div>
        <aside className="h-fit rounded-md border border-line bg-surface-2/40 p-3 lg:sticky lg:top-0">
          <h3 className="mb-1 text-sm font-medium">Load economics</h3>
          <CalcSummary calc={calc} />
        </aside>
      </form>
    </Modal>
  );
}
