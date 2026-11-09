import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowUpRight, CheckCircle2, ChevronDown, Info, KeyRound, Plug, ShieldCheck, XCircle } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useToast } from '../Toast.jsx';
import { Modal } from '../Modal.jsx';
import { Button, Field, Input, Select, cx } from '../ui.jsx';

/** Monochrome letter mark used instead of provider logos. */
export function ProviderMark({ name, className }) {
  return (
    <span aria-hidden className={cx('inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-sm font-medium text-fg-2', className)}>
      {name.replace(/[^A-Za-z]/g, '').slice(0, 1).toUpperCase()}
    </span>
  );
}

export const useConnectOptions = () => useQuery({ queryKey: ['email', 'connect-options'], queryFn: () => api.get('/api/email/connect-options'), staleTime: 60000 });

/** Start the Google / Microsoft consent redirect. The server signs the state and binds it to this user. */
export async function startOAuth(provider, toast) {
  try {
    const { url } = await api.get(`/api/email/oauth/${provider}/start`);
    window.location.assign(url);
  } catch (err) {
    toast.error(err);
  }
}

function Tile({ name, description, onClick, badge, muted }) {
  return (
    <button type="button" onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-3 text-left transition-ui hover:border-line-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30">
      <ProviderMark name={name} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-medium">{name}{badge && <span className={cx('text-[11px] font-normal', muted ? 'text-muted' : 'text-brand-700 dark:text-brand-300')}>{badge}</span>}</span>
        <span className="block truncate text-xs text-muted">{description}</span>
      </span>
    </button>
  );
}

function Picker({ options, onPick }) {
  const toast = useToast();
  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-2 text-[13px] font-medium">Sign in with your provider</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          {options.oauth.map((o) => (
            <Tile key={o.key} name={o.name} description={o.description} badge={o.available ? 'One click' : 'Not enabled yet'} muted={!o.available}
              onClick={() => (o.available ? startOAuth(o.key, toast) : onPick({ type: 'oauth-off', oauth: o }))} />
          ))}
        </div>
      </section>
      <section>
        <h3 className="mb-2 text-[13px] font-medium">Connect with an app password or SMTP</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          {options.smtp.map((p) => (
            <Tile key={p.key} name={p.name} description={p.host ? `${p.host}:${p.port}` : 'Enter your server settings'} onClick={() => onPick({ type: 'smtp', preset: p })} />
          ))}
        </div>
      </section>
      <p className="flex items-start gap-2 text-xs text-muted"><ShieldCheck className="mt-0.5 size-3.5 shrink-0" />Passwords and tokens are encrypted at rest and never shown again. Sign-in connections only get permission to send mail.</p>
    </div>
  );
}

function OAuthUnavailable({ oauth, options, onPick }) {
  const fallback = options.smtp.find((p) => p.key === oauth.fallback);
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-xl border border-line bg-surface-2 p-4">
        <Info className="mt-0.5 size-4 shrink-0 text-muted" />
        <div className="space-y-1 text-sm">
          <p className="font-medium">Your administrator hasn&apos;t enabled {oauth.name} sign-in yet</p>
          <p className="text-fg-2">One-click sign-in needs a {oauth.name === 'Google' ? 'Google Cloud OAuth client' : 'Microsoft Entra app registration'} added once in Admin → Settings. Until then you can connect the same mailbox with an app password.</p>
        </div>
      </div>
      {fallback && <Button icon={KeyRound} onClick={() => onPick({ type: 'smtp', preset: fallback })}>Use an app password instead</Button>}
    </div>
  );
}

const SECURITY = [['ssl', 'SSL/TLS (usually port 465)'], ['starttls', 'STARTTLS (usually port 587)']];

