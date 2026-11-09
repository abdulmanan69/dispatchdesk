import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { dateTime } from '../../lib/format.js';
import { Card, Input, Button, DataTable, Pagination, QueryState, EmptyState } from '../ui.jsx';

export default function AuditLog() {
  const [draft, setDraft] = useState({ action: '', actor: '', from: '', to: '' });
  const [filters, setFilters] = useState(draft);
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['admin', 'audit', filters, page], queryFn: () => api.get('/api/admin/audit', { ...filters, page, pageSize: 50 }) });
  const set = (k) => (e) => setDraft({ ...draft, [k]: e.target.value });
  return (
    <Card bodyClass="p-0">
      <form className="grid gap-2 border-b border-line p-3 sm:grid-cols-5" onSubmit={(e) => { e.preventDefault(); setPage(1); setFilters(draft); }}>
        <Input aria-label="Action contains" placeholder="Action (e.g. auth.login)" value={draft.action} onChange={set('action')} />
        <Input aria-label="Actor" placeholder="Actor name or email" value={draft.actor} onChange={set('actor')} />
        <Input aria-label="From date" type="date" value={draft.from} onChange={set('from')} />
        <Input aria-label="To date" type="date" value={draft.to} onChange={set('to')} />
        <Button type="submit" variant="secondary">Filter</Button>
      </form>
      <QueryState query={q}>
        {(d) => (
          <>
            <DataTable dense rows={d.items} empty={<EmptyState title="No audit entries match" />} columns={[
              { key: 'createdAt', header: 'Time', className: 'whitespace-nowrap', render: (x) => dateTime(x.createdAt) },
              { key: 'action', header: 'Action', render: (x) => <code className="font-mono text-xs">{x.action}</code> },
              { key: 'actor', header: 'Actor', render: (x) => (x.actor ? <span title={x.actor.email}>{x.actor.name}</span> : <span className="text-muted">system</span>) },
              { key: 'entity', header: 'Entity', render: (x) => (x.entityType ? <span className="text-xs text-muted">{x.entityType} {x.entityId?.slice(0, 10)}</span> : '—') },
              { key: 'ip', header: 'IP', render: (x) => <span className="font-mono text-xs text-muted">{x.ip || '—'}</span> },
              { key: 'details', header: 'Details', render: (x) => (x.details ? <code className="block max-w-xs truncate font-mono text-[11px] text-muted" title={JSON.stringify(x.details)}>{JSON.stringify(x.details)}</code> : '—') },
            ]} />
            <div className="border-t border-line px-3"><Pagination page={d.page} pages={d.pages} total={d.total} onPage={setPage} /></div>
          </>
        )}
      </QueryState>
    </Card>
  );
}
