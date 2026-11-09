import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Calculator, Wallet, Landmark, Route, Timer, Fuel, Scale, Clock, ArrowLeftRight, Columns3, Search, ExternalLink,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { dollars, num, label, PRESETS, US_STATES, date } from '../../lib/format.js';
import { calculateLoad } from '../../components/dispatch/calc.js';
import { Button, Card, ComboInput, ErrorState, Field, Input, LocalClock, PageHeader, Select, cx } from '../../components/ui.jsx';

// ----------------------------------------------------------------- shared bits

const n = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const pct = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(d)}%`);
const money = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : dollars(v, d));
const per = (v) => (v == null || !Number.isFinite(v) ? '—' : `${dollars(v, 2)}/mi`);

function useForm(initial) {
  const [f, setF] = useState(initial);
  const bind = (k) => ({ value: f[k], onChange: (e) => setF((s) => ({ ...s, [k]: e.target.value })) });
  return [f, bind, setF];
}

function NumField({ label: l, hint, presets, ...props }) {
  return (
    <Field label={l} hint={hint}>
      {presets ? <ComboInput type="number" inputMode="decimal" options={presets} {...props} /> : <Input type="number" inputMode="decimal" {...props} />}
    </Field>
  );
}

/** One key figure in the accent, the rest as a quiet mono list. */
function Results({ keyLabel, keyValue, rows = [], note }) {
  return (
    <div className="rounded-xl border border-line bg-bg p-5">
      <div className="text-xs text-fg-2">{keyLabel}</div>
      <div className="mt-2 text-[32px] font-medium leading-none tabular tracking-[-0.02em] text-brand-700 dark:text-brand-300">{keyValue}</div>
      {rows.length > 0 && (
        <dl className="mt-5 divide-y divide-line border-t border-line">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-4 py-2 text-sm">
              <dt className="text-fg-2">{k}</dt>
              <dd className="font-mono text-[13px] tabular">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {note && <p className="mt-3 text-xs text-muted">{note}</p>}
    </div>
  );
}

function Formula({ children }) {
  return <p className="mt-4 rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs leading-5 text-fg-2">{children}</p>;
}

function ToolLayout({ inputs, results, formula }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div>
        <div className="grid gap-4 sm:grid-cols-2">{inputs}</div>
        {formula && <Formula>{formula}</Formula>}
      </div>
      <div>{results}</div>
    </div>
  );
}

// ----------------------------------------------------------------- tools

function RateTool() {
  const [f, bind] = useForm({ rate: '2200', loaded: '781', deadhead: '40', fuel: '', mpg: '6.5', fee: '' });
  const c = calculateLoad({
    rateCents: n(f.rate) != null ? Math.round(n(f.rate) * 100) : 0, loadedMiles: n(f.loaded), deadheadMiles: n(f.deadhead),
    fuelPricePerGallon: n(f.fuel), mpg: n(f.mpg), dispatchFeePercent: n(f.fee),
  });
  return (
    <ToolLayout
      inputs={<>
        <NumField label="Total load rate ($)" min="0" step="1" {...bind('rate')} />
        <NumField label="Loaded miles" min="0" step="1" {...bind('loaded')} />
        <NumField label="Deadhead miles" min="0" step="1" {...bind('deadhead')} />
        <NumField label="Fuel price ($/gal)" hint="Enter the price you pay today" min="0" step="0.001" {...bind('fuel')} />
        <NumField label="Truck MPG" presets={PRESETS.mpg} min="1" step="0.1" {...bind('mpg')} />
        <NumField label="Dispatch fee (%)" presets={PRESETS.feePercent} min="0" max="100" step="0.1" {...bind('fee')} />
      </>}
      formula="Rate per mile = rate ÷ loaded miles · All-in = rate ÷ (loaded + deadhead) · Fuel = total miles ÷ MPG × price"
      results={<Results keyLabel="Rate per loaded mile" keyValue={per(c.ratePerMile)} rows={[
        ['All-in rate per mile', per(c.allInRatePerMile)],
        ['Total miles', num(c.totalMiles)],
        ['Deadhead share', c.deadheadPercent == null ? '—' : pct(c.deadheadPercent)],
        ['Fuel cost', c.fuelCostCents == null ? 'Add fuel price' : money(c.fuelCostCents / 100)],
        ['Dispatch fee', c.dispatchFeeCents == null ? '—' : money(c.dispatchFeeCents / 100)],
        ['Carrier net after fuel and fee', money(c.carrierNetCents / 100)],
      ]} />}
    />
  );
}

function EarningsTool() {
  const [f, bind] = useForm({ rate: '2200', loads: '3', fee: '8', trucks: '1' });
  const weekly = (n(f.rate) ?? 0) * (n(f.loads) ?? 0) * (n(f.trucks) ?? 0) * ((n(f.fee) ?? 0) / 100);
  return (
    <ToolLayout
      inputs={<>
        <NumField label="Average load rate ($)" min="0" step="1" {...bind('rate')} />
        <NumField label="Loads per truck per week" min="0" step="0.5" {...bind('loads')} />
        <NumField label="Dispatch fee (%)" presets={PRESETS.feePercent} min="0" max="100" step="0.1" {...bind('fee')} />
        <NumField label="Trucks you dispatch" min="0" step="1" {...bind('trucks')} />
      </>}
      formula="Weekly earnings = average rate × loads per week × trucks × fee % · Monthly = weekly × 52 ÷ 12"
      results={<Results keyLabel="Your monthly earnings" keyValue={money((weekly * 52) / 12, 0)} rows={[
        ['Per week', money(weekly, 0)],
        ['Per year', money(weekly * 52, 0)],
        ['Per truck per month', money(n(f.trucks) ? (weekly * 52) / 12 / n(f.trucks) : null, 0)],
        ['Carrier gross per month', money((n(f.rate) ?? 0) * (n(f.loads) ?? 0) * (n(f.trucks) ?? 0) * 52 / 12, 0)],
      ]} note="An estimate from your inputs, not a forecast of market rates." />}
    />
  );
}

function FactoringTool() {
  const [f, bind] = useForm({ invoice: '2200', fee: '3', reserve: '10', days: '30' });
  const inv = n(f.invoice) ?? 0;
  const fee = inv * ((n(f.fee) ?? 0) / 100);
  const reserve = inv * ((n(f.reserve) ?? 0) / 100);
  const advance = inv - reserve;
  const release = reserve - fee;
  const days = n(f.days);
  const apr = advance > 0 && days ? (fee / advance) * (365 / days) * 100 : null;
  return (
    <ToolLayout
      inputs={<>
        <NumField label="Invoice amount ($)" min="0" step="1" {...bind('invoice')} />
        <NumField label="Factoring fee (%)" presets={['1.5', '2', '2.5', '3', '3.5', '4', '5']} min="0" max="100" step="0.1" {...bind('fee')} />
        <NumField label="Reserve held (%)" hint="Use 0 for non-recourse with no reserve" presets={['0', '5', '10', '15', '20']} min="0" max="100" step="1" {...bind('reserve')} />
        <NumField label="Days until broker pays" presets={['15', '30', '45', '60']} min="1" step="1" {...bind('days')} />
      </>}
      formula="Advance = invoice − reserve · Fee = invoice × fee % · Released later = reserve − fee · Effective annual rate = fee ÷ advance × 365 ÷ days"
      results={<Results keyLabel="Cash today" keyValue={money(advance)} rows={[
        ['Factoring fee', money(fee)],
        ['Reserve released later', money(release)],
        ['Total you receive', money(inv - fee)],
        ['Effective annual rate', pct(apr)],
      ]} note="Terms differ by factoring company. Check your agreement for flat fees and tiered rates." />}
    />
  );
}

function DeadheadTool() {
  const [f, bind] = useForm({ miles: '60', fuel: '', mpg: '6.5', driver: '', other: '' });
  const miles = n(f.miles) ?? 0;
  const fuelPerMile = n(f.fuel) != null && n(f.mpg) ? n(f.fuel) / n(f.mpg) : 0;
  const perMile = fuelPerMile + (n(f.driver) ?? 0) + (n(f.other) ?? 0);
  return (
    <ToolLayout
      inputs={<>
        <NumField label="Deadhead miles" min="0" step="1" {...bind('miles')} />
        <NumField label="Fuel price ($/gal)" min="0" step="0.001" {...bind('fuel')} />
        <NumField label="Truck MPG" presets={PRESETS.mpg} min="1" step="0.1" {...bind('mpg')} />
        <NumField label="Driver pay ($/mi)" hint="Leave blank for owner-operators" min="0" step="0.01" {...bind('driver')} />
        <NumField label="Other cost ($/mi)" hint="Maintenance, tires" min="0" step="0.01" {...bind('other')} />
      </>}
      formula="Deadhead cost = miles × (fuel price ÷ MPG + driver pay per mile + other cost per mile)"
      results={<Results keyLabel="Deadhead cost" keyValue={money(miles * perMile)} rows={[
        ['Cost per empty mile', per(perMile)],
        ['Fuel per mile', fuelPerMile ? per(fuelPerMile) : 'Add fuel price'],
        ['Gallons burned', n(f.mpg) ? num(miles / n(f.mpg), 1) : '—'],
      ]} />}
    />
  );
}

function DetentionTool() {
  const [f, bind] = useForm({ arrive: '', depart: '', free: '2', rate: '50' });
  const a = f.arrive ? new Date(f.arrive) : null;
  const d = f.depart ? new Date(f.depart) : null;
  const hours = a && d && d > a ? (d - a) / 3600000 : null;
  const billable = hours != null ? Math.max(0, hours - (n(f.free) ?? 0)) : null;
  return (
    <ToolLayout
      inputs={<>
        <Field label="Arrived (checked in)"><Input type="datetime-local" {...bind('arrive')} /></Field>
        <Field label="Departed (loaded or empty)"><Input type="datetime-local" {...bind('depart')} /></Field>
        <NumField label="Free time (hours)" presets={['1', '2', '3']} min="0" step="0.25" {...bind('free')} />
        <NumField label="Detention rate ($/hr)" presets={PRESETS.detentionRate} min="0" step="1" {...bind('rate')} />
      </>}
      formula="Billable hours = time on site − free time · Detention = billable hours × hourly rate"
      results={<Results keyLabel="Detention to bill" keyValue={billable == null ? '—' : money(billable * (n(f.rate) ?? 0))} rows={[
        ['Time on site', hours == null ? 'Enter both times' : `${num(hours, 2)} h`],
        ['Billable hours', billable == null ? '—' : `${num(billable, 2)} h`],
      ]} note="Get in and out times on the BOL and notify the broker before free time runs out." />}
    />
  );
}

function FuelTool() {
  const [f, bind] = useForm({ miles: '821', mpg: '6.5', fuel: '' });
  const gallons = n(f.mpg) ? (n(f.miles) ?? 0) / n(f.mpg) : null;
  const cost = gallons != null && n(f.fuel) != null ? gallons * n(f.fuel) : null;
  return (
    <ToolLayout
      inputs={<>
        <NumField label="Trip miles (loaded + deadhead)" min="0" step="1" {...bind('miles')} />
        <NumField label="Truck MPG" presets={PRESETS.mpg} min="1" step="0.1" {...bind('mpg')} />
        <NumField label="Fuel price ($/gal)" hint="Enter the price you pay today" min="0" step="0.001" {...bind('fuel')} />
      </>}
      formula="Gallons = miles ÷ MPG · Fuel cost = gallons × price per gallon"
      results={<Results keyLabel="Fuel cost" keyValue={cost == null ? 'Add fuel price' : money(cost)} rows={[
        ['Gallons', gallons == null ? '—' : num(gallons, 1)],
        ['Fuel per mile', cost == null || !n(f.miles) ? '—' : per(cost / n(f.miles))],
      ]} />}
    />
  );
}

function BreakEvenTool() {
  const [f, bind] = useForm({ fuel: '', mpg: '6.5', maint: '0.18', driver: '', insurance: '', payment: '', otherFixed: '', monthlyMiles: '10000', loaded: '600', deadhead: '50', margin: '15' });
  const varPerMile = (n(f.fuel) && n(f.mpg) ? n(f.fuel) / n(f.mpg) : 0) + (n(f.maint) ?? 0) + (n(f.driver) ?? 0);
  const fixedMonthly = (n(f.insurance) ?? 0) + (n(f.payment) ?? 0) + (n(f.otherFixed) ?? 0);
  const fixedPerMile = n(f.monthlyMiles) ? fixedMonthly / n(f.monthlyMiles) : 0;
  const costPerMile = varPerMile + fixedPerMile;
  const tripMiles = (n(f.loaded) ?? 0) + (n(f.deadhead) ?? 0);
  const tripCost = costPerMile * tripMiles;
  const minRpm = n(f.loaded) ? tripCost / n(f.loaded) : null;
  const target = minRpm != null ? minRpm * (1 + (n(f.margin) ?? 0) / 100) : null;
  return (
    <ToolLayout
      inputs={<>
        <NumField label="Fuel price ($/gal)" min="0" step="0.001" {...bind('fuel')} />
        <NumField label="Truck MPG" presets={PRESETS.mpg} min="1" step="0.1" {...bind('mpg')} />
        <NumField label="Maintenance and tires ($/mi)" min="0" step="0.01" {...bind('maint')} />
        <NumField label="Driver pay ($/mi)" min="0" step="0.01" {...bind('driver')} />
        <NumField label="Insurance ($/month)" min="0" step="1" {...bind('insurance')} />
        <NumField label="Truck and trailer payment ($/month)" min="0" step="1" {...bind('payment')} />
        <NumField label="Other fixed costs ($/month)" hint="ELD, permits, phone, parking" min="0" step="1" {...bind('otherFixed')} />
        <NumField label="Miles driven per month" min="1" step="100" {...bind('monthlyMiles')} />
        <NumField label="Trip loaded miles" min="0" step="1" {...bind('loaded')} />
        <NumField label="Trip deadhead miles" min="0" step="1" {...bind('deadhead')} />
        <NumField label="Target margin (%)" presets={['10', '15', '20', '25']} min="0" step="1" {...bind('margin')} />
      </>}
      formula="Cost per mile = fuel ÷ MPG + maintenance + driver pay + monthly fixed ÷ monthly miles · Break-even RPM = cost per mile × (loaded + deadhead) ÷ loaded"
      results={<Results keyLabel="Break-even rate per loaded mile" keyValue={per(minRpm)} rows={[
        ['With target margin', per(target)],
        ['Minimum rate for this trip', money(tripCost, 0)],
        ['Operating cost per mile', per(costPerMile)],
        ['Fixed cost per mile', per(fixedPerMile)],
      ]} note="Uses only the costs you enter. Leave a field blank if it doesn't apply." />}
    />
  );
}

const ZONES = [
  ['Eastern', 'America/New_York'], ['Central', 'America/Chicago'], ['Mountain', 'America/Denver'], ['Arizona', 'America/Phoenix'],
  ['Pacific', 'America/Los_Angeles'], ['Alaska', 'America/Anchorage'], ['Hawaii', 'Pacific/Honolulu'],
];
const STATE_TZ = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago', CA: 'America/Los_Angeles', CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', HI: 'Pacific/Honolulu', ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis', IA: 'America/Chicago', KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York', MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago', MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago', NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver', NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York', OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', UT: 'America/Denver', VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles', WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver',
};
function callable(tz) {
  try {
    const now = new Date();
    const h = Number(now.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false })) % 24;
    const wd = now.toLocaleString('en-US', { timeZone: tz, weekday: 'short' });
    return !['Sat', 'Sun'].includes(wd) && h >= 8 && h < 19;
  } catch { return false; }
}

function TimeZoneTool() {
  const [, tick] = useState(0);
  const [state, setState] = useState('TX');
  useEffect(() => { const id = setInterval(() => tick((x) => x + 1), 30000); return () => clearInterval(id); }, []);
  const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div>
        <ul className="divide-y divide-line rounded-xl border border-line">
          {ZONES.map(([name, tz]) => {
            const ok = callable(tz);
            return (
              <li key={tz} className="flex items-center justify-between gap-4 px-5 py-3">
                <div>
                  <div className="text-sm font-medium">{name}</div>
                  <div className="font-mono text-xs text-muted">{tz}</div>
                </div>
                <div className="text-right">
                  <LocalClock timezone={tz} className="text-sm text-fg" />
                  <div className={cx('mt-0.5 flex items-center justify-end gap-1.5 text-xs', ok ? 'text-fg-2' : 'text-muted')}>
                    <span className={cx('size-1.5 rounded-full', ok ? 'bg-brand-600' : 'bg-line-strong')} aria-hidden />
                    {ok ? 'Good time to call' : 'Outside calling hours'}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        <Formula>Calling hours = 8:00–19:00 on weekdays in the carrier’s local time. Your time zone: {mine}</Formula>
      </div>
      <div>
        <Field label="What time is it in">
          <Select value={state} onChange={(e) => setState(e.target.value)}>{US_STATES.map((s) => <option key={s}>{s}</option>)}</Select>
        </Field>
        <div className="mt-4">
          <Results keyLabel={`Local time in ${state}`} keyValue={<LocalClock timezone={STATE_TZ[state]} className="text-[28px] text-brand-700 dark:text-brand-300" />}
            rows={[['Time zone', STATE_TZ[state] || '—'], ['Calling now', callable(STATE_TZ[state]) ? 'Yes' : 'No — schedule for 8:00 local']]}
            note="States with two time zones use the zone most of the state is in." />
        </div>
      </div>
    </div>
  );
}

const UNITS = {
  weight: { a: 'lbs', b: 'kg', toB: (v) => v * 0.45359237, toA: (v) => v / 0.45359237 },
  distance: { a: 'miles', b: 'km', toB: (v) => v * 1.609344, toA: (v) => v / 1.609344 },
  temperature: { a: '°F', b: '°C', toB: (v) => ((v - 32) * 5) / 9, toA: (v) => (v * 9) / 5 + 32 },
  volume: { a: 'gallons', b: 'liters', toB: (v) => v * 3.785411784, toA: (v) => v / 3.785411784 },
};
function ConverterTool() {
  const [kind, setKind] = useState('weight');
  const [a, setA] = useState('44000');
  const [b, setB] = useState(String(UNITS.weight.toB(44000).toFixed(1)));
  const u = UNITS[kind];
  const fmt = (v) => (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '');
  return (
    <div className="max-w-2xl">
      <Field label="Convert"><Select value={kind} onChange={(e) => { const k = e.target.value; setKind(k); setB(fmt(UNITS[k].toB(n(a) ?? 0))); }}>
        {Object.keys(UNITS).map((k) => <option key={k} value={k}>{label(k)} ({UNITS[k].a} and {UNITS[k].b})</option>)}
      </Select></Field>
      <div className="mt-4 grid grid-cols-[1fr_auto_1fr] items-end gap-3">
        <NumField label={u.a} value={a} onChange={(e) => { setA(e.target.value); setB(n(e.target.value) == null ? '' : fmt(u.toB(n(e.target.value)))); }} />
        <ArrowLeftRight className="mb-2.5 size-4 text-muted" aria-hidden />
        <NumField label={u.b} value={b} onChange={(e) => { setB(e.target.value); setA(n(e.target.value) == null ? '' : fmt(u.toA(n(e.target.value)))); }} />
      </div>
      <Formula>1 lb = 0.4536 kg · 1 mi = 1.6093 km · °C = (°F − 32) × 5 ÷ 9 · 1 gal = 3.7854 L</Formula>
    </div>
  );
}

function CompareTool() {
  const blank = { name: '', rate: '', loaded: '', deadhead: '' };
  const [loads, setLoads] = useState([{ name: 'Load A', rate: '2200', loaded: '781', deadhead: '40' }, { name: 'Load B', rate: '1850', loaded: '612', deadhead: '95' }, { ...blank, name: 'Load C' }]);
  const set = (i, k, v) => setLoads((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const calc = loads.map((l) => ({ ...l, c: calculateLoad({ rateCents: n(l.rate) != null ? Math.round(n(l.rate) * 100) : 0, loadedMiles: n(l.loaded), deadheadMiles: n(l.deadhead) }) }));
  const valid = calc.filter((l) => l.c.allInRatePerMile != null && n(l.rate));
  const best = valid.length ? valid.reduce((x, y) => (y.c.allInRatePerMile > x.c.allInRatePerMile ? y : x)) : null;
  return (
    <div>
      <div className="grid gap-4 md:grid-cols-3">
        {calc.map((l, i) => (
          <div key={i} className={cx('rounded-xl border p-4', best === l ? 'border-fg/25 shadow-[var(--shadow-float)]' : 'border-line')}>
            <Input aria-label={`Load ${i + 1} name`} value={l.name} onChange={(e) => set(i, 'name', e.target.value)} className="mb-3 font-medium" />
            <div className="space-y-3">
              <NumField label="Rate ($)" min="0" value={l.rate} onChange={(e) => set(i, 'rate', e.target.value)} />
              <NumField label="Loaded miles" min="0" value={l.loaded} onChange={(e) => set(i, 'loaded', e.target.value)} />
              <NumField label="Deadhead miles" min="0" value={l.deadhead} onChange={(e) => set(i, 'deadhead', e.target.value)} />
            </div>
            <dl className="mt-4 space-y-1.5 border-t border-line pt-3 text-sm">
              <div className="flex justify-between"><dt className="text-fg-2">Rate per mile</dt><dd className="font-mono tabular">{per(l.c.ratePerMile)}</dd></div>
              <div className="flex justify-between"><dt className="text-fg-2">All-in per mile</dt><dd className={cx('font-mono tabular', best === l && 'font-medium text-brand-700 dark:text-brand-300')}>{per(l.c.allInRatePerMile)}</dd></div>
              <div className="flex justify-between"><dt className="text-fg-2">Deadhead</dt><dd className="font-mono tabular">{l.c.deadheadPercent == null ? '—' : pct(l.c.deadheadPercent)}</dd></div>
            </dl>
            {best === l && <p className="mt-3 text-xs text-brand-700 dark:text-brand-300">Best all-in rate</p>}
          </div>
        ))}
      </div>
      <Formula>Ranked by all-in rate per mile = rate ÷ (loaded + deadhead miles). Check pickup times, lanes out of the destination and broker pay terms too.</Formula>
    </div>
  );
}

function LookupTool() {
  const [kind, setKind] = useState('dot');
  const [value, setValue] = useState('');
  const [state, setState] = useState({ status: 'idle' });
  const run = async (e) => {
    e.preventDefault();
    const v = value.replace(/\D/g, '');
    if (!v) return;
    setState({ status: 'loading' });
    try { setState({ status: 'done', data: await api.get('/api/discovery/lookup', { [kind]: v }) }); }
    catch (err) { setState({ status: 'error', error: err }); }
  };
  const save = useApiMutation((dot) => api.post('/api/discovery/save', { dotNumbers: [dot] }), {
    success: (d) => (d.created ? 'Carrier added to your list' : 'Already in your list'), invalidate: [['carriers']],
    onSuccess: (d) => setState((s) => ({ ...s, savedId: d.ids?.[0] })),
  });
  const r = state.data?.record;
  const sources = state.data?.sources;
  return (
    <div className="max-w-3xl">
      <form onSubmit={run} className="flex flex-wrap items-end gap-3">
        <Field label="Search by"><Select value={kind} onChange={(e) => setKind(e.target.value)} className="w-32"><option value="dot">USDOT</option><option value="mc">MC</option></Select></Field>
        <Field label={kind === 'dot' ? 'USDOT number' : 'MC number'}><Input inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} className="w-48 font-mono" placeholder={kind === 'dot' ? '1234567' : '123456'} /></Field>
        <Button type="submit" icon={Search} loading={state.status === 'loading'}>Look up</Button>
      </form>
      <div className="mt-6">
        {state.status === 'error' && <ErrorState error={state.error} title="Lookup failed" />}
        {state.status === 'done' && !r && <p className="text-sm text-fg-2">No carrier found in the FMCSA census for that number.</p>}
        {r && (
          <div className="rounded-xl border border-line">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
              <div>
                <div className="text-base font-medium">{r.companyName}</div>
                {r.dbaName && <div className="text-sm text-fg-2">DBA {r.dbaName}</div>}
                <div className="mt-1 font-mono text-xs text-muted">USDOT {r.dotNumber}{r.mcNumber ? ` · MC ${r.mcNumber}` : ''}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                {r.existsInCrm || state.savedId ? (
                  <Button size="sm" variant="secondary" to={`/app/carriers/${r.existingId || state.savedId}`}>Open in your list</Button>
                ) : (
                  <Button size="sm" loading={save.isPending} onClick={() => save.mutate(r.dotNumber)}>Add to CRM</Button>
                )}
                <Button size="sm" variant="ghost" href={`https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${r.dotNumber}`} target="_blank" rel="noopener noreferrer">
                  SAFER snapshot <ExternalLink className="size-3.5" />
                </Button>
              </div>
            </div>
            <dl className="grid gap-x-8 gap-y-3 px-5 py-4 text-sm sm:grid-cols-2">
              {[
                ['USDOT status', r.operatingStatus || label(r.authorityStatus)],
                ['Added to USDOT', r.authorityDate ? date(r.authorityDate) : '—'],
                ['Power units', r.fleetSize ?? '—'],
                ['Drivers', r.drivers ?? '—'],
                ['Phone', r.phone || '—'],
                ['Email', r.email || '—'],
                ['Address', [r.address, r.city, r.state, r.zip].filter(Boolean).join(', ') || '—'],
                ['Operation', r.carrierOperation || '—'],
                ['Classification', r.classification || '—'],
              ].map(([k, v]) => (
                <div key={k}><dt className="text-xs text-muted">{k}</dt><dd className="mt-0.5">{v}</dd></div>
              ))}
            </dl>
            <p className="border-t border-line px-5 py-3 text-xs text-muted">
              Source: FMCSA Company Census (data.transportation.gov){Array.isArray(sources) && sources.length ? ` · ${sources.map((s) => (typeof s === 'string' ? s : s.label || s.name || s.key)).join(', ')}` : ''} · retrieved {new Date(state.data.retrievedAt).toLocaleString()}.
              USDOT status is registration status, not operating authority. Verify authority and insurance on SAFER before booking.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- page

const TOOLS = [
  { key: 'rate', label: 'Rate per mile', icon: Calculator, desc: 'Loaded and all-in rate per mile with fuel and fee', C: RateTool },
  { key: 'compare', label: 'Compare loads', icon: Columns3, desc: 'Rank up to three loads by all-in rate', C: CompareTool },
  { key: 'breakeven', label: 'Break-even rate', icon: Scale, desc: 'Minimum rate per mile to cover your costs', C: BreakEvenTool },
  { key: 'deadhead', label: 'Deadhead cost', icon: Route, desc: 'What empty miles cost you', C: DeadheadTool },
  { key: 'fuel', label: 'Trip fuel cost', icon: Fuel, desc: 'Gallons and fuel cost for a trip', C: FuelTool },
  { key: 'detention', label: 'Detention', icon: Timer, desc: 'Billable detention from in and out times', C: DetentionTool },
  { key: 'factoring', label: 'Factoring cost', icon: Landmark, desc: 'Advance, fee, reserve and effective rate', C: FactoringTool },
  { key: 'earnings', label: 'Dispatcher earnings', icon: Wallet, desc: 'Your income from fees per week and month', C: EarningsTool },
  { key: 'timezones', label: 'Time zone board', icon: Clock, desc: 'Local time and calling hours across the US', C: TimeZoneTool },
  { key: 'convert', label: 'Unit converter', icon: ArrowLeftRight, desc: 'Weight, distance, reefer temperature, fuel', C: ConverterTool },
  { key: 'lookup', label: 'FMCSA lookup', icon: Search, desc: 'Census record by USDOT or MC number', C: LookupTool },
];

export default function ToolsHub() {
  const [sp, setSp] = useSearchParams();
  const active = useMemo(() => TOOLS.find((t) => t.key === sp.get('tool')) || TOOLS[0], [sp]);
  const Tool = active.C;
  return (
    <div>
      <PageHeader title="Dispatch tools" subtitle="Calculators and lookups for everyday dispatch work. Every tool shows its formula."
        actions={<Button variant="secondary" to="/app/loads/calculator">Full rate calculator</Button>} />
      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <nav aria-label="Tools" className="self-start rounded-xl border border-line bg-surface p-2">
          <Select aria-label="Choose a tool" className="mb-1 lg:hidden" value={active.key} onChange={(e) => setSp({ tool: e.target.value }, { replace: true })}>
            {TOOLS.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </Select>
          <ul className="hidden space-y-0.5 lg:block">
            {TOOLS.map((t) => (
              <li key={t.key}>
                <Link to={`?tool=${t.key}`} replace aria-current={t.key === active.key ? 'page' : undefined}
                  className={cx('flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm transition-ui', t.key === active.key ? 'bg-surface-2 font-medium text-fg' : 'text-fg-2 hover:bg-surface-2/60 hover:text-fg')}>
                  <t.icon className={cx('size-4 shrink-0', t.key === active.key ? 'text-brand-600 dark:text-brand-300' : 'text-muted')} strokeWidth={1.75} aria-hidden />
                  {t.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <Card title={active.label} actions={<span className="hidden text-xs text-muted sm:block">{active.desc}</span>}>
          <Tool key={active.key} />
        </Card>
      </div>
    </div>
  );
}
