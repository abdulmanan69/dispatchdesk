import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Sun } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { Card, EmptyState, PageHeader, QueryState, Select, Switch, Tabs, Button, cx } from '../../components/ui.jsx';
import TodayItem, { SECTIONS, tripFromItem } from '../../components/today/TodayItem.jsx';
import CheckCallModal from '../../components/fleet/CheckCallModal.jsx';
import TrackingLinkModal from '../../components/fleet/TrackingLinkModal.jsx';

const GROUPS = [
  [0, 'Needs action now'],
  [1, 'Today'],
  [2, 'Coming up and paperwork'],
];

/** Check-call reminder interval (per dispatcher): how long a load in transit can go without an update. */
function CheckCallSetting() {
  const q = useQuery({ queryKey: ['fleet', 'checkcall-settings'], queryFn: () => api.get('/api/fleet/settings/check-calls') });
  const save = useApiMutation((body) => api.put('/api/fleet/settings/check-calls', body), { success: 'Reminder setting saved', invalidate: [['fleet', 'checkcall-settings'], ['today']] });
  if (!q.data) return null;
  const s = q.data;
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <Switch checked={s.enabled} onChange={(v) => save.mutate({ hours: s.hours, enabled: v })} label={<span>Check-call reminders</span>} />
      <span className="flex items-center gap-2 text-fg-2">every
        <Select aria-label="Hours between check calls" value={String(s.hours)} disabled={!s.enabled} onChange={(e) => save.mutate({ hours: Number(e.target.value), enabled: s.enabled })} className="h-8 w-24 text-xs">
          {s.options.map((h) => <option key={h} value={h}>{h} h</option>)}
        </Select>
      </span>
    </div>
  );
}

/**
 * Today: one prioritized action list for every load and truck: appointments with on-time risk, check calls due,
 * trucks at a dock, empty trucks, missing PODs, overdue invoices, follow-ups and expiring paperwork.
 */
export default function Today() {
  const [scope, setScope] = useState('mine');
  const [section, setSection] = useState('all');
  const [modal, setModal] = useState(null); // { kind: 'checkcall'|'tracking', item }
  const q = useQuery({
    queryKey: ['today', scope], queryFn: ({ signal }) => api.get('/api/today', { scope }, { signal }),
    refetchInterval: 60_000, staleTime: 20_000,
  });
  const counts = q.data?.counts || {};
  const tabs = useMemo(() => [{ value: 'all', label: 'Everything', count: q.data?.items?.length ?? null }, ...Object.entries(SECTIONS).filter(([k]) => counts[k]).map(([k, v]) => ({ value: k, label: v.label, count: counts[k] }))], [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = (q.data?.items || []).filter((i) => section === 'all' || i.section === section);

  return (
    <div className="space-y-4">
      <PageHeader title="Today" subtitle="What needs you now, across every load and truck"
        actions={<>
          {q.data?.canViewTeam && (
            <Select aria-label="Whose work" value={scope} onChange={(e) => setScope(e.target.value)} className="h-9 w-36">
              <option value="mine">My work</option><option value="team">Whole team</option>
            </Select>
          )}
          <Button variant="secondary" icon={RefreshCw} loading={q.isFetching && !q.isLoading} onClick={() => q.refetch()}>Refresh</Button>
        </>} />

      <Card bodyClass="py-3"><CheckCallSetting /></Card>

      <QueryState query={q}>
        {(data) => (
          <>
            {data.items.length > 0 && <Tabs tabs={tabs} value={section} onChange={setSection} />}
            {data.items.length === 0 ? (
              <Card><EmptyState icon={Sun} title="Nothing needs you right now">Appointments, check calls, trucks at a dock, missing PODs, overdue invoices and follow-ups show up here as they come due.</EmptyState></Card>
            ) : items.length === 0 ? (
              <Card><EmptyState title="Nothing in this list" /></Card>
            ) : (
              GROUPS.map(([p, label]) => {
                const rows = items.filter((i) => i.priority === p);
                if (!rows.length) return null;
                return (
                  <Card key={p} bodyClass="p-0" title={<h2 className={cx('text-sm font-medium', p === 0 && 'text-c-red')}>{label} <span className="ml-1 font-mono text-xs text-muted">{rows.length}</span></h2>}>
                    <ul className="divide-y divide-line">
                      {rows.map((item) => (
                        <TodayItem key={item.id} item={item}
                          onCheckCall={(it) => setModal({ kind: 'checkcall', item: it })}
                          onTrackingLink={(it) => setModal({ kind: 'tracking', item: it })} />
                      ))}
                    </ul>
                  </Card>
                );
              })
            )}
            <p className="text-xs text-muted">ETAs and on-time risk are planning estimates from the road route, recent driving speed and hours-of-service rules. Updated {new Date(data.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</p>
          </>
        )}
      </QueryState>

      {modal?.kind === 'checkcall' && (
        <CheckCallModal trip={tripFromItem(modal.item)} truck={{ companyName: modal.item.carrier?.companyName || 'Truck' }} onClose={() => setModal(null)} />
      )}
      {modal?.kind === 'tracking' && <TrackingLinkModal trip={tripFromItem(modal.item)} onClose={() => setModal(null)} />}
    </div>
  );
}
