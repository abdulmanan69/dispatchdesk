import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Phone, CheckCircle2, Clock, ListPlus, Trash2, Pencil, PhoneCall, Flame, PhoneOutgoing } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { dateTime, label, relative } from '../../lib/format.js';
import { Badge, Button, Card, EmptyState, ErrorState, Field, IconButton, Input, Loading, PageHeader, Pagination, Select, StatCard, Tabs, Textarea, cx } from '../../components/ui.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import LogCallModal from '../../components/carriers/LogCallModal.jsx';
import { PhoneLink, StageBadge, useProspectLists } from '../../components/carriers/shared.jsx';

export default function Prospecting() {
  const [tab, setTab] = useState('queue');
  return (
    <div>
      <PageHeader title="Prospecting" subtitle="Today's calls from your sequences and follow-ups, ordered by urgency and the carrier's local time."
        actions={<Button icon={PhoneOutgoing} to="/app/dialer">Start dialer</Button>} />
      <Tabs tabs={[{ value: 'queue', label: "Today's calls" }, { value: 'lists', label: 'Prospect lists' }]} value={tab} onChange={setTab} className="mb-4" />
      {tab === 'queue' ? <Queue /> : <Lists />}
    </div>
  );
}

function Queue() {
  const lists = useProspectLists();
  const [listId, setListId] = useState('');
  const [includeHot, setIncludeHot] = useState(true);
  const [calling, setCalling] = useState(null);
  const q = useQuery({ queryKey: ['queue', listId, includeHot], queryFn: () => api.get('/api/prospecting/queue', { listId, includeHot: String(includeHot) }), refetchInterval: 120000 });
  const completeStep = useApiMutation((eid) => api.post(`/api/sequences/enrollments/${eid}/complete-step`), { success: 'Task done', invalidate: [['queue']] });
  const completeFu = useApiMutation((id) => api.post(`/api/follow-ups/${id}/complete`), { success: 'Follow-up done', invalidate: [['queue'], ['follow-ups']] });

  if (q.isLoading) return <Loading label="Building today's call list…" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={q.refetch} />;
  const { items, stats } = q.data;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Due today" value={stats.due} icon={Clock} />
        <StatCard label="Overdue" value={stats.overdue} icon={Clock} tone={stats.overdue ? 'red' : 'muted'} />
        <StatCard label="Callable right now" value={stats.callableNow} icon={PhoneCall} tone="green" />
        <StatCard label="Calls logged today" value={stats.callsToday} icon={Phone} tone="signal"
          sub={Object.entries(stats.outcomesToday).map(([k, v]) => `${v} ${label(k).toLowerCase()}`).join(' · ') || undefined} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Prospect list" value={listId} onChange={(e) => setListId(e.target.value)} className="w-56">
          <option value="">All carriers</option>
          {lists.data?.items.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.count})</option>)}
        </Select>
        <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-brand-600" checked={includeHot} onChange={(e) => setIncludeHot(e.target.checked)} />Include hot leads</label>
        <span className="ml-auto text-xs text-muted">Updated {relative(q.data.generatedAt)}</span>
      </div>

      <Card bodyClass="p-0">
        {!items.length ? (
          <EmptyState icon={CheckCircle2} title="Your call list is clear" action={<div className="flex gap-2"><Button to="/app/sequences" size="sm">Enroll carriers in a sequence</Button><Button to="/app/carriers" variant="secondary" size="sm">Carrier list</Button></div>}>
            Nothing is due today. Enroll carriers in a sequence, schedule follow-ups, or mark leads as High/Hot priority to fill this list.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((it) => (
              <li key={it.key} className={cx('flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center', it.overdue && 'bg-red-50/40 dark:bg-red-950/10')}>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={`/app/carriers/${it.carrier.id}`} className="font-medium hover:underline">{it.carrier.companyName}</Link>
                    <StageBadge stage={it.carrier.stage} />
                    {it.overdue && <Badge color="red">Overdue</Badge>}
                    {it.kind === 'hot' && <Badge color="amber"><Flame className="size-3" />{it.carrier.priority === 2 ? 'Hot' : 'High'} lead</Badge>}
                  </div>
                  <p className="mt-0.5 text-[13px] text-muted">
                    {it.kind === 'sequence' && <>Sequence <Link to={`/app/sequences/${it.sequence.id}`} className="underline">{it.sequence.name}</Link> · step {it.sequence.stepNumber}/{it.sequence.stepCount} ({label(it.sequence.type)}){it.sequence.instructions && ` — ${it.sequence.instructions}`}</>}
                    {it.kind === 'follow_up' && <>Follow-up ({label(it.followUp.type)}){it.followUp.note && ` — ${it.followUp.note}`}</>}
                    {it.kind === 'hot' && <>Not contacted {it.carrier.lastContactedAt ? `since ${relative(it.carrier.lastContactedAt)}` : 'yet'}</>}
                    {it.dueAt && <> · due {dateTime(it.dueAt)}</>}
                  </p>
                </div>
                <div className="w-full shrink-0 text-xs md:w-56">
                  <p className={cx('font-mono text-xs tabular', it.callWindow.callable ? 'text-fg' : 'text-muted')}>
                    {it.callWindow.localTime ? `${it.callWindow.localTime} local (${it.carrier.state})` : 'Local time unknown'}
                  </p>
                  <p className="text-muted">{it.callWindow.recommendation}</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <PhoneLink phone={it.carrier.phone} carrierId={it.carrier.id} className="text-sm" />
                  {(it.kind !== 'sequence' || it.sequence.type === 'call') && (it.followUp?.type ?? 'call') === 'call'
                    ? <Button size="sm" icon={Phone} onClick={() => setCalling(it.carrier)}>Log call</Button>
                    : it.kind === 'sequence'
                      ? <Button size="sm" variant="secondary" onClick={() => completeStep.mutate(it.sequence.enrollmentId)}>Mark task done</Button>
                      : <Button size="sm" variant="secondary" onClick={() => completeFu.mutate(it.followUp.id)}>Mark done</Button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="text-xs text-muted">Calls are placed from your own phone (tap the number). Logging the outcome advances the sequence and schedules the next step automatically. Do-not-call carriers are excluded.</p>
      <LogCallModal open={!!calling} carrier={calling} onClose={() => setCalling(null)} />
    </div>
  );
}

function Lists() {
  const confirm = useConfirm();
  const lists = useProspectLists();
  const [editing, setEditing] = useState(null);
  const [openId, setOpenId] = useState(null);
  const save = useApiMutation(
    (b) => (editing?.id ? api.patch(`/api/prospecting/lists/${editing.id}`, b) : api.post('/api/prospecting/lists', b)),
    { success: 'List saved', invalidate: [['prospect-lists']], onSuccess: () => setEditing(null) },
  );
  const del = useApiMutation((id) => api.del(`/api/prospecting/lists/${id}`), { success: 'List deleted', invalidate: [['prospect-lists']] });

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <Card title="Lists" actions={<Button size="sm" icon={ListPlus} onClick={() => setEditing({})}>New list</Button>} bodyClass="p-0">
        {lists.isLoading ? <Loading /> : !lists.data?.items.length ? (
          <EmptyState title="No prospect lists">Group carriers (e.g. "Texas reefers") then add them from the carrier list with bulk actions.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {lists.data.items.map((l) => (
              <li key={l.id} className={cx('flex items-center gap-2 px-3 py-2.5', openId === l.id && 'bg-surface-2')}>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpenId(l.id)}>
                  <p className="truncate text-sm font-medium">{l.name}</p>
                  <p className="text-xs text-muted">{l.count} carriers</p>
                </button>
                <IconButton icon={Pencil} label="Rename list" onClick={() => setEditing(l)} />
                <IconButton icon={Trash2} label="Delete list" onClick={async () => { if (await confirm({ title: `Delete "${l.name}"?`, message: 'The carriers stay in your CRM; only the list is removed.', danger: true })) { del.mutate(l.id); if (openId === l.id) setOpenId(null); } }} />
              </li>
            ))}
          </ul>
        )}
      </Card>
      {openId ? <ListDetail id={openId} /> : <Card><EmptyState title="Select a list" /></Card>}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Edit list' : 'New prospect list'} size="sm"
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" form="list-form" loading={save.isPending}>Save</Button></>}>
        {editing && (
          <form id="list-form" className="space-y-3" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); save.mutate({ name: f.get('name'), description: f.get('description') }); }}>
            <Field label="Name" required><Input name="name" defaultValue={editing.name} required maxLength={80} /></Field>
            <Field label="Description"><Textarea name="description" rows={2} defaultValue={editing.description || ''} /></Field>
          </form>
        )}
      </Modal>
    </div>
  );
}

