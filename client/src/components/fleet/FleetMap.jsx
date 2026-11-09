import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MAP_STYLES, STATUS, TRIP_STATUS, initials } from './fleetApi.js';

const US = [[-125, 24], [-66.5, 49.5]];
const empty = { type: 'FeatureCollection', features: [] };
const statusColor = ['match', ['get', 'status'], ...Object.entries(STATUS).flatMap(([k, v]) => [k, v.color]), STATUS.unknown.color];
const tripColor = ['match', ['get', 'status'], ...Object.entries(TRIP_STATUS).flatMap(([k, v]) => [k, v.color]), '#7c3aed'];

function truckFeatures(trucks) {
  return {
    type: 'FeatureCollection',
    features: trucks.filter((t) => t.location?.lat != null).map((t) => ({
      type: 'Feature', id: undefined,
      geometry: { type: 'Point', coordinates: [t.location.lng, t.location.lat] },
      properties: { id: t.id, status: t.truckStatus, label: initials(t.companyName), name: t.companyName },
    })),
  };
}

function tripFeatures(trucks) {
  const features = [];
  for (const t of trucks) {
    for (const trip of t.trips || []) {
      if (trip.origin.lat == null || trip.dest.lat == null) continue;
      features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[trip.origin.lng, trip.origin.lat], [trip.dest.lng, trip.dest.lat]] }, properties: { id: trip.id, carrierId: t.id, status: trip.status } });
      if (t.location?.lat != null && trip === t.nextTrip && t.truckStatus !== 'loaded') {
        features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[t.location.lng, t.location.lat], [trip.origin.lng, trip.origin.lat]] }, properties: { id: `${trip.id}-dh`, carrierId: t.id, status: 'deadhead' } });
      }
    }
  }
  return { type: 'FeatureCollection', features };
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

/**
 * Interactive fleet map (MapLibre GL + OpenFreeMap vector tiles, free and keyless).
 * Trucks cluster when zoomed out; colors follow truck status. Everything else is a layer that can be toggled.
 */
