import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, ListChecks, Search, ShieldCheck, UserPlus } from 'lucide-react';
import { api } from '../../lib/api.js';
import { date, num } from '../../lib/format.js';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, Input, Loading, PageHeader, Tabs, Textarea, cx } from '../../components/ui.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import { errorToast } from '../../lib/hooks.js';
import FmcsaProfile from '../../components/carriers/FmcsaProfile.jsx';
import { AuthorityBadge } from '../../components/carriers/shared.jsx';
import { saveCensusLeads } from '../../components/carriers/saveLeads.js';

/**
 * Carrier check (/app/carrier-check): look up any carrier by USDOT, MC, name, phone or email and read its full vetting
 * page (authority, insurance, safety, inspections, crashes, related carriers), or check up to 25 numbers at once.
 *   ?q=<text>   search      ?dot=<usdot>   open that carrier      ?tab=bulk   bulk check
 */
const KIND = { mc: 'MC number', dot: 'USDOT number', number: 'USDOT or MC number', phone: 'phone number', email: 'email', name: 'name' };

export default function CarrierCheck() {
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') || '';
  const dot = (sp.get('dot') || '').replace(/\D/g, '');
  const tab = sp.get('tab') === 'bulk' ? 'bulk' : 'search';
  const [text, setText] = useState(q);
  const set = (next) => setSp((prev) => {
    const out = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(next)) { if (v) out.set(k, v); else out.delete(k); }
    return out;
  });

  const search = useQuery({
    queryKey: ['carrier-check', q],
    queryFn: ({ signal }) => api.get('/api/carrier-profile/search', { q }, { signal, timeoutMs: 60_000 }),
    enabled: !!q,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const items = search.data?.items || [];
  // One exact hit (a USDOT or MC search) opens straight away.
  const single = !dot && items.length === 1 && ['dot', 'mc', 'number'].includes(search.data?.query?.kind) ? items[0].dotNumber : null;
  const open = dot || single;

  const submit = (e) => {
    e.preventDefault();
    const v = text.trim();
    if (v) set({ q: v, dot: null, tab: null });
  };

  return (
    <div>
      <PageHeader title="Carrier check"
        subtitle="Vet any carrier before you call or book: authority, insurance, safety rating, inspections, crashes and carriers that share its contact details. Free FMCSA data, updated daily." />
      <Tabs className="mb-4" value={tab} onChange={(v) => set({ tab: v === 'bulk' ? 'bulk' : null })}
        tabs={[{ value: 'search', label: 'Search' }, { value: 'bulk', label: 'Bulk check' }]} />

      {tab === 'bulk' ? <BulkCheck onOpen={(d) => set({ dot: d, tab: null })} /> : (
        <>
          <form onSubmit={submit} className="mb-4 flex flex-col gap-2 sm:flex-row" role="search">
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="USDOT, MC number, company name, phone or email" aria-label="Carrier to check" className="sm:max-w-xl" autoFocus={!q && !dot} />
            <Button type="submit" icon={Search} disabled={!text.trim()}>Check carrier</Button>
          </form>

          {open ? (
            <div className="space-y-3">
              {(items.length > 1 || (dot && q)) && <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => set({ dot: null })}>{items.length > 1 ? `All ${items.length} results` : 'Back to results'}</Button>}
              <FmcsaProfile key={open} dot={open} actions={<CrmAction dot={open} hint={items.find((i) => i.dotNumber === open)} />} onOpenRelated={(d) => set({ dot: d })} />
            </div>
          ) : !q ? (
            <Card>
              <EmptyState icon={ShieldCheck} title="Check a carrier">
                Type a USDOT or MC number for an exact match, or a company name, phone or email to find it. Every check reads FMCSA's public records live: nothing is guessed.
              </EmptyState>
            </Card>
          ) : search.isLoading ? <Loading label="Searching FMCSA…" /> : search.isError ? (
            <ErrorState title="Search failed" error={search.error} onRetry={() => search.refetch()} />
          ) : !items.length ? (
            <Card><EmptyState icon={Search} title="No carrier found">No FMCSA census record matches that {KIND[search.data?.query?.kind] || 'search'}. Check the number, or try the company's legal name.</EmptyState></Card>
          ) : (
            <Card title={`${items.length}${items.length === 25 ? '+' : ''} carrier${items.length === 1 ? '' : 's'} matching that ${KIND[search.data.query.kind]}`} bodyClass="p-0">
              <ResultList items={items} onOpen={(d) => set({ dot: d })} />
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function ResultList({ items, onOpen }) {
  return (
    <ul className="divide-y divide-line">
      {items.map((r) => (
        <li key={r.dotNumber}>
          <button type="button" onClick={() => onOpen(r.dotNumber)} className="flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-ui hover:bg-surface-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="min-w-0">
              <span className="block font-medium">{r.companyName}{r.dbaName && <span className="font-normal text-muted"> · DBA {r.dbaName}</span>}</span>
              <span className="block font-mono text-xs tabular text-muted">USDOT {r.dotNumber}{r.mcNumber ? ` · MC ${r.mcNumber}` : ''}</span>
              <span className="block text-xs text-muted">{[[r.city, r.state].filter(Boolean).join(', '), r.fleetSize != null && `${num(r.fleetSize)} truck${r.fleetSize === 1 ? '' : 's'}`, r.registeredAt && `since ${date(r.registeredAt)}`].filter(Boolean).join(' · ')}</span>
            </span>
            <span className="flex shrink-0 flex-wrap items-center gap-1.5">
              {r.usdotStatus === 'inactive' && <Badge color="red">USDOT inactive</Badge>}
              <AuthorityBadge status={r.authorityStatus} detail={r.authority?.label} />
              {r.existsInCrm && <Badge color="green"><CheckCircle2 className="size-3" aria-hidden />In your list</Badge>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Header action on the profile: open the carrier in your list, or save it as a lead (authority re-checked on save). */
function CrmAction({ dot, hint }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const state = useQuery({
    queryKey: ['carrier-check', `USDOT ${dot}`],
    queryFn: ({ signal }) => api.get('/api/carrier-profile/search', { q: `USDOT ${dot}` }, { signal, timeoutMs: 60_000 }),
    enabled: !hint,
    staleTime: 60_000,
    retry: false,
  });
  const rec = hint || state.data?.items?.[0];
  if (!rec) return null;
  if (rec.existsInCrm && rec.existingId) return <Button size="sm" variant="secondary" to={`/app/carriers/${rec.existingId}`}>Open in my list</Button>;
  const save = async () => {
    setBusy(true);
    try {
      const res = await saveCensusLeads({ dots: [dot], confirm });
      const saved = (res.items || []).find((i) => i.dotNumber === dot && i.carrierId);
      if (saved) {
        toast.success(`${rec.companyName} saved to your list`);
        qc.invalidateQueries({ queryKey: ['carrier-check'] });
        qc.invalidateQueries({ queryKey: ['carriers'] });
      } else if (res.limited) toast.error('Your plan\'s carrier limit is reached.');
    } catch (err) {
      errorToast(toast, err);
    } finally {
      setBusy(false);
    }
  };
  return <Button size="sm" icon={UserPlus} loading={busy} onClick={save}>Save as lead</Button>;
}

function BulkCheck({ onOpen }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const numbers = text.split(/[\n,;\t]+/).map((x) => x.trim()).filter(Boolean);
  const run = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await api.post('/api/carrier-profile/bulk', { numbers: numbers.slice(0, 25) }, { timeoutMs: 90_000 }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const rows = (result?.results || []).map((x, i) => ({ ...x, id: `${x.input}-${i}` }));
  return (
    <div className="space-y-4">
      <Card title="Check many carriers at once">
        <form onSubmit={run} className="space-y-3">
          <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={'One per line: USDOT or MC numbers\n3636864\nMC 1248213'} aria-label="USDOT or MC numbers" />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" icon={ListChecks} loading={busy} disabled={!numbers.length}>Check {numbers.length ? Math.min(numbers.length, 25) : ''} carrier{numbers.length === 1 ? '' : 's'}</Button>
            <span className={cx('text-xs', numbers.length > 25 ? 'text-c-amber' : 'text-muted')}>{numbers.length > 25 ? `Only the first 25 of ${numbers.length} are checked.` : 'Up to 25 at a time. Authority and insurance are checked live.'}</span>
          </div>
        </form>
      </Card>
      {error && <ErrorState title="Bulk check failed" error={error} />}
      {result && (
        <Card bodyClass="p-0" title="Results">
          {result.authorityAnswered === false && <p className="border-b border-line px-4 py-2 text-xs text-c-amber">FMCSA licensing did not answer for some carriers: their authority shows as not verified. Run the check again in a few minutes.</p>}
          <DataTable rows={rows} dense
            columns={[
              { key: 'input', header: 'Entered', render: (r) => <span className="font-mono text-xs">{r.input}</span> },
              { key: 'carrier', header: 'Carrier', render: (r) => (r.carrier ? (
                <div className="min-w-44">
                  <div className="font-medium">{r.carrier.companyName}</div>
                  <div className="font-mono text-xs tabular text-muted">USDOT {r.carrier.dotNumber}{r.carrier.mcNumber ? ` · MC ${r.carrier.mcNumber}` : ''}</div>
                </div>
              ) : <span className="text-sm text-muted">{r.error}</span>) },
              { key: 'authority', header: 'Authority', render: (r) => (r.carrier ? <AuthorityBadge status={r.carrier.authorityStatus} detail={r.carrier.authority?.label} /> : null) },
              { key: 'insurance', header: 'Insurance', render: (r) => (!r.carrier ? null : r.carrier.authority?.insuranceOnFile === true ? <Badge color="green">On file</Badge> : r.carrier.authority?.insuranceOnFile === false ? <Badge color="red">None on file</Badge> : <span className="text-muted">—</span>) },
              { key: 'usdot', header: 'USDOT', render: (r) => (!r.carrier ? null : r.carrier.usdotStatus === 'inactive' ? <Badge color="red">Inactive</Badge> : r.carrier.usdotStatus === 'active' ? <Badge color="green">Active</Badge> : <span className="text-muted">—</span>) },
              { key: 'trucks', header: 'Trucks', className: 'text-right tabular', render: (r) => r.carrier?.fleetSize ?? '' },
              { key: 'mcs150', header: 'MCS-150', render: (r) => (r.carrier?.mcs150Date ? <span className="whitespace-nowrap text-[13px]">{date(r.carrier.mcs150Date)}</span> : '') },
              { key: 'open', header: <span className="sr-only">Open</span>, className: 'text-right', render: (r) => (r.carrier ? (
                <span className="flex items-center justify-end gap-1.5">
                  {r.carrier.existsInCrm && <Link to={`/app/carriers/${r.carrier.existingId}`} className="text-xs text-green-700 hover:underline dark:text-green-400">In your list</Link>}
                  <Button size="sm" variant="secondary" icon={ShieldCheck} onClick={() => onOpen(r.carrier.dotNumber)}>Check</Button>
                </span>
              ) : null) },
            ]} />
        </Card>
      )}
    </div>
  );
}
