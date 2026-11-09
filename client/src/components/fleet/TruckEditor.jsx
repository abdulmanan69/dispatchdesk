import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { toLocalInput } from '../../lib/format.js';
import { Button, Field, Input, cx } from '../ui.jsx';
import PlaceSearch from './PlaceSearch.jsx';
import { STATUS, STATUS_KEYS } from './fleetApi.js';

const QUICK = [['Now', 0], ['+4 h', 4], ['Tomorrow 8 AM', 'tm8'], ['+2 days', 48]];
function quick(v) {
  const d = new Date();
  if (v === 'tm8') { d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); } else d.setTime(d.getTime() + v * 3600000);
  return toLocalInput(d);
}

/** Set a truck's status, location (search, map click or drag) and when it is next available. */
export default function TruckEditor({ truck, onClose, pickMode, setPickMode, mapPoint, setEditPoint }) {
  const [status, setStatus] = useState(truck.truckStatus);
  const [place, setPlace] = useState(truck.location ? { ...truck.location } : null);
  const [availableAt, setAvailableAt] = useState(truck.availableAt ? toLocalInput(truck.availableAt) : '');

  // Points picked or dragged on the map flow back in here.
  // A point picked or dragged on the map replaces the searched city (we do not reverse-geocode it).
  useEffect(() => { if (mapPoint) setPlace({ city: null, state: null, ...mapPoint }); }, [mapPoint?.lat, mapPoint?.lng]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setEditPoint(place?.lat != null ? { lat: place.lat, lng: place.lng } : null); }, [place?.lat, place?.lng]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { setEditPoint(null); setPickMode(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useApiMutation((body) => api.patch(`/api/fleet/carriers/${truck.id}`, body), {
    success: 'Truck updated', invalidate: [['fleet']], onSuccess: onClose,
  });
  const submit = (e) => {
    e.preventDefault();
    const body = { truckStatus: status, availableAt: availableAt ? new Date(availableAt).toISOString() : null };
    if (place && (place.lat != null || place.state)) body.location = { city: place.city || null, state: place.state || null, lat: place.lat ?? null, lng: place.lng ?? null };
    save.mutate(body);
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted">Update truck</p>
          <h3 className="truncate font-medium">{truck.companyName}</h3>
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Close"><X className="size-4" /></button>
      </div>

      <fieldset>
        <legend className="mb-1.5 text-[13px] font-medium">Status</legend>
        <div className="flex flex-wrap gap-1.5">
          {STATUS_KEYS.map((k) => (
            <button key={k} type="button" aria-pressed={status === k} onClick={() => setStatus(k)}
              className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-ui', status === k ? STATUS[k].soft : 'border-line text-fg-2 hover:bg-surface-2')}>
              <span className="size-2 rounded-full" style={{ background: STATUS[k].color }} />{STATUS[k].label}
            </button>
          ))}
        </div>
      </fieldset>

      <Field label="Location" hint={pickMode ? 'Click the map to drop the truck there. Drag the pin to adjust.' : 'Search a city, click the crosshair to pick on the map, or drag the pin'}>
        {(id) => <PlaceSearch id={id} value={place} onChange={setPlace} onPickOnMap={() => setPickMode(!pickMode)} picking={pickMode} />}
      </Field>
      {place?.lat != null && <p className="-mt-2 font-mono text-[11px] text-muted">{place.lat.toFixed(4)}, {place.lng.toFixed(4)}</p>}

      <Field label="Available from">
        <Input type="datetime-local" value={availableAt} onChange={(e) => setAvailableAt(e.target.value)} />
      </Field>
      <div className="-mt-2 flex flex-wrap gap-1.5">
        {QUICK.map(([l, v]) => <button key={l} type="button" onClick={() => setAvailableAt(quick(v))} className="rounded-md border border-line px-2 py-0.5 text-xs text-fg-2 hover:bg-surface-2">{l}</button>)}
        {availableAt && <button type="button" onClick={() => setAvailableAt('')} className="rounded-md px-2 py-0.5 text-xs text-muted hover:text-fg">Clear</button>}
      </div>

      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" loading={save.isPending}>Save truck</Button>
      </div>
    </form>
  );
}
