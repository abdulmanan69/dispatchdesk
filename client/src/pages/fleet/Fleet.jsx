import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Search, Maximize2, Minimize2, Navigation, Radar, Truck, Layers, CalendarRange, X, List, MapPinPlus, Radio } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { EQUIPMENT, label, money, relative, dateTime } from '../../lib/format.js';
import TruckPanel from '../../components/fleet/TruckPanel.jsx';
import { Button, Card, ErrorState, Loading, Select, Switch, cx } from '../../components/ui.jsx';
import FleetMap from '../../components/fleet/FleetMap.jsx';
import TruckEditor from '../../components/fleet/TruckEditor.jsx';
import TripPlanner from '../../components/fleet/TripPlanner.jsx';
import TripTimeline from '../../components/fleet/TripTimeline.jsx';
import NearbyTrucks from '../../components/fleet/NearbyTrucks.jsx';
import { STATUS, STATUS_KEYS, TRIP_STATUS, placeLabel, weather, liveTag } from '../../components/fleet/fleetApi.js';

function useDarkMode() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

/** Height that fills the viewport below the element's top edge. */
function useFillHeight(ref, min = 520) {
  const [h, setH] = useState(640);
  useEffect(() => {
    const calc = () => { const top = ref.current?.getBoundingClientRect().top ?? 0; setH(Math.max(min, window.innerHeight - Math.max(0, top) - 24)); };
    calc();
    window.addEventListener('resize', calc);
    return () => window.removeEventListener('resize', calc);
  }, [ref, min]);
  return h;
}

const endOfDay = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); d.setHours(23, 59, 59, 999); return d; };
function readyBy(t, when) {
  if (when === 'any') return true;
  if (t.truckStatus === 'off_duty' || t.truckStatus === 'maintenance') return false;
  const cutoff = when === 'now' ? new Date() : endOfDay(when === 'today' ? 0 : 1);
  if (t.availableAt) return new Date(t.availableAt) <= cutoff;
  return t.truckStatus === 'available';
}

