import { forwardRef, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import {
  AlarmClock, CalendarClock, CalendarDays, Check, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, List, Mail, MessageSquare,
  MoreHorizontal, Pencil, Plus, Repeat, Search, Trash2, X,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  Badge, Button, Card, Checkbox, EmptyState, ErrorState, Field, IconButton, Input, Loading, LocalClock, PageHeader, Pagination, RefreshError, Select, Tabs, cx,
} from '../../components/ui.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import CallButton from '../../components/calling/CallButton.jsx';
import ComposeModal from '../../components/email/ComposeModal.jsx';
import TextLogModal from '../../components/carriers/TextLogModal.jsx';
import CarrierTimeInput from '../../components/calling/CarrierTimeInput.jsx';
import { tzOf } from '../../components/calling/callWindow.js';
import FollowUpForm, { FollowUpDialog, FOLLOW_UP_LISTS, Segmented } from '../../components/followups/FollowUpForm.jsx';
import CompleteDialog from '../../components/followups/CompleteDialog.jsx';
import Popover, { MenuItem } from '../../components/followups/Popover.jsx';
import {
  PRIORITIES, RECURRENCES, SNOOZE_PRESETS, TYPES, WHEN_PRESETS, addDays, dayLabel, startOfDay, startOfWeek, timeOf, typeMeta,
} from '../../components/followups/followUpUtils.js';

const PRIORITY_BAR = ['bg-transparent', 'bg-signal-500', 'bg-red-500'];
const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.getAttribute?.('role') === 'combobox');

/** Reschedule one follow-up (in its carrier's local time when known) or a selection (in your time). */
function RescheduleDialog({ open, title, initial, timezone, onClose, onSave, pending }) {
  const [value, setValue] = useState('');
  useEffect(() => { if (open) setValue(new Date(initial || WHEN_PRESETS[2].get(timezone)).toISOString()); }, [open, initial, timezone]);
  return (
    <Modal open={open} onClose={onClose} size="md" title={title}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!value} onClick={() => onSave(value)}>Save</Button></>}>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {WHEN_PRESETS.map((p) => <Button key={p.key} size="sm" variant="secondary" onClick={() => setValue(p.get(timezone).toISOString())}>{p.label}</Button>)}
        </div>
        <Field label="Date and time">{(id) => <CarrierTimeInput id={id} value={value} onChange={setValue} timezone={timezone} />}</Field>
      </div>
    </Modal>
  );
}

/** Search input that owns its text and debounce, so typing never re-renders the list until the search changes. */
const SearchBox = forwardRef(function SearchBox({ onSearch }, ref) {
  const [text, setText] = useState('');
  useEffect(() => { const t = setTimeout(() => onSearch(text.trim()), 250); return () => clearTimeout(t); }, [text, onSearch]);
  return (
    <div className="relative w-full sm:w-72">
      <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" aria-hidden />
      <Input ref={ref} aria-label="Search follow-ups" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search carrier, title or note" className="pl-8 pr-8" />
      <kbd className="pointer-events-none absolute right-2 top-2 rounded border border-line px-1 font-mono text-[11px] text-muted">/</kbd>
    </div>
  );
});

function SnoozeMenu({ onSnooze, onPick, size = 'sm', label = 'Snooze' }) {
  return (
    <Popover width="w-48" trigger={({ toggle, open }) => <Button size={size} variant="secondary" icon={AlarmClock} aria-expanded={open} aria-label={label || 'Snooze'} title="Snooze" onClick={toggle}>{label}</Button>}>
      {({ close }) => (
        <>
          {SNOOZE_PRESETS.map((p) => <MenuItem key={p.label} onClick={() => { close(); onSnooze(p.body()); }}>{p.label}</MenuItem>)}
          <div className="my-1 border-t border-line" />
          <MenuItem icon={CalendarDays} onClick={() => { close(); onPick(); }}>Pick a date…</MenuItem>
        </>
      )}
    </Popover>
  );
}

