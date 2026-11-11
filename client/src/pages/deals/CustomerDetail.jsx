import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Phone, Mail, Plus, Trash2, Pencil, CheckCircle2, AlertTriangle, XCircle, ExternalLink, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { date, dateTime, dollars, label, money, num, phoneFmt } from '../../lib/format.js';
import { Badge, Button, Card, Checkbox, DataTable, EmptyState, Field, IconButton, Input, PageHeader, QueryState, Select, StatCard, Tabs, Textarea, ComboInput } from '../../components/ui.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import DocumentsPanel, { documentRequestBody } from '../../components/documents/DocumentsPanel.jsx';
import LoadFormModal from '../../components/dispatch/LoadForm.jsx';
import ComposeModal from '../../components/email/ComposeModal.jsx';
import StatementsPanel from '../../components/deals/StatementsPanel.jsx';
import { rulesSummary } from '../../components/dispatch/fit.js';
import { loadColumns, loadMobileRow } from '../dispatch/Loads.jsx';
import { CUSTOMER_COLOR, FmcsaBadge } from './Customers.jsx';

const CHECK = {
  on_file: { icon: CheckCircle2, cls: 'text-c-green', text: 'On file' },
  expiring: { icon: AlertTriangle, cls: 'text-c-amber', text: 'Expiring soon' },
  expired: { icon: XCircle, cls: 'text-c-red', text: 'Expired' },
  missing: { icon: XCircle, cls: 'text-muted', text: 'Missing' },
};
const DOC_NAME = { agreement: 'Dispatch agreement', mc_authority: 'MC authority', w9: 'W-9', coi: 'Certificate of insurance' };
const HOME_PRESETS = ['Sat,Sun', 'Sun', 'Fri,Sat,Sun', 'Sat'];

const s = (v) => (v == null ? '' : String(v));
const blank = (v) => (v === '' ? null : v);

