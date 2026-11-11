import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Trash2, Plus, Mail, Phone, Receipt } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { date, dateTime, dollars, label, money, num, phoneFmt } from '../../lib/format.js';
import { Badge, Button, Card, DataTable, EmptyState, Markdown, PageHeader, QueryState, StatCard, cx } from '../../components/ui.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import BrokerFormModal from '../../components/dispatch/BrokerForm.jsx';
import BrokerVettingCard, { LevelBadge } from '../../components/dispatch/BrokerVetting.jsx';
import LoadFormModal from '../../components/dispatch/LoadForm.jsx';
import ComposeModal from '../../components/email/ComposeModal.jsx';
import { BrokerNegotiations } from '../../components/negotiation/NegotiationList.jsx';
import { loadColumns, loadMobileRow } from './Loads.jsx';
import { PaysInBadge } from '../reports/PaysIn.jsx';

function Info({ k, children }) {
  return (
    <div className="flex justify-between gap-3 py-1.5 text-sm">
      <dt className="text-muted">{k}</dt>
      <dd className="min-w-0 break-words text-right">{children || '—'}</dd>
    </div>
  );
}

const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

/** One invoice line: number, reference and issue date, then amount and how it was (or is being) paid. */
function PaymentLine({ i }) {
  const status = i.status === 'paid'
    ? (i.daysToPay != null ? `Paid in ${days(i.daysToPay)}` : 'Paid')
    : `${i.status === 'partial' ? 'Partly paid' : 'Open'}${i.daysOpen != null ? ` ${days(i.daysOpen)}` : ''}`;
  return (
    <li>
      <Link to={`/app/invoices?open=${i.id}`} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm transition-ui hover:bg-surface-2/60">
        <div className="min-w-0">
          <div className="truncate font-medium">#{i.number}{i.reference ? <span className="font-normal text-muted"> · {i.reference}</span> : null}</div>
          <div className="text-xs text-muted">Issued {date(i.issuedAt)}{i.dueAt ? ` · due ${date(i.dueAt)}` : ''}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="tabular">{money(i.amountCents)}</div>
          <div className="flex items-center justify-end gap-1.5 text-xs text-muted">
            <span className="tabular">{status}</span>
            {i.late && <Badge color="amber">Late</Badge>}
            {i.pastDue && <Badge color="red">Past due</Badge>}
          </div>
        </div>
      </Link>
    </li>
  );
}

/** Payment history from this workspace's own freight invoices to the broker (GET /api/brokers/:id payments). */
function PaymentHistoryCard({ p }) {
  const stat = (k, v, sub, warn) => (
    <div className="min-w-0 px-4 py-3">
      <dt className="text-xs text-muted">{k}</dt>
      <dd className={cx('mt-0.5 text-lg font-medium tabular', warn && 'text-c-red')}>{v}</dd>
      {sub && <dd className="truncate text-xs text-muted">{sub}</dd>}
    </div>
  );
  return (
    <Card title={<div className="min-w-0 py-1"><h2 className="text-sm font-medium">Payment history</h2><p className="text-xs text-muted">From your own invoices to this broker, not industry data</p></div>}
      actions={<PaysInBadge p={p} quiet />} bodyClass="p-0">
      <dl className="grid grid-cols-2 divide-line border-b border-line sm:grid-cols-4 sm:divide-x">
        {stat('Average days to pay', p.avgDaysToPay != null ? days(p.avgDaysToPay) : '—',
          p.measuredInvoices ? `Median ${p.medianDaysToPay != null ? days(p.medianDaysToPay) : '—'} · ${num(p.measuredInvoices)} paid` : 'No paid invoices yet')}
        {stat('Paid late', p.paidInvoices ? num(p.paidLate) : '—', p.paidInvoices ? `of ${num(p.paidInvoices)} paid` : 'No paid invoices yet')}
        {stat('Open balance', money(p.openCents, { digits: 0 }), p.openInvoices ? `${num(p.openInvoices)} open${p.oldestOpenDays != null ? ` · oldest ${days(p.oldestOpenDays)}` : ''}` : 'None open')}
        {stat('Past due', money(p.pastDueCents, { digits: 0 }), p.pastDueInvoices ? `${num(p.pastDueInvoices)} past the due date` : 'Nothing past due', p.pastDueCents > 0)}
      </dl>
      {p.recent?.length ? (
        <>
          <ul className="divide-y divide-line">{p.recent.map((i) => <PaymentLine key={i.id} i={i} />)}</ul>
          {p.invoices > p.recent.length && <p className="border-t border-line px-4 py-2 text-xs text-muted">Last {p.recent.length} of {num(p.invoices)} invoices</p>}
        </>
      ) : <p className="px-4 py-4 text-sm text-muted">No invoices sent to this broker yet. Payment speed shows here once you invoice loads and record payments.</p>}
    </Card>
  );
}

