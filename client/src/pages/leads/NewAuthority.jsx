import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { BadgePlus, CheckCircle2, ClipboardCheck, Info, UserPlus, Users } from 'lucide-react';
import { api } from '../../lib/api.js';
import { errorToast } from '../../lib/hooks.js';
import { US_STATES, date, dateTime, label } from '../../lib/format.js';
import { Badge, Button, Card, Checkbox, DataTable, EmptyState, ErrorState, Field, IconButton, Loading, PageHeader, Select, cx } from '../../components/ui.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import SaveAndCall, { claimText } from '../../components/carriers/SaveAndCall.jsx';
import ReadinessReport from '../../components/carriers/ReadinessReport.jsx';
import { AuthorityBadge, useSequences } from '../../components/carriers/shared.jsx';
import { FmcsaProfileButton } from '../../components/carriers/FmcsaProfile.jsx';
import { EQUIPMENT_FROM_CARGO, WINDOWS, ageLabel, claimSummary, rowStatus } from './newAuthority.js';

const LIMIT = 50;
const STATE_KEY = 'dd:new-authority:state';
const savedState = () => { try { return localStorage.getItem(STATE_KEY) || ''; } catch { return ''; } };

/**
 * New-authority prospecting kit: carriers by how long ago they registered (FMCSA census), with a readiness report,
 * one-click add to the CRM (optionally into a sequence) and a guard against calling a carrier a teammate already has.
 */
