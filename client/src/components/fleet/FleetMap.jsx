import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './fleet.css';
import { MAP_STYLES, STATUS, TRIP_STATUS, initials, liveTag } from './fleetApi.js';

const US = [[-125, 24], [-66.5, 49.5]];
const empty = { type: 'FeatureCollection', features: [] };
const tripColor = ['match', ['get', 'status'], ...Object.entries(TRIP_STATUS).flatMap(([k, v]) => [k, v.color]), '#7c3aed'];
// Basemap clutter that competes with trucks and routes.
const HIDE = /poi|housenumber|aerialway|aeroway|railway_service|ferry/i;

function truckFeatures(trucks) {
  return {
    type: 'FeatureCollection',
    features: trucks.filter((t) => t.location?.lat != null).map((t) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [t.location.lng, t.location.lat] },
      properties: { id: t.id, status: t.truckStatus },
    })),
  };
}

function tripFeatures(trucks) {
  const lines = [];
  const ends = [];
  for (const t of trucks) {
    for (const trip of t.trips || []) {
      if (trip.origin.lat == null || trip.dest.lat == null) continue;
      lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[trip.origin.lng, trip.origin.lat], [trip.dest.lng, trip.dest.lat]] }, properties: { id: trip.id, carrierId: t.id, status: trip.status } });
      ends.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [trip.origin.lng, trip.origin.lat] }, properties: { kind: 'origin', status: trip.status, label: trip.origin.city } });
      ends.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [trip.dest.lng, trip.dest.lat] }, properties: { kind: 'dest', status: trip.status, label: trip.dest.city } });
      if (t.location?.lat != null && trip === t.nextTrip && t.truckStatus !== 'loaded') {
        lines.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[t.location.lng, t.location.lat], [trip.origin.lng, trip.origin.lat]] }, properties: { id: `${trip.id}-dh`, carrierId: t.id, status: 'deadhead' } });
      }
    }
  }
  return { lines: { type: 'FeatureCollection', features: lines }, ends: { type: 'FeatureCollection', features: ends } };
}

function pointFeatures(items, kind) {
  return {
    type: 'FeatureCollection',
    features: items.filter((p) => p.lat != null).map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { id: p.id, kind, label: p.label || '' } })),
  };
}

function setData(map, id, data) {
  const src = map.getSource(id);
  if (src) src.setData(data);
}

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Build or update the DOM for a truck pin. */
function paintPin(el, t, selected) {
  const color = (STATUS[t.truckStatus] || STATUS.unknown).color;
  const live = t.live || {};
  const isLive = live.sharing && !live.stale;
  const stale = live.source === 'driver_link' && live.stale;
  const moving = isLive && live.heading != null && (live.speedMph ?? 0) >= 3;
  const tag = liveTag(t);
  el.style.setProperty('--pin-color', color);
  // Toggle our classes only: MapLibre positions the marker through its own maplibregl-marker class.
  el.classList.add('fleet-pin');
  el.classList.toggle('fleet-pin--selected', !!selected);
  el.classList.toggle('fleet-pin--live', !!isLive);
  el.classList.toggle('fleet-pin--stale', !!stale);
  el.setAttribute('aria-label', `${t.companyName}, ${(STATUS[t.truckStatus] || STATUS.unknown).label}${tag ? `, ${tag.text}` : ''}`);
  el.innerHTML = `
    <span class="fleet-pin__halo"></span>
    ${moving ? `<span class="fleet-pin__arrow" style="transform: rotate(${Math.round(live.heading)}deg)"></span>` : ''}
    <span class="fleet-pin__body">${esc(initials(t.companyName))}</span>
    ${tag && (selected || isLive || stale) ? `<span class="fleet-pin__tag fleet-pin__tag--${tag.tone}">${tag.tone === 'live' ? '<span class="fleet-pin__dot"></span>' : ''}${esc(tag.text)}</span>` : ''}`;
}

/**
 * Interactive fleet map (MapLibre GL + OpenFreeMap vector tiles, free and keyless).
 * Trucks are HTML pins colored by status, with a pulsing halo when a driver is sharing live GPS.
 * When zoomed out they collapse into clusters. Trips show as cased lines with pickup/delivery ends.
 */