/** One follow-up. Memoized: props are the row data plus stable callbacks (onAction(kind, f, arg), onSelect(id, on)). */
const FollowUpRow = memo(function FollowUpRow({ f, selected, onSelect, provider, mine, onAction }) {
  const meta = typeMeta(f.type);
  const Icon = meta.icon;
  const pending = f.status === 'pending';
  const overdue = pending && new Date(f.dueAt) < new Date();
  return (
    <li className={cx('group relative flex flex-col gap-3 py-3 pl-5 pr-4 transition-ui hover:bg-surface-2/50 md:flex-row md:items-center', selected && 'bg-brand-50/60 dark:bg-brand-900/20')}>
      <span className={cx('absolute inset-y-2 left-0 w-0.5 rounded-full', PRIORITY_BAR[f.priority] || PRIORITY_BAR[0])} aria-hidden />
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {mine && <Checkbox aria-label={`Select ${f.carrier.companyName}`} checked={selected} onChange={(e) => onSelect(f.id, e.target.checked)} className="mt-0.5" />}
        <span className={cx('mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg', overdue ? 'bg-c-red-soft text-c-red' : meta.tone)} title={meta.label}>
          <Icon className="size-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link to={`/app/carriers/${f.carrier.id}`} className="truncate font-medium hover:underline">{f.carrier.companyName}</Link>
            {f.priority === 2 && <Badge color="red">Urgent</Badge>}
            {f.priority === 1 && <Badge color="amber">High</Badge>}
            {f.status === 'done' && <Badge color="green">{f.outcome || 'Done'}</Badge>}
            {f.status === 'canceled' && <Badge>Canceled</Badge>}
            {f.recurrence !== 'none' && <span className="inline-flex items-center gap-1 text-xs text-muted" title={RECURRENCES.find(([v]) => v === f.recurrence)?.[1]}><Repeat className="size-3" aria-hidden />{RECURRENCES.find(([v]) => v === f.recurrence)?.[1]}</span>}
          </div>
          <p className={cx('mt-0.5 truncate text-[13px] text-fg-2', f.status === 'done' && 'line-through decoration-line-strong')}>
            {f.title || `${meta.label} follow-up`}{f.note && <span className="text-muted"> · {f.note}</span>}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 pl-10 md:pl-0">
        <div className="w-36 text-right text-[13px] leading-tight max-md:text-left">
          <div className={cx('tabular', overdue ? 'font-medium text-red-600 dark:text-red-400' : 'text-fg')}>{timeOf(f.dueAt)}{f.snoozeCount > 0 && <span className="ml-1 text-xs font-normal text-muted" title={`Snoozed ${f.snoozeCount} time(s)`}>· {f.snoozeCount}×</span>}</div>
          <LocalClock timezone={f.carrier.timezone} className="text-xs text-muted" />
        </div>
        {pending && mine ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {f.carrier.phone && <CallButton variant="button" size="sm" phone={f.carrier.phone} carrierId={f.carrier.id} />}
            {f.carrier.email && <IconButton icon={Mail} label="Email with a template" onClick={() => onAction('email', f)} />}
            {f.carrier.phone && !f.carrier.doNotCall && <IconButton icon={MessageSquare} label={provider === 'google_voice' ? 'Text in Google Voice with a template' : 'Text with a template'} onClick={() => onAction('text', f)} />}
            <Button size="sm" icon={Check} onClick={() => onAction('complete', f)}>Done</Button>
            <SnoozeMenu onSnooze={(body) => onAction('snooze', f, body)} onPick={() => onAction('reschedule', f)} label="" />
            <Popover width="w-44" trigger={({ toggle }) => <IconButton icon={MoreHorizontal} label="More actions" onClick={toggle} />}>
              {({ close }) => (
                <>
                  <MenuItem icon={Pencil} onClick={() => { close(); onAction('edit', f); }}>Edit</MenuItem>
                  <MenuItem icon={CalendarDays} onClick={() => { close(); onAction('reschedule', f); }}>Reschedule</MenuItem>
                  <MenuItem icon={Trash2} danger onClick={() => { close(); onAction('remove', f); }}>Delete</MenuItem>
                </>
              )}
            </Popover>
          </div>
        ) : mine && f.status !== 'pending' ? (
          <IconButton icon={Trash2} label="Delete" onClick={() => onAction('remove', f)} />
        ) : null}
      </div>
    </li>
  );
});

