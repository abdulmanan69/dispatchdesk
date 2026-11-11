import { useEffect, useState } from 'react';
import { Input, cx } from '../ui.jsx';
import { browserTz, dateToZonedInput, formatInZone, zoneAbbr, zonedInputToDate } from './callWindow.js';

/**
 * Date and time picker for call-backs. When the carrier's time zone is known (and differs from yours) the time is
 * typed in the carrier's local time by default ("call me back at 3" means their 3), with your own time shown
 * alongside. A toggle switches to typing in your time. value / onChange use ISO strings ('' when empty).
 */
export default function CarrierTimeInput({ value, onChange, timezone, id, className, required, 'aria-label': ariaLabel = 'Date and time', min }) {
  const mine = browserTz();
  // Same wall clock right now means no conversion is needed (abbreviations alone mix up Arizona and Denver).
  const now = new Date();
  const sameZone = !timezone || dateToZonedInput(now, timezone) === dateToZonedInput(now, mine);
  const [mode, setMode] = useState(sameZone ? 'mine' : 'carrier');
  const zone = mode === 'carrier' && timezone ? timezone : mine;
  const [text, setText] = useState(() => (value ? dateToZonedInput(value, zone) : ''));

  // Follow outside changes (presets, reset) without fighting the user's typing.
  useEffect(() => {
    const cur = text ? zonedInputToDate(text, zone) : null;
    const v = value ? new Date(value) : null;
    if ((cur ? cur.getTime() : null) !== (v && !Number.isNaN(v.getTime()) ? v.getTime() : null)) setText(v ? dateToZonedInput(v, zone) : '');
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  // The carrier changed (another follow-up, another call): start again in that carrier's time, and show the chosen
  // moment in that zone so the typed text never disagrees with the value that will be saved.
  useEffect(() => {
    const m = sameZone ? 'mine' : 'carrier';
    setMode(m);
    const v = value ? new Date(value) : null;
    setText(v && !Number.isNaN(v.getTime()) ? dateToZonedInput(v, m === 'carrier' && timezone ? timezone : mine) : '');
  }, [timezone]); // eslint-disable-line react-hooks/exhaustive-deps

  const emit = (t, z) => {
    const d = t ? zonedInputToDate(t, z) : null;
    onChange?.(d && !Number.isNaN(d.getTime()) ? d.toISOString() : '');
  };
  const change = (e) => { setText(e.target.value); emit(e.target.value, zone); };
  const switchTo = (m) => {
    if (m === mode) return;
    setMode(m);
    // Keep the typed wall-clock time and read it in the other zone.
    emit(text, m === 'carrier' && timezone ? timezone : mine);
  };

  const d = value ? new Date(value) : null;
  const valid = d && !Number.isNaN(d.getTime());
  const carrierAbbr = zoneAbbr(timezone || mine, valid ? d : new Date());
  const myAbbr = zoneAbbr(mine, valid ? d : new Date());
  let hint = null;
  if (valid && !sameZone) {
    hint = mode === 'carrier'
      ? `= ${formatInZone(d, mine)} your time (${myAbbr})`
      : `= ${formatInZone(d, timezone)} carrier time (${carrierAbbr})`;
  } else if (!timezone) {
    hint = 'Carrier time zone unknown: time is in your zone';
  }

  return (
    <div className={cx('space-y-1.5', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Input id={id} type="datetime-local" aria-label={ariaLabel} value={text} onChange={change} required={required} min={min} className="w-60" />
        {!sameZone && (
          <div role="radiogroup" aria-label="Time zone for this time" className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5">
            {[['carrier', `Carrier time (${carrierAbbr})`], ['mine', `My time (${myAbbr})`]].map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={mode === k} onClick={() => switchTo(k)}
                className={cx('h-7 rounded-md px-2 text-xs transition-ui', mode === k ? 'bg-surface font-medium text-fg shadow-sm ring-1 ring-line' : 'text-fg-2 hover:text-fg')}>
                {l}
              </button>
            ))}
          </div>
        )}
      </div>
      {hint && <p className="text-xs text-muted" aria-live="polite">{hint}</p>}
    </div>
  );
}
