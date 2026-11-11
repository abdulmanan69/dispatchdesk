import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, Plus } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation, errorToast } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { dollars, label, num, pct, toDateInput, EQUIPMENT, US_STATES, PRESETS } from '../../lib/format.js';
import { Button, Checkbox, ComboInput, Field, Input, Select, Textarea } from '../ui.jsx';
import { Modal, useConfirm } from '../Modal.jsx';
import { useToast } from '../Toast.jsx';
import { calculateLoad, toCents, fromCents, LOAD_STATUSES } from './calc.js';
import { BrokerSelect, CarrierPicker } from './Pickers.jsx';
import FitCard, { useCarrierRules } from './FitCard.jsx';
import LegalEtaCard from './LegalEtaCard.jsx';
import RateConImport from './RateConImport.jsx';
import { RateConVetting } from './BrokerVetting.jsx';
import { formatWindow, zonedInput, zoneAbbr } from './zoned.js';
import { diesel, geocode, route } from '../fleet/fleetApi.js';

const EMPTY = {
  referenceNumber: '', originCity: '', originState: '', destCity: '', destState: '', pickupDate: '', deliveryDate: '',
  pickupFacility: '', pickupAddress: '', pickupWindowStart: '', pickupWindowEnd: '', pickupTz: '',
  deliveryFacility: '', deliveryAddress: '', deliveryWindowStart: '', deliveryWindowEnd: '', deliveryTz: '', freeTimeHours: '',
  equipment: '', commodity: '', weightLbs: '', loadedMiles: '', deadheadMiles: '', rate: '', detentionHours: '', detentionRate: '',
  fuelPricePerGallon: '', mpg: '', otherCosts: '', dispatchFeePercent: '', status: 'planned', notes: '', brokerId: null, carrierId: null,
};

// Plain YYYY-MM-DD strings (form state, parser output) are kept as-is to avoid time-zone shifts.
const dateIn = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : toDateInput(v));

/** Map an API load (cents, UTC appointment times) or parsed fields (facility-local times) into form state. */
export function loadToForm(load = {}) {
  return {
    ...EMPTY,
    ...Object.fromEntries(Object.entries(load).filter(([k, v]) => k in EMPTY && v != null).map(([k, v]) => [k, typeof v === 'number' ? String(v) : v])),
    pickupDate: dateIn(load.pickupDate),
    deliveryDate: dateIn(load.deliveryDate),
    pickupWindowStart: zonedInput(load.pickupWindowStart, load.pickupTz),
    pickupWindowEnd: zonedInput(load.pickupWindowEnd, load.pickupTz),
    deliveryWindowStart: zonedInput(load.deliveryWindowStart, load.deliveryTz),
    deliveryWindowEnd: zonedInput(load.deliveryWindowEnd, load.deliveryTz),
    rate: fromCents(load.rateCents),
    detentionRate: fromCents(load.detentionRateCents),
    otherCosts: fromCents(load.otherCostsCents),
    brokerId: load.brokerId ?? null,
    carrierId: load.carrierId ?? null,
  };
}

const blankNull = (v) => (v === '' ? null : v);
const noonIso = (ymd) => (ymd ? new Date(`${ymd}T12:00:00`).toISOString() : null);
/** Form state → API body. Appointment times go as facility-local wall time; the server applies the facility zone. */
export function formToBody(f) {
  const pickupDay = f.pickupDate || (f.pickupWindowStart ? f.pickupWindowStart.slice(0, 10) : '');
  const deliveryDay = f.deliveryDate || (f.deliveryWindowStart ? f.deliveryWindowStart.slice(0, 10) : '');
  return {
    referenceNumber: blankNull(f.referenceNumber), originCity: f.originCity, originState: f.originState, destCity: f.destCity, destState: f.destState,
    pickupDate: noonIso(pickupDay), deliveryDate: noonIso(deliveryDay),
    pickupFacility: blankNull(f.pickupFacility), pickupAddress: blankNull(f.pickupAddress),
    pickupWindowStart: blankNull(f.pickupWindowStart), pickupWindowEnd: blankNull(f.pickupWindowEnd),
    deliveryFacility: blankNull(f.deliveryFacility), deliveryAddress: blankNull(f.deliveryAddress),
    deliveryWindowStart: blankNull(f.deliveryWindowStart), deliveryWindowEnd: blankNull(f.deliveryWindowEnd),
    freeTimeHours: blankNull(f.freeTimeHours),
    equipment: blankNull(f.equipment), commodity: blankNull(f.commodity), weightLbs: blankNull(f.weightLbs),
    loadedMiles: f.loadedMiles, deadheadMiles: blankNull(f.deadheadMiles), rateCents: toCents(f.rate) ?? 0,
    detentionHours: blankNull(f.detentionHours), detentionRateCents: toCents(f.detentionRate),
    fuelPricePerGallon: blankNull(f.fuelPricePerGallon), mpg: blankNull(f.mpg), otherCostsCents: toCents(f.otherCosts),
    dispatchFeePercent: blankNull(f.dispatchFeePercent), status: f.status, notes: blankNull(f.notes),
    brokerId: f.brokerId || null, carrierId: f.carrierId || null,
  };
}

