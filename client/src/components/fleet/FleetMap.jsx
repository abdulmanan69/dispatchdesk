import { useEffect, useMemo, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './fleet.css';
import { MAP_STYLES, STATUS, TRIP_STATUS, initials, liveTag, isStale } from './fleetApi.js';
import { splitRoute } from './polyline.js';

const US = [[-125, 24], [-66.5, 49.5]];
const empty = { type: 'FeatureCollection', features: [] };
const tripColor = ['match', ['get', 'status'], ...Object.entries(TRIP_STATUS).flatMap(([k, v]) => [k, v.color]), '#7c3aed'];
// Basemap clutter that competes with trucks and routes.
const HIDE = /poi|housenumber|aerialway|aeroway|railway_service|ferry/i;
// A live truck this close to its road route is drawn on the road (GPS wobble), farther away at its real position.
const SNAP_PIN_MILES = 0.3;

const line = (coordinates, properties) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties });
const point = (coordinates, properties) => ({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties });
const fc = (features) => ({ type: 'FeatureCollection', features });
const straight = (a, b) => [[a.lng, a.lat], [b.lng, b.lat]];

/**
 * Numbered stops of consolidated trips: one point per place (stops back to back at the same place share it, labelled
 * "1, 2"), colored by the trip's status, muted once done.
 */
function consolidationStops(c, carrierId) {
  const byPlace = new Map();
  for (const s of c.stops || []) {
    if (s.lat == null || s.lng == null) continue;
    const key = `${s.lng.toFixed(4)},${s.lat.toFixed(4)}`;
    const hit = byPlace.get(key);
    if (hit) { hit.ns.push(s.n); hit.done = hit.done && !!s.done; continue; }
    byPlace.set(key, { at: [s.lng, s.lat], ns: [s.n], done: !!s.done, city: s.city || '' });
  }
  return [...byPlace.values()].map((p) => point(p.at, { label: p.ns.join(', '), wide: p.ns.length > 1, done: p.done, status: c.status, carrierId, city: p.city }));
}

/**
 * Trip lines from the stored road routes. An in-transit trip with a known truck position is split at the truck:
 * the driven part is drawn muted, the part ahead in the trip color with direction arrows. The truck's run to its next
 * pickup (deadhead) is a dashed grey road route. Straight lines appear only when the routing service had no route
 * for a trip, and are dashed and labelled "Estimate".
 * Loads on a consolidated trip are drawn as that trip: one route through every stop in order, with numbered stops,
 * instead of each load's own pickup-to-delivery line.
 */
export function buildTrips(trucks, routes, deadheads, consolidations = []) {
  const lines = [];
  const ends = [];
  const stops = [];
  const pins = new Map(); // truck id -> displayed [lng, lat]
  const grouped = new Set(consolidations.flatMap((c) => c.loadIds || []));
  const consByTruck = new Map();
  for (const c of consolidations) consByTruck.set(c.carrierId, [...(consByTruck.get(c.carrierId) || []), c]);
  for (const t of trucks) {
    const pos = t.location?.lat != null ? { lat: t.location.lat, lng: t.location.lng } : null;
    if (pos) pins.set(t.id, [pos.lng, pos.lat]);
    for (const c of consByTruck.get(t.id) || []) {
      const pts = c.points?.length > 1 ? c.points : (c.stops || []).filter((s) => s.lat != null).map((s) => [s.lng, s.lat]);
      if (pts.length < 2) continue;
      const road = c.points?.length > 1 && !c.estimate;
      const props = { id: `c:${c.id}`, carrierId: t.id, status: c.status, estimate: !road };
      if (c.status === 'in_transit' && pos) {
        const { done, ahead, snap } = splitRoute(pts, pos);
        if (done.length > 1) lines.push(line(done, { ...props, part: 'done' }));
        if (ahead.length > 1) lines.push(line(ahead, { ...props, part: 'ahead' }));
        if (snap && road && snap.offMiles < SNAP_PIN_MILES) pins.set(t.id, snap.point);
      } else {
        lines.push(line(pts, { ...props, part: 'ahead' }));
      }
      stops.push(...consolidationStops(c, t.id));
    }
    for (const trip of t.trips || []) {
      if (grouped.has(trip.id)) continue;
      if (trip.origin.lat == null || trip.dest.lat == null) continue;
      const r = routes.get(trip.id);
      const road = r?.points?.length > 1;
      const pts = road ? r.points : straight(trip.origin, trip.dest);
      const props = { id: trip.id, carrierId: t.id, status: trip.status, estimate: !road || !!r.estimate };
      if (trip.status === 'in_transit' && pos) {
        const { done, ahead, snap } = splitRoute(pts, pos);
        if (done.length > 1) lines.push(line(done, { ...props, part: 'done' }));
        if (ahead.length > 1) lines.push(line(ahead, { ...props, part: 'ahead' }));
        if (snap && road && !r.estimate && snap.offMiles < SNAP_PIN_MILES) pins.set(t.id, snap.point);
      } else {
        lines.push(line(pts, { ...props, part: 'ahead' }));
      }
      ends.push(point([trip.origin.lng, trip.origin.lat], { kind: 'origin', status: trip.status, label: trip.origin.city }));
      ends.push(point([trip.dest.lng, trip.dest.lat], { kind: 'dest', status: trip.status, label: trip.dest.city }));
    }
    const next = t.nextTrip;
    if (pos && next && !t.currentTrip && t.truckStatus !== 'loaded' && next.origin.lat != null) {
      const dh = deadheads.get(`${t.id}:${next.id}`);
      let pts = straight(pos, next.origin);
      if (dh?.points?.length > 1) {
        const { ahead } = splitRoute(dh.points, pos);
        pts = [[pos.lng, pos.lat], ...ahead];
      }
      lines.push(line(pts, { id: `${next.id}-dh`, carrierId: t.id, status: 'deadhead', part: 'ahead', estimate: !dh?.points?.length || !!dh.estimate }));
    }
  }
  return { lines: fc(lines), ends: fc(ends), stops: fc(stops), pins };
}