function SmtpStep({ preset, onDone }) {
  const [f, setF] = useState({
    fromEmail: '', fromName: '', password: '', label: '', host: preset.host, port: String(preset.port), security: preset.secure ? 'ssl' : 'starttls',
    user: '', dailyLimit: String(preset.dailyLimit || 50), cooldownSeconds: '30',
  });
  const [advanced, setAdvanced] = useState(preset.key === 'smtp');
  const [check, setCheck] = useState(null);
  const set = (k) => (e) => { setCheck(null); setF((x) => ({ ...x, [k]: e.target.value })); };
  const body = () => ({
    provider: preset.key, fromEmail: f.fromEmail.trim(), fromName: f.fromName || undefined, password: f.password, label: f.label || undefined,
    host: f.host || undefined, port: Number(f.port) || undefined, secure: f.security === 'ssl', user: f.user || undefined,
    dailyLimit: Number(f.dailyLimit) || 50, cooldownSeconds: Number(f.cooldownSeconds) || 0,
  });
  const verify = useApiMutation((b) => api.post('/api/email/accounts/smtp/verify', b), {
    onSuccess: (d) => setCheck({ ok: true, message: d.message }),
    onError: (e) => setCheck({ ok: false, message: e.message }),
  });
  const connect = useApiMutation((b) => api.post('/api/email/accounts/smtp', b), {
    invalidate: [['email', 'accounts'], ['email', 'status']],
    success: (d) => `${d.account.fromEmail} connected`,
    onSuccess: onDone,
    onError: (e) => setCheck({ ok: false, message: e.message }),
  });
  const ready = f.fromEmail.trim() && f.password && (f.host || preset.host);
  return (
    <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); if (ready) connect.mutate(body()); }}>
      <div className="flex items-start gap-3">
        <ProviderMark name={preset.name} />
        <div className="min-w-0 space-y-2 text-sm">
          <p className="font-medium">{preset.name}</p>
          <ol className="list-decimal space-y-0.5 pl-4 text-fg-2">{preset.steps.map((s) => <li key={s}>{s}</li>)}</ol>
          {preset.helpUrl && (
            <a href={preset.helpUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-[13px] text-brand-700 hover:underline dark:text-brand-300">
              Official instructions <ArrowUpRight className="size-3.5" />
            </a>
          )}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email address" required><Input type="email" autoComplete="email" value={f.fromEmail} onChange={set('fromEmail')} placeholder="you@company.com" /></Field>
        <Field label={preset.password || 'Password'} required hint="Encrypted at rest"><Input type="password" autoComplete="new-password" value={f.password} onChange={set('password')} /></Field>
        <Field label="Sender name" hint="Shown to recipients"><Input value={f.fromName} onChange={set('fromName')} placeholder="Defaults to your name" /></Field>
        <Field label="Label"><Input value={f.label} onChange={set('label')} placeholder={`${preset.name} — ${f.fromEmail || 'address'}`} /></Field>
      </div>

      <div className="rounded-xl border border-line">
        <button type="button" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}
          className="flex w-full items-center justify-between px-4 py-2.5 text-[13px] font-medium text-fg-2 transition-ui hover:text-fg">
          Server and sending settings
          <ChevronDown className={cx('size-4 transition-ui', advanced && 'rotate-180')} />
        </button>
        {advanced && (
          <div className="grid gap-4 border-t border-line p-4 sm:grid-cols-2">
            <Field label="SMTP server" required><Input value={f.host} onChange={set('host')} placeholder="smtp.example.com" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Port"><Input type="number" min={1} max={65535} value={f.port} onChange={set('port')} /></Field>
              <Field label="Security"><Select value={f.security} onChange={set('security')}>{SECURITY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
            </div>
            <Field label="Username" hint="Leave blank to use the email address"><Input value={f.user} onChange={set('user')} autoComplete="off" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Emails per day"><Input type="number" min={1} max={5000} value={f.dailyLimit} onChange={set('dailyLimit')} /></Field>
              <Field label="Seconds between sends"><Input type="number" min={0} max={3600} value={f.cooldownSeconds} onChange={set('cooldownSeconds')} /></Field>
            </div>
          </div>
        )}
      </div>

      {check && (
        <p role="status" className={cx('flex items-start gap-2 rounded-lg px-3 py-2 text-[13px]', check.ok ? 'bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-300' : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300')}>
          {check.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}{check.message}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" disabled={!ready} loading={verify.isPending} onClick={() => verify.mutate(body())}>Test connection</Button>
        <Button type="submit" icon={Plug} disabled={!ready} loading={connect.isPending}>Connect mailbox</Button>
      </div>
    </form>
  );
}

/** Provider picker → OAuth redirect or SMTP setup, all in one dialog. `start` can preselect a step. */
export function ConnectMailboxModal({ open, onClose, start }) {
  const q = useConnectOptions();
  const [step, setStep] = useState(null);
  useEffect(() => { if (open) setStep(start || null); }, [open, start]);
  const title = !step ? 'Connect a mailbox' : step.type === 'smtp' ? `Connect ${step.preset.name}` : `${step.oauth.name} sign-in`;
  return (
    <Modal open={open} onClose={onClose} title={title} size="lg">
      {step && (
        <button type="button" onClick={() => setStep(null)} className="mb-4 inline-flex items-center gap-1 text-[13px] text-muted transition-ui hover:text-fg">
          <ArrowLeft className="size-3.5" />All providers
        </button>
      )}
      {!q.data ? <p className="text-sm text-muted">{q.error ? q.error.message : 'Loading providers…'}</p>
        : !step ? <Picker options={q.data} onPick={setStep} />
          : step.type === 'oauth-off' ? <OAuthUnavailable oauth={step.oauth} options={q.data} onPick={setStep} />
            : <SmtpStep key={step.preset.key} preset={step.preset} onDone={onClose} />}
    </Modal>
  );
}

/** Reconnect an SMTP mailbox by re-entering the password (verified before saving). */
export function ReconnectSmtpModal({ account, onClose }) {
  const [password, setPassword] = useState('');
  const save = useApiMutation((p) => api.post(`/api/email/accounts/${account.id}/credentials`, { password: p }), {
    invalidate: [['email', 'accounts'], ['email', 'status']], success: 'Mailbox reconnected', onSuccess: onClose,
  });
  return (
    <Modal open onClose={onClose} title={`Reconnect ${account.fromEmail}`} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="reconnect-form" disabled={!password} loading={save.isPending}>Verify and save</Button></>}>
      <form id="reconnect-form" onSubmit={(e) => { e.preventDefault(); if (password) save.mutate(password); }} className="space-y-3">
        <p className="text-sm text-fg-2">Sign-in to {account.smtpHost} failed. Enter the current password or a new app password.</p>
        <Field label="Password"><Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus /></Field>
      </form>
    </Modal>
  );
}
