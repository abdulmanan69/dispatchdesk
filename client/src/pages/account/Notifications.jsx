import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Bell, Trash2, Check } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { dateTime, relative, label } from '../../lib/format.js';
import { Card, PageHeader, Tabs, Button, Pagination, QueryState, EmptyState, IconButton, Badge, cx } from '../../components/ui.jsx';

export default function Notifications() {
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ['notifications', 'page', filter, page],
    queryFn: () => api.get('/api/notifications', { page, pageSize: 25, unread: filter === 'unread' ? '1' : undefined }),
  });
  const inv = [['notifications']];
  const readAll = useApiMutation(() => api.post('/api/notifications/read-all'), { success: 'All notifications marked as read', invalidate: inv });
  const readOne = useApiMutation((id) => api.post(`/api/notifications/${id}/read`), { invalidate: inv });
  const remove = useApiMutation((id) => api.del(`/api/notifications/${id}`), { invalidate: inv });

  return (
    <div>
      <PageHeader title="Notifications" subtitle="Follow-up reminders, team updates, billing and system messages"
        actions={q.data?.unread > 0 && <Button variant="secondary" icon={Check} loading={readAll.isPending} onClick={() => readAll.mutate()}>Mark all read</Button>} />
      <Card bodyClass="p-0">
        <div className="px-4 pt-2">
          <Tabs value={filter} onChange={(v) => { setFilter(v); setPage(1); }} tabs={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread', count: q.data?.unread }]} />
        </div>
        <QueryState query={q} isEmpty={(d) => !d.items.length} empty={<EmptyState icon={Bell} title={filter === 'unread' ? 'No unread notifications' : 'No notifications yet'} />}>
          {(d) => (
            <>
              <ul className="divide-y divide-line">
                {d.items.map((n) => (
                  <li key={n.id} className={cx('flex items-start gap-3 px-4 py-3', !n.readAt && 'bg-brand-50/40 dark:bg-brand-900/10')}>
                    <span className={cx('mt-2 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-brand-600')} aria-hidden />
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { if (!n.readAt) readOne.mutate(n.id); if (n.link) navigate(n.link); }}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{n.title}</span>
                        <Badge>{label(n.type)}</Badge>
                      </div>
                      {n.body && <p className="mt-0.5 text-sm text-muted">{n.body}</p>}
                      <p className="mt-0.5 text-xs text-muted" title={dateTime(n.createdAt)}>{relative(n.createdAt)}</p>
                    </button>
                    {!n.readAt && <IconButton icon={Check} label="Mark as read" onClick={() => readOne.mutate(n.id)} />}
                    <IconButton icon={Trash2} label="Delete notification" onClick={() => remove.mutate(n.id)} />
                  </li>
                ))}
              </ul>
              <div className="border-t border-line px-3"><Pagination page={d.page} pages={d.pages} total={d.total} onPage={setPage} /></div>
            </>
          )}
        </QueryState>
      </Card>
    </div>
  );
}