export default function FleetMap({
  trucks = [], openLoads = [], alerts = [], layers, selectedId, onSelect, onOpenLoad, pickMode, onPick, editPoint, onEditMove,
  plannedRoute, focus, fitKey, dark, className,
}) {
  const box = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const latest = useRef({});
  latest.current = { trucks, openLoads, alerts, layers, selectedId, onSelect, onOpenLoad, pickMode, onPick, plannedRoute, onEditMove };

  const sync = () => {
    const map = mapRef.current;
    // Only the presence of our sources matters; isStyleLoaded() is still false inside style.load.
    if (!map || !map.getSource('trucks')) return;
    const s = latest.current;
    setData(map, 'trucks', truckFeatures(s.trucks));
    setData(map, 'trips', tripFeatures(s.trucks));
    setData(map, 'origins', pointFeatures(s.openLoads.map((l) => ({ id: l.id, lat: l.origin.lat, lng: l.origin.lng, label: `${l.origin.city} → ${l.dest.city}` })), 'load'));
    setData(map, 'alerts', pointFeatures(s.alerts, 'alert'));
    const r = s.plannedRoute;
    setData(map, 'plan', r?.geometry?.length ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: r.geometry }, properties: { estimate: !!r.estimate } }, ...(r.deadhead?.geometry?.length ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: r.deadhead.geometry }, properties: { estimate: true, deadhead: true } }] : [])] } : empty);
    const vis = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    const L = s.layers || {};
    ['clusters', 'cluster-count', 'truck-halo', 'truck-dot', 'truck-label'].forEach((id) => vis(id, L.trucks !== false));
    ['trip-lines', 'trip-deadhead'].forEach((id) => vis(id, L.trips !== false));
    ['origin-dot'].forEach((id) => vis(id, L.origins !== false));
    ['alert-dot'].forEach((id) => vis(id, L.weather === true));
    if (map.getLayer('truck-halo')) map.setFilter('truck-halo', ['==', ['get', 'id'], s.selectedId || '']);
  };

  const addLayers = (map) => {
    if (map.getSource('trucks')) return;
    map.addSource('trucks', { type: 'geojson', data: empty, cluster: true, clusterRadius: 44, clusterMaxZoom: 9 });
    map.addSource('trips', { type: 'geojson', data: empty });
    map.addSource('origins', { type: 'geojson', data: empty });
    map.addSource('alerts', { type: 'geojson', data: empty });
    map.addSource('plan', { type: 'geojson', data: empty });

    map.addLayer({ id: 'trip-deadhead', type: 'line', source: 'trips', filter: ['==', ['get', 'status'], 'deadhead'], paint: { 'line-color': '#94a3b8', 'line-width': 2, 'line-dasharray': [2, 2] } });
    map.addLayer({ id: 'trip-lines', type: 'line', source: 'trips', filter: ['!=', ['get', 'status'], 'deadhead'], layout: { 'line-cap': 'round' }, paint: { 'line-color': tripColor, 'line-width': 3, 'line-opacity': 0.85 } });
    map.addLayer({ id: 'plan-line', type: 'line', source: 'plan', filter: ['!', ['get', 'estimate']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0f7d73', 'line-width': 5, 'line-opacity': 0.9 } });
    map.addLayer({ id: 'plan-estimate', type: 'line', source: 'plan', filter: ['get', 'estimate'], paint: { 'line-color': '#0f7d73', 'line-width': 3, 'line-dasharray': [1.5, 1.5] } });
    map.addLayer({ id: 'origin-dot', type: 'circle', source: 'origins', paint: { 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-stroke-color': '#7c3aed', 'circle-stroke-width': 3 } });
    map.addLayer({ id: 'alert-dot', type: 'circle', source: 'alerts', paint: { 'circle-radius': 14, 'circle-color': '#dc2626', 'circle-opacity': 0.18, 'circle-stroke-color': '#dc2626', 'circle-stroke-width': 1.5 } });
    map.addLayer({ id: 'clusters', type: 'circle', source: 'trucks', filter: ['has', 'point_count'], paint: { 'circle-color': '#0f7d73', 'circle-opacity': 0.9, 'circle-radius': ['step', ['get', 'point_count'], 16, 10, 20, 30, 26], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
    map.addLayer({ id: 'cluster-count', type: 'symbol', source: 'trucks', filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Bold'], 'text-size': 12 }, paint: { 'text-color': '#ffffff' } });
    map.addLayer({ id: 'truck-halo', type: 'circle', source: 'trucks', filter: ['==', ['get', 'id'], ''], paint: { 'circle-radius': 20, 'circle-color': statusColor, 'circle-opacity': 0.22 } });
    map.addLayer({ id: 'truck-dot', type: 'circle', source: 'trucks', filter: ['!', ['has', 'point_count']], paint: { 'circle-radius': 12, 'circle-color': statusColor, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
    map.addLayer({ id: 'truck-label', type: 'symbol', source: 'trucks', filter: ['!', ['has', 'point_count']], layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 10, 'text-allow-overlap': true }, paint: { 'text-color': '#ffffff' } });
  };

  useEffect(() => {
    const map = new maplibregl.Map({
      container: box.current, style: dark ? MAP_STYLES.dark : MAP_STYLES.light, bounds: US, attributionControl: false, maxPitch: 0,
    });
    mapRef.current = map;
    // Controls sit on the left: the right side hosts the planner drawer and the app's floating dock.
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left');
    map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
    map.on('style.load', () => { addLayers(map); sync(); });
    map.on('click', 'truck-dot', (e) => { const id = e.features?.[0]?.properties?.id; if (id) latest.current.onSelect?.(id); });
    map.on('click', 'origin-dot', (e) => { const id = e.features?.[0]?.properties?.id; if (id) latest.current.onOpenLoad?.(id); });
    map.on('click', 'clusters', async (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const zoom = await map.getSource('trucks').getClusterExpansionZoom(f.properties.cluster_id);
      map.easeTo({ center: f.geometry.coordinates, zoom });
    });
    map.on('click', (e) => {
      if (!latest.current.pickMode) return;
      latest.current.onPick?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });
    for (const id of ['truck-dot', 'clusters', 'origin-dot']) {
      map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = latest.current.pickMode ? 'crosshair' : ''; });
    }
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(box.current);
    return () => { ro.disconnect(); map.remove(); mapRef.current = null; };
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

  useEffect(sync); // data, layers and selection

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
    const pad = plannedRoute ? { top: 70, bottom: 60, left: 60, right: Math.min(440, box.current.clientWidth / 2) } : 80;
    map.fitBounds(b, { padding: pad, maxZoom: 9, duration: 700 });
  }, [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const map = mapRef.current;
    if (map && focus?.lat != null) map.flyTo({ center: [focus.lng, focus.lat], zoom: Math.max(map.getZoom(), focus.zoom || 7), duration: 700 });
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
    <div className={className}>
      <div ref={box} className="h-full w-full" role="application" aria-label="Fleet map" />
    </div>
  );
}