export default function Fleet() {
  const dark = useDarkMode();
  const wrap = useRef(null);
  const height = useFillHeight(wrap);
  const [scopeAll, setScopeAll] = useState(false);
  const [search, setSearch] = useState('');
  const [statuses, setStatuses] = useState([]);
  const [equipment, setEquipment] = useState('');
  const [stateF, setStateF] = useState('');
  const [when, setWhen] = useState('any');
  const [layers, setLayers] = useState({ trucks: true, trips: true, origins: true, weather: false });
  const [selectedId, setSelectedId] = useState(null);
  const [panel, setPanel] = useState(null); // { kind: 'edit'|'plan'|'near', ...}
  const [pickMode, setPickMode] = useState(false);
  const [mapPoint, setMapPoint] = useState(null);
  const [editPoint, setEditPoint] = useState(null);
  const [plannedRoute, setPlannedRoute] = useState(null);
  const [focus, setFocus] = useState(null);
  const [fitKey, setFitKey] = useState(0);
  const [showBoard, setShowBoard] = useState(true);
  const [listOpen, setListOpen] = useState(false); // mobile truck list
  const [trailFor, setTrailFor] = useState(null);
  const [full, setFull] = useState(false);

  const q = useQuery({
    queryKey: ['fleet', scopeAll ? 'all' : 'fleet'], queryFn: () => api.get('/api/fleet', { scope: scopeAll ? 'all' : 'fleet' }),
    // Follow live drivers: refresh every 20 s while anyone is sharing, otherwise every 2 minutes.
    refetchInterval: (query) => (query.state.data?.trucks?.some((t) => t.live?.sharing) ? 20000 : 120000),
  });
  const trucks = q.data?.trucks || [];
  const trailQ = useQuery({ queryKey: ['fleet', 'trail', trailFor], queryFn: () => api.get(`/api/fleet/carriers/${trailFor}/trail`, { hours: 24 }), enabled: !!trailFor, refetchInterval: 30000 });
  const trail = trailFor ? (trailQ.data?.items || []).map((p) => [p.lng, p.lat]) : null;
  const liveCount = trucks.filter((t) => t.live?.sharing && !t.live?.stale).length;
  const toggleFull = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await wrap.current?.requestFullscreen?.();
    } catch { /* fullscreen not allowed */ }
  };
  useEffect(() => {
    const on = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const fitted = useRef(false);
  useEffect(() => { if (q.data && !fitted.current) { fitted.current = true; setFitKey((k) => k + 1); } }, [q.data]);

  const states = useMemo(() => [...new Set(trucks.map((t) => t.location?.state || t.homeState).filter(Boolean))].sort(), [trucks]);
  const visible = useMemo(() => {
    const s = search.trim().toLowerCase();
    return trucks.filter((t) => (!s || [t.companyName, t.mcNumber, t.dotNumber, t.phone, placeLabel(t.location)].filter(Boolean).join(' ').toLowerCase().includes(s))
      && (!statuses.length || statuses.includes(t.truckStatus))
      && (!equipment || String(t.equipment || '').split(',').includes(equipment))
      && (!stateF || (t.location?.state || t.homeState) === stateF)
      && readyBy(t, when));
  }, [trucks, search, statuses, equipment, stateF, when]);
  const selected = trucks.find((t) => t.id === selectedId) || null;
  const unplaced = visible.filter((t) => t.location?.lat == null).length;

  // Weather alerts for trucks (only when the layer is on; capped to keep the weather service polite).
  const located = visible.filter((t) => t.location?.lat != null).slice(0, 20);
  const wx = useQueries({
    queries: located.map((t) => ({
      queryKey: ['fleet', 'weather', t.location.lat.toFixed(2), t.location.lng.toFixed(2)],
      queryFn: () => weather(t.location), enabled: layers.weather, staleTime: 900000,
    })),
  });
  const alerts = layers.weather ? located.map((t, i) => ({ t, w: wx[i]?.data })).filter((x) => x.w?.alerts?.length)
    .map(({ t, w }) => ({ id: t.id, lat: t.location.lat, lng: t.location.lng, label: w.alerts[0].event })) : [];
  const weatherDown = layers.weather && located.length > 0 && wx.every((r) => r.isFetched && !r.data);

  const advance = useApiMutation(({ id, status }) => api.post(`/api/fleet/trips/${id}/status`, { status }), {
    success: (d) => `Trip is now ${TRIP_STATUS[d.trip.status]?.label.toLowerCase()}`, invalidate: [['fleet'], ['loads']],
  });

  const focusTruck = (t) => {
    setSelectedId(t.id);
    setListOpen(false);
    if (t.location?.lat != null) setFocus({ key: `${t.id}-${Date.now()}`, lat: t.location.lat, lng: t.location.lng, zoom: 8 });
  };
  const closePanel = () => { setPanel(null); setPickMode(false); setMapPoint(null); setEditPoint(null); setPlannedRoute(null); };
  const toggle = (k) => setLayers((l) => ({ ...l, [k]: !l[k] }));
  const toggleStatus = (k) => setStatuses((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));

  if (q.isError) return <ErrorState error={q.error} onRetry={q.refetch} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-medium tracking-[-0.01em]">Fleet map</h1>
          <p className="mt-1 text-sm text-fg-2">Where every truck is, what it is doing, and the trips you plan for it</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" icon={Radar} onClick={() => { closePanel(); setPanel({ kind: 'near' }); }}>Find trucks near</Button>
          <Button icon={Navigation} disabled={!trucks.length} onClick={() => { closePanel(); setPanel({ kind: 'plan', carrierId: selectedId || visible[0]?.id }); }}>Plan a trip</Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {STATUS_KEYS.map((k) => (
          <button key={k} type="button" onClick={() => toggleStatus(k)} aria-pressed={statuses.includes(k)}
            className={cx('flex items-center gap-2 rounded-xl border px-3 py-2 text-left transition-ui', statuses.includes(k) ? STATUS[k].soft : 'border-line bg-surface hover:bg-surface-2')}>
            <span className="size-2.5 rounded-full" style={{ background: STATUS[k].color }} />
            <span className="text-[13px] text-fg-2">{STATUS[k].label}</span>
            <span className="tabular text-base font-medium">{q.data?.counts?.[k] ?? 0}</span>
          </button>
        ))}
      </div>

      <div ref={wrap} className={cx('relative flex overflow-hidden border border-line bg-surface', full ? 'rounded-none' : 'rounded-xl')} style={{ height: full ? '100vh' : height }}>
        {/* Truck list */}
        <aside className={cx('w-[320px] shrink-0 flex-col border-r border-line bg-surface md:static md:flex md:shadow-none', listOpen ? 'absolute inset-y-0 left-0 z-10 flex w-[min(320px,85%)] shadow-xl' : 'hidden')}>
          <div className="space-y-2 border-b border-line p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search trucks" aria-label="Search trucks"
                className="h-9 w-full rounded-lg border border-line-strong bg-surface pl-8 pr-3 text-sm text-fg placeholder:text-muted focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/15" />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Select aria-label="Equipment" value={equipment} onChange={(e) => setEquipment(e.target.value)} className="h-8 text-xs"><option value="">Equipment</option>{EQUIPMENT.map((x) => <option key={x} value={x}>{label(x)}</option>)}</Select>
              <Select aria-label="State" value={stateF} onChange={(e) => setStateF(e.target.value)} className="h-8 text-xs"><option value="">State</option>{states.map((s) => <option key={s} value={s}>{s}</option>)}</Select>
              <Select aria-label="Available" value={when} onChange={(e) => setWhen(e.target.value)} className="h-8 text-xs"><option value="any">Any time</option><option value="now">Ready now</option><option value="today">By today</option><option value="tomorrow">By tomorrow</option></Select>
            </div>
            <div className="flex items-center justify-between text-xs text-muted">
              <span>{visible.length} of {trucks.length} trucks{unplaced ? ` · ${unplaced} without location` : ''}</span>
              <Switch checked={scopeAll} onChange={setScopeAll} label={<span className="text-xs">All carriers</span>} />
            </div>
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {q.isLoading && <li><Loading className="py-8" /></li>}
            {!q.isLoading && visible.length === 0 && (
              <li className="px-4 py-8 text-center text-sm text-muted">
                {trucks.length ? 'No trucks match these filters.' : <>No trucks yet. Customers appear here automatically. Turn on <span className="text-fg">All carriers</span> to place any carrier on the map.</>}
              </li>
            )}
            {visible.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => focusTruck(t)}
                  className={cx('flex w-full items-start gap-3 border-b border-line px-3 py-2.5 text-left transition-ui hover:bg-surface-2', selectedId === t.id && 'bg-surface-2')}>
                  <span className="mt-1 size-2.5 shrink-0 rounded-full ring-2 ring-white dark:ring-zinc-900" style={{ background: STATUS[t.truckStatus]?.color }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{t.companyName}</span>
                    <span className="block truncate text-xs text-muted">{t.location ? placeLabel(t.location) : 'No location'}{t.equipment ? ` · ${label(t.equipment.split(',')[0])}` : ''}</span>
                    {(t.currentTrip || t.nextTrip) && <span className="block truncate text-xs" style={{ color: TRIP_STATUS[(t.currentTrip || t.nextTrip).status]?.color }}>{(t.currentTrip || t.nextTrip).origin.city} → {(t.currentTrip || t.nextTrip).dest.city}</span>}
                    {liveTag(t) && <span className={cx('mt-0.5 flex items-center gap-1 text-[11px]', liveTag(t).tone === 'live' ? 'text-c-green' : 'text-muted')}><Radio className="size-3" aria-hidden />{liveTag(t).text}</span>}
                  </span>
                  {t.availableAt && <span className="shrink-0 text-[11px] text-muted">{new Date(t.availableAt) <= new Date() ? 'Ready' : relative(t.availableAt)}</span>}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {/* Map */}
        <div className="relative min-w-0 flex-1">
          {listOpen && <button type="button" aria-label="Close truck list" className="absolute inset-0 z-[9] bg-black/20 md:hidden" onClick={() => setListOpen(false)} />}
          <FleetMap className="absolute inset-0" dark={dark} trucks={visible} openLoads={q.data?.openLoads || []} alerts={alerts} layers={layers}
            selectedId={selectedId} onSelect={(id) => { setSelectedId(id); }} pickMode={pickMode}
            onPick={(p) => { setMapPoint(p); setPickMode(false); }} editPoint={editPoint} onEditMove={setMapPoint}
            plannedRoute={plannedRoute} focus={focus} fitKey={fitKey} trail={trail}
            onOpenLoad={(id) => { const l = q.data?.openLoads.find((x) => x.id === id); if (l) { closePanel(); setPanel({ kind: 'near-load', load: l }); } }} />

          <div className="absolute left-3 top-3 flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={() => setListOpen((v) => !v)} className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface/95 px-2.5 text-xs font-medium shadow-sm backdrop-blur hover:bg-surface-2 md:hidden"><List className="size-3.5" />Trucks {visible.length}</button>
            <button type="button" onClick={() => setFitKey((k) => k + 1)} className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface/95 px-2.5 text-xs font-medium shadow-sm backdrop-blur hover:bg-surface-2"><Navigation className="size-3.5" />Fit all</button>
            <button type="button" onClick={toggleFull} aria-label={full ? 'Exit full screen' : 'Full screen'} className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface/95 px-2.5 text-xs font-medium shadow-sm backdrop-blur hover:bg-surface-2">{full ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}<span className="hidden sm:inline">{full ? 'Exit' : 'Full screen'}</span></button>
            {liveCount > 0 && <span className="flex h-8 items-center gap-1.5 rounded-lg border border-c-green/30 bg-c-green-soft px-2.5 text-xs font-medium text-c-green shadow-sm"><span className="size-2 animate-pulse rounded-full bg-c-green" />{liveCount} live</span>}
            <span className="flex h-8 items-center gap-1 rounded-lg border border-line bg-surface/95 px-1.5 shadow-sm backdrop-blur">
              <Layers className="mx-1 size-3.5 text-muted" aria-hidden />
              {[['trucks', 'Trucks'], ['trips', 'Trips'], ['origins', 'Open loads'], ['weather', 'Weather']].map(([k, l]) => (
                <button key={k} type="button" aria-pressed={layers[k]} onClick={() => toggle(k)}
                  className={cx('rounded-md px-2 py-1 text-xs transition-ui', layers[k] ? 'bg-brand-600 text-white' : 'text-fg-2 hover:bg-surface-2')}>{l}</button>
              ))}
            </span>
            {pickMode && <span className="rounded-lg bg-brand-600 px-2.5 py-1.5 text-xs font-medium text-white shadow-sm">Click the map to place the truck</span>}
            {weatherDown && <span className="rounded-lg border border-line bg-surface/95 px-2.5 py-1.5 text-xs text-muted shadow-sm">Weather service not connected</span>}
          </div>

          {/* Selected truck: actions hub */}
          {selected && !panel && (
            <TruckPanel key={selected.id} truck={selected} onClose={() => { setSelectedId(null); setTrailFor(null); }}
              onPlan={() => setPanel({ kind: 'plan', carrierId: selected.id })}
              onEdit={() => setPanel({ kind: 'edit', truck: selected })}
              onAdvance={(id, status) => advance.mutate({ id, status })} advancing={advance.isPending}
              trailOn={trailFor === selected.id} onTrail={() => setTrailFor((x) => (x === selected.id ? null : selected.id))} />
          )}

          {/* Empty map guidance */}
          {!q.isLoading && !trucks.some((t) => t.location?.lat != null) && !panel && !selected && (
            <div className="absolute inset-x-3 bottom-16 mx-auto max-w-md rounded-xl border border-line bg-surface/95 p-4 shadow-lg backdrop-blur sm:bottom-auto sm:top-1/3">
              <div className="flex items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-c-teal-soft text-c-teal"><MapPinPlus className="size-5" aria-hidden /></span>
                <div className="min-w-0 space-y-2 text-sm">
                  <p className="font-medium">Add a truck location</p>
                  <p className="text-fg-2">Pick a truck, then set where it is: search a city, click the map, or send the driver a live location link from their phone.</p>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {trucks[0]
                      ? <Button size="sm" icon={MapPinPlus} onClick={() => setPanel({ kind: 'edit', truck: trucks[0] })}>Set location for {trucks[0].companyName.split(' ')[0]}</Button>
                      : <Button size="sm" onClick={() => setScopeAll(true)}>Show all carriers</Button>}
                    <Button size="sm" variant="secondary" to="/app/carriers">Carrier list</Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Side drawer */}
          {panel && (
            <div className="dd-enter absolute bottom-3 right-3 top-3 w-[min(400px,calc(100%-24px))] overflow-y-auto rounded-xl border border-line bg-surface p-4 shadow-xl">
              {panel.kind === 'edit' && (
                <TruckEditor key={panel.truck.id} truck={panel.truck} onClose={closePanel} pickMode={pickMode} setPickMode={setPickMode} mapPoint={mapPoint} setEditPoint={setEditPoint} />
              )}
              {panel.kind === 'plan' && (
                <TripPlanner key={`${panel.carrierId}-${panel.origin?.lat ?? ''}`} trucks={trucks} initialCarrierId={panel.carrierId} initialOrigin={panel.origin} onClose={closePanel}
                  onPreview={(r) => { setPlannedRoute(r); if (r) setFitKey((k) => k + 1); }} />
              )}
              {panel.kind === 'near' && (
                <NearbyTrucks onClose={closePanel} onFocus={focusTruck} onPlan={(t, place) => setPanel({ kind: 'plan', carrierId: t.id, origin: place })} />
              )}
              {panel.kind === 'near-load' && (
                <div className="space-y-3">
                  <div className="flex items-start justify-between"><div><p className="text-xs text-muted">Open load</p><h3 className="font-medium">{panel.load.origin.city}, {panel.load.origin.state} → {panel.load.dest.city}, {panel.load.dest.state}</h3></div>
                    <button type="button" onClick={closePanel} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Close"><X className="size-4" /></button></div>
                  <p className="text-sm text-fg-2">{money(panel.load.rateCents, { digits: 0 })} · {panel.load.loadedMiles} mi{panel.load.pickupDate ? ` · pickup ${dateTime(panel.load.pickupDate)}` : ''}</p>
                  <p className="text-xs text-muted">This load has no carrier yet. Assign it from the Loads page, or plan a new trip for a nearby truck.</p>
                  <div className="flex gap-2">
                    <Button size="sm" icon={Radar} onClick={() => setPanel({ kind: 'near' })}>Find trucks near</Button>
                    <Button size="sm" variant="secondary" to="/app/loads">Open loads</Button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className={cx('pointer-events-none absolute right-3 top-14 hidden flex-col gap-1 rounded-lg border border-line bg-surface/95 p-2 text-[11px] shadow-sm backdrop-blur', !panel && 'sm:flex')}>
            {STATUS_KEYS.map((k) => <span key={k} className="flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: STATUS[k].color }} />{STATUS[k].label}</span>)}
            <span className="flex items-center gap-1.5"><span className="size-2 rounded-full border-2 border-violet-600 bg-white" />Open load</span>
            <span className="mt-1 flex items-center gap-1.5 border-t border-line pt-1"><span className="relative flex size-2"><span className="absolute inset-0 animate-ping rounded-full bg-c-green opacity-60" /><span className="relative size-2 rounded-full bg-c-green" /></span>Live GPS</span>
            <span className="flex items-center gap-1.5"><span className="h-0.5 w-3 rounded bg-blue-600" />Trip</span>
            <span className="flex items-center gap-1.5"><span className="h-0 w-3 border-t-2 border-dashed border-zinc-500" />Empty miles</span>
          </div>
        </div>
      </div>

      <Card title={<span className="flex items-center gap-2 text-sm font-medium"><CalendarRange className="size-4 text-brand-600" />Week board</span>}
        actions={<Button size="sm" variant="ghost" onClick={() => setShowBoard((v) => !v)}>{showBoard ? 'Hide' : 'Show'}</Button>}>
        {showBoard ? <TripTimeline onSelectCarrier={(id) => { const t = trucks.find((x) => x.id === id); if (t) focusTruck(t); }} /> : <p className="text-sm text-muted">Hidden</p>}
      </Card>

      <p className="flex items-center gap-1.5 text-xs text-muted"><Truck className="size-3.5" aria-hidden />Map tiles by OpenFreeMap with OpenStreetMap data. Road miles come from the routing service when it is connected; otherwise distances are straight-line estimates × 1.18 and are labelled as such. <Link to="/app/loads" className="text-brand-700 hover:underline dark:text-brand-300">All loads</Link></p>
    </div>
  );
}