function ListDetail({ id }) {
  const [page, setPage] = useState(1);
  const [calling, setCalling] = useState(null);
  const q = useQuery({ queryKey: ['prospect-lists', id, page], queryFn: () => api.get(`/api/prospecting/lists/${id}`, { page, pageSize: 25 }) });
  const remove = useApiMutation((carrierId) => api.del(`/api/prospecting/lists/${id}/items/${carrierId}`), { success: 'Removed from list', invalidate: [['prospect-lists']] });
  if (q.isLoading) return <Card><Loading /></Card>;
  if (q.isError) return <Card><ErrorState error={q.error} onRetry={q.refetch} /></Card>;
  return (
    <Card title={q.data.list.name} bodyClass="p-0" actions={<Button size="sm" variant="secondary" to="/app/carriers">Add from carrier list</Button>}>
      {q.data.list.description && <p className="border-b border-line px-4 py-2 text-sm text-muted">{q.data.list.description}</p>}
      {!q.data.items.length ? <EmptyState title="This list is empty">Select carriers in the carrier list and choose “Add to prospect list”.</EmptyState> : (
        <ul className="divide-y divide-line">
          {q.data.items.map(({ carrier: c }) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <Link to={`/app/carriers/${c.id}`} className="min-w-40 flex-1 font-medium hover:underline">{c.companyName}</Link>
              <StageBadge stage={c.stage} />
              <span className="text-muted">{c.state}</span>
              <PhoneLink phone={c.phone} carrierId={c.id} />
              <Button size="sm" variant="secondary" icon={Phone} disabled={c.doNotCall} onClick={() => setCalling(c)}>Log call</Button>
              <IconButton icon={Trash2} label="Remove from list" onClick={() => remove.mutate(c.id)} />
            </li>
          ))}
        </ul>
      )}
      <div className="px-3"><Pagination page={q.data.page} pages={q.data.pages} total={q.data.total} onPage={setPage} /></div>
      <LogCallModal open={!!calling} carrier={calling} onClose={() => setCalling(null)} />
    </Card>
  );
}
