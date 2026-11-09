import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Flag, ExternalLink } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { dateTime, label } from '../../lib/format.js';
import { Card, Tabs, QueryState, EmptyState, Badge, Button, Pagination } from '../ui.jsx';

export default function Moderation() {
  const [status, setStatus] = useState('open');
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['admin', 'reports', status, page], queryFn: () => api.get('/api/admin/reports', { status, page, pageSize: 20 }) });
  const resolve = useApiMutation(({ id, action }) => api.post(`/api/admin/reports/${id}/resolve`, { action }), {
    success: (d, v) => ({ dismiss: 'Report dismissed', hide_content: 'Content hidden', remove_content: 'Content removed', restore_content: 'Content restored' }[v.action]),
    invalidate: [['admin', 'reports'], ['admin', 'stats']],
  });
  return (
    <Card bodyClass="p-0">
      <div className="px-3 pt-1">
        <Tabs value={status} onChange={(v) => { setStatus(v); setPage(1); }} tabs={['open', 'resolved', 'dismissed', 'all'].map((s) => ({ value: s, label: label(s) }))} className="border-0" />
      </div>
      <div className="border-t border-line">
        <QueryState query={q} isEmpty={(d) => !d.items.length} empty={<EmptyState icon={Flag} title={status === 'open' ? 'No open reports' : 'Nothing here'}>Reports from marketplace and community members appear here.</EmptyState>}>
          {(d) => (
            <>
              <ul className="divide-y divide-line">
                {d.items.map((r) => (
                  <li key={r.id} className="px-4 py-3.5">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge color="red">{label(r.reason)}</Badge>
                      <Badge>{label(r.kind)}</Badge>
                      {r.target && <Badge color={r.target.status === 'removed' ? 'red' : r.target.status === 'hidden' ? 'amber' : 'green'}>content {r.target.status}</Badge>}
                      <span className="text-xs text-muted">reported by {r.reporter.name} · {dateTime(r.createdAt)}</span>
                      {r.status !== 'open' && <span className="text-xs text-muted">· {r.status} by {r.resolvedBy || 'admin'}</span>}
                    </div>
                    {r.details && <p className="mt-1 text-sm">“{r.details}”</p>}
                    {r.target ? (
                      <div className="mt-2 rounded-md border border-line bg-surface-2 p-3 text-sm">
                        {r.target.title && <p className="font-medium">{r.target.title}</p>}
                        <p className="whitespace-pre-line text-muted">{r.target.excerpt}</p>
                        <p className="mt-1 flex items-center gap-2 text-xs text-muted">by {r.target.author?.name || 'unknown'}
                          <Link to={r.target.link} target="_blank" className="inline-flex items-center gap-1 text-brand-700 hover:underline dark:text-brand-300">open <ExternalLink className="size-3" /></Link>
                        </p>
                      </div>
                    ) : <p className="mt-2 text-sm text-muted">The reported content has been deleted.</p>}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {r.status === 'open' && <Button size="sm" variant="secondary" onClick={() => resolve.mutate({ id: r.id, action: 'dismiss' })}>Dismiss</Button>}
                      {r.target && r.target.status !== 'hidden' && <Button size="sm" variant="secondary" onClick={() => resolve.mutate({ id: r.id, action: 'hide_content' })}>Hide content</Button>}
                      {r.target && r.target.status !== 'removed' && <Button size="sm" variant="danger" onClick={() => resolve.mutate({ id: r.id, action: 'remove_content' })}>Remove content</Button>}
                      {r.target && r.target.status !== 'active' && r.target.status !== 'published' && <Button size="sm" variant="ghost" onClick={() => resolve.mutate({ id: r.id, action: 'restore_content' })}>Restore</Button>}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="border-t border-line px-3"><Pagination page={d.page} pages={d.pages} total={d.total} onPage={setPage} /></div>
            </>
          )}
        </QueryState>
      </div>
    </Card>
  );
}