/**
 * The form as the legal ETA card's input, or null until origin, destination and a delivery appointment are filled.
 * Appointment times stay facility-local wall times (the server applies each facility's zone). Without a pickup time
 * the check starts at 8:00 on the pickup date (said in its assumptions). Deadhead from the truck's last position is
 * included only for a load not yet under way whose truck is available and whose pickup time is set.
 */
export function formToEtaInput(f, { loadId = null, truck = null } = {}) {
  if (!f.originCity.trim() || !f.originState || !f.destCity.trim() || !f.destState || !f.deliveryWindowStart) return null;
  const deadhead = truck?.lat != null && truck.status === 'available' && f.pickupWindowStart && ['planned', 'booked'].includes(f.status)
    ? { from: { lat: truck.lat, lng: truck.lng } } : null;
  return {
    loadId, carrierId: f.carrierId || null,
    origin: { city: f.originCity.trim(), state: f.originState }, dest: { city: f.destCity.trim(), state: f.destState },
    pickupWindowStart: f.pickupWindowStart || null, pickupWindowEnd: f.pickupWindowEnd || null,
    deliveryWindowStart: f.deliveryWindowStart, deliveryWindowEnd: f.deliveryWindowEnd || null,
    startAt: !f.pickupWindowStart && f.pickupDate ? `${f.pickupDate}T08:00` : null,
    deadhead,
  };
}

/** The form as a load in API units, for the client-side load check. */
export function formToFitLoad(f) {
  return {
    rateCents: toCents(f.rate), loadedMiles: f.loadedMiles, deadheadMiles: f.deadheadMiles, weightLbs: f.weightLbs, equipment: f.equipment,
    originState: f.originState, destState: f.destState, pickupDate: f.pickupDate || f.pickupWindowStart?.slice(0, 10) || null,
    deliveryDate: f.deliveryDate || f.deliveryWindowStart?.slice(0, 10) || null, commodity: f.commodity, notes: f.notes,
  };
}

export function formCalc(f) {
  return calculateLoad({
    rateCents: toCents(f.rate), loadedMiles: f.loadedMiles, deadheadMiles: f.deadheadMiles, detentionHours: f.detentionHours,
    detentionRateCents: toCents(f.detentionRate), fuelPricePerGallon: f.fuelPricePerGallon, mpg: f.mpg, otherCostsCents: toCents(f.otherCosts),
    dispatchFeePercent: f.dispatchFeePercent,
  });
}

/** Rate-con details the load columns do not hold (references, FCFS, requirements, terms), as a notes block. */
export function rateConNote(fields = {}) {
  const lines = [];
  for (const key of ['pickup', 'delivery']) {
    const name = key === 'pickup' ? 'Pickup' : 'Delivery';
    const refs = (fields[`${key}Refs`] || []).map((r) => `${r.kind} ${r.value}`).join(', ');
    if (refs) lines.push(`${name} refs: ${refs}`);
    if (fields[`${key}Fcfs`]) lines.push(`${name}: first come, first served`);
  }
  if (fields.requirements?.length) lines.push(`Requirements: ${fields.requirements.join(', ')}`);
  if (fields.trailerLengthFt) lines.push(`Trailer: ${fields.trailerLengthFt} ft`);
  if (fields.detentionRateCents != null) lines.push(`Detention: $${(fields.detentionRateCents / 100).toFixed(2)}/h${fields.freeTimeHours != null ? ` after ${fields.freeTimeHours} h free` : ''}`);
  if (fields.tonuCents != null) lines.push(`TONU: $${(fields.tonuCents / 100).toFixed(2)}`);
  if (fields.layoverCents != null) lines.push(`Layover: $${(fields.layoverCents / 100).toFixed(2)}`);
  if (fields.lumper) lines.push(fields.lumper);
  if (fields.paymentTerms) lines.push(`Payment terms: ${fields.paymentTerms}`);
  return lines.length ? `From the rate con:\n${lines.join('\n')}` : '';
}

