import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, Fuel, SquareParking, Trees } from 'lucide-react';
import { cx } from '../ui.jsx';
import { CORRIDOR_MILES, parkingAlongRoute } from './parkingCorridor.js';
import './parking.css';

/**
 * Truck parking layer for the fleet map: truck stops, rest areas and truck parking from OpenStreetMap, built once by
 * tools/parking/build.mjs into a static file. Nothing is called at runtime except that one file (fetched on first use,
 * then kept in memory and in the browser's HTTP cache). The map source is set once per data load; the "along this
 * route" highlight is set only when the set of nearby places changes. Space availability is not known and not shown.
 */

export const PARKING_URL = '/data/truck-parking.json';
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
const ATTRIBUTION_HTML = '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>';

export const PARKING_KINDS = {
  1: { label: 'Truck stop', color: '#ea580c', text: 'text-c-orange', soft: 'bg-c-orange-soft', Icon: Fuel },
  2: { label: 'Rest area', color: '#16a34a', text: 'text-c-green', soft: 'bg-c-green-soft', Icon: Trees },
  3: { label: 'Truck parking', color: '#2563eb', text: 'text-c-blue', soft: 'bg-c-blue-soft', Icon: SquareParking },
};
const kindOf = (k) => PARKING_KINDS[k] || PARKING_KINDS[3];

// Lucide glyphs (24-unit paths, ISC) drawn white on the map badges.
const GLYPHS = {
  1: { scale: 1, paths: ['M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0v-6.998a2 2 0 0 0-.59-1.42L18 5', 'M14 21V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v16', 'M2 21h13', 'M3 9h11'] },
  2: { scale: 1, paths: ['M10 10v.2A3 3 0 0 1 8.9 16H5a3 3 0 0 1-1-5.8V10a3 3 0 0 1 6 0Z', 'M7 16v6', 'M13 19v3', 'M12 19h8.3a1 1 0 0 0 .7-1.7L18 14h.3a1 1 0 0 0 .7-1.7L16 9h.2a1 1 0 0 0 .8-1.7L13 3l-1.4 1.5'] },
  3: { scale: 1.55, paths: ['M9 12h4a2 2 0 0 0 0-4H9.5a.5.5 0 0 0-.5.5V16'] },
};
export const FLAG_LABELS = [[1, 'Open 24/7'], [2, 'Showers'], [4, 'Restrooms'], [8, 'Paid parking']];

const SRC = 'parking';
const ROUTE_SRC = 'parking-route';
const LAYERS = ['parking-clusters', 'parking-cluster-count', 'parking-points', 'parking-labels', 'parking-route-halo', 'parking-route-icons', 'parking-route-rank'];
const CLICKABLE = ['parking-route-icons', 'parking-route-halo', 'parking-points'];
const RANKED = 5;
const EMPTY_FC = { type: 'FeatureCollection', features: [] };

/** The parking file, fetched once when the layer is first turned on and kept for the session. */
export function useParkingData(enabled) {
  return useQuery({
    queryKey: ['fleet', 'parking-data'],
    queryFn: async ({ signal }) => {
      const r = await fetch(PARKING_URL, { signal, credentials: 'same-origin' });
      if (!r.ok) throw new Error(`Truck parking data could not load (HTTP ${r.status})`);
      const json = await r.json();
      if (!Array.isArray(json?.points)) throw new Error('Truck parking data is not valid');
      return json;
    },
    enabled: !!enabled,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

/** GeoJSON for the clustered source: only the kind, the row index and the name (for labels) travel to the map. */
export function toFeatureCollection(points) {
  return {
    type: 'FeatureCollection',
    features: points.map((p, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p[0], p[1]] }, properties: p[3] ? { k: p[2], i, n: p[3] } : { k: p[2], i } })),
  };
}

export const googleMapsUrl = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

export function milesText(m) {
  if (m == null || !Number.isFinite(m)) return '';
  return m < 10 ? `${m.toFixed(1)} mi` : `${Math.round(m).toLocaleString('en-US')} mi`;
}

/** Details for a packed row [lng, lat, kind, name, flags?, hgvSpaces?]. */
export function describe(row) {
  const [lng, lat, kind, name, flags = 0, spaces = 0] = row;
  const meta = kindOf(kind);
  const extras = FLAG_LABELS.filter(([bit]) => flags & bit).map(([, l]) => l);
  if (spaces) extras.push(`${spaces.toLocaleString('en-US')} truck spaces mapped`);
  return { lng, lat, kind, meta, title: name || meta.label, named: !!name, extras };
}

