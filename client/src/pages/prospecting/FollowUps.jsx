import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  AlarmClock, CalendarClock, CalendarDays, Check, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, List, Mail, MessageSquare,
  MoreHorizontal, Pencil, Plus, Repeat, Search, Trash2, X,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { toLocalInput } from '../../lib/format.js';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  Badge, Button, Card, Checkbox, EmptyState, ErrorState, Field, IconButton, Input, Loading, LocalClock, PageHeader, Pagination, Select, Tabs, cx,
} from '../../components/ui.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import CallButton from '../../components/calling/CallButton.jsx';
import ComposeModal from '../../components/email/ComposeModal.jsx';
import FollowUpForm, { FollowUpDialog, FOLLOW_UP_INVALIDATE, Segmented } from '../../components/followups/FollowUpForm.jsx';
import CompleteDialog from '../../components/followups/CompleteDialog.jsx';
import Popover, { MenuItem } from '../../components/followups/Popover.jsx';
import {
  PRIORITIES, RECURRENCES, SNOOZE_PRESETS, TYPES, WHEN_PRESETS, addDays, dayLabel, startOfDay, startOfWeek, textHref, timeOf, typeMeta,
} from '../../components/followups/followUpUtils.js';

const PRIORITY_BAR = ['bg-transparent', 'bg-signal-500', 'bg-red-500'];
const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.getAttribute?.('role') === 'combobox');

function RescheduleDialog({ open, title, initial, onClose, onSave, pending }) {
  const [value, setValue] = useState('');
  useEffect(() => { if (open) setValue(toLocalInput(initial || WHEN_PRESETS[2].get())); }, [open, initial]);
  return (
    <Modal open={open} onClose={onClose} size="sm" title={title}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={!value} onClick={() => onSave(new Date(value).toISOString())}>Save</Button></>}>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {WHEN_PRESETS.map((p) => <Button key={p.key} size="sm" variant="secondary" onClick={() => setValue(toLocalInput(p.get()))}>{p.label}</Button>)}
        </div>
        <Field label="Date and time"><Input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

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

function FollowUpRow({ f, selected, onSelect, provider, mine, actions }) {
  const meta = typeMeta(f.type);
  const Icon = meta.icon;
  const pending = f.status === 'pending';
  const overdue = pending && new Date(f.dueAt) < new Date();
  const sms = textHref(f.carrier.phone, provider);
  return (
    <li className={cx('group relative flex flex-col gap-3 py-3 pl-5 pr-4 transition-ui hover:bg-surface-2/50 md:flex-row md:items-center', selected && 'bg-brand-50/60 dark:bg-brand-900/20')}>
      <span className={cx('absolute inset-y-2 left-0 w-0.5 rounded-full', PRIORITY_BAR[f.priority] || PRIORITY_BAR[0])} aria-hidden />
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {mine && <Checkbox aria-label={`Select ${f.carrier.companyName}`} checked={selected} onChange={(e) => onSelect(e.target.checked)} className="mt-0.5" />}
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
          <div className="flex items-center gap-1.5">
            {f.carrier.phone && <CallButton variant="button" size="sm" phone={f.carrier.phone} carrierId={f.carrier.id} />}
            {f.carrier.email && <IconButton icon={Mail} label="Email" onClick={actions.email} />}
            {sms && <a href={sms} target={sms.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer" aria-label="Text" title={provider === 'google_voice' ? 'Text in Google Voice' : 'Text'}
              className="inline-flex size-8 items-center justify-center rounded-lg text-fg-2 transition-ui hover:bg-surface-2 hover:text-fg"><MessageSquare className="size-4" /></a>}
            <Button size="sm" icon={Check} onClick={actions.complete}>Done</Button>
            <SnoozeMenu onSnooze={actions.snooze} onPick={actions.reschedule} label="" />
            <Popover width="w-44" trigger={({ toggle }) => <IconButton icon={MoreHorizontal} label="More actions" onClick={toggle} />}>
              {({ close }) => (
                <>
                  <MenuItem icon={Pencil} onClick={() => { close(); actions.edit(); }}>Edit</MenuItem>
                  <MenuItem icon={CalendarDays} onClick={() => { close(); actions.reschedule(); }}>Reschedule</MenuItem>
                  <MenuItem icon={Trash2} danger onClick={() => { close(); actions.remove(); }}>Delete</MenuItem>
                </>
              )}
            </Popover>
          </div>
        ) : mine && f.status !== 'pending' ? (
          <IconButton icon={Trash2} label="Delete" onClick={actions.remove} />
        ) : null}
      </div>
    </li>
  );
}

