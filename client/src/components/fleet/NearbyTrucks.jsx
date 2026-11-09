import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Navigation } from 'lucide-react';
import { api } from '../../lib/api.js';
import { EQUIPMENT, label, relative } from '../../lib/format.js';
import { Button, Field, Loading, Select, cx } from '../ui.jsx';
import PlaceSearch from './PlaceSearch.jsx';
import { STATUS, placeLabel } from './fleetApi.js';

/** Rank trucks near a load's pickup: available ones first, closest first. */
export default function NearbyTrucks({ onClose, onFocus, onPlan }) {
  const [place, setPlace] = useState(null);
  const [equipment, setEquipment] = useState('');
  const [radius, setRadius] = useState('500');
  const q = useQuery({
    queryKey: ['fleet', 'near', place?.lat, place?.lng, equipment, radius],
    queryFn: () => api.get('/api/fleet/near', { lat: place.lat, lng: place.lng, equipment: equipment || undefined, radius }),
    enabled: place?.lat != null,
  });
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div><p className="text-xs text-muted">Find trucks near</p><h3 className="font-medium">A load's pickup</h3></div>
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
            <li key={t.id} className="flex items-center gap-3 px-3 py-2.5">
              <span className="w-5 text-right font-mono text-xs text-muted">{i + 1}</span>
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: STATUS[t.truckStatus]?.color }} />
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onFocus(t)}>
                <div className="truncate text-sm font-medium">{t.companyName}</div>
                <div className="truncate text-xs text-muted">{placeLabel(t.location)} · {t.distanceMiles} mi away · ~{t.deadheadEstimate} mi deadhead</div>
              </button>
              <span className={cx('shrink-0 text-xs', t.availableInTime ? 'text-green-700 dark:text-green-400' : 'text-muted')}>
                {t.availableInTime ? 'Ready' : t.availableAt ? relative(t.availableAt) : STATUS[t.truckStatus]?.label}
              </span>
              <Button size="sm" variant="secondary" icon={Navigation} onClick={() => onPlan(t, place)}>Plan</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