function truckFeatures(trucks, pins) {
  return fc(trucks.filter((t) => pins.has(t.id)).map((t) => point(pins.get(t.id), { id: t.id, status: t.truckStatus })));
}

function pointFeatures(items, kind) {
  return fc(items.filter((p) => p.lat != null).map((p) => point([p.lng, p.lat], { id: p.id, kind, label: p.label || '' })));
}

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Shield badge for driver-link positions: how far to trust the GPS (anti-forwarding and plausibility checks).
const TRUST = { high: ['#16a34a', 'High confidence'], medium: ['#d97706', 'Check this position'], low: ['#dc2626', 'Low confidence'] };
function trustBadge(live) {
  const t = live.confidence ? TRUST[live.confidence] : null;
  if (!t || !(live.source === 'driver_link' || live.shareStatus)) return { html: '', text: '' };
  const text = `${t[1]}${live.reasons?.length ? `: ${live.reasons.join('; ')}` : ''}`;
  const html = `<span class="fleet-pin__trust" aria-hidden="true" style="position:absolute;right:-6px;top:-6px;width:17px;height:17px;border-radius:9999px;background:${t[0]};display:grid;place-items:center;border:2px solid var(--surface,#fff);box-shadow:0 1px 3px rgba(0,0,0,.35)"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span>`;
  return { html, text };
}

/** Build or update the DOM for a truck pin; skipped when nothing visible changed (no innerHTML churn on every poll). */
function paintPin(el, t, selected) {
  const color = (STATUS[t.truckStatus] || STATUS.unknown).color;
  const live = t.live || {};
  const stale = live.source === 'driver_link' && isStale(live);
  const isLive = live.sharing && !isStale(live);
  const moving = isLive && live.heading != null && (live.speedMph ?? 0) >= 3;
  const tag = liveTag(t);
  const trust = trustBadge(live);
  const showTag = tag && (selected || isLive || stale);
  const offRoute = !!t.plan?.progress?.offRoute;
  const sig = [t.truckStatus, selected, isLive, stale, moving && Math.round(live.heading / 10), showTag && tag.text, trust.text, offRoute, t.companyName].join('|');
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.style.setProperty('--pin-color', color);
  // Toggle our classes only: MapLibre positions the marker through its own maplibregl-marker class.
  el.classList.add('fleet-pin');
  el.classList.toggle('fleet-pin--selected', !!selected);
  el.classList.toggle('fleet-pin--live', !!isLive);
  el.classList.toggle('fleet-pin--stale', !!stale);
  el.classList.toggle('fleet-pin--off', offRoute);
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', `${t.companyName}, ${(STATUS[t.truckStatus] || STATUS.unknown).label}${tag ? `, ${tag.text}` : ''}${offRoute ? ', off the planned route' : ''}${trust.text ? `. ${trust.text}` : ''}`);
  if (trust.text) el.title = `${t.companyName} · ${trust.text}`;
  else el.removeAttribute('title');
  el.innerHTML = `
    <span class="fleet-pin__halo"></span>
    ${moving ? `<span class="fleet-pin__arrow" style="transform: rotate(${Math.round(live.heading)}deg)"></span>` : ''}
    <span class="fleet-pin__body">${esc(initials(t.companyName))}</span>
    ${trust.html}
    ${showTag ? `<span class="fleet-pin__tag fleet-pin__tag--${tag.tone}">${tag.tone === 'live' ? '<span class="fleet-pin__dot"></span>' : ''}${esc(tag.text)}</span>` : ''}`;
}

