import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api.js';
import { EQUIPMENT, US_STATES, label, num } from '../../lib/format.js';
import { Button, Field, Input, Select } from '../ui.jsx';
import { BrokerSelect, CarrierPicker } from '../dispatch/Pickers.jsx';
import { Choice, MODE_OPTIONS, MoneyInput, NEVER_ALONE, fromCents, laneText, toCents, useNegotiationAction, usd } from './shared.jsx';

const EMPTY_LANE = { originCity: '', originState: '', destCity: '', destState: '', miles: '', deadheadMiles: '', pickupDate: '', equipment: '', reference: '' };
const TARGET_BASIS = { offer_plus_10: 'the offer plus 10%', floor: 'your walk-away rate' };
const intOrUndef = (v) => (String(v).trim() === '' || Number.isNaN(Number(v)) ? undefined : Math.round(Number(v)));

/** Walk-away hint: where the default comes from, in plain words. */
function floorHint(d, { carrierId, miles }) {
  if (!carrierId) return 'Pick the carrier to use its rate rules, or enter the lowest rate you would take.';
  if (!d) return 'Checking the carrier’s rate rules…';
  if (d.walkAwayCents != null) {
    const how = d.walkAwayBasis === 'min_rpm' ? `its minimum rate per mile × ${num(miles)} loaded mi` : 'its cost per mile, deadhead included';
    return `From carrier rules: ${usd(d.walkAwayCents)} (${how}). Leave blank to use it.`;
  }
  if (!d.rulesSet) return 'This carrier has no rate rules. Enter the lowest rate you would take.';
  return 'Add the loaded miles to work it out from the carrier rules, or enter it.';
}

function targetHint(d) {
  if (!d || d.targetCents == null) return 'What you will ask for. Never below the walk-away rate.';
  const basis = d.targetBasis === 'lane_average'
    ? `your own average on this lane over ${num(d.laneSampleSize)} load${d.laneSampleSize === 1 ? '' : 's'}, not a market rate`
    : TARGET_BASIS[d.targetBasis] || 'your numbers';
  return `Suggested ${usd(d.targetCents)} (${basis}). Leave blank to use it.`;
}

/**
 * Start a negotiation: from a load (lane, broker, carrier and posted rate come from it) or from a broker page
 * (the lane is typed here). Blank target and walk-away use the server's defaults shown in the hints.
 */
