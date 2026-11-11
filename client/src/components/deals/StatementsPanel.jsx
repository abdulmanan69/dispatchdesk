import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Printer, Send, Eye, Link2, Copy, Link2Off, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { date, dollars, money, num } from '../../lib/format.js';
import { Badge, Button, Card, Checkbox, DataTable, EmptyState, Field, Input, Loading, ErrorState, Textarea } from '../ui.jsx';
import { Modal, useConfirm } from '../Modal.jsx';
import { useToast } from '../Toast.jsx';
import { copyText, openPrintable } from '../invoices/print.js';

// Weeks run Monday 00:00 to Monday 00:00 in the account time zone (the server builds them there), so they are labeled
// in that zone, not the browser's.
const weekLabel = (w, tz) => `${date(w.periodStart, { month: 'short', day: 'numeric', timeZone: tz })} – ${date(new Date(new Date(w.periodEnd).getTime() - 1), { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz })}`;

function StatementView({ customerId, week }) {
  const q = useQuery({ queryKey: ['customer', customerId, 'statement', week], queryFn: () => api.get(`/api/customers/${customerId}/statements/${week}`), enabled: !!week });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={q.refetch} />;
  const st = q.data.statement;
  const t = st.totals;
  return (
    <div className="space-y-3">
      <DataTable rows={st.lines} dense
        empty={<EmptyState title="No delivered loads this week" />}
        mobileRow={(l) => (
          <div className="flex justify-between gap-3 text-sm">
            <span className="min-w-0"><span className="block truncate font-medium">{l.lane}</span><span className="text-xs text-muted">{date(l.date, { month: 'short', day: 'numeric' })}{l.reference ? ` · ${l.reference}` : ''}</span></span>
            <span className="text-right tabular">{money(l.grossCents)}<span className="block text-xs text-muted">fee {money(l.feeCents)}</span></span>
          </div>
        )}
        columns={[
          { key: 'date', header: 'Delivered', render: (l) => date(l.date, { month: 'short', day: 'numeric' }) },
          { key: 'lane', header: 'Load', render: (l) => <div><div>{l.lane}</div><div className="text-xs text-muted">{[l.reference && `Ref ${l.reference}`, l.broker].filter(Boolean).join(' · ')}</div></div> },
          { key: 'gross', header: 'Gross', className: 'text-right', render: (l) => <span className="tabular">{money(l.grossCents)}</span> },
          { key: 'rpm', header: 'RPM', className: 'text-right', render: (l) => <span className="tabular">{l.ratePerMile != null ? dollars(l.ratePerMile) : '—'}</span> },
          { key: 'fee', header: 'Fee', className: 'text-right', render: (l) => <span className="tabular">{l.feeCents != null ? `${money(l.feeCents)} (${l.feePercent}%)` : 'No fee %'}</span> },
          { key: 'net', header: 'Net', className: 'text-right', render: (l) => <span className="tabular font-medium">{money(l.netCents)}</span> },
        ]} />
      <dl className="ml-auto grid w-full max-w-xs gap-1 text-sm">
        <div className="flex justify-between"><dt className="text-muted">Loads · loaded miles</dt><dd className="tabular">{t.loads} · {num(t.loadedMiles)}</dd></div>
        <div className="flex justify-between"><dt className="text-muted">Gross</dt><dd className="tabular">{money(t.grossCents)}</dd></div>
        <div className="flex justify-between"><dt className="text-muted">Dispatch fee</dt><dd className="tabular">{money(t.feeCents)}</dd></div>
        <div className="flex justify-between border-t border-line pt-1 font-medium"><dt>Net to carrier</dt><dd className="tabular">{money(t.netCents)}</dd></div>
      </dl>
      {t.missingFee > 0 && <p className="text-xs text-c-amber">{t.missingFee} load{t.missingFee === 1 ? ' has' : 's have'} no fee % (set it on the customer or the load).</p>}
    </div>
  );
}

