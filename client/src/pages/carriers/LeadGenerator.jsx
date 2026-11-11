import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Crosshair, Eye, ListOrdered, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useToast } from '../../components/Toast.jsx';
import { US_STATES, dateTime, label, relative, phoneFmt } from '../../lib/format.js';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import EnrollModal from '../../components/carriers/EnrollModal.jsx';
import {
  Badge, Button, Card, Checkbox, DataTable, EmptyState, Field, Input, PageHeader, QueryState, Select, Switch, cx,
} from '../../components/ui.jsx';

const FLEET = ['', '1', '2', '3', '5', '10', '15', '25', '50', '100'];
const AGE = [['', 'Any'], ['1', '1 month'], ['3', '3 months'], ['6', '6 months'], ['12', '1 year'], ['24', '2 years'], ['36', '3 years'], ['60', '5 years']];
const BATCH = [10, 25, 50, 100, 200];
const SCORES = [[0, 'Any score'], [40, '40+'], [60, '60+ (contactable)'], [80, '80+ (best fit)']];
const STATUS = { ok: ['green', 'Completed'], limited: ['amber', 'Plan limit'], exhausted: ['gray', 'No more matches'], error: ['red', 'Failed'] };

const BLANK = {
  name: '', states: [], cargo: [], minPowerUnits: '1', maxPowerUnits: '10', authorityAgeMinMonths: '', authorityAgeMaxMonths: '24',
  requirePhone: true, requireEmail: false, requireMc: true, activeOnly: true,
  batchSize: 25, stageKey: 'lead', listId: '', newListName: '', sequenceId: '', minScore: 40, autoRun: false, frequency: 'daily',
};

const intOrNull = (v) => (v === '' || v == null ? null : Number(v));
const fleetText = (c) => (c.minPowerUnits == null && c.maxPowerUnits == null ? 'Any fleet size'
  : `${c.minPowerUnits ?? 0}–${c.maxPowerUnits ?? '∞'} trucks`);
const ageText = (c) => (c.authorityAgeMinMonths == null && c.authorityAgeMaxMonths == null ? 'Any authority age'
  : c.authorityAgeMaxMonths != null && c.authorityAgeMinMonths == null ? `Authority under ${c.authorityAgeMaxMonths} mo`
    : `Authority ${c.authorityAgeMinMonths ?? 0}–${c.authorityAgeMaxMonths ?? '∞'} mo`);