function drawBadge(kind, ring) {
  if (typeof document === 'undefined' || typeof Path2D === 'undefined') return null;
  const ratio = 2;
  const size = 26;
  const canvas = document.createElement('canvas');
  canvas.width = size * ratio;
  canvas.height = size * ratio;
  let g = null;
  try { g = canvas.getContext('2d'); } catch { g = null; }
  if (!g) return null;
  g.scale(ratio, ratio);
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2 - 1.5, 0, Math.PI * 2);
  g.fillStyle = kindOf(kind).color;
  g.fill();
  g.lineWidth = 2;
  g.strokeStyle = ring;
  g.stroke();
  const glyph = GLYPHS[kind] || GLYPHS[3];
  const k = (14 / 24) * glyph.scale;
  g.translate(size / 2 - 12 * k, size / 2 - 12 * k);
  g.scale(k, k);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 2.5 / glyph.scale;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const d of glyph.paths) g.stroke(new Path2D(d));
  return g.getImageData(0, 0, size * ratio, size * ratio);
}

function popupContent(row, near, from) {
  const d = describe(row);
  const el = document.createElement('div');
  el.className = 'min-w-[180px] max-w-[230px] space-y-1';
  const add = (tag, className, text) => {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    el.appendChild(n);
    return n;
  };
  add('div', 'font-medium leading-snug', d.title);
  add('div', cx('text-xs font-medium', d.meta.text), d.named ? d.meta.label : 'No name in OpenStreetMap');
  if (d.extras.length) add('div', 'text-xs text-fg-2', d.extras.join(' · '));
  if (near) add('div', 'text-xs text-fg-2', `${milesText(near.ahead)} ${from === 'pickup' ? 'from pickup' : 'ahead'} · ${milesText(near.off)} off the route`);
  const link = add('a', 'inline-block pt-0.5 text-[13px] font-medium text-brand-700 hover:underline dark:text-brand-300', 'Open in Google Maps');
  link.href = googleMapsUrl(d.lat, d.lng);
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  add('div', 'pt-0.5 text-[11px] leading-snug text-muted', `Space availability is not shown. ${OSM_ATTRIBUTION}`);
  return el;
}

/**
 * Imperative side of the layer: sources, layers, icons, clicks and the popup on one MapLibre map.
 * Nothing is added to the map until the layer is first turned on; after a theme switch (setStyle) it is re-added.
 */
