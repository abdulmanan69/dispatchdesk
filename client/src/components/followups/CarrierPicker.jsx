import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { api } from '../../lib/api.js';
import { cx } from '../ui.jsx';

/** Search the user's carriers and pick one. value: { id, companyName } | null */
export default function CarrierPicker({ value, onChange, id, autoFocus }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const ref = useRef(null);
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 200); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const res = useQuery({
    queryKey: ['carriers', 'picker', debounced],
    // The signal cancels the previous search when the user keeps typing.
    queryFn: ({ signal }) => api.get('/api/carriers', { q: debounced || undefined, pageSize: 8, sort: 'updatedAt', dir: 'desc' }, { signal }),
    enabled: open,
    staleTime: 30000,
  });
  const items = res.data?.items || [];
  useEffect(() => setActive(0), [debounced]);

  if (value) {
    return (
      <div className="flex h-9 items-center justify-between gap-2 rounded-lg border border-line-strong bg-surface px-3 text-sm">
        <span className="truncate font-medium">{value.companyName}</span>
        <button type="button" onClick={() => { onChange(null); setQ(''); }} aria-label="Change carrier" className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-fg"><X className="size-4" /></button>
      </div>
    );
  }
  // state too: call-back presets fall back to the state's zone when the carrier has no stored time zone.
  const pick = (c) => { onChange({ id: c.id, companyName: c.companyName, phone: c.phone, email: c.email, timezone: c.timezone, state: c.state, doNotCall: c.doNotCall }); setOpen(false); };
  return (
    <div ref={ref} className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" aria-hidden />
      <input id={id} autoFocus={autoFocus} value={q} placeholder="Search carriers" autoComplete="off"
        role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
        onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          else if (e.key === 'Enter' && open && items[active]) { e.preventDefault(); pick(items[active]); }
          else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
        }}
        className="h-9 w-full rounded-lg border border-line-strong bg-surface pl-8 pr-3 text-sm text-fg placeholder:text-muted transition-ui focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/15" />
      {open && (
        <ul id={listId} role="listbox" className="dd-enter absolute z-40 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lg">
          {res.isLoading ? <li className="px-3 py-2 text-sm text-muted">Searching…</li>
            : !items.length ? <li className="px-3 py-2 text-sm text-muted">No carriers match</li>
              : items.map((c, i) => (
                <li key={c.id} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); pick(c); }}
                  className={cx('cursor-pointer rounded-lg px-2.5 py-1.5 text-sm', i === active && 'bg-surface-2')}>
                  <div className="truncate font-medium">{c.companyName}</div>
                  <div className="truncate font-mono text-xs text-muted">{[c.dotNumber && `USDOT ${c.dotNumber}`, [c.city, c.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ') || '—'}</div>
                </li>
              ))}
        </ul>
      )}
    </div>
  );
}
