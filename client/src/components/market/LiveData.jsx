import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CloudSun, MapPin, Search, X } from 'lucide-react';
import { api } from '../../lib/api.js';
import { US_STATES, date, dateTime, relative } from '../../lib/format.js';
import { Badge, Card, Input, Select, Spinner, cx } from '../ui.jsx';
import { SourceLink, Change } from './panels.jsx';
import { BY_CODE } from './usStates.js';

/** Free real-time data on the Market page: fuel history, weather alerts, weather at a place, holidays, indicators, sources. */

export function Sparkline({ points, width = 160, height = 40, className }) {
  if (!points?.length || points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const xy = points.map((v, i) => [(i / (points.length - 1)) * width, height - 4 - ((v - min) / span) * (height - 8)]);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = xy.at(-1);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={cx('overflow-visible', className)} aria-hidden>
      <path d={`${d} L${width},${height} L0,${height} Z`} className="fill-brand-500/10" />
      <path d={d} fill="none" className="stroke-brand-600" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r="2.75" className="fill-brand-600" />
    </svg>
  );
}

const price = (n) => (n == null ? '—' : `$${n.toFixed(3)}`);
const delta = (v) => (v == null ? <span className="text-muted">—</span>
  : <span className={v > 0 ? 'text-red-700 dark:text-red-300' : v < 0 ? 'text-green-700 dark:text-green-400' : 'text-muted'}>{v > 0 ? '+' : ''}{v.toFixed(3)}</span>);