export default function NewAuthority() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const sequences = useSequences();
  const [selected, setSelected] = useState(new Set());
  const [sequenceId, setSequenceId] = useState('');
  const [readiness, setReadiness] = useState(null);
  const [adding, setAdding] = useState(false);

  const state = params.get('state') || savedState();
  const win = WINDOWS.some((w) => w.key === params.get('window')) ? params.get('window') : 'new30';
  const cargo = params.get('cargo') || '';
  const equipment = EQUIPMENT_FROM_CARGO.includes(params.get('equipment')) ? params.get('equipment') : '';
  const hasEmail = params.get('email') === '1';
  const offset = Math.max(0, Number(params.get('offset')) || 0);
  const set = (patch) => {
    const next = new URLSearchParams(params);
    if (!next.get('state') && state) next.set('state', state);
    for (const [k, v] of Object.entries(patch)) (v === '' || v == null || v === false ? next.delete(k) : next.set(k, String(v)));
    if (!('offset' in patch)) next.delete('offset');
    if (patch.state) { try { localStorage.setItem(STATE_KEY, patch.state); } catch { /* storage unavailable */ } }
    setParams(next, { replace: true });
    setSelected(new Set());
  };

  const query = { state, window: win, cargo: cargo || undefined, equipment: !cargo && equipment ? equipment : undefined, hasEmail: String(hasEmail), offset, limit: LIMIT };
  const q = useQuery({
    queryKey: ['authority-kit', 'milestones', query],
    queryFn: ({ signal }) => api.get('/api/authority-kit/milestones', query, { signal }),
    enabled: /^[A-Z]{2}$/.test(state),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const items = (q.data?.items || []).map((r) => ({ ...r, id: r.dotNumber }));
  const selectable = new Set(items.filter((r) => !r.existsInCrm).map((r) => r.id));
  const active = (sequences.data?.items || []).filter((s) => s.active);

  const claim = async (dots) => {
    if (!dots.length || adding) return;
    setAdding(true);
    const body = { dotNumbers: dots, sequenceId: sequenceId || null };
    try {
      let res;
      try {
        res = await api.post('/api/authority-kit/claim', body);
      } catch (err) {
        if (err.status !== 409) throw err;
        const ok = await confirm({ title: 'Teammates already have this', message: `${err.message} Add to your list anyway?`, confirmLabel: 'Add anyway' });
        if (!ok) return;
        res = await api.post('/api/authority-kit/claim', { ...body, force: true });
      }
      toast.success(claimSummary(res));
      setSelected(new Set());
      await Promise.all([['authority-kit'], ['carriers'], ['pipeline'], ['queue'], ['sequences'], ['billing']].map((k) => qc.invalidateQueries({ queryKey: k })));
    } catch (err) {
      errorToast(toast, err);
    } finally {
      setAdding(false);
    }
  };

  const status = (r) => {
    const s = rowStatus(r);
    if (s === 'mine') return <Link to={`/app/carriers/${r.existingId}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-xs text-c-green hover:underline"><CheckCircle2 className="size-3.5" aria-hidden />In your list</Link>;
    if (s === 'team') return <span title={claimText(r.teamClaims)}><Badge color="amber"><Users className="size-3" aria-hidden />{r.teamClaims[0].ownerName}</Badge></span>;
    return <Badge color="blue">New</Badge>;
  };

  const columns = [
    { key: 'companyName', header: 'Carrier', render: (r) => (
      <div className="min-w-44 max-w-72">
        <div className="font-medium">{r.companyName}</div>
        <div className="text-xs text-muted tabular">DOT {r.dotNumber}{r.mcNumber && ` · MC ${r.mcNumber}`}{r.docketStatus && r.docketStatus !== 'active' ? ` · docket ${r.docketStatus}` : ''}</div>
        <div className="truncate text-xs text-muted" title={r.email || undefined}>{r.email || 'No email on file'}</div>
      </div>
    ) },
    { key: 'authorityDate', header: 'Registered', render: (r) => <span className="whitespace-nowrap text-[13px]"><span className="tabular">{date(r.authorityDate)}</span><span className="block text-xs text-muted">{ageLabel(r.ageDays)}</span></span> },
    // Pending authority is expected here (new carriers), so calling a pending carrier saves it without asking.
    { key: 'phone', header: 'Phone', render: (r) => <SaveAndCall record={r} allowInactive={r.authorityStatus === 'pending'} /> },
    // Operating authority from FMCSA licensing. Shown, never filtered: new carriers are often still pending.
    { key: 'authority', header: 'Authority', render: (r) => <AuthorityBadge status={r.authorityStatus} detail={r.authority?.label} /> },
    { key: 'loc', header: 'Location', render: (r) => <span className="text-[13px]">{[r.city, r.state].filter(Boolean).join(', ')}</span> },
    { key: 'fleetSize', header: 'Trucks', className: 'text-right tabular', render: (r) => r.fleetSize ?? '—' },
    { key: 'crm', header: 'Status', render: status },
    { key: 'actions', header: <span className="sr-only">Actions</span>, render: (r) => (
      <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        <FmcsaProfileButton dot={r.dotNumber} />
        <IconButton icon={ClipboardCheck} label={`Readiness report for ${r.companyName}`} onClick={() => setReadiness(r.dotNumber)} />
        {!r.existsInCrm && <IconButton icon={UserPlus} label={`Add ${r.companyName} to my list`} disabled={adding} onClick={() => claim([r.dotNumber])} className="disabled:opacity-50" />}
      </div>
    ) },
  ];

  return (
    <div>
      <PageHeader title="New authority" subtitle="Carriers by how long ago they registered with FMCSA. Reach them at the right time, check readiness, and avoid calling a carrier a teammate already works." />

      <Card className="mb-4" bodyClass="space-y-4 p-4">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Registration window">
          {WINDOWS.map((w) => (
            <button key={w.key} type="button" role="radio" aria-checked={win === w.key} onClick={() => set({ window: w.key })}
              className={cx('rounded-full border px-3 py-1 text-[13px] transition-ui', win === w.key ? 'border-brand-600 bg-brand-600 text-white' : 'border-line text-fg-2 hover:bg-surface-2')}>
              {w.label}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-[160px_minmax(0,240px)_auto] sm:items-end">
          <Field label="State" required>
            <Select value={state} onChange={(e) => set({ state: e.target.value })}>
              <option value="">Pick a state</option>
              {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
          <Field label="Equipment or cargo">
            <Select value={cargo || (equipment ? `eq:${equipment}` : '')}
              onChange={(e) => { const v = e.target.value; set(v.startsWith('eq:') ? { equipment: v.slice(3), cargo: '' } : { cargo: v, equipment: '' }); }}>
              <option value="">Any</option>
              <optgroup label="Equipment">
                {EQUIPMENT_FROM_CARGO.map((k) => <option key={k} value={`eq:${k}`}>{label(k)}</option>)}
              </optgroup>
              {(q.data?.cargoOptions || []).length > 0 && (
                <optgroup label="Cargo class">
                  {q.data.cargoOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </optgroup>
              )}
            </Select>
          </Field>
          <Checkbox label="Has an email on file" checked={hasEmail} onChange={(e) => set({ email: e.target.checked ? '1' : '' })} className="sm:mb-2" />
        </div>
      </Card>

      <Card bodyClass="p-0"
        title={<div className="min-w-0"><h2 className="truncate text-sm font-medium">{WINDOWS.find((w) => w.key === win)?.long}{state ? ` · ${state}` : ''}</h2>
          {q.data && <p className="text-xs text-muted">{q.data.source}, read {dateTime(q.data.retrievedAt)}{q.data.newestRecord ? ` · newest record in this state: ${date(q.data.newestRecord)}` : ''}</p>}</div>}
        actions={selected.size > 0 && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {active.length > 0 && (
              <Select aria-label="Add to sequence" value={sequenceId} onChange={(e) => setSequenceId(e.target.value)} className="h-8 w-48">
                <option value="">No sequence</option>
                {active.map((s) => <option key={s.id} value={s.id}>Add to {s.name}</option>)}
              </Select>
            )}
            <Button size="sm" icon={BadgePlus} loading={adding} onClick={() => claim([...selected])}>Add {selected.size} to my list</Button>
          </div>
        )}>
        {!/^[A-Z]{2}$/.test(state) ? (
          <EmptyState icon={BadgePlus} title="Pick a state">New registrations come from the public FMCSA census, one state at a time.</EmptyState>
        ) : q.isLoading ? <Loading label="Reading the FMCSA census…" /> : q.isError ? (
          <ErrorState error={q.error} onRetry={q.refetch} title="FMCSA census search failed" />
        ) : (
          <>
            {q.data.note && <p className="border-b border-line px-4 py-2 text-xs text-c-amber">{q.data.note}</p>}
            <DataTable dense columns={columns} rows={items} selected={selected}
              onSelect={(s) => setSelected(new Set([...s].filter((id) => selectable.has(id))))}
              mobileRow={(r, { selected: on, toggle }) => (
                <div className="space-y-1.5">
                  <div className="flex items-start gap-3">
                    {selectable.has(r.id) && <Checkbox aria-label={`Select ${r.companyName}`} checked={on} onChange={toggle} />}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2"><span className="truncate font-medium">{r.companyName}</span>{status(r)}</div>
                      <div className="text-xs text-muted tabular">DOT {r.dotNumber}{r.mcNumber && ` · MC ${r.mcNumber}`} · {ageLabel(r.ageDays)}</div>
                      <div className="mt-1"><AuthorityBadge status={r.authorityStatus} detail={r.authority?.label} /></div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pl-7 text-[13px]">
                    <SaveAndCall record={r} allowInactive={r.authorityStatus === 'pending'} />
                    <FmcsaProfileButton dot={r.dotNumber} variant="ghost" />
                    <Button size="sm" variant="ghost" icon={ClipboardCheck} onClick={() => setReadiness(r.dotNumber)}>Readiness</Button>
                    {!r.existsInCrm && <Button size="sm" variant="secondary" icon={UserPlus} disabled={adding} onClick={() => claim([r.dotNumber])}>Add</Button>}
                  </div>
                </div>
              )}
              empty={<EmptyState title="No carriers in this window">The census may not have records this recent yet{q.data.newestRecord ? ` (newest in ${state}: ${date(q.data.newestRecord)})` : ''}. Try a wider window or another state.</EmptyState>} />
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-xs text-muted">
              <span className="flex min-w-0 items-start gap-1.5"><Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />Registered is the USDOT add date in the FMCSA census; the MC grant can come later. Authority is from FMCSA licensing: active means active authority with insurance on file. Equipment is inferred from the census cargo classes. Calling an unsaved carrier saves it first so the call is logged.</span>
              <span className="flex items-center gap-2">
                <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => set({ offset: Math.max(0, offset - LIMIT) })}>Previous</Button>
                <span className="tabular">{items.length ? `${offset + 1}–${offset + items.length}` : '0'}</span>
                <Button size="sm" variant="secondary" disabled={!q.data.hasMore} onClick={() => set({ offset: offset + LIMIT })}>Next</Button>
              </span>
            </div>
          </>
        )}
      </Card>

      <ReadinessReport dot={readiness} open={!!readiness} onClose={() => setReadiness(null)} />
    </div>
  );
}
