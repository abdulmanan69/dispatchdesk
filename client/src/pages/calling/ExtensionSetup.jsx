import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Copy, Check, KeyRound, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { relative, date } from '../../lib/format.js';
import { Button, Card, DataTable, EmptyState, Field, Input, PageHeader, QueryState, Select, Badge } from '../../components/ui.jsx';
import { useConfirm } from '../../components/Modal.jsx';
import { useToast } from '../../components/Toast.jsx';

function Step({ n, title, children }) {
  return (
    <li className="grid grid-cols-[32px_1fr] gap-4">
      <span className="flex size-8 items-center justify-center rounded-lg border border-line font-mono text-xs text-fg-2">{n}</span>
      <div className="min-w-0 pb-2">
        <h3 className="text-sm font-medium leading-8">{title}</h3>
        <div className="mt-1 space-y-3 text-sm text-fg-2">{children}</div>
      </div>
    </li>
  );
}

function NewToken() {
  const [name, setName] = useState('Chrome extension');
  const [expires, setExpires] = useState('90');
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const create = useApiMutation(
    () => api.post('/api/tokens', { name: name.trim() || 'Browser extension', expiresInDays: expires === 'never' ? null : Number(expires) }),
    { invalidate: [['tokens']], onSuccess: (d) => { setCreated(d.token); setCopied(false); } },
  );
  const copy = async () => {
    try { await navigator.clipboard.writeText(created); setCopied(true); toast.success('Token copied'); }
    catch { toast.error('Copy failed. Select the token and copy it manually.'); }
  };

  if (created) {
    return (
      <div className="space-y-3">
        <p className="text-fg">Copy this token now. It won’t be shown again.</p>
        <div className="flex gap-2">
          <Input readOnly value={created} className="font-mono text-xs" aria-label="New token" onFocus={(e) => e.target.select()} />
          <Button variant="secondary" icon={copied ? Check : Copy} onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
        </div>
        <p>Paste it on the extension’s settings page and click Save and test.</p>
        <Button variant="link" onClick={() => setCreated(null)}>Create another token</Button>
      </div>
    );
  }
  return (
    <form className="grid gap-3 sm:grid-cols-[1fr_160px_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
      <Field label="Token name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required /></Field>
      <Field label="Expires">
        <Select value={expires} onChange={(e) => setExpires(e.target.value)}>
          <option value="30">In 30 days</option>
          <option value="90">In 90 days</option>
          <option value="365">In 1 year</option>
          <option value="never">Never</option>
        </Select>
      </Field>
      <Button type="submit" icon={KeyRound} loading={create.isPending}>Create token</Button>
    </form>
  );
}

function Tokens() {
  const q = useQuery({ queryKey: ['tokens'], queryFn: () => api.get('/api/tokens') });
  const confirm = useConfirm();
  const revoke = useApiMutation((id) => api.del(`/api/tokens/${id}`), { success: 'Token revoked', invalidate: [['tokens']] });
  return (
    <QueryState query={q}>
      {(d) => (
        <DataTable rows={d.items}
          empty={<EmptyState icon={KeyRound} title="No tokens yet">Create one above to connect the extension.</EmptyState>}
          columns={[
            { key: 'name', header: 'Name', render: (t) => <div><div className="font-medium">{t.name}</div><div className="font-mono text-xs text-muted">{t.prefix}…</div></div> },
            { key: 'status', header: 'Status', render: (t) => (t.revokedAt ? <Badge>Revoked</Badge> : t.active ? <Badge color="green">Active</Badge> : <Badge color="amber">Expired</Badge>) },
            { key: 'used', header: 'Last used', render: (t) => <span className="text-fg-2">{t.lastUsedAt ? relative(t.lastUsedAt) : 'Never'}</span> },
            { key: 'expires', header: 'Expires', render: (t) => <span className="font-mono text-xs text-fg-2">{t.expiresAt ? date(t.expiresAt) : 'Never'}</span> },
            { key: 'created', header: 'Created', render: (t) => <span className="font-mono text-xs text-fg-2">{date(t.createdAt)}</span> },
            {
              key: 'actions', header: '', className: 'text-right', render: (t) => (t.active ? (
                <Button size="sm" variant="ghost" className="text-red-600" onClick={async () => {
                  if (await confirm({ title: 'Revoke token?', message: `“${t.name}” stops working immediately. Any browser using it is disconnected.`, danger: true, confirmLabel: 'Revoke' })) revoke.mutate(t.id);
                }}>Revoke</Button>
              ) : null),
            },
          ]} />
      )}
    </QueryState>
  );
}