export default function FleetMap({
  trucks = [], openLoads = [], alerts = [], layers, selectedId, onSelect, onOpenLoad, pickMode, onPick, editPoint, onEditMove,
  plannedRoute, focus, fitKey, dark, trail, className,
}) {
  const box = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const pins = useRef(new Map()); // truck id -> maplibregl.Marker
  const latest = useRef({});
  latest.current = { trucks, openLoads, alerts, layers, selectedId, onSelect, onOpenLoad, pickMode, onPick, plannedRoute, onEditMove, trail };

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
        if (!t || want.has(id)) continue;
        want.add(id);
        let m = pins.current.get(id);
        if (!m) {
          const el = document.createElement('div');
          el.addEventListener('click', (e) => { e.stopPropagation(); latest.current.onSelect?.(id); });
          m = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([t.location.lng, t.location.lat]).addTo(map);
          pins.current.set(id, m);
        } else {
          m.setLngLat([t.location.lng, t.location.lat]);
        }
        paintPin(m.getElement(), t, s.selectedId === id);
        m.getElement().style.zIndex = s.selectedId === id ? '3' : t.live?.sharing ? '2' : '1';
      }
    }
    for (const [id, m] of pins.current) if (!want.has(id)) { m.remove(); pins.current.delete(id); }
  };

  const sync = () => {
    const map = mapRef.current;
    // Only the presence of our sources matters; isStyleLoaded() is still false inside style.load.
    if (!map || !map.getSource('trucks')) return;
    const s = latest.current;
    const trips = tripFeatures(s.trucks);
    setData(map, 'trucks', truckFeatures(s.trucks));
    setData(map, 'trips', trips.lines);
    setData(map, 'trip-ends', trips.ends);
    setData(map, 'origins', pointFeatures(s.openLoads.map((l) => ({ id: l.id, lat: l.origin.lat, lng: l.origin.lng, label: `${l.origin.city} → ${l.dest.city}` })), 'load'));
    setData(map, 'alerts', pointFeatures(s.alerts, 'alert'));
    setData(map, 'trail', s.trail?.length > 1 ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: s.trail }, properties: {} }] } : empty);
    const r = s.plannedRoute;
    setData(map, 'plan', r?.geometry?.length ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: r.geometry }, properties: { estimate: !!r.estimate } }, ...(r.deadhead?.geometry?.length ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: r.deadhead.geometry }, properties: { estimate: true, deadhead: true } }] : [])] } : empty);
    const vis = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    const L = s.layers || {};
    ['clusters', 'cluster-count'].forEach((id) => vis(id, L.trucks !== false));
    ['trip-casing', 'trip-lines', 'trip-flow', 'trip-deadhead', 'trip-ends', 'trip-end-labels'].forEach((id) => vis(id, L.trips !== false));
    ['origin-dot'].forEach((id) => vis(id, L.origins !== false));
    ['alert-dot'].forEach((id) => vis(id, L.weather === true));
    syncPins();
  };

  const addLayers = (map) => {
    if (map.getSource('trucks')) return;
    const isDark = document.documentElement.classList.contains('dark');
    const casing = isDark ? '#0b0b0d' : '#ffffff';
    for (const l of map.getStyle().layers || []) if (HIDE.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');

    map.addSource('trucks', { type: 'geojson', data: empty, cluster: true, clusterRadius: 48, clusterMaxZoom: 7 });
    map.addSource('trips', { type: 'geojson', data: empty });
    map.addSource('trip-ends', { type: 'geojson', data: empty });
    map.addSource('origins', { type: 'geojson', data: empty });
    map.addSource('alerts', { type: 'geojson', data: empty });
    map.addSource('plan', { type: 'geojson', data: empty });
    map.addSource('trail', { type: 'geojson', data: empty, lineMetrics: true });

    const notDh = ['!=', ['get', 'status'], 'deadhead'];
    map.addLayer({ id: 'trail-line', type: 'line', source: 'trail', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-width': 4, 'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, 'rgba(22,163,74,0)', 1, 'rgba(22,163,74,0.95)'] } });
    map.addLayer({ id: 'trip-deadhead', type: 'line', source: 'trips', filter: ['==', ['get', 'status'], 'deadhead'], layout: { 'line-cap': 'round' }, paint: { 'line-color': isDark ? '#a1a1aa' : '#71717a', 'line-width': 2, 'line-dasharray': [1, 2] } });
    map.addLayer({ id: 'trip-casing', type: 'line', source: 'trips', filter: notDh, layout: { 'line-cap': 'round' }, paint: { 'line-color': casing, 'line-width': 7, 'line-opacity': 0.9 } });
    map.addLayer({ id: 'trip-lines', type: 'line', source: 'trips', filter: notDh, layout: { 'line-cap': 'round' }, paint: { 'line-color': tripColor, 'line-width': 4 } });
    // Marching dashes on trips in transit show direction of travel.
    map.addLayer({ id: 'trip-flow', type: 'line', source: 'trips', filter: ['==', ['get', 'status'], 'in_transit'], paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-opacity': 0.85, 'line-dasharray': [0, 4, 3] } });
    map.addLayer({ id: 'plan-line', type: 'line', source: 'plan', filter: ['!', ['get', 'estimate']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0f7d73', 'line-width': 5, 'line-opacity': 0.95 } });
    map.addLayer({ id: 'plan-estimate', type: 'line', source: 'plan', filter: ['get', 'estimate'], paint: { 'line-color': '#0f7d73', 'line-width': 3, 'line-dasharray': [1.5, 1.5] } });
    map.addLayer({ id: 'trip-ends', type: 'circle', source: 'trip-ends', paint: {
      'circle-radius': ['case', ['==', ['get', 'kind'], 'dest'], 6, 5],
      'circle-color': ['case', ['==', ['get', 'kind'], 'dest'], tripColor, casing],
      'circle-stroke-color': tripColor, 'circle-stroke-width': 2.5,
    } });
    map.addLayer({ id: 'trip-end-labels', type: 'symbol', source: 'trip-ends', minzoom: 4.5, layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': isDark ? '#e4e4e7' : '#27272a', 'text-halo-color': casing, 'text-halo-width': 1.5 } });
    map.addLayer({ id: 'origin-dot', type: 'circle', source: 'origins', paint: { 'circle-radius': 7, 'circle-color': casing, 'circle-stroke-color': '#7c3aed', 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'alert-dot', type: 'circle', source: 'alerts', paint: { 'circle-radius': 18, 'circle-color': '#dc2626', 'circle-opacity': 0.16, 'circle-stroke-color': '#dc2626', 'circle-stroke-width': 1.5 } });
    map.addLayer({ id: 'clusters', type: 'circle', source: 'trucks', filter: ['has', 'point_count'], paint: { 'circle-color': '#0f7d73', 'circle-opacity': 0.92, 'circle-radius': ['step', ['get', 'point_count'], 18, 10, 22, 30, 28], 'circle-stroke-color': casing, 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'cluster-count', type: 'symbol', source: 'trucks', filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Bold'], 'text-size': 13 }, paint: { 'text-color': '#ffffff' } });
  };

  useEffect(() => {
    const map = new maplibregl.Map({
      container: box.current, style: dark ? MAP_STYLES.dark : MAP_STYLES.light, bounds: US, attributionControl: false, maxPitch: 0, fadeDuration: 150,
    });
    mapRef.current = map;
    // Controls sit on the left: the right side hosts the planner drawer and the app's floating dock.
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
    map.on('style.load', () => { addLayers(map); sync(); });
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
    // Animate the in-transit dashes.
    let step = 0;
    const seq = [[0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0], [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5]];
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const anim = reduce ? null : setInterval(() => {
      if (map.getLayer('trip-flow') && map.getLayoutProperty('trip-flow', 'visibility') !== 'none') {
        step = (step + 1) % seq.length;
        map.setPaintProperty('trip-flow', 'line-dasharray', seq[step]);
      }
    }, 90);
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(box.current);
    const pinMap = pins.current;
    return () => {
      if (anim) clearInterval(anim);
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

  useEffect(sync); // data, layers, selection and trail

  useEffect(() => {
    const map = mapRef.current;
    if (map) map.getCanvas().style.cursor = pickMode ? 'crosshair' : '';
  }, [pickMode]);

  // Fit to all trucks (and the planned route) when asked.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || fitKey == null) return;
    const pts = [...trucks.filter((t) => t.location?.lat != null).map((t) => [t.location.lng, t.location.lat]), ...(plannedRoute?.geometry || [])];
    if (!pts.length) { map.fitBounds(US, { padding: 40, duration: 600 }); return; }
    const b = pts.reduce((acc, p) => acc.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
    const pad = plannedRoute ? { top: 70, bottom: 60, left: 60, right: Math.min(440, box.current.clientWidth / 2) } : 90;
    map.fitBounds(b, { padding: pad, maxZoom: 9, duration: 900 });
  }, [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current;
    if (map && focus?.lat != null) map.flyTo({ center: [focus.lng, focus.lat], zoom: Math.max(map.getZoom(), focus.zoom || 7), duration: 1200, curve: 1.42, essential: true });
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
