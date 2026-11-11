import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { Input, Select } from '../ui.jsx';

/** Select a broker from the user's broker list. */
export function BrokerSelect({ value, onChange, id, allowEmpty = true }) {
  const q = useQuery({ queryKey: ['brokers', 'options'], queryFn: () => api.get('/api/brokers', { pageSize: 200, sort: 'name' }) });
  return (
    <Select id={id} value={value || ''} onChange={(e) => onChange(e.target.value || null)} disabled={q.isLoading}>
      {allowEmpty && <option value="">{q.isLoading ? 'Loading brokers…' : 'No broker'}</option>}
      {q.data?.items?.map((b) => <option key={b.id} value={b.id}>{b.companyName}{b.mcNumber ? ` · MC ${b.mcNumber}` : ''}</option>)}
    </Select>
  );
}

function useDebounced(v, ms = 250) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/**
 * Search-as-you-type carrier picker backed by GET /api/carriers?q=.
 * `stage` narrows results (e.g. 'customer' for assigning loads).
 */
export function CarrierPicker({ value, onChange, id, stage, placeholder = 'Search carriers by name, MC or DOT', initialLabel }) {
  const [text, setText] = useState(initialLabel || '');
  const [open, setOpen] = useState(false);
  const term = useDebounced(text);
  const q = useQuery({
    queryKey: ['carriers', 'picker', term, stage],
    // The signal cancels the request for a search term the user has already typed past.
    queryFn: ({ signal }) => api.get('/api/carriers', { q: term || undefined, stage, pageSize: 10 }, { signal }),
    enabled: open,
  });
  useEffect(() => { if (!value) setText(initialLabel || ''); }, [value, initialLabel]);
  return (
    <div className="relative">
      <Input id={id} value={text} placeholder={placeholder} autoComplete="off" role="combobox" aria-expanded={open} aria-autocomplete="list"
        onChange={(e) => { setText(e.target.value); setOpen(true); if (value) onChange(null, null); }}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && (
        <ul role="listbox" className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-line bg-surface py-1 shadow-lg">
          {q.isLoading && <li className="px-3 py-2 text-sm text-muted">Searching…</li>}
          {q.isError && <li className="px-3 py-2 text-sm text-red-600">{q.error.message}</li>}
          {q.data?.items?.length === 0 && <li className="px-3 py-2 text-sm text-muted">No matching carriers</li>}
          {q.data?.items?.map((c) => (
            <li key={c.id} role="option" aria-selected={c.id === value}>
              <button type="button" className="block w-full px-3 py-2 text-left text-sm hover:bg-surface-2" onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onChange(c.id, c); setText(c.companyName); setOpen(false); }}>
                <span className="font-medium">{c.companyName}</span>
                <span className="ml-2 text-xs text-muted">{[c.mcNumber && `MC ${c.mcNumber}`, c.dotNumber && `DOT ${c.dotNumber}`, c.state].filter(Boolean).join(' · ')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
