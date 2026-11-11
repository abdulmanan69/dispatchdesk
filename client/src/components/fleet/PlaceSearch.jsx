import { useEffect, useId, useRef, useState } from 'react';
import { MapPin, Loader2, Crosshair } from 'lucide-react';
import { cx } from '../ui.jsx';
import { geocode, placeLabel } from './fleetApi.js';

// Answers already seen in this tab (the geocoder is a shared, rate-limited free service).
const seen = new Map();
const SEEN_MAX = 200;
async function lookup(q, opts) {
  const key = q.toLowerCase();
  if (seen.has(key)) return seen.get(key);
  const r = await geocode(q, opts);
  if (seen.size >= SEEN_MAX) seen.delete(seen.keys().next().value);
  seen.set(key, r);
  return r;
}

/**
 * Themed async place picker: type a city, pick a suggestion. value: { city, state, lat, lng } | null.
 * `onPickOnMap` adds a button to choose the point by clicking the map instead.
 * Searches start at 3 characters after a short pause, and repeated searches are answered from memory.
 */
export default function PlaceSearch({ value, onChange, placeholder = 'City, state', id, onPickOnMap, picking, autoFocus }) {
  const [text, setText] = useState(placeLabel(value));
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const [source, setSource] = useState('');
  const listId = `${useId()}-places`;
  const boxRef = useRef(null);
  const typed = useRef(false);

  useEffect(() => { if (!typed.current) setText(placeLabel(value)); }, [value?.city, value?.state, value?.lat, value?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!typed.current) return undefined;
    const q = text.trim();
    if (q.length < 3) { setItems([]); return undefined; }
    let live = true;
    // Typing on cancels the previous lookup (the geocoder is shared and rate limited).
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await lookup(q, { signal: ctrl.signal });
        if (live) { setItems(r.items || []); setSource(r.source || ''); setActive(0); setOpen(true); }
      } catch { if (live) setItems([]); } finally { if (live) setBusy(false); }
    }, 400);
    return () => { live = false; clearTimeout(t); ctrl.abort(); };
  }, [text]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!boxRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [open]);

  const pick = (p) => {
    typed.current = false;
    setText(placeLabel(p));
    setOpen(false);
    onChange?.({ city: p.city || null, state: p.state || null, lat: p.lat, lng: p.lng });
  };

  const key = (e) => {
    if (!open || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(items[active]); }
    else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
  };

  return (
    <div ref={boxRef} className="relative">
      <div className="flex gap-1.5">
        <div className="relative min-w-0 flex-1">
          <MapPin className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <input id={id} value={text} autoFocus={autoFocus} placeholder={placeholder} autoComplete="off"
            role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
            onChange={(e) => { typed.current = true; setText(e.target.value); }}
            onFocus={() => items.length && setOpen(true)} onKeyDown={key}
            className="h-9 w-full rounded-lg border border-line-strong bg-surface pl-8 pr-8 text-sm text-fg placeholder:text-muted transition-ui focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/15" />
          {busy && <Loader2 className="absolute right-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted" aria-hidden />}
        </div>
        {onPickOnMap && (
          <button type="button" onClick={onPickOnMap} title="Pick on the map" aria-pressed={!!picking}
            className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-ui', picking ? 'border-brand-600 bg-brand-600 text-white' : 'border-line-strong bg-surface text-fg-2 hover:bg-surface-2')}>
            <Crosshair className="size-4" aria-hidden /><span className="sr-only">Pick on the map</span>
          </button>
        )}
      </div>
      {open && (
        <ul id={listId} role="listbox" className="dd-pop absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-lg border border-line-strong bg-surface p-1 shadow-lg">
          {items.length === 0 && <li className="px-2.5 py-2 text-sm text-muted">No places found</li>}
          {items.map((p, i) => (
            <li key={`${p.label}-${i}`} role="option" aria-selected={i === active}
              onPointerMove={() => setActive(i)} onPointerDown={(e) => e.preventDefault()} onClick={() => pick(p)}
              className={cx('flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm', i === active ? 'bg-surface-2 text-fg' : 'text-fg-2')}>
              <MapPin className="size-3.5 shrink-0 text-muted" aria-hidden />
              <span className="truncate">{p.label || placeLabel(p)}</span>
            </li>
          ))}
          {source && <li role="presentation" className="px-2.5 pb-1 pt-1.5 text-[11px] text-muted">Source: {source}</li>}
        </ul>
      )}
    </div>
  );
}
