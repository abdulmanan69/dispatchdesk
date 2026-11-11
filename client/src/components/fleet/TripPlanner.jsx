import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, ArrowDownUp, CloudSun, AlertTriangle, Fuel, Route as RouteIcon } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { EQUIPMENT, label, money, toLocalInput, dateTime } from '../../lib/format.js';
import { Button, Field, Input, Select, cx } from '../ui.jsx';
import { BrokerSelect } from '../dispatch/Pickers.jsx';
import PlaceSearch from './PlaceSearch.jsx';
import FitCard from '../dispatch/FitCard.jsx';
import LegalEtaCard from '../dispatch/LegalEtaCard.jsx';
import { route, weather, diesel, placeLabel } from './fleetApi.js';

const tomorrow8 = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return toLocalInput(d); };
const num = (v) => (v === '' || v == null ? null : Number(v));

function Metric({ label: name, value, sub, tone }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2">
      <div className="text-[11.5px] text-muted">{name}</div>
      <div className={cx('tabular text-[15px] font-medium', tone)}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

function WeatherLine({ title, w }) {
  if (!w) return null;
  const alerts = w.alerts || [];
  return (
    <div className="text-xs">
      <div className="flex items-center gap-1.5 text-fg-2"><CloudSun className="size-3.5 text-sky-500" aria-hidden /><span className="font-medium text-fg">{title}</span>
        {w.current && <span>{Math.round(w.current.tempF)}°F · {w.current.description} · wind {Math.round(w.current.windMph)} mph</span>}
      </div>
      {alerts.slice(0, 2).map((a, i) => (
        <div key={i} className="mt-1 flex items-start gap-1.5 text-red-700 dark:text-red-300"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden /><span>{a.event}{a.severity ? ` · ${a.severity}` : ''}</span></div>
      ))}
    </div>
  );
}

/**
 * Plan a carrier's next trip: route from the truck to pickup (deadhead) and on to delivery, with miles, RPM, fuel, ETA and weather.
 * Distances come from the road router when available; otherwise they are marked as estimates.
 */
export default function TripPlanner({ trucks, initialCarrierId, initialOrigin, onClose, onPreview, onSaved }) {
  const [carrierId, setCarrierId] = useState(initialCarrierId || trucks[0]?.id || '');
  const truck = trucks.find((t) => t.id === carrierId);
  const [origin, setOrigin] = useState(initialOrigin || (truck?.location ? { ...truck.location } : null));
  const [dest, setDest] = useState(null);
  const [pickup, setPickup] = useState(tomorrow8());
  const [delivery, setDelivery] = useState('');
  // The delivery time starts as the drive-time estimate; it is an appointment only once the user sets it.
  const [deliveryTouched, setDeliveryTouched] = useState(false);
  const [rate, setRate] = useState('');
  const [equipment, setEquipment] = useState((truck?.equipment || '').split(',')[0] || '');
  const [brokerId, setBrokerId] = useState(null);
  const [mpg, setMpg] = useState('6.5');
  const [fuel, setFuel] = useState('');
  const [reference, setReference] = useState('');

  useEffect(() => {
    if (initialOrigin) return;
    if (truck?.location) setOrigin({ ...truck.location });
    setEquipment((truck?.equipment || '').split(',')[0] || '');
  }, [carrierId]); // eslint-disable-line react-hooks/exhaustive-deps

  const truckPt = truck?.location?.lat != null ? truck.location : null;
  const loaded = useQuery({ queryKey: ['fleet', 'route', origin?.lat, origin?.lng, dest?.lat, dest?.lng], queryFn: () => route(origin, dest), enabled: origin?.lat != null && dest?.lat != null, staleTime: 3600000 });
  const sameSpot = truckPt && origin && Math.abs(truckPt.lat - origin.lat) < 0.01 && Math.abs(truckPt.lng - origin.lng) < 0.01;
  const deadhead = useQuery({ queryKey: ['fleet', 'route', truckPt?.lat, truckPt?.lng, origin?.lat, origin?.lng], queryFn: () => route(truckPt, origin), enabled: !!truckPt && origin?.lat != null && !sameSpot, staleTime: 3600000 });
  const wOrigin = useQuery({ queryKey: ['fleet', 'weather', origin?.lat?.toFixed(2), origin?.lng?.toFixed(2)], queryFn: () => weather(origin), enabled: origin?.lat != null, staleTime: 900000 });
  const wDest = useQuery({ queryKey: ['fleet', 'weather', dest?.lat?.toFixed(2), dest?.lng?.toFixed(2)], queryFn: () => weather(dest), enabled: dest?.lat != null, staleTime: 900000 });
  const dieselQ = useQuery({ queryKey: ['market', 'diesel', origin?.state], queryFn: () => diesel(origin.state), enabled: !!origin?.state, staleTime: 3600000 });
  useEffect(() => { if (!fuel && dieselQ.data?.configured && dieselQ.data.price) setFuel(String(dieselQ.data.price)); }, [dieselQ.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    onPreview?.(loaded.data ? { ...loaded.data, deadhead: deadhead.data || null } : null);
  }, [loaded.data, deadhead.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onPreview?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  const calc = useMemo(() => {
    const lm = loaded.data?.miles ?? null;
    const dh = sameSpot ? 0 : (deadhead.data?.miles ?? (truckPt ? null : 0));
    const rateCents = num(rate) != null ? Math.round(num(rate) * 100) : null;
    const total = lm != null && dh != null ? lm + dh : null;
    const gallons = total != null && num(mpg) ? total / num(mpg) : null;
    const fuelCost = gallons != null && num(fuel) ? gallons * num(fuel) : null;
    const hours = (loaded.data?.durationHours ?? (lm != null ? lm / 50 : null));
    const eta = pickup && hours != null ? new Date(new Date(pickup).getTime() + hours * 3600000) : null;
    return {
      lm, dh, total, rateCents, gallons, fuelCost, hours, eta,
      rpmLoaded: rateCents != null && lm ? rateCents / 100 / lm : null,
      rpmAll: rateCents != null && total ? rateCents / 100 / total : null,
      net: rateCents != null && fuelCost != null ? rateCents / 100 - fuelCost : null,
    };
  }, [loaded.data, deadhead.data, rate, mpg, fuel, pickup, sameSpot, truckPt]);

  useEffect(() => { if (calc.eta && !delivery) setDelivery(toLocalInput(calc.eta)); }, [calc.eta?.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useApiMutation((body) => api.post('/api/fleet/trips', body), {
    success: 'Trip planned', invalidate: [['fleet'], ['loads'], ['today']], onSuccess: (d) => { onSaved?.(d.trip); onClose(); },
  });
  const ready = carrierId && origin?.state && dest?.state && num(rate) != null;
  // Legal ETA (hours of service) for this plan: deadhead from the truck, the pickup time and the delivery appointment.
  const etaInput = useMemo(() => ({
    carrierId: carrierId || null, origin, dest,
    pickupWindowStart: pickup ? new Date(pickup).toISOString() : null,
    deliveryWindowStart: deliveryTouched && delivery ? new Date(delivery).toISOString() : null,
    deadhead: truckPt && !sameSpot ? { from: { lat: truckPt.lat, lng: truckPt.lng } } : null,
  }), [carrierId, origin, dest, pickup, delivery, deliveryTouched, truckPt, sameSpot]);
  // The carrier's rules and negotiation numbers for this plan (same check as the load form; never blocks saving).
  const fitLoad = useMemo(() => ({
    rateCents: calc.rateCents, loadedMiles: calc.lm ? Math.round(calc.lm) : null, deadheadMiles: calc.dh != null ? Math.round(calc.dh) : null,
    equipment: equipment || null, originState: origin?.state || null, destState: dest?.state || null,
    pickupDate: pickup ? new Date(pickup).toISOString() : null, deliveryDate: delivery ? new Date(delivery).toISOString() : null,
  }), [calc.rateCents, calc.lm, calc.dh, equipment, origin?.state, dest?.state, pickup, delivery]);
  const submit = (e) => {
    e.preventDefault();
    save.mutate({
      carrierId, origin: { city: origin.city || origin.state, state: origin.state, lat: origin.lat, lng: origin.lng }, dest: { city: dest.city || dest.state, state: dest.state, lat: dest.lat, lng: dest.lng },
      pickupDate: pickup ? new Date(pickup).toISOString() : null, deliveryDate: delivery ? new Date(delivery).toISOString() : null,
      rateCents: calc.rateCents, loadedMiles: calc.lm ? Math.max(1, Math.round(calc.lm)) : null, deadheadMiles: calc.dh != null ? Math.round(calc.dh) : null,
      equipment: equipment || null, brokerId, referenceNumber: reference || null, mpg: num(mpg), fuelPricePerGallon: num(fuel),
    });
  };
  const estimate = loaded.data?.estimate || deadhead.data?.estimate;
  const f1 = (n, d = 0) => (n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div><p className="text-xs text-muted">Plan next trip</p><h3 className="font-medium">{truck?.companyName || 'Choose a carrier'}</h3></div>
        <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Close"><X className="size-4" /></button>
      </div>

      <Field label="Carrier">
        <Select value={carrierId} onChange={(e) => setCarrierId(e.target.value)} searchable>
          {trucks.map((t) => <option key={t.id} value={t.id}>{t.companyName}{t.location ? ` · ${placeLabel(t.location)}` : ''}</option>)}
        </Select>
      </Field>
      {truck && <p className="-mt-2 text-xs text-muted">Truck now: {truck.location ? placeLabel(truck.location) : 'location not set'}</p>}

      <div className="relative space-y-3">
        <Field label="Pickup">{(id) => <PlaceSearch id={id} value={origin} onChange={setOrigin} placeholder="Pickup city" />}</Field>
        <button type="button" onClick={() => { const o = origin; setOrigin(dest); setDest(o); }} title="Swap pickup and delivery"
          className="absolute right-0 top-[52px] z-10 flex size-7 items-center justify-center rounded-full border border-line bg-surface text-muted hover:text-fg"><ArrowDownUp className="size-3.5" /><span className="sr-only">Swap</span></button>
        <Field label="Delivery">{(id) => <PlaceSearch id={id} value={dest} onChange={setDest} placeholder="Delivery city" />}</Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Pickup time"><Input type="datetime-local" value={pickup} onChange={(e) => setPickup(e.target.value)} /></Field>
        <Field label="Delivery time" hint={calc.eta ? `Drive time about ${f1(calc.hours, 1)} h` : undefined}><Input type="datetime-local" value={delivery} onChange={(e) => { setDelivery(e.target.value); setDeliveryTouched(!!e.target.value); }} /></Field>
        <Field label="Rate ($)" required><Input type="number" min="0" step="1" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="2500" /></Field>
        <Field label="Equipment"><Select value={equipment} onChange={(e) => setEquipment(e.target.value)}><option value="">Any</option>{EQUIPMENT.map((q) => <option key={q} value={q}>{label(q)}</option>)}</Select></Field>
        <Field label="MPG"><Input type="number" min="1" max="30" step="0.1" value={mpg} onChange={(e) => setMpg(e.target.value)} /></Field>
        <Field label="Diesel ($/gal)" hint={dieselQ.data?.configured ? `EIA ${dieselQ.data.regionLabel || ''} · ${dieselQ.data.period || ''}` : 'Enter the price you pay'}>
          <Input type="number" min="0" step="0.01" value={fuel} onChange={(e) => setFuel(e.target.value)} placeholder="4.00" />
        </Field>
        <Field label="Broker"><BrokerSelect value={brokerId} onChange={setBrokerId} /></Field>
        <Field label="Reference #"><Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} /></Field>
      </div>

      {(loaded.data || loaded.isFetching) && (
        <div className="space-y-2 rounded-xl border border-line bg-surface-2 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 font-medium text-fg"><RouteIcon className="size-3.5 text-brand-600" aria-hidden />Trip numbers</span>
            <span className="text-muted">{loaded.isFetching ? 'Routing…' : estimate ? 'Straight-line estimate × 1.18' : `Road route · ${loaded.data?.source || ''}`}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Metric label="Loaded mi" value={f1(calc.lm)} />
            <Metric label="Deadhead mi" value={f1(calc.dh)} tone={calc.dh > 150 ? 'text-amber-600 dark:text-amber-400' : undefined} />
            <Metric label="Total mi" value={f1(calc.total)} />
            <Metric label="RPM loaded" value={calc.rpmLoaded != null ? `$${f1(calc.rpmLoaded, 2)}` : '—'} tone="text-brand-700 dark:text-brand-300" />
            <Metric label="RPM all-in" value={calc.rpmAll != null ? `$${f1(calc.rpmAll, 2)}` : '—'} tone={calc.rpmAll != null && calc.rpmAll < 2 ? 'text-red-600 dark:text-red-400' : 'text-green-700 dark:text-green-400'} />
            <Metric label="ETA" value={calc.eta ? calc.eta.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '—'} />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-2">
            <span className="flex items-center gap-1"><Fuel className="size-3.5 text-amber-500" aria-hidden />{calc.gallons != null ? `${f1(calc.gallons)} gal` : '—'} · fuel {calc.fuelCost != null ? money(Math.round(calc.fuelCost * 100), { digits: 0 }) : '—'}</span>
            {calc.net != null && <span>After fuel <span className={cx('font-medium', calc.net < 0 ? 'text-red-600' : 'text-green-700 dark:text-green-400')}>{money(Math.round(calc.net * 100), { digits: 0 })}</span></span>}
          </div>
          <div className="space-y-1.5 border-t border-line pt-2">
            <WeatherLine title={origin ? placeLabel(origin) : 'Pickup'} w={wOrigin.data} />
            <WeatherLine title={dest ? placeLabel(dest) : 'Delivery'} w={wDest.data} />
            {!wOrigin.data && !wDest.data && <p className="text-[11px] text-muted">Weather appears here when the weather service is connected.</p>}
          </div>
        </div>
      )}
      {calc.eta && delivery && new Date(delivery) < calc.eta && <p className="text-xs text-amber-700 dark:text-amber-300">Delivery is earlier than the estimated arrival ({dateTime(calc.eta)}).</p>}

      {origin?.state && dest?.state && <LegalEtaCard className="rounded-xl border border-line p-3" input={etaInput} />}

      {carrierId && origin?.state && dest?.state && (
        <FitCard className="rounded-xl border border-line p-3" carrierId={carrierId} load={fitLoad} />
      )}

      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={!ready} loading={save.isPending}>Save planned trip</Button>
      </div>
    </form>
  );
}
