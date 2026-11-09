import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownUp, ExternalLink, MapPin, Plus, Search, Truck, X } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { date } from '../../lib/format.js';
import { Badge, Button, ComboInput, Field, Input, cx } from '../ui.jsx';
import { BY_CODE, STATES, ZONES, localTime } from './usStates.js';

export const useMarketSummary = () => useQuery({ queryKey: ['market', 'summary'], queryFn: () => api.get('/api/market/summary'), staleTime: 300000 });
const useMarketPlaces = () => useQuery({ queryKey: ['market', 'states'], queryFn: () => api.get('/api/market/states'), staleTime: Infinity });

const usd = (n, d = 2) => (n == null ? '—' : `$${Number(n).toFixed(d)}`);
const int = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));

export function Change({ value, unit = '' }) {
  if (value == null) return <span className="text-muted">No prior week</span>;
  if (value === 0) return <span className="text-muted">No change vs last week</span>;
  const up = value > 0;
  return <span className={up ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-400'}>{up ? 'Up' : 'Down'} ${Math.abs(value).toFixed(3)}{unit} vs last week</span>;
}

export function SourceLink({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted underline-offset-2 hover:text-fg hover:underline">
      {children}<ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

/** Details for one state: time, carriers, your coverage, diesel for its EIA region, and next steps. */
export function StatePanel({ code, summary, onClose }) {
  const s = BY_CODE[code];
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);
  const diesel = useQuery({ queryKey: ['market', 'diesel', code], queryFn: () => api.get('/api/market/diesel', { state: code }), enabled: !!code, staleTime: 600000 });
  if (!s) return null;
  const census = summary?.carriersByState;
  const items = census?.items || [];
  const rank = items.findIndex((x) => x.state === code);
  const fmcsa = rank >= 0 ? items[rank].count : null;
  const mine = summary?.mine?.find((x) => x.state === code)?.count || 0;
  const d = diesel.data;
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-muted">{s.code}</p>
          <h3 className="text-lg font-medium leading-tight">{s.name}</h3>
          <p className="mt-0.5 text-[13px] text-fg-2">{ZONES[s.zone]?.label} time · <span className="tabular">{localTime(s.tz, now)}</span></p>
        </div>
        {onClose && <button type="button" onClick={onClose} aria-label="Close state" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg"><X className="size-4" /></button>}
      </div>
      <dl className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-line p-3">
          <dt className="text-xs text-muted">Active carriers</dt>
          <dd className="mt-1 text-lg font-medium tabular">{int(fmcsa)}</dd>
          <dd className="text-xs text-muted">{rank >= 0 ? `#${rank + 1} of ${items.length} states` : census?.error ? 'Census unavailable' : 'Loading'}</dd>
        </div>
        <div className="rounded-lg border border-line p-3">
          <dt className="text-xs text-muted">In your CRM</dt>
          <dd className="mt-1 text-lg font-medium tabular">{int(mine)}</dd>
          <dd className="text-xs text-muted">{fmcsa ? `${((mine / fmcsa) * 100).toFixed(mine / fmcsa < 0.01 ? 3 : 1)}% coverage` : 'carriers'}</dd>
        </div>
        <div className="col-span-2 rounded-lg border border-line p-3">
          <dt className="text-xs text-muted">Diesel{d?.regionLabel ? ` · ${d.regionLabel}` : ''}</dt>
          {d?.configured === false ? (
            <dd className="mt-1 text-[13px] text-fg-2">Not connected. An admin can add a free EIA API key in Admin → Settings.</dd>
          ) : d?.price != null ? (
            <>
              <dd className="mt-1 text-lg font-medium tabular">{usd(d.price, 3)}<span className="text-sm font-normal text-muted"> /gal</span></dd>
              <dd className="text-xs"><Change value={d.change} /> · week of {d.period}</dd>
            </>
          ) : <dd className="mt-1 text-[13px] text-muted">{d?.error || 'Loading'}</dd>}
        </div>
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={Search} to={`/app/discover?state=${code}`}>Find carriers here</Button>
        <Button size="sm" variant="secondary" icon={Truck} to={`/app/carriers?state=${code}`}>Open my carriers</Button>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {census?.sourceUrl && <SourceLink href={census.sourceUrl}>FMCSA Company Census{census.fetchedAt ? ` · ${date(census.fetchedAt)}` : ''}</SourceLink>}
        {d?.sourceUrl && d.configured && <SourceLink href={d.sourceUrl}>EIA weekly diesel</SourceLink>}
      </div>
    </div>
  );
}

const EQUIP = [['van', 'Van'], ['reefer', 'Reefer'], ['flatbed', 'Flatbed']];

function Segmented({ value, onChange, options, label }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5">
      {options.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          className={cx('h-7 rounded-md px-3 text-[13px] transition-ui', value === v ? 'bg-surface text-fg shadow-sm' : 'text-fg-2 hover:text-fg')}>{l}</button>
      ))}
    </div>
  );
}