/** Form values from a parse result (only the fields it found), keeping what the user already typed for costs. */
export function parsedToForm(fields = {}) {
  const next = loadToForm(fields);
  const out = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== '' && v != null && k !== 'status' && k !== 'notes'));
  if (fields.detentionRateCents != null) out.detentionRate = fromCents(fields.detentionRateCents);
  if (fields.freeTimeHours != null) out.freeTimeHours = String(fields.freeTimeHours);
  return out;
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

/** Facility zone for a city/state (server lookup, split states included), for labelling appointment inputs. */
function useFacilityZone(city, state, known) {
  // Looked up once the city stops changing (not on every keystroke); the signal drops a lookup that is out of date.
  const norm = (city || '').trim().toLowerCase();
  const [term, setTerm] = useState(norm);
  useEffect(() => {
    const t = setTimeout(() => setTerm(norm), 300);
    return () => clearTimeout(t);
  }, [norm]);
  const q = useQuery({
    queryKey: ['facility-tz', term, state],
    queryFn: ({ signal }) => api.get('/api/loads/facility-tz', { city: term || undefined, state }, { signal }),
    enabled: !!state && /^[A-Z]{2}$/.test(state),
    staleTime: Infinity,
  });
  return q.data?.timezone || known || null;
}

function StopFields({ kind, form, set }) {
  const { user } = useAuth();
  const f = form;
  const p = kind === 'pickup' ? 'pickup' : 'delivery';
  const city = kind === 'pickup' ? f.originCity : f.destCity;
  const st = kind === 'pickup' ? f.originState : f.destState;
  const zone = useFacilityZone(city, st, f[`${p}Tz`]);
  const on = (k) => (e) => set({ ...f, [k]: e.target.value });
  const abbr = zone ? zoneAbbr(zone) : '';
  const preview = f[`${p}WindowStart`] ? formatWindow(f[`${p}WindowStart`], f[`${p}WindowEnd`], zone, user?.timezone) : '';
  return (
    <fieldset className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-2">
      <legend className="px-1 text-xs font-medium text-muted">{kind === 'pickup' ? 'Pickup' : 'Delivery'} facility</legend>
      <Field label="Facility name"><Input value={f[`${p}Facility`]} onChange={on(`${p}Facility`)} maxLength={120} /></Field>
      <Field label="Address"><Input value={f[`${p}Address`]} onChange={on(`${p}Address`)} maxLength={200} autoComplete="off" /></Field>
      <Field label={`Appointment from${abbr ? ` (${abbr})` : ''}`} hint={zone ? 'Facility local time' : 'Facility local time; set the state to see the zone'}>
        <Input type="datetime-local" value={f[`${p}WindowStart`]} onChange={on(`${p}WindowStart`)} />
      </Field>
      <Field label={`Until${abbr ? ` (${abbr})` : ''}`} hint={preview || undefined}>
        <Input type="datetime-local" value={f[`${p}WindowEnd`]} min={f[`${p}WindowStart`] || undefined} onChange={on(`${p}WindowEnd`)} />
      </Field>
    </fieldset>
  );
}

/**
 * Fill what the app already knows on a new load: road miles between the two cities (routing, or a labelled
 * straight-line estimate) while the miles field is empty, and the EIA weekly diesel price for the origin's region
 * while the fuel field is empty. Both stay editable and say where they came from.
 */