export default function BrokerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [loadModal, setLoadModal] = useState(null);
  const [composing, setComposing] = useState(false);
  const q = useQuery({ queryKey: ['broker', id], queryFn: () => api.get(`/api/brokers/${id}`) });
  const remove = useApiMutation(() => api.del(`/api/brokers/${id}`), { success: 'Broker deleted', invalidate: [['brokers']], onSuccess: () => navigate('/app/brokers') });

  return (
    <QueryState query={q}>
      {({ broker: b, vetting, stats, payments, loads, emails }) => (
        <div>
          <PageHeader title={b.companyName} breadcrumb={<Link to="/app/brokers" className="hover:underline">Brokers</Link>}
            subtitle={<span className="inline-flex flex-wrap items-center gap-2"><LevelBadge level={vetting.level} checked={!!vetting.checkedAt} />{[b.mcNumber && `MC ${b.mcNumber}`, b.dotNumber && `DOT ${b.dotNumber}`, b.city && b.state && `${b.city}, ${b.state}`].filter(Boolean).join(' · ')}</span>}
            actions={<>
              {b.phone && <Button variant="secondary" icon={Phone} href={`tel:${b.phone}`}>Call</Button>}
              {b.email && <Button variant="secondary" icon={Mail} onClick={() => setComposing(true)}>Email</Button>}
              <Button variant="secondary" icon={Pencil} onClick={() => setEditing(true)}>Edit</Button>
              <Button variant="ghost" icon={Trash2} className="text-red-600" onClick={async () => {
                if (await confirm({ title: 'Delete broker?', message: `${b.companyName} will be deleted. Its ${stats.loads} load(s) are kept without a broker.`, danger: true })) remove.mutate();
              }}>Delete</Button>
            </>} />

          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Loads" value={num(stats.loads)} sub={stats.paidLoads ? `${stats.paidLoads} paid` : undefined} />
            <StatCard label="Revenue" value={money(stats.revenueCents, { digits: 0 })} />
            <StatCard label="Average RPM" value={stats.avgRatePerMile != null ? dollars(stats.avgRatePerMile) : '—'} tone="signal" />
            <StatCard label="Open invoices" value={money(payments.openCents, { digits: 0 })} sub={payments.openInvoices ? `${payments.openInvoices} open` : 'None open'} to={payments.openInvoices ? `/app/invoices?status=open&brokerId=${b.id}` : undefined} />
          </div>

          <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
            <div className="space-y-4">
              <BrokerVettingCard broker={b} vetting={vetting} />
              <Card title="Contact & terms">
                <dl className="divide-y divide-line">
                  <Info k="Contact">{b.contactName}</Info>
                  <Info k="Phone">{b.phone && <a className="hover:underline" href={`tel:${b.phone}`}>{phoneFmt(b.phone)}</a>}</Info>
                  <Info k="Email">{b.email && <span className="break-all">{b.email}</span>}</Info>
                  <Info k="Address">{[b.address, b.city, b.state, b.zip].filter(Boolean).join(', ')}</Info>
                  <Info k="Payment terms">{b.paymentTerms}</Info>
                  <Info k="Days to pay (typed)">{b.daysToPay != null ? `${b.daysToPay} days` : null}</Info>
                  <Info k="Days to pay (measured)">{payments.avgDaysToPay != null ? `${payments.avgDaysToPay} days from ${payments.measuredInvoices} paid invoice${payments.measuredInvoices === 1 ? '' : 's'}` : 'No paid invoices yet'}</Info>
                  <Info k="Credit rating">{b.creditRating}</Info>
                  <Info k="Credit limit">{b.creditLimitCents != null ? money(b.creditLimitCents, { digits: 0 }) : null}</Info>
                </dl>
              </Card>
              <Card title="Notes">{b.notes ? <Markdown text={b.notes} /> : <p className="text-sm text-muted">No notes. Use Edit to add payment history or contact preferences.</p>}</Card>
              <Card title="Emails" bodyClass="p-0">
                {emails.length ? (
                  <ul className="divide-y divide-line">
                    {emails.map((e) => (
                      <li key={e.id} className="px-4 py-2.5 text-sm">
                        <div className="flex items-center justify-between gap-2"><span className="truncate font-medium">{e.subject}</span><Badge color={e.status === 'sent' ? 'green' : e.status === 'failed' ? 'red' : 'gray'}>{label(e.status)}</Badge></div>
                        <div className="text-xs text-muted">{dateTime(e.sentAt || e.createdAt)}</div>
                      </li>
                    ))}
                  </ul>
                ) : <p className="px-4 py-4 text-sm text-muted">No emails with this broker yet.</p>}
              </Card>
            </div>
            <div className="min-w-0 space-y-4">
              <PaymentHistoryCard p={payments} />
              <BrokerNegotiations broker={b} />
              <Card title="Load history" bodyClass="p-0" actions={<>
                <Button size="sm" variant="secondary" icon={Receipt} to={`/app/invoices?brokerId=${b.id}`}>Invoices</Button>
                <Button size="sm" icon={Plus} onClick={() => setLoadModal({ initial: { brokerId: b.id } })}>Add load</Button>
              </>}>
                <DataTable rows={loads} columns={loadColumns({ onEdit: (l) => setLoadModal({ load: l }), showBroker: false })} onRowClick={(l) => navigate(`/app/loads?load=${l.id}`)}
                  mobileRow={loadMobileRow({ onEdit: (l) => setLoadModal({ load: l }) })}
                  empty={<EmptyState title="No loads with this broker">Loads you book with {b.companyName} show here with their rate per mile.</EmptyState>} />
                {loads.length > 0 && <p className="border-t border-line px-4 py-2 text-xs text-muted">Showing {loads.length} most recent · first shown {date(loads[loads.length - 1].pickupDate || loads[loads.length - 1].createdAt)}</p>}
              </Card>
            </div>
          </div>

          <BrokerFormModal open={editing} onClose={() => setEditing(false)} broker={b} />
          <LoadFormModal open={!!loadModal} onClose={() => setLoadModal(null)} load={loadModal?.load} initial={loadModal?.initial} />
          <ComposeModal open={composing} onClose={() => setComposing(false)} brokerId={b.id} toEmail={b.email} />
        </div>
      )}
    </QueryState>
  );
}
