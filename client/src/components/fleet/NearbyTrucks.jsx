import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Navigation, Scale } from 'lucide-react';
import { api } from '../../lib/api.js';
import { EQUIPMENT, label, relative } from '../../lib/format.js';
import { Badge, Button, Field, Loading, Select, cx } from '../ui.jsx';
import PlaceSearch from './PlaceSearch.jsx';
import FitCard from '../dispatch/FitCard.jsx';
import { STATUS, placeLabel } from './fleetApi.js';

/** The server's rules check of the open load for one truck (nothing when the carrier has no saved rules). */
function FitLine({ fit }) {
  if (!fit) return null;
  const n = fit.warnings.length;
  if (!n) return <div className="mt-1"><Badge color="green">Fits the rules</Badge></div>;
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1.5">
      <Badge color="amber">{n === 1 ? '1 rule warning' : `${n} rule warnings`}</Badge>
      <span className="truncate text-[11px] text-fg-2">{fit.warnings[0].message}</span>
    </div>
  );
}

/**
 * Rank trucks near a load's pickup: available ones first, closest first.
 * Opened from an open load (`load`, a fleet trip view): the pickup is filled in, each customer truck shows whether the
 * load fits its carrier's rules, and the full check opens per truck (one at a time).
 */
export default function NearbyTrucks({ onClose, onFocus, onPlan, initialPlace = null, load = null }) {
  const [place, setPlace] = useState(initialPlace?.lat != null ? initialPlace : null);
  const [equipment, setEquipment] = useState(() => (load?.equipment && EQUIPMENT.includes(load.equipment) ? load.equipment : ''));
  const [radius, setRadius] = useState('500');
  const [checking, setChecking] = useState(null);
  const q = useQuery({
    queryKey: ['fleet', 'near', place?.lat, place?.lng, equipment, radius, load?.id || ''],
    queryFn: ({ signal }) => api.get('/api/fleet/near', { lat: place.lat, lng: place.lng, equipment: equipment || undefined, radius, loadId: load?.id || undefined }, { signal }),
    enabled: place?.lat != null,
  });
  const fitFor = (t) => ({
    rateCents: load.rateCents, loadedMiles: load.loadedMiles, deadheadMiles: t.deadheadEstimate ?? null, equipment: load.equipment,
    originState: load.origin?.state, destState: load.dest?.state, pickupDate: load.pickupDate, deliveryDate: load.deliveryDate,
  });
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div><p className="text-xs text-muted">Find trucks near</p><h3 className="font-medium">{load ? `${load.origin.city}, ${load.origin.state} → ${load.dest.city}, ${load.dest.state}` : "A load's pickup"}</h3></div>
        <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Close"><X className="size-4" /></button>
      </div>
      <Field label="Pickup">{(id) => <PlaceSearch id={id} value={place} onChange={setPlace} autoFocus />}</Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Equipment"><Select value={equipment} onChange={(e) => setEquipment(e.target.value)}><option value="">Any</option>{EQUIPMENT.map((x) => <option key={x} value={x}>{label(x)}</option>)}</Select></Field>
        <Field label="Within"><Select value={radius} onChange={(e) => setRadius(e.target.value)}>{['100', '250', '500', '1000', '3000'].map((r) => <option key={r} value={r}>{r} miles</option>)}</Select></Field>
      </div>
      {q.isFetching && <Loading />}
      {q.data && (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {q.data.items.length === 0 && <li className="px-3 py-4 text-sm text-muted">No trucks with a location inside {radius} miles.</li>}
          {q.data.items.map((t, i) => (
            <Fragment key={t.id}>
            <li className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <span className="w-5 text-right font-mono text-xs text-muted">{i + 1}</span>
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: STATUS[t.truckStatus]?.color }} />
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onFocus(t)}>
                <div className="truncate text-sm font-medium">{t.companyName}</div>
                <div className="truncate text-xs text-muted">{placeLabel(t.location)} · {t.distanceMiles} mi away · ~{t.deadheadEstimate} mi deadhead</div>
                <FitLine fit={t.fit} />
              </button>
              <span className={cx('shrink-0 text-xs', t.availableInTime ? 'text-green-700 dark:text-green-400' : 'text-muted')}>
                {t.availableInTime ? 'Ready' : t.availableAt ? relative(t.availableAt) : STATUS[t.truckStatus]?.label}
              </span>
              <span className="flex shrink-0 gap-1.5">
                {load && (
                  <Button size="sm" variant="ghost" icon={Scale} aria-expanded={checking === t.id} onClick={() => setChecking(checking === t.id ? null : t.id)}>Check</Button>
                )}
                <Button size="sm" variant="secondary" icon={Navigation} onClick={() => onPlan(t, place)}>Plan</Button>
              </span>
            </li>
            {load && checking === t.id && (
              <li className="bg-surface-2 px-3 py-3"><FitCard carrierId={t.id} load={fitFor(t)} /></li>
            )}
            </Fragment>
          ))}
        </ul>
      )}
    </div>
  );
}
