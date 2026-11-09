import { useEffect, useMemo, useState } from 'react';
import { feature, mesh } from 'topojson-client';
import { geoAlbersUsa, geoPath } from 'd3-geo';
import { BY_FIPS, ZONES, localTime } from './usStates.js';
import { cx } from '../ui.jsx';

// us-atlas "states-albers-10m" is pre-projected with geoAlbersUsa().scale(1300).translate([487.5, 305]) at 975×610.
const W = 975;
const H = 610;
const projection = geoAlbersUsa().scale(1300).translate([487.5, 305]);
const path = geoPath();

let topoPromise = null;
const loadTopo = () => (topoPromise ||= import('us-atlas/states-albers-10m.json').then((m) => m.default || m));

// Vivid time-zone fills (Eastern blue, Central green, Mountain amber, Pacific purple, Alaska/Hawaii red),
// matching the sidebar clocks. Count modes use a light-to-deep blue sequential ramp.
const VARS = cx(
  '[--map-e:#3b82f6] [--map-c:#16a34a] [--map-m:#f59e0b] [--map-p:#8b5cf6] [--map-ak:#ef4444] [--map-line:#ffffff] [--map-ramp-0:#e0f2fe] [--map-ramp-1:#1d4ed8]',
  'dark:[--map-e:#2563eb] dark:[--map-c:#15803d] dark:[--map-m:#d97706] dark:[--map-p:#7c3aed] dark:[--map-ak:#dc2626] dark:[--map-line:#0f0f10] dark:[--map-ramp-0:#1e293b] dark:[--map-ramp-1:#60a5fa]',
);

const SMALL = new Set(['RI', 'DE', 'DC', 'CT', 'NJ', 'MD', 'MA', 'NH', 'VT', 'HI']);

/**
 * US states map.
 * mode: 'zones' (time zones) | 'carriers' (FMCSA active carriers) | 'mine' (your carriers).
 * values: { [stateCode]: number } for the count modes. route: [{lat, lon, label}] drawn as a line with stop markers.
 */
