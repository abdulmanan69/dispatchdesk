import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Plus, Download, Filter, X, Truck, Upload, Radar } from 'lucide-react';
import { api, qs } from '../../lib/api.js';
import { errorToast, useApiMutation } from '../../lib/hooks.js';
import { EQUIPMENT, US_STATES, label, relative, PRESETS } from '../../lib/format.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Button, Card, Checkbox, ComboInput, DataTable, EmptyState, ErrorState, Field, Input, Loading, PageHeader, Pagination, RefreshError, Select } from '../../components/ui.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';
import CarrierForm from '../../components/carriers/CarrierForm.jsx';
import EnrollModal from '../../components/carriers/EnrollModal.jsx';
import BulkEmailModal from '../../components/carriers/BulkEmailModal.jsx';
import { SELECT_ALL_CAP, bulkFilter, bulkTarget, selectAllState } from '../../components/carriers/bulkSelection.js';
import { AUTHORITY_FILTERS, AuthorityBadge, PhoneLink, ResourceLinks, STAGES, StageBadge, TagList, authorityProblem, equipmentLabel, rememberCarrierNav, useAssignees, useProspectLists, useTags } from '../../components/carriers/shared.jsx';
import { TierBadge } from '../../components/carriers/LeadScore.jsx';

const FILTER_KEYS = ['q', 'state', 'equipment', 'fleetMin', 'fleetMax', 'authorityStatus', 'authorityAgeMinMonths', 'authorityAgeMaxMonths', 'stage', 'tagId', 'assignedTo', 'source', 'scope', 'noActivity', 'activityDays', 'leadTier'];
const TIERS = [['A', 'Tier A (75+)'], ['B', 'Tier B (55–74)'], ['C', 'Tier C (under 55)'], ['unscored', 'Not scored']];
const PAGE_SIZE = 25;