function createController(map) {
  const state = { on: false, geo: null, routeGeo: EMPTY_FC, dim: false, points: null, near: null, from: 'truck' };
  let applied = {};
  let popup = null;

  // The fleet map's own sources exist once its style has loaded (isStyleLoaded() is still false inside style.load).
  const ready = () => !!map.getSource('trucks') || map.isStyleLoaded();
  const has = (id) => !!map.getLayer(id);

  function add() {
    const dark = document.documentElement.classList.contains('dark');
    const casing = dark ? '#0b0b0d' : '#ffffff';
    for (const k of [1, 2, 3]) {
      const id = `parking-${k}`;
      if (map.hasImage(id)) continue;
      const img = drawBadge(k, casing);
      if (img) map.addImage(id, img, { pixelRatio: 2 });
    }
    map.addSource(SRC, { type: 'geojson', data: EMPTY_FC, cluster: true, clusterRadius: 42, clusterMaxZoom: 8, attribution: ATTRIBUTION_HTML });
    map.addSource(ROUTE_SRC, { type: 'geojson', data: EMPTY_FC, attribution: ATTRIBUTION_HTML });
    // Below the fleet's trip ends, open loads and truck clusters; above the route lines.
    const before = has('trip-ends') ? 'trip-ends' : undefined;
    const icon = ['match', ['get', 'k'], 1, 'parking-1', 2, 'parking-2', 'parking-3'];
    const color = ['match', ['get', 'k'], 1, PARKING_KINDS[1].color, 2, PARKING_KINDS[2].color, PARKING_KINDS[3].color];
    const single = ['!', ['has', 'point_count']];
    map.addLayer({ id: 'parking-clusters', type: 'circle', source: SRC, filter: ['has', 'point_count'],
      paint: { 'circle-color': dark ? '#3f3f46' : '#52525b', 'circle-opacity': 0.85, 'circle-radius': ['step', ['get', 'point_count'], 11, 25, 14, 100, 17, 500, 21], 'circle-stroke-color': casing, 'circle-stroke-width': 2 } }, before);
    map.addLayer({ id: 'parking-cluster-count', type: 'symbol', source: SRC, filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-allow-overlap': true },
      paint: { 'text-color': '#ffffff' } }, before);
    map.addLayer({ id: 'parking-points', type: 'symbol', source: SRC, filter: single,
      layout: { 'icon-image': icon, 'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.75, 11, 1], 'icon-allow-overlap': true, 'icon-ignore-placement': true } }, before);
    map.addLayer({ id: 'parking-labels', type: 'symbol', source: SRC, minzoom: 11, filter: ['all', single, ['has', 'n']],
      layout: { 'text-field': ['get', 'n'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-optional': true, 'text-max-width': 10 },
      paint: { 'text-color': dark ? '#e4e4e7' : '#27272a', 'text-halo-color': casing, 'text-halo-width': 1.5 } }, before);
    // Along the route: solid dots when zoomed out, a soft ring behind a larger badge when zoomed in, and 1-5 for the next stops.
    map.addLayer({ id: 'parking-route-halo', type: 'circle', source: ROUTE_SRC,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 4.5, 6.5, 7, 11, 17],
        'circle-color': color,
        'circle-opacity': ['step', ['zoom'], 0.95, 6.5, 0.2],
        'circle-stroke-color': ['step', ['zoom'], casing, 6.5, color],
        'circle-stroke-width': 1.5,
      } }, before);
    map.addLayer({ id: 'parking-route-icons', type: 'symbol', source: ROUTE_SRC, minzoom: 6.5,
      layout: { 'icon-image': icon, 'icon-size': ['interpolate', ['linear'], ['zoom'], 6.5, 0.9, 11, 1.15], 'icon-allow-overlap': true, 'icon-ignore-placement': true } }, before);
    map.addLayer({ id: 'parking-route-rank', type: 'symbol', source: ROUTE_SRC, filter: ['>', ['get', 'r'], 0],
      // Lower numbers are placed first; a number that would sit on top of another is left out until zoomed in.
      layout: { 'text-field': ['to-string', ['get', 'r']], 'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-offset': [0, -1.5], 'symbol-sort-key': ['get', 'r'], 'text-padding': 1 },
      paint: { 'text-color': dark ? '#fafafa' : '#18181b', 'text-halo-color': casing, 'text-halo-width': 2 } }, before);
  }

  function sync() {
    if (!state.on && !map.getSource(SRC)) return; // never turned on: leave the map alone
    if (!ready()) return; // style.load will call again
    if (!map.getSource(SRC)) { add(); applied = {}; }
    if (state.geo && applied.geo !== state.geo) { map.getSource(SRC).setData(state.geo); applied.geo = state.geo; }
    if (applied.routeGeo !== state.routeGeo) { map.getSource(ROUTE_SRC).setData(state.routeGeo); applied.routeGeo = state.routeGeo; }
    if (applied.on !== state.on) {
      for (const id of LAYERS) if (has(id)) map.setLayoutProperty(id, 'visibility', state.on ? 'visible' : 'none');
      applied.on = state.on;
      if (!state.on) popup?.remove();
    }
    if (applied.dim !== state.dim) {
      // While a route is highlighted the other parking steps back.
      const dim = state.dim;
      if (has('parking-points')) map.setPaintProperty('parking-points', 'icon-opacity', dim ? 0.4 : 1);
      if (has('parking-labels')) map.setPaintProperty('parking-labels', 'text-opacity', dim ? 0.5 : 1);
      if (has('parking-clusters')) map.setPaintProperty('parking-clusters', 'circle-opacity', dim ? 0.35 : 0.85);
      if (has('parking-cluster-count')) map.setPaintProperty('parking-cluster-count', 'text-opacity', dim ? 0.6 : 1);
      applied.dim = dim;
    }
  }

  function open(i) {
    const row = state.points?.[i];
    if (!row || !state.on) return;
    if (!popup) popup = new maplibregl.Popup({ className: 'parking-popup', maxWidth: '260px', offset: 14, focusAfterOpen: false });
    popup.setLngLat([row[0], row[1]]).setDOMContent(popupContent(row, state.near?.get(i), state.from)).addTo(map);
  }

  // Clicks that belong to the fleet map (truck clusters, open loads, placing a truck) win over parking.
  const fleetHit = (e) => map.getCanvas().style.cursor === 'crosshair'
    || map.queryRenderedFeatures(e.point, { layers: ['clusters', 'origin-dot'].filter(has) }).length > 0;
  const onClick = (e) => {
    if (fleetHit(e)) return;
    const i = e.features?.[0]?.properties?.i;
    if (i != null) open(Number(i));
  };
  const onCluster = async (e) => {
    const f = e.features?.[0];
    if (!f || fleetHit(e)) return;
    try {
      const zoom = await map.getSource(SRC).getClusterExpansionZoom(f.properties.cluster_id);
      map.easeTo({ center: f.geometry.coordinates, zoom: zoom + 0.5, duration: 500 });
    } catch { /* the source changed under the click */ }
  };
  // The crosshair of "click the map to place the truck" stays.
  const pointer = () => { if (map.getCanvas().style.cursor !== 'crosshair') map.getCanvas().style.cursor = 'pointer'; };
  const unpointer = () => { if (map.getCanvas().style.cursor === 'pointer') map.getCanvas().style.cursor = ''; };
  const onStyle = () => { applied = {}; sync(); };
  const hover = [...CLICKABLE, 'parking-clusters'];

  map.on('style.load', onStyle);
  map.on('click', CLICKABLE, onClick);
  map.on('click', 'parking-clusters', onCluster);
  map.on('mouseenter', hover, pointer);
  map.on('mouseleave', hover, unpointer);

  return {
    update(next) { Object.assign(state, next); sync(); },
    open,
    destroy() {
      popup?.remove();
      map.off('style.load', onStyle);
      map.off('click', CLICKABLE, onClick);
      map.off('click', 'parking-clusters', onCluster);
      map.off('mouseenter', hover, pointer);
      map.off('mouseleave', hover, unpointer);
    },
  };
}

/**
 * The layer itself (map sources through `map`) plus the "Parking along this route" card when `route` is set.
 * route: { key, points: [[lng, lat], ...] ahead of the truck, from: 'truck' | 'pickup', label }.
 */
export default function ParkingLayer({ map, on, route }) {
  const q = useParkingData(on);
  const data = q.data;
  const points = data?.points;
  const geo = useMemo(() => (points ? toFeatureCollection(points) : null), [points]);
  const along = useMemo(() => (on && points && route?.points?.length > 1 ? parkingAlongRoute(points, route.points, { miles: CORRIDOR_MILES }) : null), [on, points, route]);
  // The map's highlight source changes only when the set of nearby places changes, not on every position update.
  const sig = along ? along.map((a) => a.i).join(',') : '';
  const routeGeo = useMemo(() => (along && points ? {
    type: 'FeatureCollection',
    features: along.map((a, n) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [points[a.i][0], points[a.i][1]] }, properties: { k: points[a.i][2], i: a.i, r: n < RANKED ? n + 1 : 0 } })),
  } : EMPTY_FC), [sig, points]); // eslint-disable-line react-hooks/exhaustive-deps
  const near = useMemo(() => (along ? new Map(along.map((a) => [a.i, a])) : null), [along]);

  const ctl = useRef(null);
  useEffect(() => {
    if (!map) return undefined;
    const c = createController(map);
    ctl.current = c;
    return () => { c.destroy(); ctl.current = null; };
  }, [map]);
  useEffect(() => {
    ctl.current?.update({ on: !!on, geo, routeGeo, dim: !!along?.length, points, near, from: route?.from || 'truck' });
  }, [map, on, geo, routeGeo, along, points, near, route?.from]);

  const focus = (i) => {
    const row = points?.[i];
    if (!map || !row) return;
    map.flyTo({ center: [row[0], row[1]], zoom: Math.max(map.getZoom(), 11), duration: 800, essential: true });
    ctl.current?.open(i);
  };

  if (!on || !route) return null;
  return <ParkingRouteCard query={q} along={along} points={points} route={route} onPick={focus} />;
}