export default function MarketMap({ mode = 'zones', values = {}, selected, onSelect, route = [], className }) {
  const [topo, setTopo] = useState(null);
  const [error, setError] = useState(null);
  const [hover, setHover] = useState(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { loadTopo().then(setTopo).catch((e) => setError(e.message)); }, []);
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);

  const shapes = useMemo(() => {
    if (!topo) return null;
    const states = feature(topo, topo.objects.states).features
      .map((f) => ({ f, s: BY_FIPS[String(f.id).padStart(2, '0')] }))
      .filter((x) => x.s)
      .map(({ f, s }) => ({ ...s, d: path(f), c: path.centroid(f), area: path.area(f) }));
    return { states, borders: path(mesh(topo, topo.objects.states, (a, b) => a !== b)) };
  }, [topo]);

  const max = useMemo(() => Math.max(1, ...Object.values(values).map(Number).filter(Number.isFinite)), [values]);
  const fillFor = (s) => {
    if (mode === 'zones') return ZONES[s.zone]?.fill || 'var(--map-p)';
    const v = Number(values[s.code]) || 0;
    // Square-root scale so large states do not flatten the rest.
    const t = v > 0 ? 0.12 + 0.88 * Math.sqrt(v / max) : 0;
    return `color-mix(in oklab, var(--map-ramp-1) ${Math.round(t * 100)}%, var(--map-ramp-0))`;
  };

  const points = route.map((p) => ({ ...p, xy: projection([p.lon, p.lat]) })).filter((p) => p.xy);
  const hovered = hover && shapes?.states.find((s) => s.code === hover.code);

  if (error) return <div className="flex aspect-[975/610] items-center justify-center text-sm text-muted">Map could not load: {error}</div>;
  return (
    <div className={cx('relative', VARS, className)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Map of US states">
        {!shapes && <rect width={W} height={H} rx="12" className="fill-surface-2" />}
        {shapes?.states.map((s) => (
          <path key={s.code} d={s.d} fill={fillFor(s)}
            className={cx('cursor-pointer outline-none transition-[filter] duration-150 hover:brightness-110 hover:saturate-125 focus-visible:brightness-110 dark:hover:brightness-125',
              selected === s.code && 'stroke-fg [stroke-width:3]')}
            tabIndex={0} role="button" aria-label={`${s.name}${mode !== 'zones' ? `, ${Number(values[s.code] || 0).toLocaleString('en-US')}` : ''}`}
            onMouseMove={(e) => {
              const box = e.currentTarget.ownerSVGElement.getBoundingClientRect();
              setHover({ code: s.code, x: e.clientX - box.left, y: e.clientY - box.top, w: box.width });
            }}
            onMouseLeave={() => setHover(null)}
            onClick={() => onSelect?.(s.code)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(s.code); } }} />
        ))}
        {shapes && <path d={shapes.borders} fill="none" stroke="var(--map-line)" strokeWidth="1" strokeLinejoin="round" pointerEvents="none" />}
        {shapes?.states.filter((s) => !SMALL.has(s.code) && s.area > 900).map((s) => (
          <text key={`l-${s.code}`} x={s.c[0]} y={s.c[1]} textAnchor="middle" dominantBaseline="central" pointerEvents="none"
            className={cx('font-mono text-[11px] font-semibold tracking-wide', mode === 'zones' ? 'fill-white [paint-order:stroke] [stroke:rgb(0_0_0/0.25)] [stroke-width:2px]' : selected === s.code ? 'fill-fg' : 'fill-fg/80')}>{s.code}</text>
        ))}
        {points.length > 1 && (
          <polyline points={points.map((p) => p.xy.join(',')).join(' ')} fill="none" className="stroke-fg" strokeWidth="2.5" strokeDasharray="6 5" strokeLinecap="round" pointerEvents="none" />
        )}
        {points.map((p, i) => (
          <g key={`p-${i}`} transform={`translate(${p.xy[0]},${p.xy[1]})`} pointerEvents="none">
            <circle r="9" className={i === 0 ? 'fill-brand-600' : i === points.length - 1 ? 'fill-fg' : 'fill-surface stroke-fg'} strokeWidth="2" />
            <text textAnchor="middle" dominantBaseline="central" className={cx('font-mono text-[10px]', i === 0 || i === points.length - 1 ? 'fill-bg' : 'fill-fg')}>{String.fromCharCode(65 + i)}</text>
          </g>
        ))}
      </svg>
      {hovered && (
        <div className="pointer-events-none absolute z-10 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg"
          style={{ left: Math.min(hover.x + 14, hover.w - 190), top: hover.y + 14 }}>
          <div className="font-medium text-fg">{hovered.name}</div>
          <div className="mt-0.5 text-muted">{ZONES[hovered.zone]?.label} · <span className="tabular">{localTime(hovered.tz, now)}</span></div>
          {mode !== 'zones' && <div className="mt-0.5 tabular text-fg-2">{Number(values[hovered.code] || 0).toLocaleString('en-US')} {mode === 'mine' ? 'in your CRM' : 'active carriers'}</div>}
        </div>
      )}
    </div>
  );
}

export function MapLegend({ mode, max }) {
  if (mode === 'zones') {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-2">
        {['E', 'C', 'M', 'P', 'AK'].map((z) => (
          <span key={z} className="inline-flex items-center gap-1.5"><span className={cx('size-2.5 rounded-sm border border-line', VARS)} style={{ background: ZONES[z].fill }} />{z === 'AK' ? 'Alaska and Hawaii' : ZONES[z].label}</span>
        ))}
      </div>
    );
  }
  return (
    <div className={cx('flex items-center gap-2 text-xs text-fg-2', VARS)}>
      <span className="tabular">0</span>
      <span className="h-2 w-32 rounded-full" style={{ background: 'linear-gradient(to right, var(--map-ramp-0), var(--map-ramp-1))' }} />
      <span className="tabular">{Number(max || 0).toLocaleString('en-US')}</span>
      <span className="text-muted">{mode === 'mine' ? 'carriers in your CRM' : 'active carriers (FMCSA)'}</span>
    </div>
  );
}