function SendStatement({ customer, week, onClose }) {
  const toast = useToast();
  const [f, setF] = useState({ toEmail: customer.carrier.email || '', subject: '', body: '', portalLink: !customer.portal?.active });
  const send = useApiMutation((body) => api.post(`/api/customers/${customer.id}/statements/${week}/send`, body), {
    invalidate: [['customer', customer.id]],
    onSuccess: (d) => {
      if (d.outcome === 'failed') { toast.error(d.message || 'The email could not be sent'); return; }
      toast.success(d.outcome === 'sent' ? 'Statement sent from your mailbox' : d.message || 'Statement queued');
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} title="Email the statement" size="md"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button icon={Send} loading={send.isPending} disabled={!f.toEmail.trim()} onClick={() => send.mutate({ toEmail: f.toEmail.trim(), subject: f.subject.trim() || undefined, body: f.body.trim() || undefined, portalLink: f.portalLink })}>Send</Button></>}>
      <div className="space-y-3">
        <Field label="To" required><Input type="email" value={f.toEmail} onChange={(e) => setF({ ...f, toEmail: e.target.value })} /></Field>
        <Field label="Subject" hint="Blank: “Dispatch statement · week of …”"><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} maxLength={300} /></Field>
        <Field label="Message" hint="Blank: the statement itself (each load, gross, fee and net)."><Textarea rows={5} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
        <Checkbox checked={f.portalLink} onChange={(e) => setF({ ...f, portalLink: e.target.checked })}
          label={customer.portal?.active ? 'Include a new portal link (the current link stops working)' : 'Include a portal link to statements and load documents'} />
        <p className="text-xs text-muted">Sent from your own connected mailbox.</p>
      </div>
    </Modal>
  );
}

