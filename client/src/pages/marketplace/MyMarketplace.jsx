import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Eye, EyeOff, Inbox, Pencil, Plus, Store, Trash2, ExternalLink } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { date, label, relative } from '../../lib/format.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { Avatar, Badge, Button, Card, DataTable, EmptyState, IconButton, PageHeader, QueryState, Tabs, cx } from '../../components/ui.jsx';
import { ChatThread } from '../../components/training/ChatThread.jsx';
import { priceLabel } from '../../components/marketplace/ListingCard.jsx';

const STATUS_COLOR = { active: 'green', hidden: 'gray', removed: 'red' };

function MyListings() {
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['marketplace', 'mine'], queryFn: () => api.get('/api/marketplace/mine') });
  const toggle = useApiMutation(({ id, status }) => api.patch(`/api/marketplace/listings/${id}`, { status }), {
    invalidate: [['marketplace']], success: (_, v) => (v.status === 'hidden' ? 'Listing hidden' : 'Listing is live'),
  });
  const del = useApiMutation((id) => api.del(`/api/marketplace/listings/${id}`), { invalidate: [['marketplace']], success: 'Listing deleted' });

  return (
    <Card bodyClass="p-0">
      <QueryState query={q} isEmpty={(d) => !d.items.length}
        empty={<EmptyState icon={Store} title="You have no listings yet" action={<Button icon={Plus} to="/app/marketplace/new">Post a listing</Button>}>Offer your dispatch service, tools or training to the community.</EmptyState>}>
        {(d) => (
          <DataTable
            rows={d.items}
            columns={[
              { key: 'title', header: 'Listing', render: (l) => (
                <div className="min-w-48">
                  <Link to={`/marketplace/${l.id}`} className="font-medium hover:underline">{l.title}</Link>
                  <div className="text-xs text-muted">{label(l.category)} · {priceLabel(l)}</div>
                </div>
              ) },
              { key: 'status', header: 'Status', render: (l) => <Badge color={STATUS_COLOR[l.status]}>{l.status === 'removed' ? 'Removed by moderator' : label(l.status)}</Badge> },
              { key: 'messageCount', header: 'Messages', className: 'tabular', render: (l) => l.messageCount ?? 0 },
              { key: 'createdAt', header: 'Posted', render: (l) => <span className="text-xs text-muted">{date(l.createdAt)}</span> },
              { key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right', render: (l) => (
                <div className="flex justify-end gap-0.5">
                  <Link to={`/marketplace/${l.id}`} aria-label="View listing" title="View listing" className="inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"><ExternalLink className="size-4" /></Link>
                  {l.status !== 'removed' && (
                    <>
                      <IconButton icon={l.status === 'active' ? EyeOff : Eye} label={l.status === 'active' ? 'Hide listing' : 'Make listing live'}
                        onClick={() => toggle.mutate({ id: l.id, status: l.status === 'active' ? 'hidden' : 'active' })} />
                      <Link to={`/app/marketplace/${l.id}/edit`} aria-label="Edit listing" title="Edit listing" className="inline-flex size-8 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"><Pencil className="size-4" /></Link>
                    </>
                  )}
                  <IconButton icon={Trash2} label="Delete listing" className="hover:text-red-600" onClick={async () => {
                    if (await confirm({ title: 'Delete listing?', message: `"${l.title}" and its conversations will be permanently deleted.`, danger: true })) del.mutate(l.id);
                  }} />
                </div>
              ) },
            ]}
          />
        )}
      </QueryState>
    </Card>
  );
}