/**
 * Interactive fleet map (MapLibre GL + OpenFreeMap vector tiles, free and keyless).
 * Trucks are HTML pins colored by status, with a pulsing halo when a driver is sharing live GPS; zoomed out they cluster.
 * Each GeoJSON source is rebuilt only when its own inputs change, and setData runs only for sources that changed.
 * On touch screens the map needs two fingers to pan, so the page still scrolls with one.
 */
export default function FleetMap({
  trucks = [], openLoads = [], alerts = [], layers, selectedId, onSelect, onOpenLoad, pickMode, onPick, editPoint, onEditMove,
  plannedRoute, focus, fitKey, dark, trail, className, routes, deadheads, onMap, consolidations,
}) {
  const box = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const pins = useRef(new Map()); // truck id -> maplibregl.Marker
  const applied = useRef({}); // source id -> last data object sent to the map
  const latest = useRef({});

  const routeMap = routes || EMPTY_MAP;
  const deadheadMap = deadheads || EMPTY_MAP;
  const consList = consolidations || EMPTY_LIST;
  const trips = useMemo(() => buildTrips(trucks, routeMap, deadheadMap, consList), [trucks, routeMap, deadheadMap, consList]);
  const data = useMemo(() => ({
    trucks: truckFeatures(trucks, trips.pins),
    trips: trips.lines,
    'trip-ends': trips.ends,
    'consolidation-stops': trips.stops,
  }), [trucks, trips]);
  const originData = useMemo(() => pointFeatures(openLoads.map((l) => ({ id: l.id, lat: l.origin.lat, lng: l.origin.lng, label: `${l.origin.city} → ${l.dest.city}` })), 'load'), [openLoads]);
  const alertData = useMemo(() => pointFeatures(alerts, 'alert'), [alerts]);
  const trailData = useMemo(() => (trail?.length > 1 ? fc([line(trail, {})]) : empty), [trail]);
  const planData = useMemo(() => {
    const r = plannedRoute;
    if (!r?.geometry?.length) return empty;
    return fc([
      line(r.geometry, { estimate: !!r.estimate }),
      ...(r.deadhead?.geometry?.length ? [line(r.deadhead.geometry, { estimate: true, deadhead: true })] : []),
    ]);
  }, [plannedRoute]);
  latest.current = { trucks, pins: trips.pins, layers, selectedId, onSelect, onOpenLoad, pickMode, onPick, onEditMove, sources: { ...data, origins: originData, alerts: alertData, trail: trailData, plan: planData } };

  // HTML pins for unclustered trucks; clusters stay as a circle layer.
  const syncPins = () => {
    const map = mapRef.current;
    if (!map || !map.getSource('trucks')) return;
    const s = latest.current;
    const show = s.layers?.trucks !== false;
    const byId = new Map(s.trucks.map((t) => [t.id, t]));
    const want = new Set();
    if (show) {
      for (const f of map.querySourceFeatures('trucks')) {
        if (f.properties.cluster) continue;
        const id = f.properties.id;
        const t = byId.get(id);
        const at = s.pins.get(id);
        if (!t || !at || want.has(id)) continue;
        want.add(id);
        let m = pins.current.get(id);
        if (!m) {
          const el = document.createElement('div');
          el.addEventListener('click', (e) => { e.stopPropagation(); latest.current.onSelect?.(id); });
          el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); latest.current.onSelect?.(id); } });
          m = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(at).addTo(map);
          pins.current.set(id, m);
        } else {
          const cur = m.getLngLat();
          if (cur.lng !== at[0] || cur.lat !== at[1]) m.setLngLat(at);
        }
        paintPin(m.getElement(), t, s.selectedId === id);
        m.getElement().style.zIndex = s.selectedId === id ? '3' : t.live?.sharing ? '2' : '1';
      }
    }
    for (const [id, m] of pins.current) if (!want.has(id)) { m.remove(); pins.current.delete(id); }
  };

  /** Send changed sources to the map (all of them after a style reload). */
  const pushSources = (force = false) => {
    const map = mapRef.current;
    // Only the presence of our sources matters; isStyleLoaded() is still false inside style.load.
    if (!map || !map.getSource('trucks')) return;
    for (const [id, value] of Object.entries(latest.current.sources)) {
      if (!force && applied.current[id] === value) continue;
      map.getSource(id)?.setData(value);
      applied.current[id] = value;
    }
  };

  const applyLayers = () => {
    const map = mapRef.current;
    if (!map || !map.getSource('trucks')) return;
    const vis = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    const L = latest.current.layers || {};
    ['clusters', 'cluster-count'].forEach((id) => vis(id, L.trucks !== false));
    TRIP_LAYERS.forEach((id) => vis(id, L.trips !== false));
    vis('origin-dot', L.origins !== false);
    vis('alert-dot', L.weather === true);
    // Other trucks' trips step back while one truck is selected.
    const sel = latest.current.selectedId;
    const fade = (on) => (sel ? ['case', ['==', ['get', 'carrierId'], sel], on, on * 0.35] : on);
    for (const [id, prop, on] of [['trip-lines', 'line-opacity', 1], ['trip-casing', 'line-opacity', 0.9], ['trip-estimate', 'line-opacity', 0.9], ['trip-deadhead', 'line-opacity', 0.9], ['trip-done', 'line-opacity', 0.75], ['cons-stop', 'circle-opacity', 1], ['cons-stop-num', 'text-opacity', 1]]) {
      if (map.getLayer(id)) map.setPaintProperty(id, prop, fade(on));
    }
  };

  const addLayers = (map) => {
    if (map.getSource('trucks')) return;
    const isDark = document.documentElement.classList.contains('dark');
    const casing = isDark ? '#0b0b0d' : '#ffffff';
    const muted = isDark ? '#71717a' : '#a1a1aa';
    for (const l of map.getStyle().layers || []) if (HIDE.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');

    map.addSource('trucks', { type: 'geojson', data: empty, cluster: true, clusterRadius: 48, clusterMaxZoom: 7 });
    for (const id of ['trips', 'trip-ends', 'origins', 'alerts', 'plan', 'consolidation-stops']) map.addSource(id, { type: 'geojson', data: empty });
    map.addSource('trail', { type: 'geojson', data: empty, lineMetrics: true });

    const isDh = ['==', ['get', 'status'], 'deadhead'];
    const ahead = ['==', ['get', 'part'], 'ahead'];
    const road = ['!', ['get', 'estimate']];
    map.addLayer({ id: 'trail-line', type: 'line', source: 'trail', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-width': 4, 'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, 'rgba(22,163,74,0)', 1, 'rgba(22,163,74,0.95)'] } });
    map.addLayer({ id: 'trip-deadhead', type: 'line', source: 'trips', filter: isDh, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': isDark ? '#a1a1aa' : '#71717a', 'line-width': ['case', road, 3, 2], 'line-dasharray': [1.2, 1.6] } });
    map.addLayer({ id: 'trip-done', type: 'line', source: 'trips', filter: ['all', ['!', isDh], ['==', ['get', 'part'], 'done']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': muted, 'line-width': 3, 'line-opacity': 0.75 } });
    map.addLayer({ id: 'trip-casing', type: 'line', source: 'trips', filter: ['all', ['!', isDh], ahead, road], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': casing, 'line-width': 7, 'line-opacity': 0.9 } });
    map.addLayer({ id: 'trip-lines', type: 'line', source: 'trips', filter: ['all', ['!', isDh], ahead, road], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': tripColor, 'line-width': 4 } });
    map.addLayer({ id: 'trip-estimate', type: 'line', source: 'trips', filter: ['all', ['!', isDh], ahead, ['get', 'estimate']], layout: { 'line-cap': 'round' }, paint: { 'line-color': tripColor, 'line-width': 3, 'line-dasharray': [2, 2], 'line-opacity': 0.9 } });
    // Direction of travel: static arrows along the road ahead of a loaded truck (no animation, nothing repaints).
    map.addLayer({ id: 'trip-arrows', type: 'symbol', source: 'trips', filter: ['all', ahead, ['==', ['get', 'status'], 'in_transit']], minzoom: 4,
      layout: { 'symbol-placement': 'line', 'symbol-spacing': 64, 'text-field': '›', 'text-font': ['Noto Sans Bold'], 'text-size': 19, 'text-keep-upright': false, 'text-rotation-alignment': 'map', 'text-allow-overlap': true, 'text-ignore-placement': true, 'text-offset': [0, -0.12] },
      paint: { 'text-color': '#ffffff', 'text-opacity': 0.95 } });
    map.addLayer({ id: 'trip-estimate-label', type: 'symbol', source: 'trips', filter: ['all', ahead, ['get', 'estimate']], minzoom: 4.5,
      layout: { 'symbol-placement': 'line-center', 'text-field': 'Estimate', 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, -0.9], 'text-optional': true },
      paint: { 'text-color': isDark ? '#d4d4d8' : '#3f3f46', 'text-halo-color': casing, 'text-halo-width': 1.5 } });
    map.addLayer({ id: 'plan-line', type: 'line', source: 'plan', filter: ['!', ['get', 'estimate']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0f7d73', 'line-width': 5, 'line-opacity': 0.95 } });
    map.addLayer({ id: 'plan-estimate', type: 'line', source: 'plan', filter: ['get', 'estimate'], paint: { 'line-color': '#0f7d73', 'line-width': 3, 'line-dasharray': [1.5, 1.5] } });
    map.addLayer({ id: 'trip-ends', type: 'circle', source: 'trip-ends', paint: {
      'circle-radius': ['case', ['==', ['get', 'kind'], 'dest'], 6, 5],
      'circle-color': ['case', ['==', ['get', 'kind'], 'dest'], tripColor, casing],
      'circle-stroke-color': tripColor, 'circle-stroke-width': 2.5,
    } });
    map.addLayer({ id: 'trip-end-labels', type: 'symbol', source: 'trip-ends', minzoom: 4.5, layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': isDark ? '#e4e4e7' : '#27272a', 'text-halo-color': casing, 'text-halo-width': 1.5 } });
    // Consolidated trips: numbered stops in driving order.
    map.addLayer({ id: 'cons-stop', type: 'circle', source: 'consolidation-stops', paint: {
      'circle-radius': ['case', ['get', 'wide'], 12, 9], 'circle-color': ['case', ['get', 'done'], muted, tripColor],
      'circle-stroke-color': casing, 'circle-stroke-width': 2,
    } });
    map.addLayer({ id: 'cons-stop-num', type: 'symbol', source: 'consolidation-stops', layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 10.5, 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': '#ffffff' } });
    map.addLayer({ id: 'cons-stop-city', type: 'symbol', source: 'consolidation-stops', minzoom: 5, layout: { 'text-field': ['get', 'city'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.35], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': isDark ? '#e4e4e7' : '#27272a', 'text-halo-color': casing, 'text-halo-width': 1.5 } });
    map.addLayer({ id: 'origin-dot', type: 'circle', source: 'origins', paint: { 'circle-radius': 7, 'circle-color': casing, 'circle-stroke-color': '#7c3aed', 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'alert-dot', type: 'circle', source: 'alerts', paint: { 'circle-radius': 18, 'circle-color': '#dc2626', 'circle-opacity': 0.16, 'circle-stroke-color': '#dc2626', 'circle-stroke-width': 1.5 } });
    map.addLayer({ id: 'clusters', type: 'circle', source: 'trucks', filter: ['has', 'point_count'], paint: { 'circle-color': '#0f7d73', 'circle-opacity': 0.92, 'circle-radius': ['step', ['get', 'point_count'], 18, 10, 22, 30, 28], 'circle-stroke-color': casing, 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'cluster-count', type: 'symbol', source: 'trucks', filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Bold'], 'text-size': 13 }, paint: { 'text-color': '#ffffff' } });
  };

  useEffect(() => {
    const coarse = !!window.matchMedia?.('(pointer: coarse)').matches;
    const map = new maplibregl.Map({
      container: box.current, style: dark ? MAP_STYLES.dark : MAP_STYLES.light, bounds: US, attributionControl: false, maxPitch: 0, fadeDuration: 150,
      // Phones and tablets: one finger scrolls the page, two fingers move the map.
      cooperativeGestures: coarse,
    });
    mapRef.current = map;
    // Controls sit on the left: the right side hosts the planner drawer and the app's floating dock.
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
    map.on('style.load', () => { applied.current = {}; addLayers(map); pushSources(true); applyLayers(); syncPins(); });
    // Keep the (required) attribution as a small info button instead of a banner across the map.
    map.once('load', () => box.current?.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
    map.on('moveend', syncPins);
    map.on('sourcedata', (e) => { if (e.sourceId === 'trucks' && e.isSourceLoaded) syncPins(); });
    map.on('click', 'origin-dot', (e) => { const id = e.features?.[0]?.properties?.id; if (id) latest.current.onOpenLoad?.(id); });
    map.on('click', 'clusters', async (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const zoom = await map.getSource('trucks').getClusterExpansionZoom(f.properties.cluster_id);
      map.easeTo({ center: f.geometry.coordinates, zoom: zoom + 0.5, duration: 600 });
    });
    map.on('click', (e) => {
      if (!latest.current.pickMode) return;
      latest.current.onPick?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });
    for (const id of ['clusters', 'origin-dot']) {
      map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = latest.current.pickMode ? 'crosshair' : ''; });
    }
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(box.current);
    const pinMap = pins.current;
    // Optional overlays (the truck parking layer) get the map instance and add their own sources and layers.
    onMap?.(map);
    return () => {
      onMap?.(null);
      ro.disconnect();
      for (const m of pinMap.values()) m.remove();
      pinMap.clear();
      map.remove();
      mapRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Theme switch: swap the basemap; our layers are re-added on style.load.
  const firstStyle = useRef(true);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (firstStyle.current) { firstStyle.current = false; return; }
    // diff: false forces a full reload so style.load fires and our layers are re-added.
    map.setStyle(dark ? MAP_STYLES.dark : MAP_STYLES.light, { diff: false });
  }, [dark]);

  // Data: only sources whose inputs changed are sent to the map (consolidated-trip stops ride along with the trips).
  useEffect(() => { pushSources(); syncPins(); }, [data, originData, alertData, trailData, planData]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { applyLayers(); syncPins(); }, [layers, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current;
    if (map) map.getCanvas().style.cursor = pickMode ? 'crosshair' : '';
  }, [pickMode]);

  // Fit to all trucks (and the planned route) when asked.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || fitKey == null) return;
    const pts = [...[...trips.pins.values()], ...(plannedRoute?.geometry || [])];
    if (!pts.length) { map.fitBounds(US, { padding: 40, duration: 600 }); return; }
    const b = pts.reduce((acc, p) => acc.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
    const pad = plannedRoute ? { top: 70, bottom: 60, left: 60, right: Math.min(440, box.current.clientWidth / 2) } : 90;
    map.fitBounds(b, { padding: pad, maxZoom: 9, duration: 900 });
  }, [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus) return;
    if (focus.bounds) {
      const w = box.current?.clientWidth || 800;
      // Room for the truck panel on the left and the legend on the right.
      map.fitBounds(focus.bounds, { padding: { top: 70, bottom: 60, left: w > 700 ? 420 : 40, right: w > 1000 ? 150 : 40 }, maxZoom: 10, duration: 1000 });
    } else if (focus.lat != null) {
      map.flyTo({ center: [focus.lng, focus.lat], zoom: Math.max(map.getZoom(), focus.zoom || 7), duration: 1200, curve: 1.42, essential: true });
    }
  }, [focus?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Draggable marker while editing a truck's location.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    if (!editPoint) { markerRef.current?.remove(); markerRef.current = null; return undefined; }
    if (!markerRef.current) {
      markerRef.current = new maplibregl.Marker({ draggable: true, color: '#0f7d73' }).setLngLat([editPoint.lng, editPoint.lat]).addTo(map);
      markerRef.current.on('dragend', () => { const p = markerRef.current.getLngLat(); latest.current.onEditMove?.({ lat: p.lat, lng: p.lng }); });
    } else {
      markerRef.current.setLngLat([editPoint.lng, editPoint.lat]);
    }
    return undefined;
  }, [editPoint?.lat, editPoint?.lng, !!editPoint]); // eslint-disable-line react-hooks/exhaustive-deps

  // MapLibre sets position: relative on its container, so size comes from a wrapper.
  return (
    <div className={`fleet-map ${className || ''}`}>
      <div ref={box} className="h-full w-full" role="application" aria-label="Fleet map" />
    </div>
  );
}

const EMPTY_MAP = new Map();
const EMPTY_LIST = [];
const TRIP_LAYERS = ['trip-casing', 'trip-lines', 'trip-estimate', 'trip-deadhead', 'trip-done', 'trip-arrows', 'trip-estimate-label', 'trip-ends', 'trip-end-labels', 'cons-stop', 'cons-stop-num', 'cons-stop-city'];