function useLoadAssist(f, set, enabled) {
  const [milesNote, setMilesNote] = useState(null);
  const [deadheadNote, setDeadheadNote] = useState(null);
  const truck = useCarrierRules(enabled ? f.carrierId : null).data?.carrier?.truck;
  // Deadhead from the truck's last known position to the pickup city, while the deadhead field is empty.
  const dhReady = enabled && truck && f.deadheadMiles === '' && f.originCity.trim() && f.originState;
  useEffect(() => {
    if (!dhReady) return undefined;
    let cancelled = false;
    const origin = [f.originCity, f.originState].join('|');
    const t = setTimeout(async () => {
      try {
        const g = await geocode(`${f.originCity}, ${f.originState}`);
        const to = g?.items?.[0];
        if (cancelled || !to?.lat) return;
        const r = await route({ lat: truck.lat, lng: truck.lng }, to);
        if (cancelled || r?.miles == null) return;
        set((cur) => (cur.deadheadMiles === '' && [cur.originCity, cur.originState].join('|') === origin ? { ...cur, deadheadMiles: String(Math.round(r.miles)) } : cur));
        setDeadheadNote(`From the truck’s last position${truck.city ? ` near ${truck.city}, ${truck.state}` : ''}${r.estimate ? ' (straight-line estimate)' : ''}`);
      } catch { /* the user types the deadhead */ }
    }, 900);
    return () => { cancelled = true; clearTimeout(t); };
  }, [dhReady, truck?.lat, truck?.lng, f.originCity, f.originState, set]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = enabled && f.loadedMiles === '' && f.originCity.trim() && f.originState && f.destCity.trim() && f.destState;
  useEffect(() => {
    if (!ready) return undefined;
    let cancelled = false;
    const pair = [f.originCity, f.originState, f.destCity, f.destState].join('|');
    const t = setTimeout(async () => {
      try {
        const [a, b] = await Promise.all([geocode(`${f.originCity}, ${f.originState}`), geocode(`${f.destCity}, ${f.destState}`)]);
        const from = a?.items?.[0];
        const to = b?.items?.[0];
        if (cancelled || !from?.lat || !to?.lat) return;
        const r = await route(from, to);
        if (cancelled || !r?.miles) return;
        set((cur) => (cur.loadedMiles === '' && [cur.originCity, cur.originState, cur.destCity, cur.destState].join('|') === pair ? { ...cur, loadedMiles: String(Math.round(r.miles)) } : cur));
        setMilesNote(r.estimate ? 'Straight-line estimate (routing unavailable): check it against the rate con' : 'Road miles from routing: check them against the rate con');
      } catch { /* the user types the miles */ }
    }, 800);
    return () => { cancelled = true; clearTimeout(t); };
  }, [ready, f.originCity, f.originState, f.destCity, f.destState, set]); // eslint-disable-line react-hooks/exhaustive-deps
  const dieselQ = useQuery({ queryKey: ['diesel', f.originState], queryFn: () => diesel(f.originState), enabled: enabled && /^[A-Z]{2}$/.test(f.originState || ''), staleTime: 60 * 60_000 });
  const d = dieselQ.data;
  useEffect(() => {
    if (enabled && d?.configured && d.price) set((cur) => (cur.fuelPricePerGallon === '' ? { ...cur, fuelPricePerGallon: String(d.price) } : cur));
  }, [d, enabled, set]);
  const fuelNote = d?.configured && d.price && String(d.price) === String(f.fuelPricePerGallon)
    ? `EIA weekly average for ${d.regionLabel || 'your region'}${d.period ? `, ${d.period}` : ''}. Change it to what the truck pays.`
    : 'Diesel price the truck pays per gallon.';
  return { milesNote: f.loadedMiles !== '' ? milesNote : null, fuelNote, deadheadNote: f.deadheadMiles !== '' ? deadheadNote : null };
}

export function LoadFields({ form, set, stops = false, assist = true }) {
  const f = form;
  const on = (k) => (e) => set({ ...f, [k]: e.target.value });
  const { milesNote, fuelNote, deadheadNote } = useLoadAssist(f, set, assist);
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
      {stops && (
        <div className="grid gap-3 sm:col-span-2">
          <StopFields kind="pickup" form={f} set={set} />
          <StopFields kind="delivery" form={f} set={set} />
        </div>
      )}
      <Field label="Total rate ($)" required><Input type="number" min="0" step="0.01" inputMode="decimal" value={f.rate} onChange={on('rate')} required /></Field>
      <Field label="Loaded miles" required hint={milesNote || undefined}><Input type="number" min="1" step="1" inputMode="numeric" value={f.loadedMiles} onChange={on('loadedMiles')} required /></Field>
      <Field label="Deadhead miles" hint={deadheadNote || undefined}><Input type="number" min="0" step="1" value={f.deadheadMiles} onChange={on('deadheadMiles')} /></Field>
      <Field label="Equipment">
        <Select value={f.equipment || ''} onChange={on('equipment')}><option value="">—</option>{EQUIPMENT.map((e) => <option key={e} value={e}>{label(e)}</option>)}</Select>
      </Field>
      <Field label="Commodity"><ComboInput options={PRESETS.commodity} placeholder="Pick or type" value={f.commodity} onChange={on('commodity')} maxLength={120} /></Field>
      <Field label="Weight (lbs)"><Input type="number" min="0" step="1" value={f.weightLbs} onChange={on('weightLbs')} /></Field>
      <Field label="Detention hours"><Input type="number" min="0" step="0.25" value={f.detentionHours} onChange={on('detentionHours')} /></Field>
      <Field label="Detention rate ($/hr)"><ComboInput options={PRESETS.detentionRate} type="number" min="0" step="0.01" value={f.detentionRate} onChange={on('detentionRate')} /></Field>
      {stops && <Field label="Free time before detention (hours)" hint="From the rate con; 2 hours when blank"><Input type="number" min="0" max="48" step="0.5" value={f.freeTimeHours} onChange={on('freeTimeHours')} /></Field>}
      <Field label="Fuel price ($/gal)" hint={fuelNote}><Input type="number" min="0" step="0.001" value={f.fuelPricePerGallon} onChange={on('fuelPricePerGallon')} /></Field>
      <Field label="Truck MPG"><ComboInput options={PRESETS.mpg} type="number" min="1" step="0.1" value={f.mpg} onChange={on('mpg')} /></Field>
      <Field label="Other costs ($)" hint="Tolls, lumper, permits…"><Input type="number" min="0" step="0.01" value={f.otherCosts} onChange={on('otherCosts')} /></Field>
      <Field label="Dispatch fee (%)"><ComboInput options={PRESETS.feePercent} type="number" min="0" max="100" step="0.1" value={f.dispatchFeePercent} onChange={on('dispatchFeePercent')} /></Field>
    </div>
  );
}

