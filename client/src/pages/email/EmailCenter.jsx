import { useEffect, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Mail, Plus, Trash2, RefreshCw, Send, X, Plug, FileText, ShieldOff, Pencil } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../components/Toast.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import { ComposeForm } from '../../components/email/ComposeModal.jsx';
import { ConnectMailboxModal, ReconnectSmtpModal, ProviderMark, startOAuth, useConnectOptions } from '../../components/email/ConnectMailbox.jsx';
import {
  Badge, Button, Card, DataTable, EmptyState, Field, Input, PageHeader, Pagination, QueryState, Select, StatCard, Switch, Tabs, Textarea,
} from '../../components/ui.jsx';
import { dateTime, label, relative } from '../../lib/format.js';

const STATUS_COLOR = { sent: 'green', scheduled: 'blue', draft: 'gray', failed: 'red', canceled: 'gray', sending: 'amber' };

function MessageView({ email, onClose }) {
  return (
    <Modal open={!!email} onClose={onClose} title={email?.subject || 'Email'} size="lg">
      {email && (
        <div className="space-y-3 text-sm">
          <dl className="grid grid-cols-[90px_1fr] gap-x-3 gap-y-1 text-[13px]">
            <dt className="text-muted">Status</dt><dd><Badge color={STATUS_COLOR[email.status]}>{label(email.status)}</Badge></dd>
            <dt className="text-muted">To</dt><dd>{email.toEmail || '—'}</dd>
            <dt className="text-muted">From</dt><dd>{email.emailAccount?.label || 'Default mailbox'}</dd>
            {email.carrier && (<><dt className="text-muted">Carrier</dt><dd><Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/app/carriers/${email.carrier.id}`}>{email.carrier.companyName}</Link></dd></>)}
            {email.broker && (<><dt className="text-muted">Broker</dt><dd><Link className="text-brand-700 hover:underline dark:text-brand-300" to={`/app/brokers/${email.broker.id}`}>{email.broker.companyName}</Link></dd></>)}
            {email.sentAt && (<><dt className="text-muted">Sent</dt><dd>{dateTime(email.sentAt)}</dd></>)}
            {email.status === 'scheduled' && (<><dt className="text-muted">Sends</dt><dd>{dateTime(email.nextAttemptAt || email.scheduledAt)}</dd></>)}
            {email.attempts > 0 && (<><dt className="text-muted">Attempts</dt><dd>{email.attempts}</dd></>)}
            {email.providerMessageId && (<><dt className="text-muted">Provider id</dt><dd className="break-all font-mono text-xs">{email.providerMessageId}</dd></>)}
          </dl>
          {email.error && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">{email.error}</p>}
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-md border border-line bg-surface-2/50 p-3 font-sans text-sm">{email.body}</pre>
        </div>
      )}
    </Modal>
  );
}

function DraftEditor({ draft, onClose }) {
  const [f, setF] = useState(null);
  useEffect(() => { if (draft) setF({ toEmail: draft.toEmail, subject: draft.subject, body: draft.body }); }, [draft]);
  const save = useApiMutation((v) => api.patch(`/api/email/messages/${draft.id}`, v), { invalidate: [['emails']], success: 'Draft saved' });
  const send = useApiMutation(async (v) => { await api.patch(`/api/email/messages/${draft.id}`, v); return api.post(`/api/email/messages/${draft.id}/send`); }, {
    invalidate: [['emails'], ['email', 'status']],
    onSuccess: (r) => { if (r.outcome === 'sent') onClose(); },
  });
  const toast = useToast();
  useEffect(() => {
    if (!send.data) return;
    if (send.data.outcome === 'sent') toast.success('Email accepted by your mail provider.');
    else if (send.data.outcome === 'failed') toast.error(`Not sent: ${send.data.message}`);
    else toast.info(send.data.message);
  }, [send.data, toast]);
  return (
    <Modal open={!!draft} onClose={onClose} title="Edit draft" size="lg"
      footer={f && (<>
        <Button variant="secondary" loading={save.isPending} onClick={() => save.mutate(f)}>Save</Button>
        <Button icon={Send} loading={send.isPending} onClick={() => send.mutate(f)}>Send now</Button>
      </>)}>
      {f && (
        <div className="space-y-3">
          <Field label="To"><Input type="email" value={f.toEmail} onChange={(e) => setF({ ...f, toEmail: e.target.value })} /></Field>
          <Field label="Subject"><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
          <Field label="Message"><Textarea rows={12} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
        </div>
      )}
    </Modal>
  );
}

function MessageList({ status }) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [view, setView] = useState(null);
  const [edit, setEdit] = useState(null);
  const confirm = useConfirm();
  const toast = useToast();
  useEffect(() => setPage(1), [status, q]);
  const query = useQuery({ queryKey: ['emails', status, page, q], queryFn: () => api.get('/api/email/messages', { status, page, q, pageSize: 25 }) });
  const cancel = useApiMutation((id) => api.post(`/api/email/messages/${id}/cancel`), { invalidate: [['emails'], ['email', 'status']], success: 'Scheduled email canceled' });
  const remove = useApiMutation((id) => api.del(`/api/email/messages/${id}`), { invalidate: [['emails']], success: 'Deleted' });
  const retry = useApiMutation((id) => api.post(`/api/email/messages/${id}/send`), {
    invalidate: [['emails'], ['email', 'status']],
    onSuccess: (r) => (r.outcome === 'sent' ? toast.success('Email accepted by your mail provider.') : r.outcome === 'failed' ? toast.error(`Still failing: ${r.message}`) : toast.info(r.message)),
  });

  const columns = [
    { key: 'toEmail', header: 'To', render: (m) => <span className="font-medium">{m.toEmail || <span className="text-muted">No recipient</span>}</span> },
    { key: 'subject', header: 'Subject', render: (m) => <span className="line-clamp-1 max-w-[340px]">{m.subject || <span className="text-muted">(no subject)</span>}</span> },
    { key: 'about', header: 'Regarding', render: (m) => m.carrier?.companyName || m.broker?.companyName || '—' },
    { key: 'when', header: status === 'scheduled' ? 'Sends' : status === 'sent' ? 'Sent' : 'Updated', render: (m) => <span className="whitespace-nowrap text-muted">{status === 'scheduled' ? dateTime(m.nextAttemptAt || m.scheduledAt) : status === 'sent' ? dateTime(m.sentAt) : relative(m.updatedAt)}</span> },
    { key: 'status', header: 'Status', render: (m) => <Badge color={STATUS_COLOR[m.status]}>{label(m.status)}{m.aiGenerated ? ' · AI' : ''}</Badge> },
    {
      key: 'actions', header: '', className: 'text-right', render: (m) => (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {m.status === 'draft' && <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEdit(m)}>Edit</Button>}
          {m.status === 'scheduled' && <Button size="sm" variant="ghost" icon={X} onClick={() => cancel.mutate(m.id)}>Cancel</Button>}
          {m.status === 'failed' && <Button size="sm" variant="ghost" icon={RefreshCw} loading={retry.isPending && retry.variables === m.id} onClick={() => retry.mutate(m.id)}>Retry</Button>}
          {['draft', 'failed', 'canceled'].includes(m.status) && (
            <Button size="sm" variant="ghost" icon={Trash2} aria-label="Delete" onClick={async () => { if (await confirm({ title: 'Delete email?', message: 'This removes it permanently.', danger: true })) remove.mutate(m.id); }} />
          )}
        </div>
      ),
    },
  ];

  return (
    <Card bodyClass="p-0" title={<Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search subject or recipient" className="max-w-xs" aria-label="Search emails" />}>
      <QueryState query={query}>
        {(data) => (
          <>
            <DataTable columns={columns} rows={data.items} onRowClick={setView}
              empty={<EmptyState icon={Mail} title={`No ${status} emails`}>{status === 'failed' ? 'Emails the provider rejected show up here with the reason.' : null}</EmptyState>} />
            <div className="px-3"><Pagination page={data.page} pages={data.pages} total={data.total} onPage={setPage} /></div>
          </>
        )}
      </QueryState>
      <MessageView email={view} onClose={() => setView(null)} />
      <DraftEditor draft={edit} onClose={() => setEdit(null)} />
    </Card>
  );
}

function Templates() {
  const [editing, setEditing] = useState(null);
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['email', 'templates'], queryFn: () => api.get('/api/email/templates') });
  const fields = useQuery({ queryKey: ['email', 'merge-fields'], queryFn: () => api.get('/api/email/merge-fields') });
  const save = useApiMutation((t) => (t.id ? api.patch(`/api/email/templates/${t.id}`, t) : api.post('/api/email/templates', t)), {
    invalidate: [['email', 'templates']], success: 'Template saved', onSuccess: () => setEditing(null),
  });
  const remove = useApiMutation((id) => api.del(`/api/email/templates/${id}`), { invalidate: [['email', 'templates']], success: 'Template deleted' });
  const bodyRef = useRef(null);
  const insert = (token) => {
    const el = bodyRef.current;
    const v = editing.body || '';
    const pos = el ? el.selectionStart : v.length;
    setEditing({ ...editing, body: `${v.slice(0, pos)}{{${token}}}${v.slice(pos)}` });
  };
  return (
    <Card title="Templates" actions={<Button size="sm" icon={Plus} onClick={() => setEditing({ name: '', subject: '', body: '', category: 'carrier' })}>New template</Button>} bodyClass="p-0">
      <QueryState query={q} isEmpty={(d) => !d.items.length}
        empty={<EmptyState icon={FileText} title="No templates yet" action={<Button size="sm" icon={Plus} onClick={() => setEditing({ name: '', subject: '', body: '', category: 'carrier' })}>Create your first template</Button>}>Reusable emails with merge fields such as {'{{company}}'} and {'{{first_name}}'}.</EmptyState>}>
        {(d) => (
          <DataTable rows={d.items} onRowClick={(t) => setEditing(t)} columns={[
            { key: 'name', header: 'Name', render: (t) => <span className="font-medium">{t.name}</span> },
            { key: 'category', header: 'Category', render: (t) => <Badge>{label(t.category)}</Badge> },
            { key: 'subject', header: 'Subject', render: (t) => <span className="line-clamp-1 max-w-sm">{t.subject}</span> },
            { key: 'updatedAt', header: 'Updated', render: (t) => <span className="text-muted">{relative(t.updatedAt)}</span> },
            { key: 'x', header: '', className: 'text-right', render: (t) => (
              <Button size="sm" variant="ghost" icon={Trash2} aria-label="Delete template" onClick={async (e) => { e.stopPropagation(); if (await confirm({ title: `Delete "${t.name}"?`, message: 'Sequence steps using it will keep working only if they have their own text.', danger: true })) remove.mutate(t.id); }} />
            ) },
          ]} />
        )}
      </QueryState>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Edit template' : 'New template'} size="lg"
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate(editing)}>Save template</Button></>}>
        {editing && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" required><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
              <Field label="Category">
                <Select value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })}>
                  {['carrier', 'broker', 'follow_up', 'other'].map((c) => <option key={c} value={c}>{label(c)}</option>)}
                </Select>
              </Field>
            </div>
            <Field label="Subject" required><Input value={editing.subject} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} /></Field>
            <Field label="Body" required><Textarea ref={bodyRef} rows={12} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} /></Field>
            <div>
              <p className="mb-1.5 text-xs text-muted">Insert merge field at cursor:</p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(fields.data?.fields || {}).map(([k, desc]) => (
                  <button key={k} type="button" title={desc} onClick={() => insert(k)} className="rounded border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11.5px] hover:border-brand-400">{`{{${k}}}`}</button>
                ))}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}

const PROVIDER_NAME = {
  gmail: 'Google', outlook: 'Microsoft', gmail_smtp: 'Gmail (app password)', outlook_smtp: 'Outlook (SMTP)', yahoo: 'Yahoo Mail', aol: 'AOL Mail',
  zoho: 'Zoho Mail', icloud: 'iCloud Mail', hostinger: 'Hostinger', godaddy: 'GoDaddy', fastmail: 'Fastmail', smtp: 'SMTP',
};
const isOAuth = (a) => a.provider === 'gmail' || a.provider === 'outlook';
const tileCls = 'flex items-center gap-3 rounded-xl border border-line p-3 text-left transition-ui hover:border-line-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30';

function Mailboxes() {
  const toast = useToast();
  const confirm = useConfirm();
  const [connect, setConnect] = useState(null); // null | { start }
  const [limits, setLimits] = useState(null);
  const [reconnect, setReconnect] = useState(null);
  const accounts = useQuery({ queryKey: ['email', 'accounts'], queryFn: () => api.get('/api/email/accounts') });
  const options = useConnectOptions();
  const inv = [['email', 'accounts'], ['email', 'status']];
  const test = useApiMutation((id) => api.post(`/api/email/accounts/${id}/test`), { invalidate: inv, success: (r) => `Test email accepted, check ${r.to}` });
  const patch = useApiMutation(({ id, ...v }) => api.patch(`/api/email/accounts/${id}`, v), { invalidate: inv, success: 'Mailbox updated', onSuccess: () => setLimits(null) });
  const remove = useApiMutation((id) => api.del(`/api/email/accounts/${id}`), { invalidate: inv, success: (r) => (r.removed ? 'Mailbox removed' : 'Mailbox disconnected') });
  const oauthOpt = (key) => options.data?.oauth.find((o) => o.key === key);
  const quick = (key) => {
    const o = oauthOpt(key);
    if (!o) return setConnect({});
    if (o.available) return startOAuth(key, toast);
    return setConnect({ start: { type: 'oauth-off', oauth: o } });
  };
  const doReconnect = (a) => (isOAuth(a) ? quick(a.provider) : setReconnect(a));

  return (
    <div className="space-y-4">
      <Card title="Mailboxes" actions={<Button size="sm" icon={Plus} onClick={() => setConnect({})}>Connect mailbox</Button>}>
        <div className="grid gap-2 sm:grid-cols-3">
          {[['gmail', 'Google', 'Gmail and Google Workspace'], ['outlook', 'Microsoft', 'Outlook.com and Microsoft 365']].map(([key, name, desc]) => {
            const o = oauthOpt(key);
            return (
              <button key={key} type="button" onClick={() => quick(key)} className={tileCls}>
                <ProviderMark name={name} />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">Continue with {name}</span>
                  <span className="block truncate text-xs text-muted">{o && !o.available ? 'Sign-in not enabled; app password works' : desc}</span>
                </span>
              </button>
            );
          })}
          <button type="button" onClick={() => setConnect({})} className={tileCls}>
            <ProviderMark name="Other" />
            <span className="min-w-0">
              <span className="block text-sm font-medium">Other provider</span>
              <span className="block truncate text-xs text-muted">Yahoo, Zoho, iCloud, Hostinger, GoDaddy, SMTP</span>
            </span>
          </button>
        </div>
      </Card>

      <QueryState query={accounts} isEmpty={(d) => !d.items.length}
        empty={<Card><EmptyState icon={Mail} title="No mailboxes yet" action={<Button icon={Plus} onClick={() => setConnect({})}>Connect mailbox</Button>}>Connect the mailbox you send from. Emails, templates and sequence steps all go out through it.</EmptyState></Card>}>
        {(d) => (
          <div className="grid gap-3 lg:grid-cols-2">
            {d.items.map((a) => (
              <Card key={a.id}>
                <div className="flex items-start gap-3">
                  <ProviderMark name={PROVIDER_NAME[a.provider] || a.provider} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{a.fromEmail}</p>
                    <p className="truncate text-xs text-muted">{PROVIDER_NAME[a.provider] || label(a.provider)}{a.smtpHost ? ` · ${a.smtpHost}:${a.smtpPort}` : ''}{a.fromName ? ` · sends as ${a.fromName}` : ''}</p>
                  </div>
                  <Badge color={a.status === 'connected' ? 'green' : a.status === 'error' ? 'red' : 'gray'}>{a.status === 'error' ? 'Needs attention' : label(a.status)}</Badge>
                </div>
                {a.lastError && a.status !== 'connected' && (
                  <p className="mt-3 break-words rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200">{a.lastError}</p>
                )}
                <dl className="mt-4 grid grid-cols-3 gap-2 text-xs">
                  <div><dt className="text-muted">Sent today</dt><dd className="mt-0.5 text-sm font-medium tabular">{a.sentToday} / {a.dailyLimit}</dd></div>
                  <div><dt className="text-muted">Between sends</dt><dd className="mt-0.5 text-sm font-medium tabular">{a.cooldownSeconds}s</dd></div>
                  <div><dt className="text-muted">Last send</dt><dd className="mt-0.5 text-sm font-medium">{a.lastSentAt ? relative(a.lastSentAt) : 'Never'}</dd></div>
                </dl>
                <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                  {a.status === 'connected' ? (
                    <Switch checked={a.isDefault} disabled={a.isDefault || patch.isPending} onChange={() => patch.mutate({ id: a.id, isDefault: true })}
                      label={<span className="text-[13px]">{a.isDefault ? 'Default sender' : 'Make default'}</span>} />
                  ) : (
                    <Button size="sm" icon={RefreshCw} onClick={() => doReconnect(a)}>Reconnect</Button>
                  )}
                  <span className="flex-1" />
                  {a.status === 'connected' && <Button size="sm" variant="ghost" icon={Send} loading={test.isPending && test.variables === a.id} onClick={() => test.mutate(a.id)}>Send test</Button>}
                  {a.status !== 'disconnected' && <Button size="sm" variant="ghost" onClick={() => setLimits({ id: a.id, label: a.label, dailyLimit: a.dailyLimit, cooldownSeconds: a.cooldownSeconds })}>Limits</Button>}
                  <Button size="sm" variant="ghost" className="text-red-600" onClick={async () => {
                    const removing = a.status === 'disconnected';
                    if (await confirm({ title: removing ? 'Remove mailbox?' : 'Disconnect mailbox?', message: removing ? 'The mailbox entry is deleted. Sent history is kept.' : 'Stored credentials are erased. Scheduled emails will use another connected mailbox.', danger: true, confirmLabel: removing ? 'Remove' : 'Disconnect' })) remove.mutate(a.id);
                  }}>{a.status === 'disconnected' ? 'Remove' : 'Disconnect'}</Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </QueryState>

      <ConnectMailboxModal open={!!connect} start={connect?.start} onClose={() => setConnect(null)} />
      {reconnect && <ReconnectSmtpModal account={reconnect} onClose={() => setReconnect(null)} />}
      <Modal open={!!limits} onClose={() => setLimits(null)} title="Sending limits" size="sm"
        footer={<Button loading={patch.isPending} onClick={() => patch.mutate({ id: limits.id, label: limits.label, dailyLimit: Number(limits.dailyLimit), cooldownSeconds: Number(limits.cooldownSeconds) })}>Save</Button>}>
        {limits && (
          <div className="space-y-3">
            <Field label="Label"><Input value={limits.label} onChange={(e) => setLimits({ ...limits, label: e.target.value })} /></Field>
            <Field label="Daily limit" hint="Your plan's daily email limit also applies."><Input type="number" min={1} max={5000} value={limits.dailyLimit} onChange={(e) => setLimits({ ...limits, dailyLimit: e.target.value })} /></Field>
            <Field label="Cooldown between sends (seconds)"><Input type="number" min={0} max={3600} value={limits.cooldownSeconds} onChange={(e) => setLimits({ ...limits, cooldownSeconds: e.target.value })} /></Field>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Suppressions() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [email, setEmail] = useState('');
  const query = useQuery({ queryKey: ['email', 'suppressions', page, q], queryFn: () => api.get('/api/email/suppressions', { page, q }) });
  const add = useApiMutation((v) => api.post('/api/email/suppressions', v), { invalidate: [['email', 'suppressions']], success: 'Added to do-not-email list', onSuccess: () => setEmail('') });
  const remove = useApiMutation((id) => api.del(`/api/email/suppressions/${id}`), { invalidate: [['email', 'suppressions']], success: (r) => r.note });
  return (
    <Card title="Do-not-email list" bodyClass="p-0" actions={
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); add.mutate({ email }); }}>
        <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@company.com" className="w-56" aria-label="Email to suppress" />
        <Button type="submit" size="md" icon={Plus} loading={add.isPending}>Add</Button>
      </form>
    }>
      <div className="border-b border-line px-4 py-2.5">
        <p className="text-xs text-muted">Addresses here are never emailed — manually added, unsubscribed through your email footer, or bounced. Scheduled emails to them are canceled.</p>
        <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search" className="mt-2 max-w-xs" aria-label="Search suppressed emails" />
      </div>
      <QueryState query={query}>
        {(d) => (
          <>
            <DataTable rows={d.items} empty={<EmptyState icon={ShieldOff} title="No suppressed addresses" />} columns={[
              { key: 'email', header: 'Email', render: (s) => <span className="font-medium">{s.email}</span> },
              { key: 'reason', header: 'Reason', render: (s) => <Badge color={s.reason === 'unsubscribed' ? 'amber' : s.reason === 'bounced' ? 'red' : 'gray'}>{label(s.reason)}</Badge> },
              { key: 'createdAt', header: 'Added', render: (s) => <span className="text-muted">{relative(s.createdAt)}</span> },
              { key: 'x', header: '', className: 'text-right', render: (s) => <Button size="sm" variant="ghost" icon={Trash2} aria-label="Remove" onClick={() => remove.mutate(s.id)} /> },
            ]} />
            <div className="px-3"><Pagination page={d.page} pages={d.pages} total={d.total} onPage={setPage} /></div>
          </>
        )}
      </QueryState>
    </Card>
  );
}

function Signature() {
  const { user, setUser } = useAuth();
  const [sig, setSig] = useState(user?.emailSignature || '');
  const save = useApiMutation((v) => api.patch('/api/profile', v), { success: 'Signature saved', onSuccess: (d) => setUser(d.user) });
  return (
    <Card title="Email signature" footer={<div className="flex justify-end"><Button loading={save.isPending} onClick={() => save.mutate({ emailSignature: sig })}>Save signature</Button></div>}>
      <p className="mb-2 text-sm text-muted">Appended to every email you send (or placed where you write {'{{signature}}'}).</p>
      <Textarea rows={6} value={sig} onChange={(e) => setSig(e.target.value)} placeholder={'Jane Doe\nDispatcher · Example Dispatch LLC\n(555) 555-0100'} aria-label="Email signature" />
    </Card>
  );
}

const TABS = ['compose', 'sent', 'scheduled', 'drafts', 'failed', 'templates', 'mailboxes', 'suppression', 'signature'];

export default function EmailCenter() {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const tab = TABS.includes(params.get('tab')) ? params.get('tab') : 'compose';
  const status = useQuery({ queryKey: ['email', 'status'], queryFn: () => api.get('/api/email/status') });

  useEffect(() => {
    const connected = params.get('connected');
    const error = params.get('error');
    const email = params.get('email');
    if (connected) toast.success(`${email || (connected === 'gmail' ? 'Google mailbox' : 'Microsoft mailbox')} connected`);
    if (error) toast.error(error);
    if (connected || error) { params.delete('connected'); params.delete('error'); params.delete('email'); setParams(params, { replace: true }); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setTab = (t) => setParams({ tab: t });
  const s = status.data;
  return (
    <div>
      <PageHeader title="Email" subtitle="Mailboxes, templates, outreach history and opt-outs." />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Mailboxes connected" value={s?.mailboxesConnected ?? '—'} icon={Plug} />
        <StatCard label="Sent today" value={s ? `${s.sentToday}${s.limit >= 0 ? ` / ${s.limit}` : ''}` : '—'} sub={s?.planName ? `${s.planName} plan daily limit` : undefined} icon={Send} />
        <StatCard label="Scheduled" value={s?.scheduled ?? '—'} icon={Mail} />
        <StatCard label="Daily limit" value={s ? (s.limit < 0 ? 'Unlimited' : s.limit) : '—'} tone="signal" />
      </div>
      <Tabs className="mb-4" value={tab} onChange={setTab} tabs={TABS.map((t) => ({ value: t, label: label(t) }))} />
      {tab === 'compose' && <Card title="New email"><ComposeForm /></Card>}
      {tab === 'sent' && <MessageList status="sent" />}
      {tab === 'scheduled' && <MessageList status="scheduled" />}
      {tab === 'drafts' && <MessageList status="draft" />}
      {tab === 'failed' && <MessageList status="failed" />}
      {tab === 'templates' && <Templates />}
      {tab === 'mailboxes' && <Mailboxes />}
      {tab === 'suppression' && <Suppressions />}
      {tab === 'signature' && <Signature />}
    </div>
  );
}