/** Rates, terms and the carrier rules the load check uses. */
function TermsForm({ customer }) {
  const [f, setF] = useState({});
  useEffect(() => {
    setF({
      status: customer.status, dispatchFeePercent: s(customer.dispatchFeePercent), minRatePerMile: s(customer.minRatePerMile),
      maxDeadheadMiles: s(customer.maxDeadheadMiles), homeBase: customer.homeBase || '', notes: customer.notes || '',
      maxWeightLbs: s(customer.maxWeightLbs), trailerLengthFt: s(customer.trailerLengthFt), hazmat: !!customer.hazmat, twic: !!customer.twic, teamDrivers: !!customer.teamDrivers,
      avoidStates: customer.avoidStates || '', homeTimeDays: customer.homeTimeDays || '', costPerMile: customer.costPerMileCents != null ? String(customer.costPerMileCents / 100) : '',
      minHaulMiles: s(customer.minHaulMiles), maxHaulMiles: s(customer.maxHaulMiles),
    });
  }, [customer]);
  const save = useApiMutation((body) => api.patch(`/api/customers/${customer.id}`, body), { success: 'Customer updated', invalidate: [['customer', customer.id], ['customers'], ['customer-rules']] });
  const on = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = (e) => {
    e.preventDefault();
    const { costPerMile, ...rest } = f;
    save.mutate({
      ...rest,
      dispatchFeePercent: blank(f.dispatchFeePercent), minRatePerMile: blank(f.minRatePerMile), maxDeadheadMiles: blank(f.maxDeadheadMiles),
      maxWeightLbs: blank(f.maxWeightLbs), trailerLengthFt: blank(f.trailerLengthFt), avoidStates: blank(f.avoidStates), homeTimeDays: blank(f.homeTimeDays),
      costPerMileCents: costPerMile === '' ? null : Math.round(Number(costPerMile) * 100), minHaulMiles: blank(f.minHaulMiles), maxHaulMiles: blank(f.maxHaulMiles),
    });
  };
  return (
    <form className="space-y-4" onSubmit={submit}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Status">
          <Select value={f.status || 'active'} onChange={on('status')}>{['active', 'paused', 'churned'].map((x) => <option key={x} value={x}>{label(x)}</option>)}</Select>
        </Field>
        <Field label="Dispatch fee (%)"><Input type="number" min="0" max="100" step="0.1" value={f.dispatchFeePercent ?? ''} onChange={on('dispatchFeePercent')} /></Field>
        <Field label="Home base" className="sm:col-span-2"><Input value={f.homeBase || ''} onChange={on('homeBase')} placeholder="e.g. Dallas, TX" maxLength={200} /></Field>
      </div>
      <fieldset className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-2">
        <legend className="px-1 text-xs font-medium text-muted">Carrier rules (checked on every load, never blocking)</legend>
        <Field label="Minimum rate per loaded mile ($)"><Input type="number" min="0" step="0.01" value={f.minRatePerMile ?? ''} onChange={on('minRatePerMile')} /></Field>
        <Field label="Cost per mile ($)" hint="Truck’s all-in cost, used for the walk-away rate incl. deadhead"><Input type="number" min="0" step="0.01" value={f.costPerMile ?? ''} onChange={on('costPerMile')} /></Field>
        <Field label="Max deadhead (miles)"><Input type="number" min="0" step="1" value={f.maxDeadheadMiles ?? ''} onChange={on('maxDeadheadMiles')} /></Field>
        <Field label="Max weight (lbs)"><Input type="number" min="0" step="100" value={f.maxWeightLbs ?? ''} onChange={on('maxWeightLbs')} /></Field>
        <Field label="Trailer length (ft)"><ComboInput options={['53', '48', '45', '40', '28']} type="number" min="0" max="60" value={f.trailerLengthFt ?? ''} onChange={on('trailerLengthFt')} /></Field>
        <Field label="Avoid states" hint="Comma separated, e.g. NY, NJ"><Input value={f.avoidStates || ''} onChange={(e) => setF({ ...f, avoidStates: e.target.value.toUpperCase() })} maxLength={160} /></Field>
        <Field label="Home time days" hint="Days the truck is home, e.g. Sat, Sun"><ComboInput options={HOME_PRESETS} value={f.homeTimeDays || ''} onChange={on('homeTimeDays')} maxLength={40} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Min haul (mi)"><Input type="number" min="0" step="1" value={f.minHaulMiles ?? ''} onChange={on('minHaulMiles')} /></Field>
          <Field label="Max haul (mi)"><Input type="number" min="0" step="1" value={f.maxHaulMiles ?? ''} onChange={on('maxHaulMiles')} /></Field>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 sm:col-span-2">
          <Checkbox label="Hazmat" checked={!!f.hazmat} onChange={(e) => setF({ ...f, hazmat: e.target.checked })} />
          <Checkbox label="TWIC card" checked={!!f.twic} onChange={(e) => setF({ ...f, twic: e.target.checked })} />
          <Checkbox label="Team drivers" checked={!!f.teamDrivers} onChange={(e) => setF({ ...f, teamDrivers: e.target.checked })} />
        </div>
      </fieldset>
      <Field label="Notes"><Textarea rows={3} value={f.notes || ''} onChange={on('notes')} maxLength={5000} /></Field>
      <Button type="submit" loading={save.isPending}>Save terms and rules</Button>
    </form>
  );
}

