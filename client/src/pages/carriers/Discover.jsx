import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Search, Save, Info, CheckCircle2, AlertTriangle, Play, Users } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { US_STATES, date, dateTime } from '../../lib/format.js';
import { Badge, Button, Card, Checkbox, DataTable, EmptyState, ErrorState, Field, Input, Loading, PageHeader, Select } from '../../components/ui.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { AuthorityBadge, equipmentLabel } from '../../components/carriers/shared.jsx';
import { FmcsaProfileButton } from '../../components/carriers/FmcsaProfile.jsx';
import SaveAndCall, { claimText } from '../../components/carriers/SaveAndCall.jsx';
import { saveCensusLeads } from '../../components/carriers/saveLeads.js';
import LeadFilters, { LEAD_FILTER_DEFAULTS, activeLeadFilters, leadFiltersToQuery } from '../../components/carriers/LeadFilters.jsx';
import { SignalChips, TierBadge } from '../../components/carriers/LeadScore.jsx';

const INITIAL = { state: '', city: '', name: '', dot: '', mc: '', minPowerUnits: '', maxPowerUnits: '', authorityAgeMinMonths: '', authorityAgeMaxMonths: '', activeOnly: true, hasMc: true, hasEmail: false, order: 'newest' };
const LIMIT = 50;
const HIDDEN_REASONS = [['sharedContact', 'shared contact'], ['unsafe', 'unsafe safety rating'], ['filtered', 'outside the filters']];
/** "2 shared contact, 1 outside the filters" from the search's hiddenReasons. */
const hiddenReasonText = (r) => HIDDEN_REASONS.filter(([k]) => r?.[k] > 0).map(([k, t]) => `${r[k]} ${t}`).join(', ');