/** Compact list of the next stops along the route ahead. */
export function ParkingRouteCard({ query, along, points, route, onPick }) {
  const [open, setOpen] = useState(() => (typeof window === 'undefined' ? true : window.innerWidth >= 640));
  const next = (along || []).slice(0, RANKED);
  const fromText = route.from === 'pickup' ? 'Miles from the pickup' : 'Miles ahead of the truck';
  return (
    <section aria-label="Parking along this route"
      className="absolute bottom-3 left-14 right-3 z-[6] rounded-xl border border-line bg-surface/95 shadow-lg backdrop-blur sm:bottom-16 sm:left-auto sm:w-[300px]">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <SquareParking className="size-4 shrink-0 text-c-blue" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">Parking along this route</span>
          <span className="block truncate text-[11px] text-muted">
            {query.isLoading ? 'Loading truck parking' : query.isError ? 'Truck parking did not load' : `${along?.length ?? 0} within ${CORRIDOR_MILES} mi${route.label ? ` · ${route.label}` : ''}`}
          </span>
        </span>
        {open ? <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden /> : <ChevronUp className="size-4 shrink-0 text-muted" aria-hidden />}
      </button>
      {open && (
        <div className="border-t border-line px-3 pb-2.5 pt-2">
          {query.isError && (
            <p className="text-xs text-fg-2">Could not load the parking file. <button type="button" className="font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => query.refetch()}>Try again</button></p>
          )}
          {!query.isError && along && next.length === 0 && (
            <p className="text-xs text-fg-2">No truck stops, rest areas or truck parking are mapped within {CORRIDOR_MILES} mi of the road ahead.</p>
          )}
          {next.length > 0 && (
            <>
              <p className="mb-1 text-[11px] text-muted">{fromText}</p>
              <ol className="space-y-0.5">
                {next.map((a, n) => {
                  const d = describe(points[a.i]);
                  const { Icon } = d.meta;
                  return (
                    <li key={a.i}>
                      <button type="button" onClick={() => onPick?.(a.i)}
                        className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-ui hover:bg-surface-2">
                        <span className="w-3 shrink-0 text-center text-[11px] font-medium tabular text-muted">{n + 1}</span>
                        <span className={cx('flex size-6 shrink-0 items-center justify-center rounded-full', d.meta.soft, d.meta.text)}><Icon className="size-3.5" aria-hidden /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] font-medium">{d.title}</span>
                          <span className="block truncate text-[11px] text-muted">{d.named ? d.meta.label : 'No name'}{d.extras.length ? ` · ${d.extras[0]}` : ''}</span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block text-[12px] font-medium tabular">{milesText(a.ahead)}</span>
                          <span className="block text-[10.5px] tabular text-muted">{milesText(a.off)} off</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
          <p className="mt-1.5 text-[10.5px] leading-snug text-muted">Space availability is not shown. Data {OSM_ATTRIBUTION}.</p>
        </div>
      )}
    </section>
  );
}

/** Status line next to the layer chips while the layer is on: loading, error, or the attribution and the caveat. */
export function ParkingNote() {
  const q = useParkingData(true);
  if (q.isError) {
    return (
      <span className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface/95 px-2.5 text-xs text-fg-2 shadow-sm backdrop-blur">
        Truck parking did not load
        <button type="button" className="font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => q.refetch()}>Try again</button>
      </span>
    );
  }
  return (
    <span className="flex min-h-8 items-center rounded-lg border border-line bg-surface/95 px-2.5 py-1 text-[11px] leading-snug text-muted shadow-sm backdrop-blur">
      {q.isLoading ? 'Loading truck parking' : `Truck parking ${OSM_ATTRIBUTION}. Space availability is not shown.`}
    </span>
  );
}

/** Legend rows for the fleet map legend. */
export function ParkingLegend() {
  return (
    <>
      {[1, 2, 3].map((k) => {
        const { Icon, label, color } = PARKING_KINDS[k];
        return (
          <span key={k} className={cx('flex items-center gap-1.5', k === 1 && 'mt-1 border-t border-line pt-1')}>
            <span className="flex size-3.5 items-center justify-center rounded-full text-white" style={{ background: color }}><Icon className="size-2.5" aria-hidden /></span>{label}
          </span>
        );
      })}
    </>
  );
}