function Lanes({ customer }) {
  const confirm = useConfirm();
  const [form, setForm] = useState(null);
  const inv = [['customer', customer.id]];
  const save = useApiMutation(
    (l) => (l.id ? api.patch(`/api/customers/${customer.id}/lanes/${l.id}`, l) : api.post(`/api/customers/${customer.id}/lanes`, l)),
    { success: 'Lane saved', invalidate: inv, onSuccess: () => setForm(null) },
  );
  const remove = useApiMutation((laneId) => api.del(`/api/customers/${customer.id}/lanes/${laneId}`), { success: 'Lane removed', invalidate: inv });
  return (
    <Card title="Preferred lanes" bodyClass="p-0" actions={<Button size="sm" variant="secondary" icon={Plus} onClick={() => setForm({ origin: '', destination: '', notes: '' })}>Add lane</Button>}>
      {customer.lanes.length ? (
        <ul className="divide-y divide-line">
          {customer.lanes.map((l) => (
            <li key={l.id} className="flex items-center gap-2 px-4 py-2.5 text-sm">
              <div className="min-w-0 flex-1"><span className="font-medium">{l.origin} → {l.destination}</span>{l.notes && <span className="ml-2 text-xs text-muted">{l.notes}</span>}</div>
              <IconButton icon={Pencil} label="Edit lane" onClick={() => setForm({ ...l, notes: l.notes || '' })} />
              <IconButton icon={Trash2} label="Remove lane" className="hover:text-red-600" onClick={async () => { if (await confirm({ title: 'Remove lane?', message: `${l.origin} → ${l.destination}`, danger: true, confirmLabel: 'Remove' })) remove.mutate(l.id); }} />
            </li>
          ))}
        </ul>
      ) : <p className="px-4 py-4 text-sm text-muted">No lanes yet. Add the regions this carrier wants to run.</p>}
      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? 'Edit lane' : 'Add lane'} size="sm"
        footer={<><Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button><Button type="submit" form="lane-form" loading={save.isPending}>Save</Button></>}>
        {form && (
          <form id="lane-form" className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(form); }}>
            <Field label="Origin" required><Input value={form.origin} onChange={(e) => setForm({ ...form, origin: e.target.value })} placeholder="City, ST or region" required maxLength={120} /></Field>
            <Field label="Destination" required><Input value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} required maxLength={120} /></Field>
            <Field label="Notes"><Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={500} /></Field>
          </form>
        )}
      </Modal>
    </Card>
  );
}

function FmcsaCard({ fmcsa }) {
  return (
    <Card title={<span className="inline-flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4 text-c-teal" aria-hidden />FMCSA watch</span>}>
      {!fmcsa ? (
        <p className="text-sm text-muted">Checked about once a day, overnight, once the carrier has a USDOT or MC number. No check has run yet.</p>
      ) : (
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between gap-3"><dt className="text-muted">Status</dt><dd><FmcsaBadge fmcsa={fmcsa} /></dd></div>
          {fmcsa.insuranceOnFile != null && <div className="flex justify-between gap-3"><dt className="text-muted">Liability insurance on file</dt><dd>{fmcsa.insuranceOnFile ? 'Yes' : 'No'}</dd></div>}
          {fmcsa.lastChange && (
            <div className="rounded-md border border-c-amber/30 bg-c-amber-soft px-2.5 py-1.5 text-[13px]">
              <p className="font-medium">Changed {date(fmcsa.lastChange.at)}</p>
              <ul>{fmcsa.lastChange.items.map((c) => <li key={c.field}>{c.label}: {c.from} → {c.to}</li>)}</ul>
            </div>
          )}
          <p className="text-xs text-muted">FMCSA public data, checked {date(fmcsa.checkedAt)}.</p>
        </dl>
      )}
    </Card>
  );
}