export default function Discover() {
  const [params] = useSearchParams();
  const confirm = useConfirm();
  // ?state=XX (from the market map) pre-fills the state filter.
  const [form, setForm] = useState(() => ({ ...INITIAL, state: /^[A-Z]{2}$/.test(params.get('state') || '') ? params.get('state') : INITIAL.state }));
  const [lead, setLead] = useState(() => ({ ...LEAD_FILTER_DEFAULTS }));
  const [search, setSearch] = useState(null); // submitted params
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(new Set());
  const [lookup, setLookup] = useState('');
  const [sequenceId, setSequenceId] = useState('');
  const [enrolled, setEnrolled] = useState(null);
  const sequences = useQuery({ queryKey: ['sequences'], queryFn: () => api.get('/api/sequences') });
  const activeSequences = (sequences.data?.items || []).filter((s) => s.active);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const providers = useQuery({ queryKey: ['discovery', 'providers'], queryFn: () => api.get('/api/discovery/providers'), staleTime: 300000 });
  const filterOptions = useQuery({ queryKey: ['discovery', 'filter-options'], queryFn: () => api.get('/api/discovery/filter-options'), staleTime: 3600000 });
  // The signal cancels a search the user has already moved past (new filters, next page).
  const results = useQuery({
    queryKey: ['discovery', 'search', search, offset],
    queryFn: ({ signal }) => api.get('/api/discovery/search', { ...search, offset, limit: LIMIT }, { signal }),
    enabled: !!search,
    retry: false,
  });
  const look = useQuery({
    queryKey: ['discovery', 'lookup', lookup],
    queryFn: ({ signal }) => api.get('/api/discovery/lookup', /^\s*mc/i.test(lookup) ? { mc: lookup } : { dot: lookup }, { signal }),
    enabled: !!lookup,
    retry: false,
  });

  // The server re-checks operating authority; carriers without active authority need "Save anyway".
  const save = useApiMutation((dots) => saveCensusLeads({ dots, sequenceId, confirm }), {
    success: (d) => `Saved ${d.created} carrier${d.created === 1 ? '' : 's'}${d.sequence ? ` · ${d.enrolled} added to ${d.sequence.name}` : ''}${d.skipped ? ` · ${d.skipped} already in your list` : ''}${d.limited ? ` · ${d.limited} over plan limit` : ''}${d.notFound ? ` · ${d.notFound} not found` : ''}${d.inactiveAuthority ? ` · ${d.inactiveAuthority} not saved: authority not active` : ''}${d.unverified ? ` · ${d.unverified} not saved: authority not verified` : ''}`,
    invalidate: [['discovery', 'search'], ['discovery', 'lookup'], ['carriers'], ['pipeline'], ['sequences'], ['queue'], ['billing']],
    onSuccess: (d) => { setSelected(new Set()); if (d.sequence && d.enrolled) setEnrolled({ ...d.sequence, count: d.enrolled }); },
  });

  // Team collision guard: say so before saving carriers that teammates already work.
  const saveDots = async (dots) => {
    const claimed = rows.filter((r) => dots.includes(r.id) && r.teamClaims?.length);
    if (claimed.length) {
      const message = claimed.length === 1 ? `${claimText(claimed[0].teamClaims)} Save it to your list anyway?` : `${claimed.length} of these carriers are already with teammates. Save them to your list anyway?`;
      if (!(await confirm({ title: 'Teammates already have some of these', message, confirmLabel: 'Save anyway' }))) return;
    }
    save.mutate(dots);
  };

  const submit = (e) => {
    e.preventDefault();
    const p = { ...Object.fromEntries(Object.entries(form).map(([k, v]) => [k, typeof v === 'boolean' ? String(v) : v])), ...leadFiltersToQuery(lead) };
    setOffset(0);
    setSelected(new Set());
    setSearch(p);
  };

  const items = results.data?.items || [];
  const rows = items.map((r) => ({ ...r, id: r.dotNumber }));
  const selectable = new Set(rows.filter((r) => !r.existsInCrm).map((r) => r.id));
  const census = providers.data?.items.find((p) => p.id === 'fmcsa_census');
  const qc = providers.data?.items.find((p) => p.id === 'fmcsa_qc');

  // Already in your list (link to it), or a teammate has it (team collision guard).
  const crmStatus = (r) => (r.existsInCrm ? <Link to={`/app/carriers/${r.existingId}`} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-xs text-green-700 hover:underline dark:text-green-400"><CheckCircle2 className="size-3.5" />In your list</Link>
    : r.teamClaims?.length ? <span title={claimText(r.teamClaims)}><Badge color="amber"><Users className="size-3" aria-hidden />{r.teamClaims[0].ownerName}</Badge></span> : null);

  // Phones (below sm): one card per carrier with the call link and status on screen, instead of a 9-column table.
  const mobileRow = (r, { selected: on, toggle }) => (
    <div className="flex items-start gap-3">
      {r.existsInCrm ? <span className="size-4 shrink-0" aria-hidden /> : (
        <span onClick={(e) => e.stopPropagation()} className="pt-0.5"><Checkbox aria-label={`Select ${r.companyName}`} checked={on} onChange={toggle} /></span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 break-words font-medium">{r.companyName}</span>
          <span className="flex shrink-0 items-center gap-1"><TierBadge tier={r.tier} score={r.score} /><AuthorityBadge status={r.authorityStatus} detail={r.authority?.label} /><FmcsaProfileButton dot={r.dotNumber} label="Profile" variant="ghost" /></span>
        </div>
        <div className="mt-0.5 text-xs text-muted tabular">DOT {r.dotNumber}{r.mcNumber && ` · MC ${r.mcNumber}`}</div>
        <div className="text-xs text-muted">
          {[[r.city, r.state].filter(Boolean).join(', '), r.fleetSize != null && `${r.fleetSize} truck${r.fleetSize === 1 ? '' : 's'}`, r.authorityDate && `registered ${date(r.authorityDate)}`].filter(Boolean).join(' · ') || 'No location on file'}
        </div>
        {r.email && <div className="truncate text-xs text-muted">{r.email}</div>}
        <SignalChips signals={r.signals} max={4} className="mt-1.5" />
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
          <SaveAndCall record={r} />
          {crmStatus(r)}
        </div>
      </div>
    </div>
  );

  const columns = [
    { key: 'score', header: 'Lead', render: (r) => <span title={(r.scoreReasons || []).join(', ')}><TierBadge tier={r.tier} score={r.score} /></span> },
    { key: 'companyName', header: 'Carrier', render: (r) => (
      <div className="min-w-48">
        <div className="font-medium">{r.companyName}</div>
        {r.dbaName && <div className="text-xs text-muted">DBA {r.dbaName}</div>}
        <div className="text-xs text-muted tabular">DOT {r.dotNumber}{r.mcNumber && ` · MC ${r.mcNumber}`}</div>
        <SignalChips signals={r.signals} max={4} className="mt-1" />
      </div>
    ) },
    // Calling a lead that is not saved yet saves it first, so the call is logged on the record.
    { key: 'phone', header: 'Phone', render: (r) => <SaveAndCall record={r} /> },
    { key: 'email', header: 'Email', render: (r) => <span className="text-[13px]">{r.email || '—'}</span> },
    { key: 'loc', header: 'Location', render: (r) => <span className="whitespace-nowrap">{[r.city, r.state].filter(Boolean).join(', ')}</span> },
    { key: 'fleetSize', header: 'Trucks', className: 'text-right tabular', render: (r) => r.fleetSize ?? '—' },
    { key: 'equipment', header: 'Equipment*', render: (r) => <span className="text-[13px]">{equipmentLabel(r.equipment)}</span> },
    // Operating authority from FMCSA licensing (not the census USDOT status).
    { key: 'authorityStatus', header: 'Authority', render: (r) => <div className="flex flex-wrap items-center gap-1.5"><AuthorityBadge status={r.authorityStatus} detail={r.authority?.label} /><FmcsaProfileButton dot={r.dotNumber} label="Profile" variant="ghost" /></div> },
    { key: 'authorityDate', header: 'Registered', render: (r) => <span className="whitespace-nowrap text-[13px]">{date(r.authorityDate)}</span> },
    { key: 'crm', header: '', render: crmStatus },
  ];

  return (
    <div>
      <PageHeader title="Find carriers" subtitle="Search the public FMCSA Company Census for carriers you can call, then save them to your list." />

      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        {census && <Badge color="green">{census.label}: available</Badge>}
        {qc && <Badge color={qc.configured ? 'green' : 'gray'}>{qc.label}: {qc.configured ? 'configured' : 'not configured'}</Badge>}
        {census?.note && <span className="text-muted">{census.note}</span>}
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div className="space-y-4">
          <Card title="Search the census">
            <form onSubmit={submit} className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Field label="State"><Select value={form.state} onChange={set('state')}><option value="">Any</option>{US_STATES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
                <Field label="City"><Input value={form.city} onChange={set('city')} /></Field>
              </div>
              <Field label="Company name contains"><Input value={form.name} onChange={set('name')} /></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="USDOT"><Input inputMode="numeric" value={form.dot} onChange={set('dot')} /></Field>
                <Field label="MC"><Input value={form.mc} onChange={set('mc')} /></Field>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Trucks min"><Input type="number" min="0" value={form.minPowerUnits} onChange={set('minPowerUnits')} /></Field>
                <Field label="Trucks max"><Input type="number" min="0" value={form.maxPowerUnits} onChange={set('maxPowerUnits')} /></Field>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Registered ≥ months ago"><Input type="number" min="0" value={form.authorityAgeMinMonths} onChange={set('authorityAgeMinMonths')} /></Field>
                <Field label="Registered ≤ months ago"><Input type="number" min="0" value={form.authorityAgeMaxMonths} onChange={set('authorityAgeMaxMonths')} /></Field>
              </div>
              <Field label="Order"><Select value={form.order} onChange={set('order')}><option value="newest">Newest registrations first</option><option value="score">Best leads first (each page)</option><option value="dot">USDOT number</option></Select></Field>
              <div className="space-y-1.5">
                <Checkbox label="Active authority only" checked={form.activeOnly} onChange={set('activeOnly')} />
                <Checkbox label="Has MC number (for-hire)" checked={form.hasMc} onChange={set('hasMc')} />
                <Checkbox label="Has email on file" checked={form.hasEmail} onChange={set('hasEmail')} />
              </div>
              <div className="space-y-2">
                <p className="text-[13px] font-medium">Lead filters{activeLeadFilters(lead) > 0 && <span className="ml-1 font-normal text-muted">({activeLeadFilters(lead)} on)</span>}</p>
                <LeadFilters value={lead} onChange={setLead} idPrefix="disc"
                  equipmentOptions={filterOptions.data?.equipmentOptions} insurerSuggestions={filterOptions.data?.insurerSuggestions || []} />
              </div>
              <Button type="submit" icon={Search} className="w-full" loading={results.isFetching}>Find leads</Button>
            </form>
          </Card>

          <Card title="Quick lookup">
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setLookup(new FormData(e.currentTarget).get('q').trim()); }}>
              <Input name="q" aria-label="USDOT or MC number" placeholder="USDOT or MC-123456" />
              <Button type="submit" variant="secondary">Look up</Button>
            </form>
            {look.isFetching && <Loading label="Looking up…" className="py-4" />}
            {look.isError && <p className="mt-3 text-sm text-red-600">{look.error.message}</p>}
            {look.data && !look.data.record && <p className="mt-3 text-sm text-muted">No FMCSA record found.</p>}
            {look.data?.record && (
              <div className="mt-3 space-y-1 text-sm">
                <p className="font-medium">{look.data.record.companyName}</p>
                <p className="text-xs text-muted tabular">DOT {look.data.record.dotNumber}{look.data.record.mcNumber && ` · MC ${look.data.record.mcNumber}`}</p>
                <p><SaveAndCall record={look.data.record} /> · {[look.data.record.city, look.data.record.state].filter(Boolean).join(', ')}</p>
                {look.data.record.teamClaims?.length > 0 && <p className="text-xs text-c-amber">{claimText(look.data.record.teamClaims)}</p>}
                <p className="flex flex-wrap items-center gap-2"><AuthorityBadge status={look.data.record.authorityStatus} detail={look.data.record.authority?.label} /> {look.data.record.fleetSize ?? '?'} trucks</p>
                {look.data.record.operatingStatus && <p className="text-xs text-muted">{look.data.record.operatingStatus}</p>}
                <p className="text-xs text-muted">Source: {look.data.sources.join(' + ')} · retrieved {dateTime(look.data.retrievedAt)}</p>
                {look.data.record.existsInCrm
                  ? <Button size="sm" variant="secondary" to={`/app/carriers/${look.data.record.existingId}`}>Open in CRM</Button>
                  : <Button size="sm" icon={Save} loading={save.isPending} onClick={async () => {
                    const rec = look.data.record;
                    if (rec.teamClaims?.length && !(await confirm({ title: 'A teammate has this carrier', message: `${claimText(rec.teamClaims)} Save it to your list anyway?`, confirmLabel: 'Save anyway' }))) return;
                    save.mutate([rec.dotNumber]);
                  }}>Save to my list</Button>}
              </div>
            )}
          </Card>
        </div>

        <Card bodyClass="p-0" title={results.data ? `${results.data.source} — retrieved ${dateTime(results.data.retrievedAt)}` : 'Results'}
          actions={selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Select aria-label="Add to sequence" value={sequenceId} onChange={(e) => setSequenceId(e.target.value)} className="h-8 w-52">
                <option value="">Don't add to a sequence</option>
                {activeSequences.map((s) => <option key={s.id} value={s.id}>Add to {s.name}</option>)}
              </Select>
              <Button size="sm" icon={Save} loading={save.isPending} onClick={() => saveDots([...selected])}>
                {sequenceId ? `Save ${selected.size} and add to sequence` : `Save ${selected.size} to my list`}
              </Button>
            </div>
          )}>
          {enrolled && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface-2 px-5 py-3 text-sm">
              <span><span className="font-medium">{enrolled.count}</span> carrier{enrolled.count === 1 ? '' : 's'} added to <span className="font-medium">{enrolled.name}</span></span>
              <span className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setEnrolled(null)}>Dismiss</Button>
                <Button size="sm" icon={Play} to={`/app/dialer?sequenceId=${enrolled.id}`}>Start</Button>
              </span>
            </div>
          )}
          {!search ? (
            <EmptyState icon={Search} title="Search live FMCSA data">Pick a state (and optionally city, fleet size or registration age) to find carriers. Results come straight from the FMCSA census — nothing is pre-loaded or invented.</EmptyState>
          ) : results.isLoading ? <Loading label="Querying FMCSA…" /> : results.isError ? (
            <ErrorState error={results.error} onRetry={results.refetch} title="FMCSA search failed" />
          ) : (
            <>
              {results.data.note && <p className="flex items-center gap-1.5 border-b border-line px-4 py-2 text-xs text-amber-700"><AlertTriangle className="size-3.5" />{results.data.note}</p>}
              {results.data.authorityError && <p role="status" className="flex items-center gap-1.5 border-b border-line px-4 py-2 text-xs text-c-amber"><AlertTriangle className="size-3.5 shrink-0" aria-hidden />{results.data.authorityError}</p>}
              {results.data.hiddenInactive > 0 && (
                <p role="status" className="flex items-center gap-1.5 border-b border-line px-4 py-2 text-xs text-muted"><Info className="size-3.5 shrink-0" aria-hidden />
                  {results.data.hiddenInactive} carrier{results.data.hiddenInactive === 1 ? '' : 's'} hidden: authority not active. Untick “Active authority only” to see {results.data.hiddenInactive === 1 ? 'it' : 'them'}.</p>
              )}
              {results.data.hiddenByFilters > 0 && (
                <p role="status" className="flex items-center gap-1.5 border-b border-line px-4 py-2 text-xs text-muted"><Info className="size-3.5 shrink-0" aria-hidden />
                  {results.data.hiddenByFilters} hidden by filters{hiddenReasonText(results.data.hiddenReasons) ? ` (${hiddenReasonText(results.data.hiddenReasons)})` : ''}.</p>
              )}
              <DataTable dense columns={columns} rows={rows} selected={selected} mobileRow={mobileRow}
                onSelect={(s) => setSelected(new Set([...s].filter((id) => selectable.has(id))))}
                empty={<EmptyState title="No carriers match">Widen the filters — e.g. remove the city or fleet-size limits.</EmptyState>} />
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-xs text-muted">
                <span className="flex items-center gap-1.5"><Info className="size-3.5 shrink-0" />*Equipment is inferred from FMCSA cargo classes only where unambiguous (e.g. refrigerated food → reefer); otherwise blank. Authority comes from FMCSA licensing (L&amp;I and Motus): active means active operating authority with liability insurance on file.</span>
                <span className="flex items-center gap-2">
                  <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>Previous</Button>
                  <span className="tabular">{offset + 1}–{offset + items.length}</span>
                  <Button size="sm" variant="secondary" disabled={!results.data.hasMore} onClick={() => setOffset(offset + LIMIT)}>Next</Button>
                </span>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
