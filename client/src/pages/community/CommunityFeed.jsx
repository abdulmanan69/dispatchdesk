import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { MessagesSquare, Plus, Search } from 'lucide-react';
import { api } from '../../lib/api.js';
import { label } from '../../lib/format.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Button, EmptyState, Input, PageHeader, Pagination, QueryState, Select, cx } from '../../components/ui.jsx';
import { PostCard } from '../../components/community/PostCard.jsx';
import { PostEditor } from '../../components/community/PostEditor.jsx';

export default function CommunityFeed() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const isApp = location.pathname.startsWith('/app');
  const base = isApp ? '/app/community' : '/community';
  const [params, setParams] = useSearchParams();
  const category = params.get('category') || '';
  const sort = params.get('sort') || 'new';
  const page = Number(params.get('page') || 1);
  const qParam = params.get('q') || '';
  const [search, setSearch] = useState(qParam);
  const [composing, setComposing] = useState(false);
  useEffect(() => setSearch(qParam), [qParam]);

  const update = (patch) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    if (!('page' in patch)) next.delete('page');
    setParams(next);
  };

  const q = useQuery({
    queryKey: ['community', 'posts', { category, sort, page, q: qParam }],
    queryFn: () => api.get('/api/community/posts', { category, sort, page, pageSize: 20, q: qParam }),
    placeholderData: keepPreviousData,
  });
  const create = useApiMutation((body) => api.post('/api/community/posts', body), {
    invalidate: [['community']], success: 'Post published',
    onSuccess: (res) => { setComposing(false); navigate(`${base}/${res.post.id}`); },
  });

  const startPost = () => {
    if (!user) return navigate(`/login?next=${encodeURIComponent(location.pathname)}`);
    setComposing(true);
  };
  const cats = q.data?.categories || [];
  const total = cats.reduce((s, c) => s + c.count, 0);

  const body = (
    <>
      <div className="flex flex-col gap-3 md:flex-row">
        <form className="relative flex-1" role="search" onSubmit={(e) => { e.preventDefault(); update({ q: search.trim() }); }}>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search discussions" aria-label="Search discussions" className="pl-8" />
        </form>
        <Select aria-label="Sort" className="md:w-40" value={sort} onChange={(e) => update({ sort: e.target.value === 'new' ? '' : e.target.value })}>
          <option value="new">Newest</option>
          <option value="top">Most discussed</option>
        </Select>
      </div>
      <div className="mt-4 grid gap-5 lg:grid-cols-[200px_1fr]">
        <nav aria-label="Categories" className="flex gap-1.5 overflow-x-auto lg:flex-col lg:overflow-visible">
          {[{ key: '', count: total }, ...cats].map((c) => (
            <button key={c.key || 'all'} type="button" aria-current={category === c.key} onClick={() => update({ category: c.key })}
              className={cx('flex items-center justify-between gap-3 whitespace-nowrap rounded-md px-3 py-1.5 text-left text-sm', category === c.key ? 'bg-brand-600/10 font-medium text-brand-800 dark:text-brand-200' : 'text-muted hover:bg-surface-2 hover:text-fg')}>
              {c.key ? label(c.key) : 'All topics'}<span className="text-xs tabular opacity-70">{c.count}</span>
            </button>
          ))}
        </nav>
        <div className="min-w-0">
          <QueryState query={q} isEmpty={(d) => !d.items.length}
            empty={<EmptyState icon={MessagesSquare} title="No discussions found" action={<Button icon={Plus} onClick={startPost}>Start a discussion</Button>}>
              {qParam || category ? 'Try another search or topic.' : 'Be the first to start a conversation.'}
            </EmptyState>}>
            {(d) => (
              <>
                <div className="space-y-3">{d.items.map((p) => <PostCard key={p.id} post={p} base={base} />)}</div>
                <div className="mt-3"><Pagination page={d.page} pages={d.pages} total={d.total} onPage={(p) => update({ page: String(p) })} /></div>
              </>
            )}
          </QueryState>
        </div>
      </div>
      <PostEditor open={composing} onClose={() => setComposing(false)} onSubmit={(b) => create.mutate(b)} busy={create.isPending} />
    </>
  );

  if (isApp) {
    return (
      <>
        <PageHeader title="Community" subtitle="Ask questions, share wins and learn from other dispatchers." actions={<Button icon={Plus} onClick={startPost}>New post</Button>} />
        {body}
      </>
    );
  }
  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-medium tracking-[-0.01em]">Community</h1>
          <p className="mt-1 text-sm text-muted">Dispatchers helping dispatchers: prospecting, brokers, loads, compliance and tools.</p>
        </div>
        <Button icon={Plus} onClick={startPost}>{user ? 'New post' : 'Log in to post'}</Button>
      </div>
      {body}
    </div>
  );
}