export default function ExtensionSetup() {
  const info = useQuery({ queryKey: ['extension', 'info'], queryFn: () => api.get('/api/extension/info') });
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    setDownloading(true);
    try { await api.download('/api/extension/download', 'dispatchdesk-clicker.zip'); }
    catch (e) { toast.error(e); }
    finally { setDownloading(false); }
  };

  return (
    <div>
      <PageHeader title="Browser extension" subtitle="Call carriers and add USDOT or MC numbers to your CRM from FMCSA SAFER, load boards and any other site" />
      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card title="Set up in three steps">
          <ol className="space-y-6">
            <Step n="1" title="Download the extension">
              <p>The zip is already pointed at this server{info.data ? <> (<span className="font-mono text-xs">{info.data.appUrl}</span>)</> : null}.</p>
              <Button icon={Download} loading={downloading} onClick={download} disabled={info.isError}>
                Download{info.data ? ` v${info.data.version}` : ''}
              </Button>
              {info.isError && <p className="text-red-600">{info.error.message}</p>}
            </Step>
            <Step n="2" title="Install it in Chrome or Edge">
              <ol className="list-decimal space-y-1 pl-5">
                <li>Unzip the file.</li>
                <li>Open <span className="font-mono text-xs text-fg">chrome://extensions</span> or <span className="font-mono text-xs text-fg">edge://extensions</span>.</li>
                <li>Turn on Developer mode, click Load unpacked and choose the unzipped folder.</li>
                <li>Pin DispatchDesk Clicker to the toolbar.</li>
              </ol>
            </Step>
            <Step n="3" title="Connect it to your account">
              <p>Create a token here, then paste it on the extension’s settings page, which opens after installing.</p>
              <NewToken />
            </Step>
          </ol>
        </Card>

        <div className="space-y-6">
          <Card title="What it does">
            <ul className="space-y-3 text-sm text-fg-2">
              <li><span className="text-fg">Lists numbers on the page.</span> Phone, USDOT and MC numbers appear in the toolbar popup.</li>
              <li><span className="text-fg">Click to call.</span> Uses the calling provider you set in Power dialer settings: phone app, Google Voice, Teams, Twilio and others.</li>
              <li><span className="text-fg">Adds carriers.</span> Fetches the record from the FMCSA census and saves it to your carrier list.</li>
              <li><span className="text-fg">Right-click.</span> Select a number on any page to call it or look it up.</li>
              <li><span className="text-fg">Workspace.</span> Open workspace (<kbd className="font-mono text-xs">Alt+Shift+D</kbd>) places the power dialer and Google Voice side by side, 50/50 or 60/40.</li>
              <li><span className="text-fg">Side panel.</span> Shows the next carrier, script and local time. Log the outcome with keys 1–8, add notes, set a follow-up and send a template email without leaving the call.</li>
            </ul>
          </Card>
          <Card title={<span className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4 text-muted" strokeWidth={1.75} />Privacy</span>}>
            <ul className="space-y-2 text-sm text-fg-2">
              <li>The extension reads a page only when you click its toolbar button.</li>
              <li>It talks only to this server. Nothing runs on websites in the background.</li>
              <li>Tokens can’t open admin, billing, team or account-security settings.</li>
              <li>A call starts only when you click Call.</li>
            </ul>
          </Card>
        </div>
      </div>

      <Card title="Your tokens" className="mt-6" bodyClass="p-0">
        <Tokens />
      </Card>
    </div>
  );
}
