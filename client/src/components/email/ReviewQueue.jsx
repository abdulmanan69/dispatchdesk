import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Check, X, ClipboardCheck } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useToast } from '../Toast.jsx';
import { Modal, useConfirm } from '../Modal.jsx';
import { Badge, Button, Card, DataTable, EmptyState, Field, Input, Pagination, QueryState, Textarea } from '../ui.jsx';
import { relative } from '../../lib/format.js';

/**
 * "Needs approval": emails in status 'review' (GET /api/email/review). They come from sequence steps set to
 * "AI writes, I approve", from AI emails held because they mention a figure the inputs do not contain, from steps
 * the AI could not write (the body is then the brief, and it has to be written before approving), and from rate
 * negotiations set to approve each email.
 * Approve & send schedules the email now; reject cancels it and the carrier leaves that sequence.
 */

const PAGE_SIZE = 25;
const invalidate = [['emails'], ['email', 'status'], ['sequences'], ['queue']];
const reason = (s) => String(s || '').replace(/_/g, ' ');
const who = (m) => m.carrier?.companyName || m.broker?.companyName || m.toEmail;
const source = (m) => m.sequence?.name || (m.negotiationId ? 'Rate negotiation' : null);

/** Badge for emails written by AI (lists and the message view). */
export function AiBadge() {
  return <Badge color="violet" title="Written by AI">AI</Badge>;
}

/** Number of emails waiting for approval, for the tab badge. Shares the ['emails'] prefix, so any email change refreshes it. */
export function useReviewCount() {
  return useQuery({
    queryKey: ['emails', 'review', 'count'],
    queryFn: () => api.get('/api/email/review', { page: 1, pageSize: 1 }),
    select: (d) => d.total,
    staleTime: 30000,
  });
}

function Notes({ email }) {
  const ended = email.sequence?.ended;
  return (
    <>
      {ended && (
        <p className="rounded-md border border-c-red/30 bg-c-red-soft px-3 py-2 text-[13px] text-c-red">
          This carrier&apos;s sequence ended ({reason(email.sequence.endedReason)}), so this email cannot be sent. Reject it, or write a new email from Compose.
        </p>
      )}
      {!ended && email.note && (
        <p className="rounded-md border border-c-amber/30 bg-c-amber-soft px-3 py-2 text-[13px] text-c-amber">{email.note}</p>
      )}
    </>
  );
}