function PortalLink({ customer }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [created, setCreated] = useState(null);
  const create = useApiMutation(() => api.post(`/api/customers/${customer.id}/portal`, { days: 90 }), { invalidate: [['customer', customer.id]], onSuccess: (d) => setCreated(d) });
  const revoke = useApiMutation(() => api.del(`/api/customers/${customer.id}/portal`), { success: 'Portal link turned off', invalidate: [['customer', customer.id]], onSuccess: () => setCreated(null) });
  const active = customer.portal?.active;
  const copy = async () => {
    if (await copyText(created.url)) toast.success('Link copied');
    else toast.info('Select the link and copy it with Ctrl+C');
  };
  return (
    <Card title="Carrier portal link" bodyClass="space-y-3 p-4">
      <p className="text-sm text-muted">A private link where {customer.carrier.companyName} sees its weekly statements and the rate con, BOL and POD of delivered loads. Nothing else in your workspace is visible.</p>
      {created ? (
        <div className="space-y-2">
          <p className="text-xs text-muted">Copy it now: for security it is shown only once. Expires {date(created.expiresAt)}.</p>
          <div className="flex gap-2">
            <Input readOnly value={created.url} aria-label="Portal link" onFocus={(e) => e.target.select()} />
            <Button variant="secondary" icon={Copy} onClick={copy}>Copy</Button>
          </div>
        </div>
      ) : active ? (
        <p className="text-sm"><Badge color="green">Active</Badge> <span className="text-muted">until {date(customer.portal.expiresAt)}</span></p>
      ) : <p className="text-sm"><Badge color="gray">Off</Badge></p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon={active ? RefreshCw : Link2} loading={create.isPending}
          onClick={async () => { if (!active || await confirm({ title: 'Create a new link?', message: 'The current link stops working. Send the new one to the carrier.', confirmLabel: 'Create new link' })) create.mutate(); }}>
          {active ? 'Create a new link' : 'Create link'}
        </Button>
        {active && <Button size="sm" variant="ghost" icon={Link2Off} loading={revoke.isPending} onClick={async () => { if (await confirm({ title: 'Turn off the portal link?', message: 'The carrier will no longer be able to open it.', confirmLabel: 'Turn off', danger: true })) revoke.mutate(); }}>Turn off</Button>}
      </div>
    </Card>
  );
}

/** Weekly dispatch-fee statements for a customer: totals per week, detail, print, email, and the portal link. */
export default function StatementsPanel({ customer }) {
  const toast = useToast();
  const [view, setView] = useState(null);
  const [sending, setSending] = useState(null);
  const q = useQuery({ queryKey: ['customer', customer.id, 'statements'], queryFn: () => api.get(`/api/customers/${customer.id}/statements`, { weeks: 12 }) });
  const print = (week) => { if (!openPrintable(`/api/customers/${customer.id}/statements/${week}/print`)) toast.info('Allow pop-ups for this site to print the statement.'); };
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Card title="Weekly statements" bodyClass="p-0">
        {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={q.refetch} /> : (
          <>
            <p className="border-b border-line px-4 py-2 text-xs text-muted">Loads delivered Monday to Sunday ({q.data.timezone}). Fee = the load’s fee %, else {customer.dispatchFeePercent != null ? `${customer.dispatchFeePercent}%` : 'the customer’s fee % (not set)'}.</p>
            <DataTable rows={q.data.items.map((w) => ({ ...w, id: w.weekStart }))}
              mobileRow={(w) => (
                <div className="space-y-2">
                  <div className="flex justify-between gap-2 text-sm"><span className="font-medium">{weekLabel(w, q.data.timezone)}</span><span className="tabular">{money(w.totals.feeCents)}</span></div>
                  <p className="text-xs text-muted">{w.totals.loads} load{w.totals.loads === 1 ? '' : 's'} · gross {money(w.totals.grossCents)} · net {money(w.totals.netCents)}</p>
                  {w.totals.loads > 0 && <div className="flex gap-1"><Button size="sm" variant="secondary" onClick={() => setView(w.weekStart)}>View</Button><Button size="sm" variant="secondary" onClick={() => setSending(w.weekStart)}>Email</Button></div>}
                </div>
              )}
              columns={[
                { key: 'week', header: 'Week', render: (w) => <span className="whitespace-nowrap">{weekLabel(w, q.data.timezone)}{w.weekStart === q.data.currentWeek && <Badge color="blue" className="ml-1.5">This week</Badge>}</span> },
                { key: 'loads', header: 'Loads', className: 'text-right', render: (w) => <span className="tabular">{w.totals.loads}</span> },
                { key: 'gross', header: 'Gross', className: 'text-right', render: (w) => <span className="tabular">{money(w.totals.grossCents, { digits: 0 })}</span> },
                { key: 'fee', header: 'Fee', className: 'text-right', render: (w) => <span className="tabular font-medium">{money(w.totals.feeCents)}</span> },
                { key: 'net', header: 'Net', className: 'text-right', render: (w) => <span className="tabular">{money(w.totals.netCents, { digits: 0 })}</span> },
                {
                  key: 'actions', header: <span className="sr-only">Actions</span>, className: 'text-right',
                  render: (w) => (w.totals.loads > 0 ? (
                    <span className="inline-flex gap-1">
                      <Button size="sm" variant="ghost" icon={Eye} onClick={() => setView(w.weekStart)}>View</Button>
                      <Button size="sm" variant="ghost" icon={Printer} onClick={() => print(w.weekStart)}>Print</Button>
                      <Button size="sm" variant="ghost" icon={Send} onClick={() => setSending(w.weekStart)}>Email</Button>
                    </span>
                  ) : <span className="text-xs text-muted">No loads</span>),
                },
              ]} />
          </>
        )}
      </Card>
      <PortalLink customer={customer} />
      <Modal open={!!view} onClose={() => setView(null)} size="lg" title={view ? `Statement · week of ${date(`${view}T12:00:00`)}` : ''}
        footer={view && <><Button variant="secondary" icon={Printer} onClick={() => print(view)}>Print</Button><Button icon={Send} onClick={() => { setSending(view); setView(null); }}>Email</Button></>}>
        {view && <StatementView customerId={customer.id} week={view} />}
      </Modal>
      {sending && <SendStatement customer={customer} week={sending} onClose={() => setSending(null)} />}
    </div>
  );
}