export default function CarrierList() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { user } = useAuth();
  const [showFilters, setShowFilters] = useState(false);
  const [creating, setCreating] = useState(() => params.get("new") === "1");
  const [selected, setSelected] = useState(new Set());
  const [allMatching, setAllMatching] = useState(false); // every carrier matching the filters, across pages
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [bulkValue, setBulkValue] = useState('');
  const [bulkAction, setBulkAction] = useState('');
  const [exporting, setExporting] = useState(false);
  const toast = useToast();

  const filters = useMemo(() => Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) || ''])), [params]);
  const page = Number(params.get('page') || 1);
  const sort = { field: params.get('sort') || 'createdAt', dir: params.get('dir') || 'desc' };
  const query = { ...filters, page, pageSize: PAGE_SIZE, sort: sort.field, dir: sort.dir };

  // The signal cancels the request for a search or page the user has already moved past.
  const list = useQuery({ queryKey: ['carriers', query], queryFn: ({ signal }) => api.get('/api/carriers', query, { signal }), placeholderData: keepPreviousData });
  const tags = useTags();
  const assignees = useAssignees();
  const lists = useProspectLists();
  const activeFilters = FILTER_KEYS.filter((k) => k !== 'q' && filters[k]).length;

  const clearSelection = () => { setSelected(new Set()); setAllMatching(false); setBulkAction(''); setBulkValue(''); };
  const update = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v === '' || v == null ? next.delete(k) : next.set(k, v));
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
    setSelected(new Set());
    setAllMatching(false);
  };

  const total = list.data?.total ?? 0;
  const pageRows = list.data?.items || [];
  const selectedCount = allMatching ? total : selected.size;
  const target = bulkTarget({ allMatching, ids: selected, filter: bulkFilter(filters, sort) });
  const banner = selectAllState({ selectedCount: selected.size, pageCount: pageRows.length, total, allMatching });

  const bulk = useApiMutation((body) => api.post('/api/carriers/bulk', body), {
    success: (d) => `Updated ${d.affected} carrier${d.affected === 1 ? '' : 's'}${d.inaccessible ? ` (${d.inaccessible} read-only skipped)` : ''}`,
    invalidate: [['carriers'], ['pipeline'], ['tags'], ['prospect-lists']],
    onSuccess: clearSelection,
  });
  const callList = useApiMutation((body) => api.post('/api/carriers/bulk', { ...body, action: 'call_list' }), {
    invalidate: [['prospect-lists']],
    success: (d) => `Call list “${d.list.name}” is ready with ${d.added} carrier${d.added === 1 ? '' : 's'}${d.noPhone + d.doNotCall + d.overLimit ? ` (${[d.noPhone && `${d.noPhone} without a phone`, d.doNotCall && `${d.doNotCall} do-not-call`, d.overLimit && `${d.overLimit} over the 200 limit`].filter(Boolean).join(', ')} left out)` : ''}`,
    onSuccess: (d) => { clearSelection(); navigate(`/app/dialer?listId=${encodeURIComponent(d.list.id)}`); },
  });

  const runBulk = async () => {
    if (bulkAction === 'enroll_sequence') return setEnrollOpen(true);
    if (bulkAction === 'email') return setEmailOpen(true);
    if (bulkAction === 'call_list') return callList.mutate(target);
    if (bulkAction === 'delete' && !(await confirm({ title: `Delete ${selectedCount.toLocaleString('en-US')} carrier${selectedCount === 1 ? '' : 's'}?`, message: 'This permanently removes the carriers with their notes, calls, follow-ups and documents.', danger: true }))) return;
    let value = bulkValue;
    if (bulkAction === 'set_do_not_call' || bulkAction === 'set_do_not_email') value = bulkValue !== 'false';
    bulk.mutate({ action: bulkAction, ...target, value });
  };

  // Same filters and order as the list on screen. One export runs per account at a time: a second one gets a 409,
  // shown as a toast like any other failure.
  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await api.download(`/api/carriers/export.csv${qs({ ...filters, sort: sort.field, dir: sort.dir })}`, 'carriers.csv');
    } catch (err) {
      errorToast(toast, err);
    } finally {
      setExporting(false);
    }
  };
  const openCarrier = (c) => { rememberCarrierNav(pageRows.map((x) => x.id), `${window.location.pathname}${window.location.search}`); navigate(`/app/carriers/${c.id}`); };

  const columns = [
    { key: 'companyName', header: 'Carrier', sortable: true, render: (c) => (
      <div className="min-w-48">
        <div className="font-medium">{c.companyName}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted tabular">
          {c.dotNumber && <span>DOT {c.dotNumber}</span>}{c.mcNumber && <span>MC {c.mcNumber}</span>}
          {c.priority > 0 && <span className="font-medium text-signal-600">{c.priority === 2 ? 'Hot' : 'High'}</span>}
        </div>
        <TagList tags={c.tags} className="mt-1" />
      </div>
    ) },
    // Lead score v2 (lead generator and Find carriers); carriers without one sort last.
    { key: 'leadScore', header: 'Lead score', sortable: true, render: (c) => <TierBadge tier={c.leadTier} score={c.leadScore} /> },
    { key: 'phone', header: 'Phone', render: (c) => (c.doNotCall ? <span className="whitespace-nowrap text-xs text-red-600">Do not call</span> : <PhoneLink phone={c.phone} carrierId={c.id} className="whitespace-nowrap" />) },
    { key: 'state', header: 'Location', sortable: true, render: (c) => <span className="whitespace-nowrap">{[c.city, c.state].filter(Boolean).join(', ') || '—'}</span> },
    { key: 'equipment', header: 'Equipment', render: (c) => <span className="text-[13px]">{equipmentLabel(c.equipment)}</span> },
    { key: 'fleetSize', header: 'Trucks', sortable: true, className: 'text-right tabular', render: (c) => c.fleetSize ?? '—' },
    { key: 'authorityStatus', header: 'Authority', render: (c) => <AuthorityBadge status={c.authorityStatus} detail={c.operatingStatus} /> },
    { key: 'stage', header: 'Stage', render: (c) => <StageBadge stage={c.stage} /> },
    { key: 'lastCallAt', header: 'Last call', render: (c) => <span className="whitespace-nowrap text-[13px] text-muted">{c.lastCallAt ? relative(c.lastCallAt) : 'Never called'}</span> },
    { key: 'lastContactedAt', header: 'Last activity', sortable: true, render: (c) => <span className="whitespace-nowrap text-[13px] text-muted">{c.lastActivityAt ? relative(c.lastActivityAt) : 'No activity'}</span> },
    { key: 'resources', header: 'Resources', render: (c) => <ResourceLinks carrier={c} compact /> },
  ];
  if (filters.scope === 'team') columns.push({ key: 'owner', header: 'Owner', render: (c) => c.owner?.name });

  const needsValue = { move_stage: true, add_tag: true, remove_tag: true, add_to_list: true };
  const pending = bulk.isPending || callList.isPending;

  return (
    <div>
      <PageHeader title="Carrier list" subtitle="Every carrier in your pipeline. Search by name, MC, USDOT or phone."
        actions={<>
          <Button variant="secondary" icon={Download} loading={exporting} onClick={exportCsv}>Export CSV</Button>
          <Button variant="secondary" icon={Upload} to="/app/import">Import</Button>
          <Button icon={Plus} onClick={() => setCreating(true)}>Add carrier</Button>
        </>} />

      <Card bodyClass="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <Input aria-label="Search carriers" placeholder="Search name, MC, DOT or phone" defaultValue={filters.q} key={filters.q}
            onKeyDown={(e) => { if (e.key === 'Enter') update({ q: e.currentTarget.value.trim() }); }} onBlur={(e) => e.target.value.trim() !== filters.q && update({ q: e.target.value.trim() })} className="max-w-sm" />
          <Select aria-label="Stage" value={filters.stage} onChange={(e) => update({ stage: e.target.value })} className="w-40">
            <option value="">All stages</option>{STAGES.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
          </Select>
          <Select aria-label="No activity" value={filters.noActivity || 'any'} onChange={(e) => update({ noActivity: e.target.value === 'any' ? '' : e.target.value })} className="w-52">
            <option value="any">Any activity</option>
            <option value="no_call">No call</option>
            <option value="no_email">No email</option>
            <option value="none">No call, email or text</option>
          </Select>
          {/* Operating authority (FMCSA licensing): pick "Authority inactive", select all, then delete or archive. */}
          <Select aria-label="Authority" value={filters.authorityStatus} onChange={(e) => update({ authorityStatus: e.target.value })} className="w-44">
            <option value="">Any authority</option>{AUTHORITY_FILTERS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </Select>
          {filters.noActivity && (
            <Input aria-label="In the last N days" type="number" min="1" max="3650" placeholder="Days" defaultValue={filters.activityDays} key={`d${filters.activityDays}`}
              title="Only count activity in the last N days (empty = ever)"
              onKeyDown={(e) => { if (e.key === 'Enter') update({ activityDays: e.currentTarget.value }); }} onBlur={(e) => e.target.value !== filters.activityDays && update({ activityDays: e.target.value })} className="w-24" />
          )}
          <Select aria-label="Lead tier" value={filters.leadTier} onChange={(e) => update({ leadTier: e.target.value })} className="w-40">
            <option value="">Any lead tier</option>{TIERS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </Select>
          <Button variant="secondary" icon={Filter} onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}>
            Filters{activeFilters ? ` (${activeFilters})` : ''}
          </Button>
          {user?.team && (
            <Select aria-label="Scope" value={filters.scope || 'mine'} onChange={(e) => update({ scope: e.target.value === 'mine' ? '' : e.target.value })} className="w-36">
              <option value="mine">My carriers</option><option value="team">Team</option>
            </Select>
          )}
          {(activeFilters > 0 || filters.q) && <Button variant="ghost" icon={X} onClick={() => setParams({}, { replace: true })}>Clear</Button>}
        </div>

        {showFilters && (
          <div className="grid gap-3 border-b border-line bg-surface-2/40 p-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="State"><Select value={filters.state} onChange={(e) => update({ state: e.target.value })}><option value="">Any</option>{US_STATES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
            <Field label="Equipment"><Select value={filters.equipment} onChange={(e) => update({ equipment: e.target.value })}><option value="">Any</option>{EQUIPMENT.map((e) => <option key={e} value={e}>{label(e)}</option>)}</Select></Field>
            <Field label="Tag"><Select value={filters.tagId} onChange={(e) => update({ tagId: e.target.value })}><option value="">Any</option>{tags.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Trucks min"><Input type="number" min="0" defaultValue={filters.fleetMin} onBlur={(e) => update({ fleetMin: e.target.value })} /></Field>
              <Field label="Trucks max"><Input type="number" min="0" defaultValue={filters.fleetMax} onBlur={(e) => update({ fleetMax: e.target.value })} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Authority age ≥ (mo)"><Input type="number" min="0" defaultValue={filters.authorityAgeMinMonths} onBlur={(e) => update({ authorityAgeMinMonths: e.target.value })} /></Field>
              <Field label="Authority age ≤ (mo)"><Input type="number" min="0" defaultValue={filters.authorityAgeMaxMonths} onBlur={(e) => update({ authorityAgeMaxMonths: e.target.value })} /></Field>
            </div>
            <Field label="Assigned to">
              <Select value={filters.assignedTo} onChange={(e) => update({ assignedTo: e.target.value })}>
                <option value="">Anyone</option><option value="me">Me</option><option value="unassigned">Unassigned</option>
                {assignees.data?.items.filter((u) => u.id !== user.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </Select>
            </Field>
            <Field label="Source">
              <Select value={filters.source} onChange={(e) => update({ source: e.target.value })}>
                <option value="">Any</option><option value="manual">Manual</option><option value="csv">CSV import</option><option value="fmcsa_census">FMCSA Census</option><option value="lead_generator">Lead generator</option>
              </Select>
            </Field>
          </div>
        )}

        {selectedCount > 0 && (
          <div className="border-b border-line bg-brand-50/60 text-sm dark:bg-brand-900/20" role="region" aria-label="Bulk actions">
            {(banner === 'offer' || banner === 'tooMany' || banner === 'all') && (
              <p className="border-b border-line/70 px-3 py-2 text-[13px] text-fg-2" role="status">
                {banner === 'all' && <>All <span className="font-medium text-fg">{total.toLocaleString('en-US')}</span> carriers matching these filters are selected. <button type="button" className="font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={clearSelection}>Clear selection</button></>}
                {banner === 'offer' && <>All {pageRows.length} on this page are selected. <button type="button" className="font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => setAllMatching(true)}>Select all {total.toLocaleString('en-US')} matching carriers</button></>}
                {banner === 'tooMany' && <>All {pageRows.length} on this page are selected. {total.toLocaleString('en-US')} carriers match; narrow the filters to {SELECT_ALL_CAP.toLocaleString('en-US')} or fewer to select them all.</>}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 p-3">
              <span className="font-medium">{selectedCount.toLocaleString('en-US')} selected</span>
              <Select aria-label="Bulk action" value={bulkAction} onChange={(e) => { setBulkAction(e.target.value); setBulkValue(''); }} className="w-52">
                <option value="">Choose action…</option>
                <option value="email">Email with a template</option>
                <option value="call_list">Call in the power dialer</option>
                <option value="move_stage">Move to stage</option>
                <option value="add_tag">Add tag</option>
                <option value="remove_tag">Remove tag</option>
                <option value="add_to_list">Add to prospect list</option>
                <option value="enroll_sequence">Enroll in sequence</option>
                <option value="assign">Assign to</option>
                <option value="set_do_not_call">Set do-not-call</option>
                <option value="set_do_not_email">Set do-not-email</option>
                <option value="delete">Delete</option>
              </Select>
              {bulkAction === 'move_stage' && <Select aria-label="Stage" value={bulkValue} onChange={(e) => setBulkValue(e.target.value)} className="w-40"><option value="">Stage…</option>{STAGES.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}</Select>}
              {bulkAction === 'add_tag' && <ComboInput aria-label="Tag name" placeholder="Tag name" value={bulkValue} onChange={(e) => setBulkValue(e.target.value)} className="w-44" options={[...new Set([...(tags.data?.items || []).map((t) => t.name), ...PRESETS.tagNames])]} />}
              {bulkAction === 'remove_tag' && <Select aria-label="Tag" value={bulkValue} onChange={(e) => setBulkValue(e.target.value)} className="w-40"><option value="">Tag…</option>{tags.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>}
              {bulkAction === 'add_to_list' && <Select aria-label="List" value={bulkValue} onChange={(e) => setBulkValue(e.target.value)} className="w-44"><option value="">List…</option>{lists.data?.items.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}
              {bulkAction === 'assign' && <Select aria-label="Assignee" value={bulkValue} onChange={(e) => setBulkValue(e.target.value)} className="w-44"><option value="">Unassigned</option>{assignees.data?.items.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>}
              {(bulkAction === 'set_do_not_call' || bulkAction === 'set_do_not_email') && <Select aria-label="Value" value={bulkValue || 'true'} onChange={(e) => setBulkValue(e.target.value)} className="w-28"><option value="true">On</option><option value="false">Off</option></Select>}
              {bulkAction === 'call_list' && <span className="text-xs text-muted">Makes a call list of up to 200 carriers with a phone number. Every call still starts from your click.</span>}
              <Button size="sm" disabled={!bulkAction || (needsValue[bulkAction] && !bulkValue)} loading={pending} onClick={runBulk} variant={bulkAction === 'delete' ? 'danger' : 'primary'}>
                {bulkAction === 'email' ? 'Write email' : bulkAction === 'call_list' ? 'Open dialer' : 'Apply'}
              </Button>
              <Button size="sm" variant="ghost" onClick={clearSelection}>Clear selection</Button>
            </div>
          </div>
        )}

        {/* A failed refresh (after a bulk action) keeps the loaded page on screen with a notice instead of an error page. */}
        {list.isLoading ? <Loading /> : list.isError && !list.data ? <ErrorState error={list.error} onRetry={list.refetch} /> : (
          <>
            <RefreshError query={list} className="m-3" />
            <DataTable columns={columns} rows={pageRows} selected={selected} onSelect={(s) => { setAllMatching(false); setSelected(s); }} sort={sort}
              onSort={(s) => update({ sort: s.field, dir: s.dir })} onRowClick={openCarrier}
              mobileRow={(c, { selected: on, toggle }) => (
                <div className="flex items-start gap-3">
                  <span onClick={(e) => e.stopPropagation()} className="pt-0.5"><Checkbox aria-label={`Select ${c.companyName}`} checked={on} onChange={() => { setAllMatching(false); toggle(); }} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <span className="truncate font-medium">{c.companyName}</span>
                      <span className="flex shrink-0 items-center gap-1">{c.leadTier && <TierBadge tier={c.leadTier} score={c.leadScore} />}<StageBadge stage={c.stage} /></span>
                    </div>
                    {authorityProblem(c.authorityStatus) && <div className="mt-1"><AuthorityBadge status={c.authorityStatus} detail={c.operatingStatus} /></div>}
                    <div className="mt-0.5 text-xs text-muted">{[c.city, c.state].filter(Boolean).join(', ') || 'No location'}{c.dotNumber ? ` · DOT ${c.dotNumber}` : ''}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[13px]" onClick={(e) => e.stopPropagation()}>
                      {c.doNotCall ? <span className="text-xs text-red-600">Do not call</span> : <PhoneLink phone={c.phone} carrierId={c.id} />}
                      <span className="text-xs text-muted">{c.lastCallAt ? `Called ${relative(c.lastCallAt)}` : 'Never called'}</span>
                    </div>
                  </div>
                </div>
              )}
              empty={(
                <EmptyState icon={Truck} title={filters.q || activeFilters ? 'No carriers match these filters' : 'No carriers yet'}
                  action={!filters.q && !activeFilters && <div className="flex flex-wrap justify-center gap-2"><Button icon={Radar} to="/app/discover">Find carriers</Button><Button variant="secondary" icon={Upload} to="/app/import">Import CSV</Button><Button variant="secondary" icon={Plus} onClick={() => setCreating(true)}>Add manually</Button></div>}>
                  {filters.q || activeFilters ? 'Try removing a filter.' : 'Find carriers in the FMCSA census, import a CSV, or add one by hand.'}
                </EmptyState>
              )} />
            <div className="border-t border-line px-3"><Pagination page={list.data.page} pages={list.data.pages} total={list.data.total} onPage={(p) => update({ page: String(p) })} /></div>
          </>
        )}
      </Card>

      {creating && <CarrierForm open onClose={() => setCreating(false)} onSaved={(c) => navigate(`/app/carriers/${c.id}`)} />}
      <EnrollModal open={enrollOpen} onClose={() => setEnrollOpen(false)} carrierIds={allMatching ? [] : [...selected]} filter={allMatching ? target.filter : undefined} count={selectedCount} onDone={clearSelection} />
      <BulkEmailModal open={emailOpen} onClose={() => setEmailOpen(false)} target={target} count={selectedCount} onDone={clearSelection} />
    </div>
  );
}
