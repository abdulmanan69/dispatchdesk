import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { money } from '../../lib/format.js';
import { Button, Loading, cx } from '../ui.jsx';
import { TRIP_STATUS, NEXT_TRIP_STATUS } from './fleetApi.js';

const DAY = 86400000;
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

/** One-week board: a row per carrier, a bar per trip from pickup to delivery. Advance status from the bar's menu. */
export default function TripTimeline({ carrierId, onSelectCarrier }) {
  const [from, setFrom] = useState(() => startOfDay(new Date()));
  const q = useQuery({
    queryKey: ['fleet', 'trips', from.toISOString(), carrierId || ''],
    queryFn: () => api.get('/api/fleet/trips', { from: from.toISOString(), days: 7, carrierId }),
  });
  const advance = useApiMutation(({ id, status }) => api.post(`/api/fleet/trips/${id}/status`, { status }), {
    success: (d) => `Trip is now ${TRIP_STATUS[d.trip.status]?.label.toLowerCase() || d.trip.status}`, invalidate: [['fleet'], ['loads']],
  });
  const days = Array.from({ length: 7 }, (_, i) => new Date(from.getTime() + i * DAY));
  const rows = useMemo(() => {
    const by = new Map();
    for (const t of q.data?.items || []) {
      const key = t.carrier?.id || 'none';
      if (!by.has(key)) by.set(key, { carrier: t.carrier, trips: [] });
      by.get(key).trips.push(t);
    }
    return [...by.values()];
  }, [q.data]);
  const pos = (t) => {
    const s = t.pickupDate ? new Date(t.pickupDate).getTime() : from.getTime();
    const e = t.deliveryDate ? new Date(t.deliveryDate).getTime() : s + DAY / 2;
    const left = Math.max(0, (s - from.getTime()) / (7 * DAY));
    const right = Math.min(1, (e - from.getTime()) / (7 * DAY));
    return { left: `${left * 100}%`, width: `${Math.max(0.035, right - left) * 100}%` };
  };
  const today = startOfDay(new Date()).getTime();

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" icon={ChevronLeft} aria-label="Previous week" onClick={() => setFrom(new Date(from.getTime() - 7 * DAY))} />
          <Button variant="ghost" size="sm" onClick={() => setFrom(startOfDay(new Date()))}>This week</Button>
          <Button variant="ghost" size="sm" icon={ChevronRight} aria-label="Next week" onClick={() => setFrom(new Date(from.getTime() + 7 * DAY))} />
        </div>
        <div className="flex flex-wrap gap-2 text-[11px] text-muted">
          {['planned', 'booked', 'in_transit', 'delivered'].map((k) => <span key={k} className="flex items-center gap-1"><span className="size-2 rounded-sm" style={{ background: TRIP_STATUS[k].color }} />{TRIP_STATUS[k].label}</span>)}
        </div>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[640px]">
          <div className="grid grid-cols-[160px_1fr] border-b border-line text-[11px] text-muted">
            <div className="px-2 py-1.5">Carrier</div>
            <div className="grid grid-cols-7">
              {days.map((d) => <div key={d.toISOString()} className={cx('border-l border-line px-1.5 py-1.5', d.getTime() === today && 'bg-brand-50 font-medium text-brand-800 dark:bg-brand-900/30 dark:text-brand-200')}>{d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' })}</div>)}
            </div>
          </div>
          {q.isLoading && <Loading className="py-6" />}
          {!q.isLoading && rows.length === 0 && <p className="px-2 py-6 text-center text-sm text-muted">No trips this week. Plan one from a truck on the map.</p>}
          {rows.map((row) => (
            <div key={row.carrier?.id || 'none'} className="grid grid-cols-[160px_1fr] border-b border-line last:border-0">
              <button type="button" onClick={() => row.carrier && onSelectCarrier?.(row.carrier.id)} className="truncate px-2 py-2 text-left text-[13px] font-medium hover:underline">{row.carrier?.companyName || 'Unassigned'}</button>
              <div className="relative h-auto min-h-10 py-1.5" style={{ height: `${Math.max(1, row.trips.length) * 26 + 12}px` }}>
                <div className="pointer-events-none absolute inset-0 grid grid-cols-7">{days.map((d) => <div key={d.toISOString()} className="border-l border-line" />)}</div>
                {row.trips.map((t, i) => {
                  const next = NEXT_TRIP_STATUS[t.status];
                  return (
                    <div key={t.id} className="absolute flex h-[22px] items-center gap-1 overflow-hidden rounded-md px-1.5 text-[11px] font-medium text-white shadow-sm"
                      style={{ ...pos(t), top: 6 + i * 26, background: TRIP_STATUS[t.status]?.color || '#7c3aed' }}
                      title={`${t.origin.city}, ${t.origin.state} → ${t.dest.city}, ${t.dest.state} · ${money(t.rateCents, { digits: 0 })} · ${TRIP_STATUS[t.status]?.label}`}>
                      <span className="truncate">{t.origin.city} → {t.dest.city}</span>
                      {next && (
                        <button type="button" onClick={() => advance.mutate({ id: t.id, status: next })} disabled={advance.isPending}
                          className="ml-auto shrink-0 rounded bg-white/20 px-1 hover:bg-white/35" title={`Mark ${TRIP_STATUS[next].label.toLowerCase()}`}>
                          {TRIP_STATUS[next].label}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
