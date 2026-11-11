import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../../lib/api.js';
import { dtf, label } from '../../lib/format.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Badge, Button, ErrorState, IconButton, Loading, cx } from '../ui.jsx';
import { LOAD_STATUSES, LOAD_STATUS_COLOR } from './calc.js';
import { safeZone, zoneAbbr, zonedInput } from './zoned.js';

// ---------------------------------------------------------------------------
// Placement helpers (plain YYYY-MM-DD days; each stop is placed on its facility's local day)
// ---------------------------------------------------------------------------

const parts = (ymd) => ymd.split('-').map(Number);
export function addDays(ymd, n) {
  const [y, m, d] = parts(ymd);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export const weekdayOf = (ymd) => {
  const [y, m, d] = parts(ymd);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
export const startOfWeek = (ymd) => addDays(ymd, -weekdayOf(ymd));
export function addMonths(ymd, n) {
  const [y, m] = parts(ymd);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
}

/** Whole weeks (Sunday first) covering the month of `ymd`: 35 or 42 days. */
export function monthGrid(ymd) {
  const [y, m] = parts(ymd);
  const first = `${ymd.slice(0, 7)}-01`;
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const end = addDays(startOfWeek(last), 6);
  const out = [];
  for (let d = startOfWeek(first); d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}
export const weekGrid = (ymd) => Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(ymd), i));

/** Local day of an instant at the facility (the viewer's zone when the facility has none). */
export const dayIn = (value, tz) => (value ? zonedInput(value, tz).slice(0, 10) || null : null);
export const todayIn = (tz) => dayIn(new Date(), safeZone(tz) || undefined);

/**
 * Pickup and delivery entries of each load. The appointment start places a stop when there is one, otherwise the
 * pickup/delivery date; both are read in the facility's zone, so an 11 PM Pacific pickup stays on its own day.
 */
export function calendarEvents(loads = []) {
  const out = [];
  for (const load of loads) {
    for (const kind of ['pickup', 'delivery']) {
      const tz = safeZone(load[`${kind}Tz`]) || undefined;
      const at = load[`${kind}WindowStart`] || null;
      const day = at ? dayIn(at, tz) : dayIn(load[`${kind}Date`], tz);
      if (day) out.push({ key: `${load.id}:${kind}`, kind, day, at, tz, load });
    }
  }
  return out;
}

/** Map day -> entries for the visible days, timed entries first in time order, then pickups before deliveries. */
export function placeEvents(events, days) {
  const map = new Map(days.map((d) => [d, []]));
  for (const e of events) map.get(e.day)?.push(e);
  for (const list of map.values()) {
    list.sort((a, b) => (a.at ? new Date(a.at).getTime() : Infinity) - (b.at ? new Date(b.at).getTime() : Infinity)
      || (a.kind === b.kind ? 0 : a.kind === 'pickup' ? -1 : 1));
  }
  return map;
}

/** Query range for the visible days, one day wider on each side (dates are stored at facility noon). */
export const queryRange = (days) => ({ from: addDays(days[0], -1), to: addDays(days[days.length - 1], 1) });

export function timeLabel(e) {
  if (!e.at) return '';
  const d = new Date(e.at);
  return `${dtf({ timeZone: e.tz, hour: 'numeric', minute: '2-digit' }).format(d)} ${zoneAbbr(e.tz, d)}`.trim();
}

// ---------------------------------------------------------------------------

const CHIP = {
  gray: 'border-line bg-c-gray-soft text-fg-2',
  blue: 'border-c-blue/30 bg-c-blue-soft text-c-blue',
  violet: 'border-c-purple/30 bg-c-purple-soft text-c-purple',
  brand: 'border-c-teal/30 bg-c-teal-soft text-c-teal',
  amber: 'border-c-amber/30 bg-c-amber-soft text-c-amber',
  green: 'border-c-green/30 bg-c-green-soft text-c-green',
  red: 'border-c-red/30 bg-c-red-soft text-c-red line-through',
};
const chipClass = (status) => CHIP[LOAD_STATUS_COLOR[status]] || CHIP.gray;
const KIND = { pickup: 'PU', delivery: 'DEL' };
const KIND_LONG = { pickup: 'Pickup', delivery: 'Delivery' };
const WEEK_HEAD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const name = (l) => (l.referenceNumber ? `#${l.referenceNumber}` : `${l.originCity} → ${l.destCity}`);
const fullDay = (ymd) => dtf({ timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${ymd}T12:00:00Z`));
const describe = (e) => `${KIND_LONG[e.kind]} ${timeLabel(e)}, ${name(e.load)}, ${e.load.originCity}, ${e.load.originState} to ${e.load.destCity}, ${e.load.destState}, ${label(e.load.status)}`;

function Chip({ e, onOpen, withTime = false }) {
  return (
    <button type="button" title={describe(e)} aria-label={describe(e)} onClick={() => onOpen(e.load.id)}
      className={cx('block w-full truncate rounded border px-1 py-px text-left text-[11px] leading-4 hover:brightness-95', chipClass(e.load.status))}>
      <span className="font-medium">{KIND[e.kind]}</span>{withTime && e.at ? ` ${timeLabel(e)}` : ''} {name(e.load)}
    </button>
  );
}

function Agenda({ day, events, onOpen }) {
  return (
    <section aria-label={fullDay(day)} className="rounded-lg border border-line bg-surface">
      <h3 className="border-b border-line px-3 py-2 text-sm font-medium">{fullDay(day)}</h3>
      {events.length ? (
        <ul className="divide-y divide-line">
          {events.map((e) => (
            <li key={e.key}>
              <button type="button" onClick={() => onOpen(e.load.id)} className="flex w-full items-start gap-3 px-3 py-2 text-left text-sm hover:bg-surface-2">
                <span className="w-20 shrink-0 text-xs tabular text-muted">{KIND_LONG[e.kind]}<span className="block">{timeLabel(e) || 'No time'}</span></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{name(e.load)}</span>
                  <span className="block truncate text-xs text-muted">{[`${e.load.originCity}, ${e.load.originState} → ${e.load.destCity}, ${e.load.destState}`, e.load.carrier?.companyName].filter(Boolean).join(' · ')}</span>
                </span>
                <Badge color={LOAD_STATUS_COLOR[e.load.status]}>{label(e.load.status)}</Badge>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="px-3 py-3 text-sm text-muted">No pickups or deliveries.</p>}
    </section>
  );
}

/**
 * Month and week calendar of pickups and deliveries, colored by status, each in its facility's local time.
 * Clicking an entry opens the load. The API returns at most 500 loads per range and says when there are more.
 */
export default function LoadCalendar({ filters = {}, showCanceled = false, onOpen }) {
  const { user } = useAuth();
  const today = todayIn(user?.timezone);
  const [mode, setMode] = useState('month');
  const [anchor, setAnchor] = useState(today);
  const [selected, setSelected] = useState(today);
  const days = useMemo(() => (mode === 'month' ? monthGrid(anchor) : weekGrid(anchor)), [mode, anchor]);
  const params = { view: 'calendar', ...filters, canceled: showCanceled ? 'true' : undefined, ...queryRange(days) };
  const q = useQuery({ queryKey: ['loads', 'calendar', params], queryFn: () => api.get('/api/loads', params), placeholderData: keepPreviousData });
  const byDay = useMemo(() => placeEvents(calendarEvents(q.data?.items), days), [q.data, days]);

  const step = (n) => {
    const next = mode === 'month' ? addMonths(anchor, n) : addDays(anchor, 7 * n);
    setAnchor(next);
    setSelected(mode === 'month' ? next : startOfWeek(next));
  };
  const goToday = () => { setAnchor(today); setSelected(today); };
  const month = anchor.slice(0, 7);
  const title = mode === 'month'
    ? dtf({ timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${anchor.slice(0, 7)}-15T12:00:00Z`))
    : `${dtf({ timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${days[0]}T12:00:00Z`))} – ${dtf({ timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${days[6]}T12:00:00Z`))}`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <IconButton icon={ChevronLeft} label={mode === 'month' ? 'Previous month' : 'Previous week'} onClick={() => step(-1)} />
          <IconButton icon={ChevronRight} label={mode === 'month' ? 'Next month' : 'Next week'} onClick={() => step(1)} />
          <Button size="sm" variant="secondary" onClick={goToday}>Today</Button>
        </div>
        <h2 className="text-sm font-medium" aria-live="polite">{title}</h2>
        <div className="ml-auto flex rounded-md border border-line p-0.5" role="group" aria-label="Calendar range">
          <Button size="sm" variant={mode === 'month' ? 'secondary' : 'ghost'} aria-pressed={mode === 'month'} onClick={() => { setMode('month'); setAnchor(selected); }}>Month</Button>
          <Button size="sm" variant={mode === 'week' ? 'secondary' : 'ghost'} aria-pressed={mode === 'week'} onClick={() => { setMode('week'); setAnchor(selected); }}>Week</Button>
        </div>
      </div>

      {q.data?.tooMany && (
        <p role="status" className="rounded-md border border-c-amber/30 bg-c-amber-soft px-3 py-2 text-sm text-c-amber">
          Too many loads in this range: showing the first {q.data.cap}. Switch to the week view or narrow the search to see the rest.
        </p>
      )}

      {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={q.refetch} /> : mode === 'month' ? (
        <>
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <div className="grid grid-cols-7 border-b border-line bg-surface-2/50 text-center text-[11px] font-medium text-muted">
              {WEEK_HEAD.map((d) => <div key={d} className="py-1.5"><span className="sm:hidden" aria-hidden>{d[0]}</span><span className="hidden sm:inline">{d}</span></div>)}
            </div>
            <div className="grid grid-cols-7">
              {days.map((d) => {
                const events = byDay.get(d) || [];
                const outside = d.slice(0, 7) !== month;
                return (
                  <div key={d} className={cx('min-h-14 border-b border-r border-line p-0.5 sm:min-h-24 sm:p-1 [&:nth-child(7n)]:border-r-0', outside && 'bg-surface-2/40')}>
                    <button type="button" onClick={() => setSelected(d)} aria-pressed={selected === d}
                      aria-label={`${fullDay(d)}, ${events.length} stop${events.length === 1 ? '' : 's'}`}
                      className={cx('flex w-full flex-col items-center rounded px-0.5 py-0.5 text-xs sm:items-start', selected === d ? 'bg-surface-2 ring-1 ring-brand-500' : 'hover:bg-surface-2')}>
                      <span className={cx('tabular', d === today ? 'rounded-full bg-brand-600 px-1.5 font-medium text-white' : outside ? 'text-muted' : 'text-fg')}>{Number(d.slice(8))}</span>
                      {events.length > 0 && (
                        <span className="mt-0.5 flex flex-wrap justify-center gap-0.5 sm:hidden" aria-hidden>
                          {events.slice(0, 4).map((e) => <span key={e.key} className={cx('size-1.5 rounded-full border', chipClass(e.load.status))} />)}
                        </span>
                      )}
                    </button>
                    <div className="mt-0.5 hidden space-y-0.5 sm:block">
                      {events.slice(0, 3).map((e) => <Chip key={e.key} e={e} onOpen={onOpen} />)}
                      {events.length > 3 && (
                        <button type="button" onClick={() => setSelected(d)} className="w-full text-left text-[11px] text-muted hover:text-fg">+{events.length - 3} more</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <Agenda day={selected} events={byDay.get(selected) || []} onOpen={onOpen} />
        </>
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-lg border border-line bg-surface sm:grid sm:grid-cols-7">
            {days.map((d) => {
              const events = byDay.get(d) || [];
              return (
                <section key={d} aria-label={fullDay(d)} className="min-h-64 border-r border-line p-1.5 last:border-r-0">
                  <h3 className={cx('mb-1.5 text-xs font-medium', d === today ? 'text-brand-700 dark:text-brand-300' : 'text-muted')}>
                    {WEEK_HEAD[weekdayOf(d)]} <span className="tabular">{Number(d.slice(8))}</span>
                  </h3>
                  <div className="space-y-1">
                    {events.map((e) => <Chip key={e.key} e={e} onOpen={onOpen} withTime />)}
                    {!events.length && <p className="text-[11px] text-muted">None</p>}
                  </div>
                </section>
              );
            })}
          </div>
          <div className="space-y-2 sm:hidden">
            {days.map((d) => <Agenda key={d} day={d} events={byDay.get(d) || []} onOpen={onOpen} />)}
          </div>
        </>
      )}

      <ul className="flex flex-wrap gap-1.5" aria-label="Status colors">
        {LOAD_STATUSES.filter((s) => s !== 'canceled' || showCanceled).map((s) => <li key={s}><Badge color={LOAD_STATUS_COLOR[s]}>{label(s)}</Badge></li>)}
        <li className="text-xs text-muted">PU pickup · DEL delivery · times are facility local</li>
      </ul>
    </div>
  );
}