/** The parse result's broker: match it by MC, or offer to create it from the rate con. */
function ParsedBroker({ parsed, form, setForm }) {
  const qc = useQueryClient();
  const f = parsed?.fields || {};
  const match = parsed?.broker?.match;
  const create = useApiMutation(() => api.post('/api/brokers', {
    companyName: f.brokerName || `Broker MC ${f.brokerMc}`, mcNumber: f.brokerMc || null, phone: f.brokerPhone || null, email: f.brokerEmail || null,
  }), {
    success: 'Broker added', invalidate: [['brokers']],
    onSuccess: (d) => { qc.invalidateQueries({ queryKey: ['brokers', 'options'] }); setForm((x) => ({ ...x, brokerId: d.broker.id })); },
  });
  if (!parsed || (!f.brokerMc && !f.brokerName)) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted">
        Rate con broker: {[f.brokerName, f.brokerMc && `MC ${f.brokerMc}`, f.brokerPhone, f.brokerEmail].filter(Boolean).join(' · ')}
      </p>
      {!match && !form.brokerId && (
        <Button size="sm" variant="secondary" icon={Plus} loading={create.isPending} onClick={() => create.mutate()}>Add this broker</Button>
      )}
      {f.brokerMc && <RateConVetting mc={f.brokerMc} phone={f.brokerPhone} email={f.brokerEmail} brokerId={match?.id || form.brokerId || undefined} initial={parsed.vetting} />}
    </div>
  );
}