/** Diesel + gasoline, national with a 12-week line, and a by-region table. */
export function FuelCards({ diesel, gasoline }) {
  if (!diesel.configured) {
    return (
      <Card>
        <p className="text-sm font-medium">Fuel prices are not connected</p>
        <p className="mt-1 text-[13px] text-fg-2">Weekly retail diesel and gasoline come from the U.S. Energy Information Administration. An admin can add a free EIA API key in Admin → Settings → Integrations.</p>
        <div className="mt-3"><SourceLink href="https://www.eia.gov/opendata/register.php">Get a free EIA key</SourceLink></div>
      </Card>
    );
  }
  const hist = diesel.history || [];
  const gasBy = Object.fromEntries((gasoline?.regions || []).map((r) => [r.region, r]));
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(280px,1fr)_minmax(220px,0.8fr)_2fr]">
      <Card bodyClass="p-5">
        <p className="text-[13px] text-fg-2">Diesel, U.S. average</p>
        {diesel.national ? (
          <>
            <div className="mt-2 flex items-end justify-between gap-3">
              <p className="text-4xl font-medium tracking-tight tabular">${diesel.national.price.toFixed(3)}<span className="ml-1 text-base font-normal text-muted">/gal</span></p>
              <Sparkline points={hist.map((h) => h.price)} />
            </div>
            <p className="mt-1 text-[13px]"><Change value={diesel.national.change} /></p>
            <p className="mt-3 text-xs text-muted">Week of {diesel.national.period}{hist.length > 1 ? ` · line shows ${hist.length} weeks from ${hist[0].period}` : ''}</p>
          </>
        ) : <p className="mt-2 text-sm text-muted">{diesel.error || 'No data'}</p>}
        <div className="mt-3"><SourceLink href={diesel.sourceUrl}>Source: EIA weekly retail prices</SourceLink></div>
      </Card>
      <Card bodyClass="p-5">
        <p className="text-[13px] text-fg-2">Regular gasoline, U.S. average</p>
        {gasoline?.national ? (
          <>
            <p className="mt-2 text-3xl font-medium tracking-tight tabular">${gasoline.national.price.toFixed(3)}<span className="ml-1 text-base font-normal text-muted">/gal</span></p>
            <p className="mt-1 text-[13px]"><Change value={gasoline.national.change} /></p>
            <p className="mt-3 text-xs text-muted">Week of {gasoline.national.period}. Useful for box trucks and pickups on gas.</p>
          </>
        ) : <p className="mt-2 text-sm text-muted">No gasoline data this week</p>}
      </Card>
      <Card title="By region" bodyClass="p-0">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line text-left text-xs text-muted">
            <th className="px-5 py-2 font-normal">Region</th><th className="px-3 py-2 text-right font-normal">Diesel</th><th className="px-3 py-2 text-right font-normal">Week</th>
            <th className="px-3 py-2 text-right font-normal">Gasoline</th><th className="px-5 py-2 text-right font-normal">Week</th>
          </tr></thead>
          <tbody>
            {(diesel.regions || []).map((r) => (
              <tr key={r.region} className="border-b border-line last:border-0">
                <td className="px-5 py-2.5 text-fg-2">{r.regionLabel}</td>
                <td className="px-3 py-2.5 text-right font-medium tabular">{price(r.price)}</td>
                <td className="px-3 py-2.5 text-right text-xs tabular">{delta(r.change)}</td>
                <td className="px-3 py-2.5 text-right tabular text-fg-2">{price(gasBy[r.region]?.price)}</td>
                <td className="px-5 py-2.5 text-right text-xs tabular">{delta(gasBy[r.region]?.change ?? null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {diesel.error && <p className="px-5 pb-3 text-xs text-muted">{diesel.error}</p>}
      </Card>
    </div>
  );
}

const SEV = { Extreme: 'red', Severe: 'red', Moderate: 'amber', Minor: 'blue', Unknown: 'gray' };

/** NWS alerts for chosen states (defaults to where your carriers are). */
export function WeatherAlerts() {
  const [states, setStates] = useState(null); // null = server default (your carrier states)
  const [adding, setAdding] = useState('');
  const key = states ? states.join(',') : '';
  const q = useQuery({ queryKey: ['market', 'alerts', key], queryFn: () => api.get('/api/market/alerts', states ? { states: key } : {}), staleTime: 300000, retry: false });
  const shown = states ?? q.data?.states ?? [];
  const [sev, setSev] = useState('all');
  const items = (q.data?.items || []).filter((a) => sev === 'all' || (sev === 'severe' ? ['Extreme', 'Severe'].includes(a.severity) : true));
  const add = (s) => { if (s && !shown.includes(s)) setStates([...shown, s].slice(0, 15)); setAdding(''); };
  return (
    <Card title="Weather alerts" actions={<SourceLink href="https://alerts.weather.gov/">National Weather Service</SourceLink>}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {shown.map((s) => (
          <span key={s} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 py-0.5 pl-2 pr-1 text-xs">
            {s}<button type="button" aria-label={`Remove ${s}`} onClick={() => setStates(shown.filter((x) => x !== s))} className="rounded p-0.5 text-muted hover:text-fg"><X className="size-3" /></button>
          </span>
        ))}
        <Select aria-label="Add a state" value={adding} onChange={(e) => add(e.target.value)} className="h-8 w-32 text-xs">
          <option value="">Add state</option>
          {US_STATES.filter((s) => !shown.includes(s)).map((s) => <option key={s} value={s}>{s} · {BY_CODE[s]?.name || s}</option>)}
        </Select>
        <span className="flex-1" />
        <Select aria-label="Severity" value={sev} onChange={(e) => setSev(e.target.value)} className="h-8 w-36 text-xs">
          <option value="all">All alerts</option><option value="severe">Severe and extreme</option>
        </Select>
      </div>
      {q.isLoading ? <Spinner /> : q.data?.error ? <p className="text-sm text-muted">{q.data.error}</p>
        : !shown.length ? <p className="text-sm text-muted">Add a state, or add carriers with a state, to watch alerts there.</p>
          : !items.length ? <p className="text-sm text-muted">No active alerts in {shown.join(', ')}.</p> : (
            <ul className="max-h-96 divide-y divide-line overflow-y-auto">
              {items.map((a) => (
                <li key={a.id} className="py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm"><Badge color={SEV[a.severity] || 'gray'} className="mr-2">{a.severity}</Badge><span className="font-medium">{a.event}</span></p>
                    {a.expires && <span className="shrink-0 text-xs text-muted" title={dateTime(a.expires)}>until {dateTime(a.expires)}</span>}
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-fg-2">{a.areaDesc}</p>
                </li>
              ))}
            </ul>
          )}
      {q.data?.total > (q.data?.items?.length || 0) && <p className="mt-2 text-xs text-muted">Showing {q.data.items.length} of {q.data.total}.</p>}
    </Card>
  );
}

/** Geocode a place (Photon / OSM) and show current weather + alerts there. */
export function WeatherAtPlace() {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [place, setPlace] = useState(null);
  useEffect(() => { const t = setTimeout(() => setQuery(text.trim()), 450); return () => clearTimeout(t); }, [text]);
  const geo = useQuery({ queryKey: ['market', 'geocode', query], queryFn: () => api.get('/api/market/geocode', { q: query }), enabled: query.length >= 2 && !place, staleTime: 86400000, retry: false });
  const wx = useQuery({ queryKey: ['market', 'weather', place?.lat, place?.lng], queryFn: () => api.get('/api/market/weather', { lat: place.lat, lng: place.lng }), enabled: !!place, staleTime: 600000, retry: false });
  const c = wx.data?.current;
  return (
    <Card title="Weather at a stop" actions={<SourceLink href="https://open-meteo.com/">Open-Meteo, NWS</SourceLink>}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" aria-hidden />
        <Input aria-label="City or address" value={text} placeholder="City, ST or address" className="pl-8"
          onChange={(e) => { setText(e.target.value); setPlace(null); }} />
      </div>
      {!place && query.length >= 2 && (
        <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
          {geo.isLoading && <li className="px-3 py-2"><Spinner className="size-4" /></li>}
          {(geo.data?.items || []).slice(0, 6).map((p) => (
            <li key={`${p.label}${p.lat}`}>
              <button type="button" onClick={() => { setPlace(p); setText(p.label); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2">
                <MapPin className="size-3.5 shrink-0 text-muted" aria-hidden />{p.label}{p.source === 'centroid' && <span className="ml-auto text-xs text-muted">approximate</span>}
              </button>
            </li>
          ))}
          {geo.data && !geo.data.items.length && <li className="px-3 py-2 text-sm text-muted">No US place found</li>}
        </ul>
      )}
      {geo.data?.note && !place && <p className="mt-2 text-xs text-muted">{geo.data.note}</p>}
      {place && (
        <div className="mt-4">
          {wx.isLoading ? <Spinner /> : (
            <>
              {c ? (
                <div className="flex items-center gap-4">
                  <CloudSun className="size-8 text-fg-2" strokeWidth={1.5} aria-hidden />
                  <div>
                    <p className="text-2xl font-medium tabular">{Math.round(c.tempF)}°F <span className="text-sm font-normal text-fg-2">{c.description}</span></p>
                    <p className="text-xs text-muted tabular">Wind {Math.round(c.windMph)} mph{c.gustMph != null ? `, gusts ${Math.round(c.gustMph)}` : ''} · observed {relative(c.observedAt + 'Z')}</p>
                  </div>
                </div>
              ) : null}
              {(wx.data?.alerts || []).slice(0, 4).map((a) => (
                <p key={a.id} className="mt-3 text-sm"><Badge color={SEV[a.severity] || 'gray'} className="mr-2">{a.severity}</Badge>{a.event}</p>
              ))}
              {wx.data && !wx.data.alerts?.length && <p className="mt-3 text-xs text-muted">No active NWS alerts at this point.</p>}
              {(wx.data?.errors || []).map((e) => <p key={e} className="mt-2 text-xs text-muted">{e}</p>)}
            </>
          )}
        </div>
      )}
      <p className="mt-3 text-[11.5px] text-muted">Place search © OpenStreetMap contributors (Photon). Weather by Open-Meteo.com, CC BY 4.0.</p>
    </Card>
  );
}

export function Holidays() {
  const q = useQuery({ queryKey: ['market', 'holidays'], queryFn: () => api.get('/api/market/holidays'), staleTime: 3600000 });
  return (
    <Card title="Upcoming holidays" actions={<SourceLink href="https://date.nager.at/">Nager.Date</SourceLink>}>
      {q.isLoading ? <Spinner /> : q.data?.error ? <p className="text-sm text-muted">{q.data.error}</p> : (
        <ul className="space-y-3">
          {(q.data?.items || []).map((h) => {
            const days = Math.round((new Date(`${h.date}T12:00:00`) - new Date()) / 86400000);
            return (
              <li key={h.date + h.name}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-medium">{h.name}</span>
                  <span className="shrink-0 text-xs text-muted tabular">{date(`${h.date}T12:00:00`)} · {days <= 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}</span>
                </div>
                {h.note && <p className="mt-0.5 text-xs text-fg-2">{h.note}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function NotConnected({ children, keyUrl }) {
  return (
    <div>
      <p className="text-[13px] text-fg-2">{children}</p>
      {keyUrl && <div className="mt-2"><SourceLink href={keyUrl}>Get a free key</SourceLink></div>}
    </div>
  );
}

export function Indicators() {
  const q = useQuery({ queryKey: ['market', 'indicators'], queryFn: () => api.get('/api/market/indicators'), staleTime: 3600000, retry: false });
  const t = q.data?.truckTonnage;
  const u = q.data?.usdaTruckRates;
  const cols = useMemo(() => {
    const first = u?.rows?.[0];
    return first ? Object.keys(first).slice(0, 7) : [];
  }, [u]);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(280px,1fr)_2fr]">
      <Card title="Truck tonnage" actions={t && <SourceLink href={t.sourceUrl}>FRED · ATA</SourceLink>}>
        {q.isLoading ? <Spinner /> : !t?.configured ? <NotConnected keyUrl="https://fred.stlouisfed.org/docs/api/api_key.html">Monthly for-hire truck tonnage index from the American Trucking Associations, via FRED. An admin can add a free FRED key in Admin → Settings → Integrations.</NotConnected>
          : t.error ? <p className="text-sm text-muted">{t.error}</p> : (
            <>
              <div className="flex items-end justify-between gap-3">
                <p className="text-3xl font-medium tabular">{t.latest?.value.toFixed(1)}</p>
                <Sparkline points={t.points.map((p) => p.value)} />
              </div>
              <p className="mt-1 text-[13px] text-fg-2 tabular">
                {t.change != null && <>{t.change > 0 ? '+' : ''}{t.change} vs prior month</>}{t.yoyPct != null && <> · {t.yoyPct > 0 ? '+' : ''}{t.yoyPct}% vs a year earlier</>}
              </p>
              <p className="mt-2 text-xs text-muted">{t.title}, {t.latest?.date}. 2015 = 100.</p>
            </>
          )}
      </Card>
      <Card title="Produce truck rates" actions={u && <SourceLink href={u.pdfUrl}>USDA weekly report (PDF)</SourceLink>}>
        {q.isLoading ? <Spinner /> : !u?.configured ? (
          <NotConnected keyUrl="https://mymarketnews.ams.usda.gov/mymarketnews-api">USDA Market News publishes refrigerated truck rates from major produce shipping areas every week. Open the free PDF, or an admin can add a free My Market News API key to show the latest rows here.</NotConnected>
        ) : u.error ? <p className="text-sm text-muted">{u.error}</p> : (
          <>
            <p className="mb-3 text-xs text-muted">{u.title}{u.reportDate ? `, report of ${u.reportDate}` : ''}. Columns as published by USDA.</p>
            <div className="max-h-80 overflow-auto rounded-lg border border-line">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface-2"><tr>{cols.map((c) => <th key={c} className="px-3 py-2 text-left font-medium text-fg-2">{c.replace(/_/g, ' ')}</th>)}</tr></thead>
                <tbody>{u.rows.map((r, i) => <tr key={i} className="border-t border-line">{cols.map((c) => <td key={c} className="px-3 py-1.5 tabular">{String(r[c] ?? '')}</td>)}</tr>)}</tbody>
              </table>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

const STATE_BADGE = { connected: ['green', 'Connected'], ready: ['gray', 'Ready'], needs_key: ['amber', 'Needs free key'], error: ['red', 'Error'] };

export function DataSources() {
  const q = useQuery({ queryKey: ['market', 'sources'], queryFn: () => api.get('/api/market/sources'), staleTime: 60000 });
  return (
    <Card title="Data sources" bodyClass="p-0">
      <p className="px-5 pt-4 text-[13px] text-fg-2">Every number on this page comes from a free public source. Nothing is estimated unless it says so.</p>
      {q.isLoading ? <div className="p-5"><Spinner /></div> : (
        <div className="overflow-x-auto">
          <table className="mt-3 w-full text-sm">
            <thead><tr className="border-y border-line text-left text-xs text-muted">
              <th className="px-5 py-2 font-normal">Source</th><th className="px-3 py-2 font-normal">Provides</th><th className="px-3 py-2 font-normal">Status</th>
              <th className="px-3 py-2 font-normal">Last fetched</th><th className="px-5 py-2 font-normal">Terms</th>
            </tr></thead>
            <tbody>
              {(q.data?.items || []).map((s) => {
                const [color, label] = STATE_BADGE[s.state] || STATE_BADGE.ready;
                return (
                  <tr key={s.id} className="border-b border-line last:border-0 align-top">
                    <td className="px-5 py-2.5 font-medium">{s.name}</td>
                    <td className="px-3 py-2.5 text-fg-2">{s.provides}</td>
                    <td className="px-3 py-2.5"><Badge color={color}>{label}</Badge>{s.state === 'error' && s.lastError && <p className="mt-1 max-w-xs text-xs text-muted">{s.lastError}</p>}</td>
                    <td className="px-3 py-2.5 text-xs text-muted">{s.lastOkAt ? relative(s.lastOkAt) : '—'}</td>
                    <td className="px-5 py-2.5"><SourceLink href={s.needsKey && s.state === 'needs_key' ? s.keyUrl : s.terms}>{s.needsKey && s.state === 'needs_key' ? 'Get key' : 'Terms'}</SourceLink></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="px-5 py-3 text-[11.5px] text-muted">Map and place data © OpenStreetMap contributors. Routes by OSRM. Weather by Open-Meteo.com (CC BY 4.0) and the National Weather Service. Fuel by EIA.</p>
    </Card>
  );
}