function WeekView({ weekStart, items, onPick }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = startOfDay(new Date()).getTime();
  return (
    <div className="grid grid-cols-1 divide-y divide-line sm:grid-cols-7 sm:divide-x sm:divide-y-0">
      {days.map((d) => {
        const list = items.filter((f) => startOfDay(f.dueAt).getTime() === d.getTime());
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
  const [view, setView] = useState('today');
  const [mode, setMode] = useState('list');
  const [type, setType] = useState('');
  const [priority, setPriority] = useState('');
  const [scope, setScope] = useState('mine');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [quickAdd, setQuickAdd] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [edit, setEdit] = useState(null);
  const [completing, setCompleting] = useState(null);
  const [rescheduling, setRescheduling] = useState(null); // follow-up | 'bulk'
  const [emailing, setEmailing] = useState(null);

  useEffect(() => { const t = setTimeout(() => { setQ(search.trim()); setPage(1); }, 250); return () => clearTimeout(t); }, [search]);
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
  const list = useQuery({ queryKey: ['follow-ups', params], queryFn: () => api.get('/api/follow-ups', params), placeholderData: keepPreviousData });
  const settings = useQuery({ queryKey: ['telephony', 'settings'], queryFn: () => api.get('/api/telephony/settings'), staleTime: 300000 });
  const provider = settings.data?.settings?.provider;
  const counts = list.data?.counts;
  const items = useMemo(() => list.data?.items || [], [list.data]);

  const snooze = useApiMutation(({ id, body }) => api.post(`/api/follow-ups/${id}/snooze`, body), {
    invalidate: FOLLOW_UP_INVALIDATE, success: (d) => `Snoozed to ${dayLabel(d.followUp.dueAt).toLowerCase()} ${timeOf(d.followUp.dueAt)}`,
  });
  const reschedule = useApiMutation(({ id, dueAt }) => api.patch(`/api/follow-ups/${id}`, { dueAt }), {
    invalidate: FOLLOW_UP_INVALIDATE, success: 'Rescheduled', onSuccess: () => setRescheduling(null),
  });
  const del = useApiMutation((id) => api.del(`/api/follow-ups/${id}`), { invalidate: FOLLOW_UP_INVALIDATE, success: 'Follow-up deleted' });
  const bulk = useApiMutation((body) => api.post('/api/follow-ups/bulk', body), {
    invalidate: FOLLOW_UP_INVALIDATE,
    success: (d) => `${d.updated} updated${d.skipped ? ` · ${d.skipped} skipped` : ''}`,
    onSuccess: () => { setSelected(new Set()); setRescheduling(null); },
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

  const selectable = items.filter((f) => f.userId === user.id);
  const allSelected = selectable.length > 0 && selectable.every((f) => selected.has(f.id));
  const toggle = (id, on) => setSelected((s) => { const n = new Set(s); on ? n.add(id) : n.delete(id); return n; });
  const ids = [...selected];

  const actionsFor = (f) => ({
    complete: () => setCompleting(f),
    snooze: (body) => snooze.mutate({ id: f.id, body }),
    reschedule: () => setRescheduling(f),
    edit: () => setEdit(f),
    email: () => setEmailing(f),
    remove: async () => { if (await confirm({ title: 'Delete this follow-up?', message: f.recurrence !== 'none' ? 'Future repeats stop too.' : undefined, confirmLabel: 'Delete', danger: true })) del.mutate(f.id); },
  });

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
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted" aria-hidden />
          <Input ref={searchRef} aria-label="Search follow-ups" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search carrier, title or note" className="pl-8 pr-8" />
          <kbd className="pointer-events-none absolute right-2 top-2 rounded border border-line px-1 font-mono text-[11px] text-muted">/</kbd>
        </div>
        <Select aria-label="Type" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} className="w-36">
          <option value="">All types</option>
          {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </Select>
        <Select aria-label="Priority" value={String(priority)} onChange={(e) => { setPriority(e.target.value); setPage(1); }} className="w-36">
          <option value="">Any priority</option>
          {PRIORITIES.map((p) => <option key={p.value} value={String(p.value)}>{p.label}</option>)}
        </Select>
        {user?.team && <Select aria-label="Scope" value={scope} onChange={(e) => setScope(e.target.value)} className="w-32"><option value="mine">Mine</option><option value="team">Team</option></Select>}
        {filtered && <Button size="sm" variant="ghost" icon={X} onClick={() => { setType(''); setPriority(''); setSearch(''); }}>Clear</Button>}
      </div>

      {selected.size > 0 && (
        <div className="dd-enter sticky top-2 z-30 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-4 py-2 shadow-sm">
          <span className="mr-1 text-sm font-medium tabular">{selected.size} selected</span>
          <Button size="sm" icon={Check} loading={bulk.isPending} onClick={() => bulk.mutate({ ids, action: 'complete' })}>Mark done</Button>
          <SnoozeMenu onSnooze={(b) => bulk.mutate({ ids, action: 'snooze', ...b })} onPick={() => setRescheduling('bulk')} />
          <Button size="sm" variant="secondary" icon={CalendarDays} onClick={() => setRescheduling('bulk')}>Reschedule</Button>
          <Popover align="left" width="w-40" trigger={({ toggle }) => <Button size="sm" variant="secondary" icon={ChevronDown} onClick={toggle}>Priority</Button>}>
            {({ close }) => PRIORITIES.map((p) => <MenuItem key={p.value} onClick={() => { close(); bulk.mutate({ ids, action: 'priority', priority: p.value }); }}>{p.label}</MenuItem>)}
          </Popover>
          <Button size="sm" variant="secondary" icon={Trash2} onClick={async () => { if (await confirm({ title: `Delete ${selected.size} follow-up(s)?`, confirmLabel: 'Delete', danger: true })) bulk.mutate({ ids, action: 'delete' }); }}>Delete</Button>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
        </div>
      )}

      <Card bodyClass="p-0">
        {list.isLoading ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={list.refetch} /> : mode === 'week' ? (
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
                      onSelect={(on) => toggle(f.id, on)} actions={actionsFor(f)} />
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
      <RescheduleDialog open={!!rescheduling} title={rescheduling === 'bulk' ? `Reschedule ${selected.size} follow-up(s)` : 'Reschedule'}
        initial={rescheduling && rescheduling !== 'bulk' ? rescheduling.dueAt : null} pending={reschedule.isPending || bulk.isPending}
        onClose={() => setRescheduling(null)}
        onSave={(dueAt) => (rescheduling === 'bulk' ? bulk.mutate({ ids, action: 'reschedule', dueAt }) : reschedule.mutate({ id: rescheduling.id, dueAt }))} />
      <ComposeModal open={!!emailing} onClose={() => setEmailing(null)} carrierId={emailing?.carrier.id} toEmail={emailing?.carrier.email}
        subject={emailing?.title || ''} />
    </div>
  );
}