/** Create / edit a load in a modal. `initial` may be an API load or parsed fields; `importOpen` starts with the rate-con import. */
export default function LoadFormModal({ open, onClose, load, initial, onSaved, importOpen = false }) {
  const editing = !!load?.id;
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [form, setForm] = useState(EMPTY);
  const [parsed, setParsed] = useState(null);
  const [rcFile, setRcFile] = useState(null);
  const [attach, setAttach] = useState(false);
  const [showImport, setShowImport] = useState(importOpen);
  // Fill the form once per opening (and when a different load is opened). A refetch of the same load while the
  // form is open (acknowledging warnings, a driver check-in, window focus) must not wipe what the user typed.
  const filledFor = useRef(null);
  useEffect(() => {
    if (!open) { filledFor.current = null; return; }
    const key = load?.id || 'new';
    if (filledFor.current === key) return;
    filledFor.current = key;
    setForm(loadToForm(load || initial || {}));
    setParsed(null);
    setRcFile(null);
    setAttach(false);
    setShowImport(importOpen && !load?.id);
  }, [open, load, initial, importOpen]);
  const calc = useMemo(() => formCalc(form), [form]);
  const fitLoad = useMemo(() => formToFitLoad(form), [form]);
  const rules = useCarrierRules(form.carrierId);
  const truck = rules.data?.carrier?.truck;
  const etaInput = useMemo(() => formToEtaInput(form, { loadId: editing ? load.id : null, truck }), [form, editing, load?.id, truck]);

  // Picking a customer carrier fills its dispatch fee when the field is empty.
  useEffect(() => {
    const fee = rules.data?.customer?.dispatchFeePercent;
    if (fee != null && form.dispatchFeePercent === '') setForm((f) => (f.dispatchFeePercent === '' ? { ...f, dispatchFeePercent: String(fee) } : f));
  }, [rules.data, form.dispatchFeePercent]);

  const onParsed = ({ parsed: res, file }) => {
    setParsed(res);
    setRcFile(file || null);
    const note = rateConNote(res.fields);
    setForm((f) => ({
      ...f,
      ...parsedToForm(res.fields),
      brokerId: f.brokerId || res.broker?.match?.id || null,
      notes: note && !String(f.notes || '').includes('From the rate con:') ? [f.notes, note].filter(Boolean).join('\n\n') : f.notes,
    }));
    if (res.found.length) toast.success(`Filled ${res.found.length} field${res.found.length === 1 ? '' : 's'} from the rate con. Check them before saving.`);
    else toast.info('Nothing recognized. Fill the form by hand.');
  };

  const uploadRateCon = async (loadId) => {
    const fd = new FormData();
    fd.append('loadId', loadId);
    fd.append('type', 'rate_confirmation');
    fd.append('file', rcFile, rcFile.name);
    await api.upload('/api/documents', fd);
  };

  const save = useApiMutation(
    async ({ body, force }) => {
      try {
        return await (editing ? api.patch(`/api/loads/${load.id}`, { ...body, ...(force ? { force: true } : {}) }) : api.post('/api/loads', body));
      } catch (err) {
        if (err.status === 409 && err.details?.code === 'CONFIRM_STATUS' && await confirm({ title: 'Change status?', message: err.message, confirmLabel: 'Change status' })) {
          return api.patch(`/api/loads/${load.id}`, { ...body, force: true });
        }
        throw err;
      }
    },
    {
      invalidate: [['loads'], ['broker'], ['customer'], ['brokers'], ['load']],
      onSuccess: async (data) => {
        let attached = false;
        if (rcFile && attach && data?.load?.id) {
          try { await uploadRateCon(data.load.id); attached = true; qc.invalidateQueries({ queryKey: ['documents'] }); } catch (err) { errorToast(toast, err); }
        }
        toast.success(`${editing ? 'Load updated' : 'Load saved'}${attached ? ' with the rate con attached' : ''}`);
        if (data?.load?.fit?.warnings?.length) toast.info(`${data.load.fit.warnings.length} carrier-rules warning${data.load.fit.warnings.length === 1 ? '' : 's'} saved with the load. They never block booking.`);
        if (data?.paperwork?.missing?.includes('pod')) toast.info('No POD on file yet. Upload it from the load’s documents.');
        onSaved?.(data.load);
        onClose();
      },
    },
  );
  const submit = (e) => { e.preventDefault(); save.mutate({ body: formToBody(form) }); };

  return (
    <Modal open={open} onClose={onClose} title={editing ? 'Edit load' : 'New load'} size="xl"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" form="load-form" loading={save.isPending}>{editing ? 'Save changes' : 'Save load'}</Button>
      </>}>
      <form id="load-form" onSubmit={submit} className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <div className="min-w-0 space-y-3">
          {showImport ? (
            <RateConImport onParsed={onParsed} />
          ) : (
            <Button size="sm" variant="secondary" icon={FileUp} onClick={() => setShowImport(true)}>Import rate con</Button>
          )}
          {rcFile && (
            <Checkbox checked={attach} onChange={(e) => setAttach(e.target.checked)} label={`Attach ${rcFile.name} to this load as its rate confirmation`} />
          )}
          <ParsedBroker parsed={parsed} form={form} setForm={setForm} />
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
          <LoadFields form={form} set={setForm} stops assist={!editing} />
          <Field label="Notes"><Textarea rows={4} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={5000} /></Field>
        </div>
        <aside className="h-fit space-y-4 lg:sticky lg:top-0">
          <div className="rounded-md border border-line bg-surface-2/40 p-3">
            <FitCard load={fitLoad} carrierId={form.carrierId} loadId={editing ? load.id : undefined} stored={editing ? load.fit : undefined} />
          </div>
          {etaInput && (
            <div className="rounded-md border border-line bg-surface-2/40 p-3">
              <LegalEtaCard input={etaInput} />
            </div>
          )}
          <div className="rounded-md border border-line bg-surface-2/40 p-3">
            <h3 className="mb-1 text-sm font-medium">Load economics</h3>
            <CalcSummary calc={calc} />
          </div>
        </aside>
      </form>
    </Modal>
  );
}