/** Open one waiting email: edit, approve & send, or reject. */
export function ReviewEditor({ email, onClose }) {
  const confirm = useConfirm();
  const [f, setF] = useState(null);
  useEffect(() => { if (email) setF({ subject: email.subject, body: email.body }); }, [email]);
  const approve = useApiMutation((v) => api.post(`/api/email/messages/${email.id}/approve`, v), {
    invalidate, success: (r) => r.message || 'Approved', onSuccess: onClose,
  });
  const reject = useApiMutation(() => api.post(`/api/email/messages/${email.id}/reject`), {
    invalidate,
    success: (r) => (r.stopped ? `Rejected. ${email.carrier?.companyName || 'The carrier'} left the sequence.` : 'Rejected'),
    onSuccess: onClose,
  });
  if (!email || !f) return null;
  const unchangedBrief = email.needsWriting && f.body.trim() === String(email.body).trim();
  const blocked = email.sequence?.ended;
  const onReject = async () => {
    const seq = email.sequence;
    const ok = await confirm({
      title: 'Reject this email?',
      message: seq
        ? `It is not sent, and ${email.carrier?.companyName || 'the carrier'} leaves the sequence "${seq.name}". Its other emails waiting here are canceled too. To keep the carrier in the sequence, edit the email and approve it instead.`
        : 'It is not sent.',
      confirmLabel: 'Reject', danger: true,
    });
    if (ok) reject.mutate();
  };
  return (
    <Modal open onClose={onClose} title="Review email" size="lg"
      footer={<>
        <Button variant="secondary" icon={X} loading={reject.isPending} onClick={onReject}>Reject</Button>
        <Button icon={Check} loading={approve.isPending} disabled={blocked || unchangedBrief || !f.subject.trim() || !f.body.trim()}
          title={unchangedBrief ? 'Write the email first' : undefined} onClick={() => approve.mutate(f)}>Approve &amp; send</Button>
      </>}>
      <div className="space-y-3 text-sm">
        <dl className="grid grid-cols-[90px_1fr] gap-x-3 gap-y-1 text-[13px]">
          <dt className="text-muted">Written by</dt>
          <dd className="flex flex-wrap items-center gap-1.5">{email.aiGenerated ? <><AiBadge /><span>AI{email.sequence ? ', from your brief' : ''}</span></> : email.needsWriting ? 'Your brief (AI could not write it)' : 'You'}</dd>
          <dt className="text-muted">To</dt><dd className="break-all">{email.toEmail || '—'}</dd>
          {email.carrier && (<><dt className="text-muted">Carrier</dt><dd><Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/app/carriers/${email.carrier.id}`}>{email.carrier.companyName}</Link></dd></>)}
          {email.broker && (<><dt className="text-muted">Broker</dt><dd><Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/app/brokers/${email.broker.id}`}>{email.broker.companyName}</Link></dd></>)}
          {!email.sequence && email.negotiationId && (<><dt className="text-muted">From</dt><dd>Rate negotiation</dd></>)}
          {email.sequence && (<><dt className="text-muted">Sequence</dt><dd><Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/app/sequences/${email.sequence.id}`}>{email.sequence.name}</Link></dd></>)}
          <dt className="text-muted">Mailbox</dt><dd>{email.emailAccount?.label || email.emailAccount?.fromEmail || 'Default mailbox'}</dd>
          <dt className="text-muted">Waiting</dt><dd>{relative(email.createdAt)}</dd>
        </dl>
        <Notes email={email} />
        <Field label="Subject"><Input value={f.subject} maxLength={300} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
        <Field label="Message" hint="Plain text. Your signature and the unsubscribe link are already handled.">
          <Textarea rows={12} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function SubjectCell({ m }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {m.aiGenerated && <AiBadge />}
      <span className="line-clamp-1 max-w-[340px]">{m.subject || <span className="text-muted">(no subject)</span>}</span>
    </span>
  );
}

function StateBadge({ m }) {
  if (m.sequence?.ended) return <Badge color="red">Sequence ended</Badge>;
  if (m.needsWriting) return <Badge color="amber">Needs writing</Badge>;
  if (m.note) return <Badge color="amber">Check figures</Badge>;
  return <Badge color="blue">Ready</Badge>;
}

export default function ReviewQueue() {
  const toast = useToast();
  const confirm = useConfirm();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(() => new Set());
  const [open, setOpen] = useState(null);
  const query = useQuery({ queryKey: ['emails', 'review', page], queryFn: () => api.get('/api/email/review', { page, pageSize: PAGE_SIZE }) });
  useEffect(() => setSelected(new Set()), [page]);
  const bulk = useApiMutation((ids) => api.post('/api/email/review/approve-bulk', { ids }), {
    invalidate,
    onSuccess: (r) => {
      setSelected(new Set());
      if (!r.skipped?.length) toast.success(r.message);
      else {
        const why = [...new Set(r.skipped.map((s) => s.reason))].slice(0, 2).join('; ');
        toast.info(`${r.approved} approved, ${r.skipped.length} not approved: ${why}`);
      }
    },
  });
  const approveSelected = async () => {
    const n = selected.size;
    if (await confirm({ title: `Approve and send ${n} ${n === 1 ? 'email' : 'emails'}?`, message: 'They go out in the background, within your mailbox limits. Emails that need writing or whose sequence ended are left here.', confirmLabel: 'Approve & send' })) {
      bulk.mutate([...selected]);
    }
  };

  const columns = [
    { key: 'about', header: 'To', render: (m) => <span className="font-medium">{who(m)}</span> },
    { key: 'subject', header: 'Subject', render: (m) => <SubjectCell m={m} /> },
    { key: 'source', header: 'From', render: (m) => <span className="line-clamp-1 max-w-[200px] text-fg-2">{source(m) || '—'}</span> },
    { key: 'state', header: 'Status', render: (m) => <StateBadge m={m} /> },
    { key: 'waiting', header: 'Waiting', render: (m) => <span className="whitespace-nowrap text-muted">{relative(m.createdAt)}</span> },
    { key: 'open', header: '', className: 'text-right', render: (m) => <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setOpen(m); }}>Review</Button> },
  ];

  return (
    <Card bodyClass="p-0" title={<span className="text-sm text-fg-2">Nothing here is sent until you approve it.</span>}
      actions={<Button size="sm" icon={Check} disabled={!selected.size} loading={bulk.isPending} onClick={approveSelected}>Approve selected{selected.size ? ` (${selected.size})` : ''}</Button>}>
      <QueryState query={query}>
        {(data) => (
          <>
            <DataTable columns={columns} rows={data.items} onRowClick={setOpen} selected={selected} onSelect={setSelected}
              mobileRow={(m, { selected: on, toggle }) => (
                <div className="flex items-start gap-3">
                  <input type="checkbox" aria-label="Select email" checked={on} onChange={toggle} onClick={(e) => e.stopPropagation()} className="dd-check mt-0.5 size-4 shrink-0 accent-brand-600" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{who(m)}</span>
                      <StateBadge m={m} />
                    </div>
                    <SubjectCell m={m} />
                    <p className="truncate text-xs text-muted">{source(m) ? `${source(m)} · ` : ''}{relative(m.createdAt)}</p>
                  </div>
                </div>
              )}
              empty={<EmptyState icon={ClipboardCheck} title="Nothing waiting for approval">Sequence email steps set to &quot;AI writes, I approve&quot; wait here until you approve them.</EmptyState>} />
            <div className="px-3"><Pagination page={data.page} pages={data.pages} total={data.total} onPage={setPage} /></div>
          </>
        )}
      </QueryState>
      {open && <ReviewEditor email={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}
