import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { Modal } from '../Modal.jsx';
import { Button, Field, Input, Textarea } from '../ui.jsx';
import PlaceSearch from './PlaceSearch.jsx';
import { parseHours } from './fleetApi.js';

/**
 * Log a check call with the driver: what they said, where the truck is (optional, moves the truck on the map) and the
 * hours left on their clocks (optional, feeds the legal ETA). Calls are made by the dispatcher; nothing is dialed here.
 */
export default function CheckCallModal({ trip, truck, onClose, onSaved }) {
  const [note, setNote] = useState('');
  const [place, setPlace] = useState(null);
  const [hours, setHours] = useState({ drive: '', shift: '', cycle: '' });
  const [error, setError] = useState(null);
  const save = useApiMutation((body) => api.post(`/api/fleet/trips/${trip.id}/check-call`, body), {
    success: 'Check call logged', invalidate: [['fleet'], ['today']],
    onSuccess: (d) => { onSaved?.(d); onClose(); },
  });
  const submit = (e) => {
    e.preventDefault();
    const drive = parseHours(hours.drive);
    const shift = parseHours(hours.shift);
    const cycle = parseHours(hours.cycle);
    if ([drive, shift, cycle].some((v) => Number.isNaN(v))) { setError('Write hours as 6:30 or 6.5'); return; }
    if ((drive ?? 0) > 660 || (shift ?? 0) > 840 || (cycle ?? 0) > 4200) { setError('Hours left cannot be more than 11, 14 and 70'); return; }
    setError(null);
    const hos = drive != null || shift != null || cycle != null ? { driveLeftMin: drive, shiftLeftMin: shift, cycleLeftMin: cycle } : null;
    save.mutate({
      note: note.trim() || null, hos,
      location: place && (place.state || place.lat != null) ? { city: place.city || null, state: place.state || null, lat: place.lat ?? null, lng: place.lng ?? null } : null,
    });
  };
  const set = (k) => (e) => setHours((h) => ({ ...h, [k]: e.target.value }));
  return (
    <Modal open onClose={onClose} size="md" title={`Check call · ${truck.companyName}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="check-call-form" loading={save.isPending}>Log check call</Button></>}>
      <form id="check-call-form" onSubmit={submit} className="space-y-4">
        <p className="text-sm text-fg-2">{trip.origin.city}, {trip.origin.state} → {trip.dest.city}, {trip.dest.state}{trip.referenceNumber ? ` · ref ${trip.referenceNumber}` : ''}</p>
        <Field label="What the driver said"><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Rolling, about 2 hours out. No issues." /></Field>
        <Field label="Where the truck is" hint="Optional. Moves the truck on the map.">{(id) => <PlaceSearch id={id} value={place} onChange={setPlace} placeholder="City, state" />}</Field>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium">Hours left <span className="font-normal text-muted">(optional, for the legal ETA)</span></legend>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Drive (11 h)"><Input inputMode="decimal" value={hours.drive} onChange={set('drive')} placeholder="6:30" /></Field>
            <Field label="Shift (14 h)"><Input inputMode="decimal" value={hours.shift} onChange={set('shift')} placeholder="9:00" /></Field>
            <Field label="Cycle (70 h)"><Input inputMode="decimal" value={hours.cycle} onChange={set('cycle')} placeholder="42" /></Field>
          </div>
          {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}
        </fieldset>
      </form>
    </Modal>
  );
}
