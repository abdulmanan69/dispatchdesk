import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Plus, Search, Store } from 'lucide-react';
import { api } from '../../lib/api.js';
import { label } from '../../lib/format.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Button, EmptyState, Input, Pagination, QueryState, Select, cx } from '../../components/ui.jsx';
import { ListingCard, PRICE_TYPES } from '../../components/marketplace/ListingCard.jsx';

export default function MarketplaceBrowse() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const category = params.get('category') || '';
  const sort = params.get('sort') || 'new';
  const priceType = params.get('priceType') || '';
  const page = Number(params.get('page') || 1);
  const qParam = params.get('q') || '';
  const [search, setSearch] = useState(qParam);
  useEffect(() => setSearch(qParam), [qParam]);

  const update = (patch) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    if (!('page' in patch)) next.delete('page');
    setParams(next);
  };

  const q = useQuery({
    queryKey: ['marketplace', 'listings', { category, sort, priceType, page, q: qParam }],
    queryFn: () => api.get('/api/marketplace/listings', { category, sort, priceType, page, pageSize: 24, q: qParam }),
    placeholderData: keepPreviousData,
  });
  const cats = q.data?.categories || [];
  const total = cats.reduce((s, c) => s + c.count, 0);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-medium tracking-[-0.01em]">Marketplace</h1>
          <p className="mt-1 text-sm text-muted">Dispatch tools, training, services and jobs posted by the community. Posting is free.</p>
        </div>
        <Button icon={Plus} to={user ? '/app/marketplace/new' : `/login?next=${encodeURIComponent('/app/marketplace/new')}`}>Post a listing</Button>
      </div>

      <div className="mt-6 flex flex-col gap-3 md:flex-row">
        <form className="relative flex-1" role="search" onSubmit={(e) => { e.preventDefault(); update({ q: search.trim() }); }}>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search listings" aria-label="Search listings" className="pl-8" />
        </form>
        <Select aria-label="Price type" className="md:w-44" value={priceType} onChange={(e) => update({ priceType: e.target.value })}>
          <option value="">Any price</option>
          {PRICE_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
        <Select aria-label="Sort" className="md:w-44" value={sort} onChange={(e) => update({ sort: e.target.value === 'new' ? '' : e.target.value })}>
          <option value="new">Newest</option>
          <option value="price_asc">Price: low to high</option>
          <option value="price_desc">Price: high to low</option>
        </Select>
      </div>

      <div className="mt-4 flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Categories">
        {[{ key: '', count: total }, ...cats].map((c) => (
          <button key={c.key || 'all'} type="button" role="tab" aria-selected={category === c.key} onClick={() => update({ category: c.key })}
            className={cx('whitespace-nowrap rounded-full border px-3 py-1 text-[13px]', category === c.key ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-surface text-muted hover:text-fg')}>
            {c.key ? label(c.key) : 'All'} <span className="tabular opacity-70">{c.count}</span>
          </button>
        ))}
      </div>

      <div className="mt-6">
        <QueryState query={q} isEmpty={(d) => !d.items.length}
          empty={<EmptyState icon={Store} title="No listings found">{qParam || category || priceType ? 'Try a different search or category.' : 'Be the first to post a listing.'}</EmptyState>}>
          {(d) => (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {d.items.map((l) => <ListingCard key={l.id} listing={l} />)}
              </div>
              <div className="mt-4"><Pagination page={d.page} pages={d.pages} total={d.total} onPage={(p) => update({ page: String(p) })} /></div>
            </>
          )}
        </QueryState>
      </div>
      <p className="mt-10 text-center text-xs text-muted">Payments are arranged directly between buyers and sellers — the platform does not process marketplace payments. Report anything suspicious.</p>
    </div>
  );
}