/** Origin, stops and destination; fuel and (with a rate) revenue for the trip. Reports the route to draw. */
export function TripPlanner({ onRoute, compact }) {
  const places = useMarketPlaces();
  const summary = useMarketSummary();
  const options = useMemo(() => [...(places.data?.cities || []), ...STATES.map((s) => s.name)], [places.data]);
  const [stops, setStops] = useState(['', '']);
  const [equipment, setEquipment] = useState('van');
  const [mpg, setMpg] = useState('6.5');
  const [tank, setTank] = useState('150');
  const [miles, setMiles] = useState('');
  const [rate, setRate] = useState('');
  const [result, setResult] = useState(null);
  const manual = summary.data?.spotRates?.manual;

  const trip = useApiMutation((body) => api.post('/api/market/trip', body), {
    onSuccess: (d) => { setResult(d); onRoute?.(d.stops.map((s) => ({ lat: s.lat, lon: s.lon, label: s.place }))); },
  });
  const ready = stops.filter((s) => s.trim()).length >= 2;
  const run = (e) => {
    e?.preventDefault();
    if (!ready) return;
    trip.mutate({
      stops: stops.filter((s) => s.trim()), mpg: Number(mpg) || 6.5, tankGallons: Number(tank) || 150, equipment,
      miles: miles ? Number(miles) : null, ratePerMile: rate ? Number(rate) : null,
    });
  };
  const setStop = (i, v) => setStops((s) => s.map((x, j) => (j === i ? v : x)));
  const move = (i, dir) => setStops((s) => { const n = [...s]; [n[i], n[i + dir]] = [n[i + dir], n[i]]; return n; });

  return (
    <form onSubmit={run} className="space-y-4">
      <div className="space-y-2">
        {stops.map((s, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className={cx('flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-[11px]',
              i === 0 ? 'bg-brand-600 text-white' : i === stops.length - 1 ? 'bg-fg text-bg' : 'border border-line-strong text-fg')}>{String.fromCharCode(65 + i)}</span>
            <ComboInput aria-label={i === 0 ? 'Origin' : i === stops.length - 1 ? 'Destination' : `Stop ${i}`} options={options} value={s}
              onChange={(e) => setStop(i, e.target.value)} placeholder={i === 0 ? 'Origin, e.g. Dallas, TX' : i === stops.length - 1 ? 'Destination' : 'Pickup or drop'} />
            {stops.length > 2 && <button type="button" aria-label="Remove stop" onClick={() => setStops((x) => x.filter((_, j) => j !== i))} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg"><X className="size-4" /></button>}
            {i > 0 && i < stops.length - 1 && <button type="button" aria-label="Move up" onClick={() => move(i, -1)} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg"><ArrowDownUp className="size-4" /></button>}
          </div>
        ))}
        <div className="flex gap-3 pl-8">
          {stops.length < 8 && <button type="button" onClick={() => setStops((s) => [...s.slice(0, -1), '', s[s.length - 1]])} className="inline-flex items-center gap-1 text-[13px] text-brand-700 hover:underline dark:text-brand-300"><Plus className="size-3.5" />Add stop</button>}
          <button type="button" onClick={() => setStops((s) => [...s].reverse())} className="inline-flex items-center gap-1 text-[13px] text-fg-2 hover:text-fg"><ArrowDownUp className="size-3.5" />Reverse</button>
        </div>
      </div>
      <Segmented label="Equipment" value={equipment} onChange={setEquipment} options={EQUIP} />
      <div className={cx('grid gap-3', compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4')}>
        <Field label="Miles per gallon"><ComboInput options={['5.5', '6', '6.5', '7', '7.5', '8']} type="number" min="2" max="20" step="0.1" value={mpg} onChange={(e) => setMpg(e.target.value)} /></Field>
        <Field label="Tank (gal)"><ComboInput options={['100', '120', '150', '200', '250', '300']} type="number" min="20" max="500" value={tank} onChange={(e) => setTank(e.target.value)} /></Field>
        <Field label="Miles" hint="Leave empty to estimate"><Input type="number" min="1" value={miles} onChange={(e) => setMiles(e.target.value)} placeholder="Estimate" /></Field>
        <Field label="Rate $/mile" hint={manual?.[equipment] ? `Your ${equipment} rate: $${manual[equipment]}` : 'Optional'}><Input type="number" min="0.3" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} placeholder={manual?.[equipment] ? String(manual[equipment]) : '—'} /></Field>
      </div>
      <Button type="submit" icon={MapPin} disabled={!ready} loading={trip.isPending}>Plan trip</Button>

      {result && (
        <div className="space-y-3 rounded-lg border border-line p-4">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
            <Stat label={result.estimate ? 'Miles (estimate)' : 'Miles'} value={int(result.miles)} />
            <Stat label="Diesel" value={int(result.gallons)} unit=" gal" sub={`${result.fuelStops} fuel stop${result.fuelStops === 1 ? '' : 's'}`} />
            <Stat label="Fuel cost" value={usd(result.fuelCost)} sub={result.priceSource || 'Enter a diesel price'} />
            <Stat label="Fuel per mile" value={usd(result.fuelCostPerMile, 3)} />
            {result.revenue != null && <>
              <Stat label="Revenue" value={usd(result.revenue)} sub={`$${result.ratePerMile}/mi · ${result.rateSource}`} />
              <Stat label="After fuel" value={usd(result.afterFuel)} sub={result.fuelShare != null ? `Fuel is ${(result.fuelShare * 100).toFixed(0)}% of revenue` : null} accent />
            </>}
          </div>
          <div className="space-y-1 border-t border-line pt-3 text-xs text-muted">
            {result.legs.map((l, i) => <div key={i} className="flex justify-between gap-3"><span>{String.fromCharCode(65 + i)} to {String.fromCharCode(66 + i)} · {l.from} to {l.to}</span><span className="tabular">{int(l.miles)} mi{l.precision === 'state' ? ' · state center' : ''}</span></div>)}
            <p>{result.method}</p>
          </div>
        </div>
      )}
    </form>
  );
}

function Stat({ label, value, unit = '', sub, accent }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div className={cx('text-base font-medium tabular', accent && 'text-brand-700 dark:text-brand-300')}>{value}{value !== '—' && unit}</div>
      {sub && <div className="text-[11.5px] text-muted">{sub}</div>}
    </div>
  );
}

/** Weekly spot rates the user reads from DAT Trendlines and types in. */
export function SpotRatesCard() {
  const summary = useMarketSummary();
  const sr = summary.data?.spotRates;
  const manual = sr?.manual;
  const [f, setF] = useState({ van: '', reefer: '', flatbed: '' });
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (manual) setF({ van: manual.van ?? '', reefer: manual.reefer ?? '', flatbed: manual.flatbed ?? '' });
  }, [manual]);
  const save = useApiMutation((body) => api.put('/api/market/spot-rates', body), {
    invalidate: [['market', 'summary']], success: 'Rates saved', onSuccess: () => setEditing(false),
  });
  const show = editing || !manual;
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-fg-2">Read this week&rsquo;s national averages on DAT Trendlines, then enter them here. The trip planner uses them for revenue.</p>
      <SourceLink href={sr?.link || 'https://www.dat.com/trendlines'}>DAT Trendlines, weekly national averages</SourceLink>
      {show ? (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate({ van: f.van || null, reefer: f.reefer || null, flatbed: f.flatbed || null }); }}>
          <div className="grid grid-cols-3 gap-2">
            {EQUIP.map(([k, l]) => (
              <Field key={k} label={`${l} $/mi`}><Input type="number" min="0.3" max="20" step="0.01" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder="0.00" /></Field>
            ))}
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={save.isPending}>Save rates</Button>
            {manual && <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
          </div>
        </form>
      ) : (
        <div>
          <div className="grid grid-cols-3 gap-2">
            {EQUIP.map(([k, l]) => (
              <div key={k} className="rounded-lg border border-line p-3">
                <div className="text-xs text-muted">{l}</div>
                <div className="text-lg font-medium tabular">{manual[k] != null ? `$${Number(manual[k]).toFixed(2)}` : '—'}</div>
                <div className="text-[11.5px] text-muted">per mile</div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between gap-3">
            <Badge>Entered by you · {date(manual.updatedAt)}</Badge>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Update</Button>
          </div>
        </div>
      )}
    </div>
  );
}