function InboxView({ listingId, userId, onSelect }) {
  const { user } = useAuth();
  const threads = useQuery({ queryKey: ['marketplace', 'inbox'], queryFn: () => api.get('/api/marketplace/inbox'), refetchInterval: 30000 });
  const selected = listingId && userId;
  const thread = useQuery({ queryKey: ['marketplace', 'inbox', listingId, userId], queryFn: () => api.get(`/api/marketplace/inbox/${listingId}/${userId}`), enabled: !!selected });
  const reply = useApiMutation((body) => api.post(`/api/marketplace/inbox/${listingId}/${userId}`, { body }), { invalidate: [['marketplace', 'inbox']] });

  return (
    <div className="grid h-[min(72vh,680px)] gap-4 lg:grid-cols-[320px_1fr]">
      <div className={cx('flex flex-col overflow-hidden rounded-xl border border-line bg-surface', selected && 'hidden lg:flex')}>
        <div className="border-b border-line px-4 py-3 text-sm font-medium">Conversations</div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <QueryState query={threads} isEmpty={(d) => !d.items.length} empty={<EmptyState icon={Inbox} title="No messages yet">Buyers who contact you, and sellers you contact, appear here.</EmptyState>}>
            {(d) => (
              <ul>
                {d.items.map((t) => {
                  const active = t.listingId === listingId && t.user.id === userId;
                  return (
                    <li key={`${t.listingId}:${t.user.id}`}>
                      <button type="button" onClick={() => onSelect(t.listingId, t.user.id)} className={cx('flex w-full items-start gap-2.5 border-b border-line/60 px-3.5 py-3 text-left hover:bg-surface-2', active && 'bg-brand-600/10')}>
                        <Avatar name={t.user.name} src={t.user.avatarUrl} size={30} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium">{t.user.name}</span>
                            {t.unread > 0 && <Badge color="amber">{t.unread}</Badge>}
                          </div>
                          <p className="truncate text-xs text-muted">{t.iAmSeller ? 'Your listing' : 'Re'}: {t.listingTitle}</p>
                          <p className="truncate text-xs text-muted">{t.lastMine ? 'You: ' : ''}{t.lastMessage}</p>
                          <p className="text-[11px] text-muted">{relative(t.lastAt)}</p>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </QueryState>
        </div>
      </div>
      <div className={cx('flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface', !selected && 'hidden lg:flex')}>
        {!selected ? <EmptyState icon={Inbox} title="Select a conversation" /> : (
          <QueryState query={thread}>
            {(d) => (
              <>
                <header className="flex items-center gap-3 border-b border-line px-4 py-3">
                  <button type="button" className="text-sm text-muted lg:hidden" onClick={() => onSelect(null, null)}>Back</button>
                  {d.user && <Avatar name={d.user.name} src={d.user.avatarUrl} size={28} />}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{d.user?.name ?? 'Unknown user'}</p>
                    <Link to={`/marketplace/${d.listing.id}`} className="block truncate text-xs text-muted hover:underline">{d.listing.title}</Link>
                  </div>
                </header>
                <ChatThread messages={d.items} mine={(m) => m.sender?.id === user.id} onSend={(body) => reply.mutateAsync(body)} sending={reply.isPending}
                  placeholder="Write a reply… (Ctrl+Enter to send)" emptyText="No messages." />
              </>
            )}
          </QueryState>
        )}
      </div>
    </div>
  );
}

export default function MyMarketplace() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'listings';
  const unread = useQuery({ queryKey: ['marketplace', 'inbox'], queryFn: () => api.get('/api/marketplace/inbox') });
  return (
    <>
      <PageHeader
        title="Marketplace"
        subtitle="Manage your listings and conversations with buyers and sellers."
        actions={<>
          <Button variant="secondary" to="/marketplace">Browse marketplace</Button>
          <Button icon={Plus} to="/app/marketplace/new">Post a listing</Button>
        </>}
      />
      <Tabs className="mb-4" value={tab} onChange={(t) => setParams({ tab: t })}
        tabs={[{ value: 'listings', label: 'My listings' }, { value: 'inbox', label: 'Inbox', count: unread.data?.unread || undefined }]} />
      {tab === 'listings' ? <MyListings /> : (
        <InboxView listingId={params.get('listing')} userId={params.get('user')}
          onSelect={(l, u) => setParams(l ? { tab: 'inbox', listing: l, user: u } : { tab: 'inbox' })} />
      )}
    </>
  );
}