export default function CustomerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [tab, setTab] = useState('overview');
  const [loadModal, setLoadModal] = useState(null);
  const [composing, setComposing] = useState(null);
  const q = useQuery({ queryKey: ['customer', id], queryFn: () => api.get(`/api/customers/${id}`) });
  const remove = useApiMutation(() => api.del(`/api/customers/${id}`), { success: 'Customer removed and carrier archived', invalidate: [['customers'], ['pipeline']], onSuccess: () => navigate('/app/customers') });

  return (
    <QueryState query={q}>
      {(data) => {
        const { customer, checklist, revenue, loads, brokers, activities, fmcsa } = data;
        const c = customer.carrier;
        const primary = c.contacts.find((x) => x.isPrimary) || c.contacts[0];
        const missing = checklist.filter((x) => x.status !== 'on_file').map((x) => x.type);
        const rules = rulesSummary(customer.rules || {});
        const addLoad = () => setLoadModal({ initial: { carrierId: c.id, carrierLabel: c.companyName, dispatchFeePercent: customer.dispatchFeePercent } });
        return (
          <div>
            <PageHeader title={c.companyName} breadcrumb={<Link to="/app/customers" className="hover:underline">Customers</Link>}
              subtitle={<span className="inline-flex flex-wrap items-center gap-2"><Badge color={CUSTOMER_COLOR[customer.status]}>{label(customer.status)}</Badge>{[c.mcNumber && `MC ${c.mcNumber}`, c.dotNumber && `DOT ${c.dotNumber}`, `signed ${date(customer.signedAt)}`].filter(Boolean).join(' · ')}</span>}
              actions={<>
                {c.phone && <Button variant="secondary" icon={Phone} href={`tel:${c.phone}`}>Call</Button>}
                {c.email && <Button variant="secondary" icon={Mail} onClick={() => setComposing({})}>Email</Button>}
                <Button variant="secondary" icon={ExternalLink} to={`/app/carriers/${c.id}`}>Carrier profile</Button>
                <Button icon={Plus} onClick={addLoad}>Add load</Button>
              </>} />

            <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="Loads hauled" value={num(revenue.loads)} sub="Delivered, invoiced or paid" />
              <StatCard label="Gross revenue" value={money(revenue.grossCents, { digits: 0 })} />
              <StatCard label="Dispatch fees earned" value={money(revenue.dispatchFeeCents, { digits: 0 })} tone="green"
                sub={revenue.booked?.loads ? `${money(revenue.booked.dispatchFeeCents, { digits: 0 })} more on ${revenue.booked.loads} booked load${revenue.booked.loads === 1 ? '' : 's'}` : customer.dispatchFeePercent != null ? `at ${customer.dispatchFeePercent}%` : 'Set a fee % to track'} />
              <StatCard label="Average RPM" value={revenue.avgRatePerMile != null ? dollars(revenue.avgRatePerMile) : '—'} tone="signal" />
            </div>

            <Tabs className="mb-4" value={tab} onChange={setTab} tabs={[
              { value: 'overview', label: 'Overview' },
              { value: 'statements', label: 'Statements' },
              { value: 'documents', label: 'Documents', count: data.documents.length },
              { value: 'loads', label: 'Loads', count: loads.length },
              { value: 'activity', label: 'Activity' },
            ]} />

            {tab === 'overview' && (
              <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
                <div className="space-y-4">
                  <Card title="Rates, terms and rules">
                    {rules.length > 0 && <div className="mb-4 flex flex-wrap gap-1">{rules.map((r) => <Badge key={r} color="gray">{r}</Badge>)}</div>}
                    <TermsForm customer={customer} />
                  </Card>
                  <Lanes customer={customer} />
                </div>
                <div className="space-y-4">
                  <Card title="Paperwork checklist" actions={<Button size="sm" variant="link" onClick={() => setTab('documents')}>Manage</Button>}>
                    <ul className="space-y-2">
                      {checklist.map((item) => {
                        const st = CHECK[item.status];
                        return (
                          <li key={item.type} className="flex items-center gap-2 text-sm">
                            <st.icon className={`size-4 ${st.cls}`} aria-hidden />
                            <span className="flex-1">{DOC_NAME[item.type] || label(item.type)}</span>
                            <span className={`text-xs ${st.cls}`}>{st.text}{item.expiresAt ? ` · ${date(item.expiresAt)}` : ''}</span>
                          </li>
                        );
                      })}
                    </ul>
                    {missing.length > 0 && (
                      <Button size="sm" variant="secondary" icon={Mail} className="mt-3" onClick={() => setComposing({ request: true })}>Request missing documents</Button>
                    )}
                  </Card>
                  <FmcsaCard fmcsa={fmcsa} />
                  <Card title="Company">
                    <dl className="space-y-1.5 text-sm">
                      <div className="flex justify-between gap-3"><dt className="text-muted">Phone</dt><dd>{c.phone ? phoneFmt(c.phone) : '—'}</dd></div>
                      <div className="flex justify-between gap-3"><dt className="text-muted">Email</dt><dd className="break-all text-right">{c.email || '—'}</dd></div>
                      <div className="flex justify-between gap-3"><dt className="text-muted">Address</dt><dd className="text-right">{[c.address, c.city, c.state, c.zip].filter(Boolean).join(', ') || '—'}</dd></div>
                      <div className="flex justify-between gap-3"><dt className="text-muted">Equipment</dt><dd className="text-right">{c.equipment ? c.equipment.split(',').map(label).join(', ') : '—'}</dd></div>
                      <div className="flex justify-between gap-3"><dt className="text-muted">Fleet</dt><dd>{c.fleetSize != null ? `${c.fleetSize} power units` : '—'}</dd></div>
                      <div className="flex justify-between gap-3"><dt className="text-muted">Primary contact</dt><dd className="text-right">{primary ? `${primary.name}${primary.phone ? ` · ${phoneFmt(primary.phone)}` : ''}` : '—'}</dd></div>
                      <div className="flex justify-between gap-3"><dt className="text-muted">Dispatcher</dt><dd>{c.assignedTo?.name || '—'}</dd></div>
                    </dl>
                  </Card>
                  <Card title="Brokers worked with" bodyClass="p-0">
                    {brokers.length ? (
                      <ul className="divide-y divide-line">{brokers.map((b) => <li key={b.id} className="flex justify-between px-4 py-2 text-sm"><Link to={`/app/brokers/${b.id}`} className="hover:underline">{b.companyName}</Link><span className="text-muted">{b.loads} load{b.loads === 1 ? '' : 's'}</span></li>)}</ul>
                    ) : <p className="px-4 py-3 text-sm text-muted">Appears once loads with a broker are recorded.</p>}
                  </Card>
                  <Card title="Danger zone">
                    <p className="mb-3 text-sm text-muted">Removing the customer record archives the carrier. Documents, loads and history are kept.</p>
                    <Button variant="danger" size="sm" icon={Trash2} onClick={async () => { if (await confirm({ title: 'Remove customer?', message: `${c.companyName} will be moved to Archived.`, danger: true, confirmLabel: 'Remove' })) remove.mutate(); }}>Remove customer</Button>
                  </Card>
                </div>
              </div>
            )}

            {tab === 'statements' && <StatementsPanel customer={customer} />}

            {tab === 'documents' && <Card title="Documents"><DocumentsPanel carrierId={c.id} missing={missing} carrierEmail={c.email} /></Card>}

            {tab === 'loads' && (
              <Card bodyClass="p-0" title="Load history" actions={<Button size="sm" icon={Plus} onClick={addLoad}>Add load</Button>}>
                <DataTable rows={loads} columns={loadColumns({ onEdit: (l) => setLoadModal({ load: l }), showCarrier: false })} onRowClick={(l) => navigate(`/app/loads?load=${l.id}`)}
                  mobileRow={loadMobileRow({ onEdit: (l) => setLoadModal({ load: l }) })}
                  empty={<EmptyState title="No loads yet">Record loads you book for {c.companyName} to track revenue and fees.</EmptyState>} />
              </Card>
            )}

            {tab === 'activity' && (
              <Card title="Recent activity">
                {activities.length ? (
                  <ul className="space-y-2.5">
                    {activities.map((a) => (
                      <li key={a.id} className="flex flex-col gap-0.5 text-sm sm:flex-row sm:gap-3">
                        <span className="shrink-0 text-xs text-muted sm:w-32">{dateTime(a.createdAt)}</span>
                        <span>{a.summary}{a.user && <span className="text-xs text-muted"> · {a.user.name}</span>}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-muted">No activity yet.</p>}
              </Card>
            )}

            <LoadFormModal open={!!loadModal} onClose={() => setLoadModal(null)} load={loadModal?.load} initial={loadModal?.initial} />
            <ComposeModal open={!!composing} onClose={() => setComposing(null)} carrierId={c.id} toEmail={c.email} templateCategory="carrier"
              subject={composing?.request ? 'Documents we need for your file' : undefined}
              body={composing?.request ? documentRequestBody(missing) : undefined} />
          </div>
        );
      }}
    </QueryState>
  );
}