function Meter({ name, used, limit, calm }) {
  const unlimited = limit < 0;
  const ratio = unlimited || !limit ? 0 : Math.min(1, used / limit);
  return (
    <div className="min-w-0">
      <div className="flex justify-between gap-3 text-sm"><span className="text-fg-2">{name}</span>
        <span className="tabular text-muted">{used.toLocaleString('en-US')} / {unlimited ? '∞' : limit.toLocaleString('en-US')}</span></div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label={name} aria-valuenow={used} aria-valuemin={0} aria-valuemax={unlimited ? undefined : limit}>
        <div className={cx('h-full rounded-full', calm ? 'bg-fg-2/50' : ratio >= 0.9 ? 'bg-red-500' : ratio >= 0.7 ? 'bg-signal-500' : 'bg-brand-500')} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

function Chip({ on, children, ...props }) {
  return (
    <button type="button" aria-pressed={on} {...props}
      className={cx('rounded-md border px-2 py-1 text-xs transition-ui', on ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-surface text-fg-2 hover:bg-surface-2')}>
      {children}
    </button>
  );
}

function ScoreBadge({ score }) {
  return <Badge color={score >= 80 ? 'brand' : score >= 60 ? 'green' : 'gray'} className="tabular">{score}</Badge>;
}

function toForm(g) {
  if (!g) return BLANK;
  const c = g.criteria || {};
  const s = (v) => (v == null ? '' : String(v));
  return {
    name: g.name, states: c.states || [], cargo: c.cargo || [], minPowerUnits: s(c.minPowerUnits), maxPowerUnits: s(c.maxPowerUnits),
    authorityAgeMinMonths: s(c.authorityAgeMinMonths), authorityAgeMaxMonths: s(c.authorityAgeMaxMonths),
    requirePhone: !!c.requirePhone, requireEmail: !!c.requireEmail, requireMc: !!c.requireMc, activeOnly: c.activeOnly !== false,
    batchSize: g.batchSize, stageKey: g.stageKey, listId: g.listId || '', newListName: '', sequenceId: g.sequenceId || '', minScore: g.minScore, autoRun: g.autoRun, frequency: g.frequency,
  };
}

function criteriaOf(f) {
  return {
    states: f.states, cargo: f.cargo, minPowerUnits: intOrNull(f.minPowerUnits), maxPowerUnits: intOrNull(f.maxPowerUnits),
    authorityAgeMinMonths: intOrNull(f.authorityAgeMinMonths), authorityAgeMaxMonths: intOrNull(f.authorityAgeMaxMonths),
    requirePhone: f.requirePhone, requireEmail: f.requireEmail, requireMc: f.requireMc, activeOnly: f.activeOnly,
  };
}

function GeneratorEditor({ generator, cargoOptions, entitlements, onClose }) {
  const toast = useToast();
  const [f, setF] = useState(() => toForm(generator));
  const [preview, setPreview] = useState(null);
  const previewRef = useRef(null);
  useEffect(() => { if (preview) previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [preview]);
  const lists = useQuery({ queryKey: ['prospecting', 'lists'], queryFn: () => api.get('/api/prospecting/lists') });
  const sequences = useQuery({ queryKey: ['sequences'], queryFn: () => api.get('/api/sequences') });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));
  const toggle = (k, v) => setF((x) => ({ ...x, [k]: x[k].includes(v) ? x[k].filter((y) => y !== v) : [...x[k], v] }));

  const save = useApiMutation((body) => (generator ? api.patch(`/api/lead-generators/${generator.id}`, body) : api.post('/api/lead-generators', body)), {
    invalidate: [['lead-generators'], ['prospecting', 'lists'], ['billing']],
    success: generator ? 'Generator saved' : 'Generator created',
    onSuccess: onClose,
  });
  const runPreview = useApiMutation((body) => api.post('/api/lead-generators/preview', body), { onSuccess: setPreview });

  const valid = f.name.trim() && f.states.length;
  const submit = (e) => {
    e.preventDefault();
    if (!valid) { toast.error('Give it a name and pick at least one state'); return; }
    const listChoice = f.listId === '__new' ? { newListName: f.newListName.trim() || `${f.name.trim()} leads` } : { listId: f.listId || null };
    save.mutate({
      name: f.name.trim(), criteria: criteriaOf(f), batchSize: Number(f.batchSize), stageKey: f.stageKey, minScore: Number(f.minScore),
      autoRun: f.autoRun, frequency: f.frequency, sequenceId: f.sequenceId || null, ...listChoice,
    });
  };

  return (
    <Modal open onClose={onClose} size="xl" title={generator ? `Edit ${generator.name}` : 'New lead generator'}
      footer={<>
        <Button variant="secondary" icon={Eye} disabled={!f.states.length} loading={runPreview.isPending}
          onClick={() => runPreview.mutate({ criteria: criteriaOf(f), minScore: Number(f.minScore) })}>Preview matches</Button>
        <span className="flex-1" />
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" form="leadgen-form" loading={save.isPending} disabled={!valid}>{generator ? 'Save' : 'Create generator'}</Button>
      </>}>
      <form id="leadgen-form" onSubmit={submit} className="space-y-6">
        <Field label="Name" required><Input value={f.name} onChange={set('name')} placeholder="Texas small reefer fleets" maxLength={80} /></Field>

        <fieldset className="space-y-2">
          <legend className="text-[13px] font-medium">States <span className="font-normal text-muted">{f.states.length ? `${f.states.length} selected` : 'pick up to 15'}</span></legend>
          <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-9 md:grid-cols-13">
            {US_STATES.map((s) => <Chip key={s} on={f.states.includes(s)} disabled={!f.states.includes(s) && f.states.length >= 15} onClick={() => toggle('states', s)}>{s}</Chip>)}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-[13px] font-medium">Cargo hauled <span className="font-normal text-muted">{f.cargo.length ? 'matches any selected' : 'any cargo'}</span></legend>
          <div className="flex flex-wrap gap-1.5">
            {cargoOptions.map((o) => <Chip key={o.value} on={f.cargo.includes(o.value)} disabled={!f.cargo.includes(o.value) && f.cargo.length >= 12} onClick={() => toggle('cargo', o.value)}>{o.label}</Chip>)}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-4">
          <Field label="Fleet from"><Select value={f.minPowerUnits} onChange={set('minPowerUnits')}>{FLEET.map((v) => <option key={v} value={v}>{v ? `${v} truck${v === '1' ? '' : 's'}` : 'Any'}</option>)}</Select></Field>
          <Field label="Fleet up to"><Select value={f.maxPowerUnits} onChange={set('maxPowerUnits')}>{FLEET.map((v) => <option key={v} value={v}>{v ? `${v} truck${v === '1' ? '' : 's'}` : 'Any'}</option>)}</Select></Field>
          <Field label="Authority older than"><Select value={f.authorityAgeMinMonths} onChange={set('authorityAgeMinMonths')}>{AGE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          <Field label="Authority newer than"><Select value={f.authorityAgeMaxMonths} onChange={set('authorityAgeMaxMonths')}>{AGE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Checkbox label="Has a phone number" checked={f.requirePhone} onChange={set('requirePhone')} />
          <Checkbox label="Has an email" checked={f.requireEmail} onChange={set('requireEmail')} />
          <Checkbox label="Has MC authority" checked={f.requireMc} onChange={set('requireMc')} />
          <Checkbox label="USDOT active" checked={f.activeOnly} onChange={set('activeOnly')} />
        </div>

        <div className="grid gap-4 border-t border-line pt-5 sm:grid-cols-4">
          <Field label="Leads per run"><Select value={f.batchSize} onChange={set('batchSize')}>{BATCH.map((v) => <option key={v} value={v}>{v}</option>)}</Select></Field>
          <Field label="Minimum lead score" hint="Phone, email, MC, new authority, small fleet"><Select value={f.minScore} onChange={set('minScore')}>{SCORES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          <Field label="Pipeline stage"><Select value={f.stageKey} onChange={set('stageKey')}><option value="lead">Lead</option><option value="prospecting">Prospecting</option></Select></Field>
          <Field label="Add to prospect list">
            <Select value={f.listId} onChange={set('listId')}>
              <option value="">No list</option>
              {(lists.data?.items || []).map((l) => <option key={l.id} value={l.id}>{l.name} ({l.count})</option>)}
              <option value="__new">New list…</option>
            </Select>
          </Field>
          <Field label="Enroll in sequence" hint="New leads start the sequence right away">
            <Select value={f.sequenceId} onChange={set('sequenceId')}>
              <option value="">No sequence</option>
              {(sequences.data?.items || []).filter((x) => x.active || x.id === f.sequenceId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
          </Field>
          {f.listId === '__new' && <Field label="New list name" className="sm:col-span-2"><Input value={f.newListName} onChange={set('newListName')} placeholder={`${f.name || 'Generator'} leads`} maxLength={80} /></Field>}
        </div>

        <div className="flex flex-wrap items-center gap-4 rounded-lg border border-line bg-surface-2 px-4 py-3">
          <Switch checked={f.autoRun} disabled={!entitlements.autoRun} onChange={(v) => setF((x) => ({ ...x, autoRun: v }))} label="Run on a schedule" />
          {f.autoRun && <Select value={f.frequency} onChange={set('frequency')} className="w-32"><option value="daily">Daily</option><option value="weekly">Weekly</option></Select>}
          <span className="text-xs text-muted">
            {entitlements.autoRun ? 'New leads arrive automatically and you get a notification. Calls are never placed for you.'
              : <>Scheduled runs are part of paid plans. <Link to="/app/billing" className="text-brand-700 underline-offset-2 hover:underline dark:text-brand-300">See plans</Link></>}
          </span>
        </div>
      </form>

      {preview && (
        <div ref={previewRef} className="mt-6 scroll-mt-4 border-t border-line pt-5">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium">Preview · {preview.items.length} new match{preview.items.length === 1 ? '' : 'es'} on the first page</h3>
            <span className="text-xs text-muted">{preview.scanned} scanned · {preview.skipped} already in CRM · {preview.belowScore} below score · {preview.source}</span>
          </div>
          {preview.note && <p className="mb-2 text-xs text-muted">{preview.note}</p>}
          <DataTable dense rows={preview.items.map((r) => ({ ...r, id: r.dotNumber }))} empty={<p className="py-6 text-center text-sm text-muted">No new carriers match. Add states or loosen the filters.</p>}
            columns={[
              { key: 'score', header: 'Score', render: (r) => <span title={r.scoreReasons.join(', ')}><ScoreBadge score={r.score} /></span> },
              { key: 'companyName', header: 'Carrier', render: (r) => <div className="min-w-40"><div className="font-medium">{r.companyName}</div><div className="font-mono text-xs text-muted">USDOT {r.dotNumber}{r.mcNumber ? ` · MC ${r.mcNumber}` : ''}</div></div> },
              { key: 'state', header: 'Location', render: (r) => [r.city, r.state].filter(Boolean).join(', ') },
              { key: 'fleetSize', header: 'Trucks', render: (r) => <span className="tabular">{r.fleetSize ?? '—'}</span> },
              { key: 'phone', header: 'Phone', render: (r) => (r.phone ? phoneFmt(r.phone) : '—') },
            ]} />
        </div>
      )}
    </Modal>
  );
}

function RunResult({ result, onClose }) {
  const [color, text] = STATUS[result.run.status] || STATUS.ok;
  const [enrolling, setEnrolling] = useState(false);
  const ids = result.run.carrierIds || result.carriers.map((c) => c.id);
  // A generator linked to a sequence enrolls its leads itself; otherwise offer it here.
  const enrolledAlready = /Enrolled \d+ in "/.test(result.run.message || '');
  return (
    <Modal open onClose={onClose} size="lg" title={`${result.run.created} new lead${result.run.created === 1 ? '' : 's'}`}
      footer={<>
        {ids.length > 0 && !enrolledAlready && <Button variant="secondary" icon={ListOrdered} onClick={() => setEnrolling(true)}>Enroll these {ids.length} lead{ids.length === 1 ? '' : 's'}</Button>}
        {result.run.created > 0 && <Button variant="secondary" to="/app/prospecting">Open call queue</Button>}
        <Button onClick={onClose}>Done</Button>
      </>}>
      <EnrollModal open={enrolling} carrierIds={ids} onClose={() => setEnrolling(false)} />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Badge color={color}>{text}</Badge>
        <span className="text-muted">{result.run.scanned} census records scanned · {result.run.skipped} already in CRM · {result.run.belowScore} below score</span>
      </div>
      {result.run.message && <p className="mb-4 text-sm text-fg-2">{result.run.message}</p>}
      {result.carriers.length > 0 && (
        <DataTable dense rows={result.carriers} columns={[
          { key: 'companyName', header: 'Carrier', render: (c) => <Link to={`/app/carriers/${c.id}`} className="font-medium hover:underline">{c.companyName}</Link> },
          { key: 'dotNumber', header: 'USDOT', render: (c) => <span className="font-mono text-xs">{c.dotNumber}</span> },
          { key: 'state', header: 'Location', render: (c) => [c.city, c.state].filter(Boolean).join(', ') },
          { key: 'fleetSize', header: 'Trucks', render: (c) => <span className="tabular">{c.fleetSize ?? '—'}</span> },
          { key: 'priority', header: 'Priority', render: (c) => (c.priority >= 2 ? <Badge color="brand">Hot</Badge> : c.priority === 1 ? <Badge color="green">High</Badge> : <span className="text-muted">Normal</span>) },
        ]} />
      )}
    </Modal>
  );
}

function GeneratorCard({ g, cargoLabels, entitlements, onEdit, onRun, running }) {
  const confirm = useConfirm();
  const c = g.criteria;
  const toggleAuto = useApiMutation((autoRun) => api.patch(`/api/lead-generators/${g.id}`, { autoRun }), {
    invalidate: [['lead-generators']], success: (_, v) => (v ? 'Scheduled runs on' : 'Scheduled runs off'),
  });
  const del = useApiMutation(() => api.del(`/api/lead-generators/${g.id}`), { invalidate: [['lead-generators'], ['billing']], success: 'Generator deleted' });
  const last = g.lastRun;
  const [color, text] = last ? STATUS[last.status] || STATUS.ok : [];
  return (
    <Card className="flex flex-col" bodyClass="flex flex-1 flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-medium">{g.name}</h3>
          <p className="mt-0.5 text-[13px] text-fg-2">{c.states.join(', ')}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" size="sm" icon={Pencil} onClick={onEdit} aria-label={`Edit ${g.name}`} />
          <Button variant="ghost" size="sm" icon={Trash2} aria-label={`Delete ${g.name}`} loading={del.isPending}
            onClick={async () => { if (await confirm({ title: `Delete ${g.name}?`, message: 'Leads it already created stay in your CRM.', confirmLabel: 'Delete', danger: true })) del.mutate(); }} />
        </div>
      </div>
      <dl className="grid grid-cols-[80px_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        <dt className="text-muted">Fleet</dt><dd>{fleetText(c)}</dd>
        <dt className="text-muted">Authority</dt><dd>{ageText(c)}</dd>
        <dt className="text-muted">Cargo</dt><dd className="truncate" title={(c.cargo || []).map((k) => cargoLabels[k]).join(', ')}>{c.cargo?.length ? c.cargo.map((k) => cargoLabels[k] || k).join(', ') : 'Any'}</dd>
        <dt className="text-muted">Requires</dt><dd>{[c.requirePhone && 'phone', c.requireEmail && 'email', c.requireMc && 'MC'].filter(Boolean).join(', ') || 'Nothing'}</dd>
        <dt className="text-muted">Each run</dt><dd>{g.batchSize} leads · score {g.minScore}+ · {label(g.stageKey)}</dd>
        <dt className="text-muted">List</dt><dd className="truncate">{g.list?.name || 'None'}</dd>
        <dt className="text-muted">Sequence</dt><dd className="truncate">{g.sequence ? <Link to={`/app/sequences/${g.sequence.id}`} className="hover:underline">{g.sequence.name}</Link> : 'None'}</dd>
      </dl>
      <div className="mt-auto space-y-3 border-t border-line pt-4">
        <div className="flex items-center justify-between gap-3 text-[13px]">
          {last ? <span className="flex min-w-0 items-center gap-2"><Badge color={color}>{text}</Badge><span className="truncate text-muted">{last.created} added {relative(last.createdAt)}</span></span>
            : <span className="text-muted">Not run yet</span>}
          {g.autoRun && g.nextRunAt && <span className="shrink-0 text-xs text-muted" title={dateTime(g.nextRunAt)}>Next {relative(g.nextRunAt)}</span>}
        </div>
        <div className="flex items-center justify-between gap-3">
          <Switch checked={g.autoRun} disabled={!entitlements.autoRun || toggleAuto.isPending} onChange={(v) => toggleAuto.mutate(v)} label={<span className="text-[13px]">{g.autoRun ? `Runs ${g.frequency}` : 'Manual'}</span>} />
          <Button size="sm" icon={Play} loading={running} onClick={onRun}>Run now</Button>
        </div>
      </div>
    </Card>
  );
}

export default function LeadGenerator() {
  const [editing, setEditing] = useState(null); // null | 'new' | generator
  const [result, setResult] = useState(null);
  const [runningId, setRunningId] = useState(null);
  const q = useQuery({ queryKey: ['lead-generators'], queryFn: () => api.get('/api/lead-generators') });
  const runs = useQuery({ queryKey: ['lead-generators', 'runs'], queryFn: () => api.get('/api/lead-generators/runs') });
  const toast = useToast();
  const run = useApiMutation((id) => api.post(`/api/lead-generators/${id}/run`), {
    invalidate: [['lead-generators'], ['carriers'], ['pipeline'], ['prospecting'], ['billing']],
    onSuccess: (d) => { setRunningId(null); setResult(d); },
    onError: (e) => { setRunningId(null); toast.error(e); },
  });
  const start = (id) => { setRunningId(id); run.mutate(id); };

  const ent = q.data?.entitlements;
  const atLimit = ent && ent.maxGenerators >= 0 && ent.generators >= ent.maxGenerators;
  const cargoOptions = q.data?.cargoOptions || [];
  const cargoLabels = Object.fromEntries(cargoOptions.map((o) => [o.value, o.label]));

  return (
    <div>
      <PageHeader title="Lead generator"
        subtitle="Saved FMCSA Census searches that add fresh, scored carriers to your CRM and call queue"
        actions={<Button icon={Plus} disabled={!ent || atLimit} title={atLimit ? 'Your plan’s generator limit is reached' : undefined} onClick={() => setEditing('new')}>New generator</Button>} />

      <QueryState query={q}>
        {(d) => (
          <div className="space-y-6">
            <Card bodyClass="grid gap-5 p-5 sm:grid-cols-[1fr_1fr_auto] sm:items-center">
              <Meter name="Leads generated this month" used={d.entitlements.usedThisMonth} limit={d.entitlements.monthlyLimit} />
              <Meter calm name="Generator profiles" used={d.entitlements.generators} limit={d.entitlements.maxGenerators} />
              <div className="flex items-center gap-3 text-[13px] sm:justify-end">
                <span className="text-fg-2">{d.entitlements.planName} plan · scheduled runs {d.entitlements.autoRun ? 'included' : 'not included'}</span>
                {!d.entitlements.autoRun && <Button size="sm" variant="secondary" to="/app/billing">Upgrade</Button>}
              </div>
            </Card>

            {d.items.length === 0 ? (
              <Card>
                <EmptyState icon={Crosshair} title="No generators yet"
                  action={<Button icon={Plus} disabled={atLimit} onClick={() => setEditing('new')}>Create your first generator</Button>}>
                  Pick states, fleet size, authority age and cargo. Each run pulls carriers from the public FMCSA Census, skips anyone already in your CRM, scores them, and adds the best to your pipeline.
                </EmptyState>
              </Card>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {d.items.map((g) => (
                  <GeneratorCard key={g.id} g={g} cargoLabels={cargoLabels} entitlements={d.entitlements}
                    onEdit={() => setEditing(g)} onRun={() => start(g.id)} running={runningId === g.id} />
                ))}
              </div>
            )}

            <Card title="Run history">
              <QueryState query={runs}>
                {(r) => (
                  <DataTable dense rows={r.items} empty={<p className="py-6 text-center text-sm text-muted">Runs appear here after you run a generator.</p>}
                    columns={[
                      { key: 'createdAt', header: 'When', render: (x) => <span title={dateTime(x.createdAt)}>{relative(x.createdAt)}</span> },
                      { key: 'generatorName', header: 'Generator' },
                      { key: 'trigger', header: 'Trigger', render: (x) => <span className="text-muted">{x.trigger === 'scheduled' ? 'Scheduled' : 'Manual'}</span> },
                      { key: 'status', header: 'Status', render: (x) => { const [c, t] = STATUS[x.status] || STATUS.ok; return <Badge color={c}>{t}</Badge>; } },
                      { key: 'created', header: 'Added', render: (x) => <span className="tabular">{x.created}</span> },
                      { key: 'scanned', header: 'Scanned', render: (x) => <span className="tabular text-muted">{x.scanned}</span> },
                      { key: 'message', header: 'Note', render: (x) => <span className="block max-w-md truncate text-xs text-muted" title={x.message || ''}>{x.message || '—'}</span> },
                    ]} />
                )}
              </QueryState>
            </Card>
          </div>
        )}
      </QueryState>

      {editing && ent && (
        <GeneratorEditor generator={editing === 'new' ? null : editing} cargoOptions={cargoOptions} entitlements={ent} onClose={() => setEditing(null)} />
      )}
      {result && <RunResult result={result} onClose={() => setResult(null)} />}
    </div>
  );
}