export default function StartForm({ load = null, broker = null, onStarted, onCancel }) {
  const fixedBroker = load?.broker || broker || null;
  const [brokerId, setBrokerId] = useState(fixedBroker?.id || null);
  const [carrierId, setCarrierId] = useState(load?.carrier?.id || null);
  const [lane, setLane] = useState(EMPTY_LANE);
  const [offer, setOffer] = useState(load?.rateCents > 0 ? fromCents(load.rateCents) : '');
  const [target, setTarget] = useState('');
  const [floor, setFloor] = useState('');
  const [mode, setMode] = useState('approve');
  const [maxRounds, setMaxRounds] = useState('3');
  const setL = (k) => (e) => setLane((l) => ({ ...l, [k]: e.target.value }));

  const miles = load ? load.loadedMiles : intOrUndef(lane.miles);
  const params = {
    loadId: load?.id, carrierId: carrierId || undefined, offerCents: toCents(offer) ?? undefined,
    ...(load ? {} : { originState: lane.originState || undefined, destState: lane.destState || undefined, miles: intOrUndef(lane.miles), deadheadMiles: intOrUndef(lane.deadheadMiles) }),
  };
  const defaults = useQuery({
    queryKey: ['negotiation-defaults', params],
    queryFn: ({ signal }) => api.get('/api/negotiations/defaults', params, { signal }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const d = defaults.data;

  const start = useNegotiationAction(null, (body) => api.post('/api/negotiations', body), {
    success: 'First email drafted. Review it before it goes out.',
    onSuccess: (data) => onStarted?.(data.negotiation.id),
  });

  const pickedBroker = fixedBroker;
  const noEmail = pickedBroker && !pickedBroker.email;
  const submit = (e) => {
    e.preventDefault();
    start.mutate({
      loadId: load?.id, brokerId: brokerId || undefined, carrierId: carrierId || null,
      lane: load ? undefined : {
        ...lane, miles: intOrUndef(lane.miles), deadheadMiles: intOrUndef(lane.deadheadMiles),
        pickupDate: lane.pickupDate || undefined, equipment: lane.equipment || undefined,
      },
      offerCents: toCents(offer), targetCents: toCents(target), floorCents: toCents(floor),
      mode, maxRounds: Number(maxRounds),
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="flex items-start gap-2 rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-[13px] text-fg-2">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-c-green" aria-hidden />
        <span>{NEVER_ALONE} It drafts emails and reads the broker’s replies; you approve the final rate and the booking.</span>
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        {fixedBroker ? (
          <div className="space-y-1 text-sm">
            <p className="text-[13px] font-medium">Broker</p>
            <p className="min-w-0 break-words">{fixedBroker.companyName}{fixedBroker.email ? <span className="text-muted"> · {fixedBroker.email}</span> : null}</p>
            {noEmail && <p className="text-xs text-c-red">Add the broker’s email address first.</p>}
          </div>
        ) : (
          <Field label="Broker" required><BrokerSelect value={brokerId} onChange={setBrokerId} /></Field>
        )}
        <Field label="Carrier" hint="Its rate rules set the walk-away rate">
          <CarrierPicker value={carrierId} onChange={(id) => setCarrierId(id)} initialLabel={load?.carrier?.companyName} />
        </Field>
      </div>

      {load ? (
        <p className="text-sm text-fg-2">{laneText(load)}{load.loadedMiles ? ` · ${num(load.loadedMiles)} mi` : ''}{load.equipment ? ` · ${label(load.equipment)}` : ''}{load.referenceNumber ? ` · #${load.referenceNumber}` : ''}</p>
      ) : (
        <fieldset className="grid grid-cols-2 gap-3 rounded-lg border border-line p-3 sm:grid-cols-4">
          <legend className="px-1 text-xs font-medium text-muted">Lane</legend>
          <Field label="Pickup city" required className="col-span-1"><Input value={lane.originCity} onChange={setL('originCity')} maxLength={100} required /></Field>
          <Field label="State" required><Select value={lane.originState} onChange={setL('originState')}><option value="">—</option>{US_STATES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
          <Field label="Delivery city" required><Input value={lane.destCity} onChange={setL('destCity')} maxLength={100} required /></Field>
          <Field label="State" required><Select value={lane.destState} onChange={setL('destState')}><option value="">—</option>{US_STATES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
          <Field label="Loaded miles"><Input inputMode="numeric" value={lane.miles} onChange={setL('miles')} /></Field>
          <Field label="Deadhead miles"><Input inputMode="numeric" value={lane.deadheadMiles} onChange={setL('deadheadMiles')} /></Field>
          <Field label="Pickup date"><Input type="date" value={lane.pickupDate} onChange={setL('pickupDate')} /></Field>
          <Field label="Equipment"><Select value={lane.equipment} onChange={setL('equipment')}><option value="">—</option>{EQUIPMENT.map((x) => <option key={x} value={x}>{label(x)}</option>)}</Select></Field>
          <Field label="Reference" className="col-span-2 sm:col-span-1"><Input value={lane.reference} onChange={setL('reference')} maxLength={60} /></Field>
        </fieldset>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Broker’s offer" hint="Their posted or quoted rate"><MoneyInput value={offer} onChange={setOffer} /></Field>
        <Field label="Target" hint={targetHint(d)}><MoneyInput value={target} onChange={setTarget} placeholder={d?.targetCents != null ? String(d.targetCents / 100) : ''} /></Field>
        <Field label="Walk-away rate" hint={floorHint(d, { carrierId: carrierId || load?.carrierId, miles })}><MoneyInput value={floor} onChange={setFloor} placeholder={d?.walkAwayCents != null ? String(d.walkAwayCents / 100) : ''} /></Field>
      </div>
      {d?.error && !target && !floor && <p className="text-[13px] text-c-amber">{d.error}</p>}

      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-0 space-y-1">
          <p className="text-[13px] font-medium">Emails</p>
          <Choice label="When emails go out" options={MODE_OPTIONS} value={mode} onChange={setMode} />
        </div>
        <Field label="Rounds" className="w-28">
          <Select value={maxRounds} onChange={(e) => setMaxRounds(e.target.value)}>{[1, 2, 3, 4, 5, 6].map((x) => <option key={x} value={String(x)}>{x}</option>)}</Select>
        </Field>
      </div>
      <p className="text-xs text-muted">
        {mode === 'auto'
          ? 'Counters between your walk-away and your target go out on their own, up to the number of rounds. The first email, any acceptance, walking away and answers to questions always wait for you.'
          : 'Every email waits for you in this negotiation and in the Email center under Needs approval.'}
      </p>

      <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-3">
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" loading={start.isPending} disabled={noEmail || (!fixedBroker && !brokerId)}>Draft the first email</Button>
      </div>
    </form>
  );
}