function WeekView({ weekStart, items, onPick }) {
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  // Group once per data change instead of filtering every item for every day on each render.
  const byDay = useMemo(() => {
    const m = new Map();
    for (const f of items) {
      const k = startOfDay(f.dueAt).getTime();
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(f);
    }
    return m;
  }, [items]);
  const today = startOfDay(new Date()).getTime();
  return (
    <div className="grid grid-cols-1 divide-y divide-line sm:grid-cols-7 sm:divide-x sm:divide-y-0">
      {days.map((d) => {
        const list = byDay.get(d.getTime()) || [];
        const isToday = d.getTime() === today;
        return (
          <div key={d.toISOString()} className="min-h-40 p-2">
            <div className="mb-2 flex items-baseline justify-between px-1">
              <span className={cx('text-xs', isToday ? 'font-medium text-brand-700 dark:text-brand-300' : 'text-muted')}>{d.toLocaleDateString('en-US', { weekday: 'short' })}</span>
              <span className={cx('tabular text-sm', isToday ? 'inline-flex size-6 items-center justify-center rounded-full bg-brand-600 font-medium text-white' : 'text-fg-2')}>{d.getDate()}</span>
            </div>
            <div className="space-y-1">
              {list.map((f) => {
                const Icon = typeMeta(f.type).icon;
                const overdue = f.status === 'pending' && new Date(f.dueAt) < new Date();
                return (
                  <button key={f.id} type="button" onClick={() => onPick(f)}
                    className={cx('relative w-full overflow-hidden rounded-lg border border-line bg-surface py-1.5 pl-3 pr-2 text-left text-xs transition-ui hover:border-line-strong', f.status === 'done' && 'opacity-60')}>
                    <span className={cx('absolute inset-y-0 left-0 w-0.5', f.priority ? PRIORITY_BAR[f.priority] : 'bg-line-strong')} aria-hidden />
                    <div className="flex items-center gap-1.5">
                      <Icon className="size-3 shrink-0 text-muted" aria-hidden />
                      <span className={cx('tabular', overdue ? 'text-red-600 dark:text-red-400' : 'text-muted')}>{timeOf(f.dueAt)}</span>
                    </div>
                    <div className={cx('mt-0.5 truncate font-medium', f.status === 'done' && 'line-through')}>{f.carrier.companyName}</div>
                    {f.title && <div className="truncate text-muted">{f.title}</div>}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function FollowUps() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const searchRef = useRef(null);
  // ?view=overdue|today|upcoming|done opens that tab (links from reminder notifications).
  const [sp] = useSearchParams();
  const urlView = ['overdue', 'today', 'upcoming', 'done'].includes(sp.get('view')) ? sp.get('view') : null;
  const [view, setView] = useState(urlView || 'today');
  const [mode, setMode] = useState('list');
  useEffect(() => { if (urlView) { setView(urlView); setMode('list'); } }, [urlView]);
  const [type, setType] = useState('');
  const [priority, setPriority] = useState('');
  const [scope, setScope] = useState('mine');
  const [searchKey, setSearchKey] = useState(0);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [quickAdd, setQuickAdd] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [edit, setEdit] = useState(null);
  const [completing, setCompleting] = useState(null);
  const [rescheduling, setRescheduling] = useState(null); // follow-up | 'bulk'
  const [emailing, setEmailing] = useState(null);
  const [texting, setTexting] = useState(null);

  const onSearch = useCallback((value) => { setQ(value); }, []);
  useEffect(() => { setPage(1); }, [q]);
  useEffect(() => setSelected(new Set()), [view, type, priority, q, scope, mode, page]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || document.querySelector('[role="dialog"]')) return;
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); setQuickAdd(true); }
      else if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const filters = { type: type || undefined, priority: priority === '' ? undefined : priority, q: q || undefined, scope };
  const params = mode === 'week'
    ? { ...filters, view: 'all', status: 'all', from: weekStart.toISOString(), to: addDays(weekStart, 7).toISOString(), pageSize: 500 }
    : { ...filters, view, page, pageSize: 100 };
  // The signal cancels the previous request when the search or filters change again.
  const list = useQuery({ queryKey: ['follow-ups', params], queryFn: ({ signal }) => api.get('/api/follow-ups', params, { signal }), placeholderData: keepPreviousData });
  const settings = useQuery({ queryKey: ['telephony', 'settings'], queryFn: () => api.get('/api/telephony/settings'), staleTime: 300000 });
  const provider = settings.data?.settings?.provider;
  const counts = list.data?.counts;
  const items = useMemo(() => list.data?.items || [], [list.data]);

  // Mutations refresh the lists (FOLLOW_UP_LISTS) and only the profiles of the carriers they touched (vars.carrierIds).
  // Without that list (a selected follow-up was no longer on screen) every cached carrier profile is marked stale.
  const qc = useQueryClient();
  const refreshCarriers = (_, vars) => {
    const ids = vars?.carrierIds;
    if (!Array.isArray(ids)) { qc.invalidateQueries({ queryKey: ['carrier'] }); return; }
    for (const id of new Set(ids)) if (id) qc.invalidateQueries({ queryKey: ['carrier', id] });
  };
  const carriersOf = (followUpIds) => {
    const byId = new Map(items.map((f) => [f.id, f.carrier?.id]));
    return followUpIds.every((id) => byId.get(id)) ? followUpIds.map((id) => byId.get(id)) : null;
  };
  const snooze = useApiMutation(({ id, body }) => api.post(`/api/follow-ups/${id}/snooze`, body), {
    invalidate: FOLLOW_UP_LISTS, success: (d) => `Snoozed to ${dayLabel(d.followUp.dueAt).toLowerCase()} ${timeOf(d.followUp.dueAt)}`,
    onSuccess: refreshCarriers,
  });
  const reschedule = useApiMutation(({ id, dueAt }) => api.patch(`/api/follow-ups/${id}`, { dueAt }), {
    invalidate: FOLLOW_UP_LISTS, success: 'Rescheduled', onSuccess: (d, vars) => { refreshCarriers(d, vars); setRescheduling(null); },
  });
  const del = useApiMutation(({ id }) => api.del(`/api/follow-ups/${id}`), { invalidate: FOLLOW_UP_LISTS, success: 'Follow-up deleted', onSuccess: refreshCarriers });
  const bulk = useApiMutation(({ carrierIds, ...body }) => api.post('/api/follow-ups/bulk', body), {
    invalidate: FOLLOW_UP_LISTS,
    success: (d) => `${d.updated} updated${d.skipped ? ` · ${d.skipped} skipped` : ''}`,
    onSuccess: (d, vars) => { refreshCarriers(d, vars); setSelected(new Set()); setRescheduling(null); },
  });

  const groups = useMemo(() => {
    if (view === 'overdue' || view === 'done') return [{ key: view, label: view === 'overdue' ? 'Overdue' : 'Completed', items }];
    const map = new Map();
    for (const f of items) {
      const k = startOfDay(f.dueAt).toISOString();
      if (!map.has(k)) map.set(k, { key: k, label: dayLabel(f.dueAt), items: [] });
      map.get(k).items.push(f);
    }
    return [...map.values()];
  }, [items, view]);

  const selectable = useMemo(() => items.filter((f) => f.userId === user.id), [items, user.id]);
  const allSelected = selectable.length > 0 && selectable.every((f) => selected.has(f.id));
  const toggle = useCallback((id, on) => setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; }), []);
  const ids = [...selected];
  /** Run a bulk action on the selection; carrierIds stays in the browser (only for refreshing those profiles). */
  const bulkRun = (body) => bulk.mutate({ ...body, ids, carrierIds: carriersOf(ids) });
  const complete = useApiMutation(({ id }) => api.post(`/api/follow-ups/${id}/complete`, {}), { invalidate: FOLLOW_UP_LISTS, success: 'Follow-up done', onSuccess: refreshCarriers });

  // One stable dispatcher for every row: the latest handlers live in a ref, so memoized rows never re-render for it.
  const handlers = useRef({});
  handlers.current = {
    complete: (f) => setCompleting(f),
    snooze: (f, body) => snooze.mutate({ id: f.id, body, carrierIds: [f.carrier.id] }),
    reschedule: (f) => setRescheduling(f),
    edit: (f) => setEdit(f),
    email: (f) => setEmailing(f),
    text: (f) => setTexting(f),
    remove: async (f) => { if (await confirm({ title: 'Delete this follow-up?', message: f.recurrence !== 'none' ? 'Future repeats stop too.' : undefined, confirmLabel: 'Delete', danger: true })) del.mutate({ id: f.id, carrierIds: [f.carrier.id] }); },
  };
  const onAction = useCallback((kind, f, arg) => handlers.current[kind]?.(f, arg), []);

  const filtered = !!(type || priority !== '' || q);
  const emptyText = {
    overdue: 'Nothing overdue. You are caught up.',
    today: 'Nothing else due today.',
    upcoming: 'No upcoming follow-ups.',
    done: 'Completed follow-ups show up here.',
  }[view];

  return (
    <div>
      <PageHeader title="Follow-ups" subtitle="Call-backs, emails, texts and tasks in one place. Logging a call completes that carrier's due follow-ups."
        actions={<Button icon={quickAdd ? ChevronUp : Plus} variant={quickAdd ? 'secondary' : 'primary'} onClick={() => setQuickAdd((v) => !v)} title="Shortcut: N">{quickAdd ? 'Hide' : 'New follow-up'}</Button>} />

      {quickAdd && (
        <Card className="mb-5" title="New follow-up" actions={<IconButton icon={X} label="Close" onClick={() => setQuickAdd(false)} />}>
          <FollowUpForm compact formId="quick-add-follow-up" />
        </Card>
      )}

      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        {mode === 'list' ? (
          <Tabs className="min-w-0 flex-1" value={view} onChange={(v) => { setView(v); setPage(1); }} tabs={[
            { value: 'overdue', label: 'Overdue', count: counts?.overdue },
            { value: 'today', label: 'Today', count: counts?.today },
            { value: 'upcoming', label: 'Upcoming', count: counts?.upcoming },
            { value: 'done', label: 'Done', count: counts?.done },
          ]} />
        ) : (
          <div className="flex items-center gap-2">
            <IconButton icon={ChevronLeft} label="Previous week" onClick={() => setWeekStart((w) => addDays(w, -7))} />
            <IconButton icon={ChevronRight} label="Next week" onClick={() => setWeekStart((w) => addDays(w, 7))} />
            <Button size="sm" variant="secondary" onClick={() => setWeekStart(startOfWeek(new Date()))}>This week</Button>
            <span className="ml-1 text-sm font-medium tabular">
              {weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – {addDays(weekStart, 6).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
          </div>
        )}
        <Segmented label="Layout" size="sm" value={mode} onChange={setMode} options={[{ value: 'list', label: 'List', icon: List }, { value: 'week', label: 'Week', icon: CalendarDays }]} />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchBox key={searchKey} ref={searchRef} onSearch={onSearch} />
        <Select aria-label="Type" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} className="w-36">
          <option value="">All types</option>
          {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </Select>
        <Select aria-label="Priority" value={String(priority)} onChange={(e) => { setPriority(e.target.value); setPage(1); }} className="w-36">
          <option value="">Any priority</option>
          {PRIORITIES.map((p) => <option key={p.value} value={String(p.value)}>{p.label}</option>)}
        </Select>
        {user?.team && <Select aria-label="Scope" value={scope} onChange={(e) => setScope(e.target.value)} className="w-32"><option value="mine">Mine</option><option value="team">Team</option></Select>}
        {filtered && <Button size="sm" variant="ghost" icon={X} onClick={() => { setType(''); setPriority(''); setQ(''); setSearchKey((k) => k + 1); }}>Clear</Button>}
      </div>

      {selected.size > 0 && (
        <div className="dd-enter sticky top-2 z-30 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-4 py-2 shadow-sm">
          <span className="mr-1 text-sm font-medium tabular">{selected.size} selected</span>
          <Button size="sm" icon={Check} loading={bulk.isPending} onClick={() => bulkRun({ action: 'complete' })}>Mark done</Button>
          <SnoozeMenu onSnooze={(b) => bulkRun({ action: 'snooze', ...b })} onPick={() => setRescheduling('bulk')} />
          <Button size="sm" variant="secondary" icon={CalendarDays} onClick={() => setRescheduling('bulk')}>Reschedule</Button>
          <Popover align="left" width="w-40" trigger={({ toggle }) => <Button size="sm" variant="secondary" icon={ChevronDown} onClick={toggle}>Priority</Button>}>
            {({ close }) => PRIORITIES.map((p) => <MenuItem key={p.value} onClick={() => { close(); bulkRun({ action: 'priority', priority: p.value }); }}>{p.label}</MenuItem>)}
          </Popover>
          <Button size="sm" variant="secondary" icon={Trash2} onClick={async () => { if (await confirm({ title: `Delete ${selected.size} follow-up(s)?`, confirmLabel: 'Delete', danger: true })) bulkRun({ action: 'delete' }); }}>Delete</Button>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
        </div>
      )}

      {/* A failed background refresh keeps the loaded list on screen with a retry notice. */}
      <RefreshError query={list} />
      <Card bodyClass="p-0">
        {list.isLoading ? <Loading /> : list.isError && !list.data ? <ErrorState error={list.error} onRetry={list.refetch} /> : mode === 'week' ? (
          <WeekView weekStart={weekStart} items={items} onPick={(f) => (f.userId === user.id && f.status === 'pending' ? setEdit(f) : null)} />
        ) : !items.length ? (
          <EmptyState icon={CalendarClock} title={filtered ? 'No follow-ups match these filters' : emptyText}
            action={!filtered && view !== 'done' ? <Button icon={Plus} onClick={() => setQuickAdd(true)}>New follow-up</Button> : null}>
            {!filtered && view !== 'done' && 'Logging a no-answer call schedules a call-back automatically.'}
          </EmptyState>
        ) : (
          <>
            {selectable.length > 0 && (
              <div className="flex items-center gap-3 border-b border-line px-5 py-2 text-xs text-muted">
                <Checkbox aria-label="Select all" checked={allSelected} onChange={(e) => setSelected(e.target.checked ? new Set(selectable.map((f) => f.id)) : new Set())} />
                <span className="tabular">{list.data.total} follow-up{list.data.total === 1 ? '' : 's'}</span>
              </div>
            )}
            {groups.map((g) => (
              <section key={g.key}>
                {groups.length > 1 || view === 'upcoming' ? (
                  <h3 className="sticky top-0 z-10 border-b border-line bg-surface-2/80 px-5 py-1.5 text-xs font-medium text-fg-2 backdrop-blur">{g.label} <span className="font-normal text-muted tabular">· {g.items.length}</span></h3>
                ) : null}
                <ul className="divide-y divide-line">
                  {g.items.map((f) => (
                    <FollowUpRow key={f.id} f={f} provider={provider} mine={f.userId === user.id} selected={selected.has(f.id)}
                      onSelect={toggle} onAction={onAction} />
                  ))}
                </ul>
              </section>
            ))}
            <div className="border-t border-line px-3"><Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} onPage={setPage} /></div>
          </>
        )}
      </Card>
      <p className="mt-3 text-xs text-muted">Shortcuts: <kbd className="font-mono">N</kbd> new follow-up · <kbd className="font-mono">/</kbd> search</p>

      <FollowUpDialog open={!!edit} followUp={edit} onClose={() => setEdit(null)} />
      {completing && <CompleteDialog followUp={completing} onClose={() => setCompleting(null)} />}
      <RescheduleDialog open={!!rescheduling} title={rescheduling === 'bulk' ? `Reschedule ${selected.size} follow-up(s)` : `Reschedule · ${rescheduling?.carrier?.companyName || ''}`}
        initial={rescheduling && rescheduling !== 'bulk' ? rescheduling.dueAt : null} timezone={rescheduling && rescheduling !== 'bulk' ? tzOf(rescheduling.carrier) : null}
        pending={reschedule.isPending || bulk.isPending}
        onClose={() => setRescheduling(null)}
        onSave={(dueAt) => (rescheduling === 'bulk' ? bulkRun({ action: 'reschedule', dueAt }) : reschedule.mutate({ id: rescheduling.id, dueAt, carrierIds: [rescheduling.carrier?.id] }))} />
      <ComposeModal open={!!emailing} onClose={() => setEmailing(null)} carrierId={emailing?.carrier.id} toEmail={emailing?.carrier.email}
        subject={emailing?.title || ''} templateCategory="follow_up"
        doneOption={emailing && emailing.type === 'email' ? { label: 'Mark this follow-up done', defaultChecked: true } : undefined}
        onSent={(res, meta) => { if (meta?.done && emailing) complete.mutate({ id: emailing.id, carrierIds: [emailing.carrier.id] }); }} />
      {texting && (
        <TextLogModal carrier={texting.carrier} category="follow_up" onClose={() => setTexting(null)}
          doneOption={texting.type === 'text' ? { label: 'Mark this follow-up done', defaultChecked: true } : undefined}
          onLogged={({ done }) => { if (done) complete.mutate({ id: texting.id, carrierIds: [texting.carrier.id] }); }} />
      )}
    </div>
  );
}
