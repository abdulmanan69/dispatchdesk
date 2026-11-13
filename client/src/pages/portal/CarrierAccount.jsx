import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Download, EyeOff, FileText, Loader2, LogOut, Mail, Phone, Share2, ShieldCheck, Trash2, Upload, Users } from 'lucide-react';
import { date, relative } from '../../lib/format.js';
import { Badge, Button, Checkbox, EmptyState, Field, Input, Loading, Select, Switch, Tabs, cx } from '../../components/ui.jsx';
import { Modal } from '../../components/Modal.jsx';
import { Logo } from '../../components/Logo.jsx';
import { DispatcherCard, StatementsView } from '../../components/portal/Statements.jsx';

/**
 * Carrier profile (/carrier): for carriers, not dispatchers. Sign in with the USDOT (or MC) number and a code sent to
 * the email FMCSA has on file; keep documents once; see the dispatchers that invited you, share documents with each
 * one you choose, and read their statements when they turned the portal on. API: /api/public/carrier.
 */
const API = '/api/public/carrier';

function csrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)dd_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}
async function ensureCsrf() {
  if (!csrfToken()) await fetch('/api/auth/csrf', { credentials: 'same-origin' }).catch(() => {});
}
/** Same-origin call with the carrier cookie and the CSRF header. Throws Error with .status and .code. */
export async function carrierCall(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (method !== 'GET') {
    await ensureCsrf();
    opts.headers['X-CSRF-Token'] = csrfToken();
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  let res;
  try {
    res = await fetch(`${API}${path}`, opts);
  } catch {
    throw Object.assign(new Error('No connection. Check your signal and try again.'), { status: 0 });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error || `Something went wrong (${res.status})`), { status: res.status, code: data?.code || data?.details?.code });
  return data;
}
const carrierGet = (fullPath) => carrierCall('GET', fullPath.replace(API, ''));

function Shell({ children, onSignOut }) {
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-line bg-surface/95 px-4 backdrop-blur">
        <Logo compact />
        {onSignOut ? <Button size="sm" variant="ghost" icon={LogOut} onClick={onSignOut}>Sign out</Button> : <span className="text-sm text-muted">Carrier profile</span>}
      </header>
      <main className="mx-auto max-w-3xl space-y-4 px-4 pb-10 pt-5">{children}</main>
    </div>
  );
}

export default function CarrierAccount() {
  const qc = useQueryClient();
  useEffect(() => { document.title = 'Carrier profile'; }, []);
  const me = useQuery({ queryKey: ['carrier-account'], queryFn: () => carrierCall('GET', '/me'), retry: false });
  const signOut = async () => {
    await carrierCall('POST', '/logout').catch(() => {});
    qc.setQueryData(['carrier-account'], undefined);
    qc.removeQueries({ queryKey: ['carrier-account'] });
    me.refetch();
  };
  if (me.isLoading) return <Shell><Loading /></Shell>;
  if (me.isError && me.error.status === 401) return <Shell><SignIn onSignedIn={() => me.refetch()} /></Shell>;
  if (me.isError) {
    return <Shell><div className="rounded-2xl border border-line bg-surface p-6 text-center"><p className="text-fg-2">{me.error.message}</p><Button className="mt-3" variant="secondary" onClick={() => me.refetch()}>Try again</Button></div></Shell>;
  }
  return <Shell onSignOut={signOut}><Home data={me.data} onChange={(d) => qc.setQueryData(['carrier-account'], d)} reload={() => me.refetch()} /></Shell>;
}

// ---------------------------------------------------------------------------------------------------------------

/** "DispatchDesk <no-reply@x.com>" -> { name: 'DispatchDesk', address: 'no-reply@x.com' }; null when unknown. */
function senderParts(sender) {
  if (!sender) return null;
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(sender);
  return m ? { name: m[1].trim() || null, address: m[2].trim() } : { name: null, address: sender.trim() };
}

/** A bare number in MC mode is sent as "MC 123"; anything the carrier typed with a prefix goes as typed. */
export const signInNumber = (kind, raw) => {
  const v = String(raw || '').trim();
  return kind === 'mc' && /^\d+$/.test(v) ? `MC ${v}` : v;
};

function SignIn({ onSignedIn }) {
  const [kind, setKind] = useState('dot');
  const [number, setNumber] = useState('');
  const [sent, setSent] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const start = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSent(await carrierCall('POST', '/login/start', { number: signInNumber(kind, number) }));
      setCode('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const verify = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await carrierCall('POST', '/login/verify', { number: sent.dot, code });
      onSignedIn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <section className="space-y-1">
        <h1 className="text-2xl font-medium leading-tight">Your carrier profile</h1>
        <p className="text-[15px] text-fg-2">Keep your W-9, insurance and authority in one place. Share them with the dispatchers you choose, and see every dispatcher's statements in one login. Free for carriers.</p>
      </section>
      <section className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
        {!sent ? (
          <form onSubmit={start} className="space-y-3">
            <div className="inline-flex rounded-lg border border-line p-0.5" role="group" aria-label="Number type">
              {[['dot', 'USDOT'], ['mc', 'MC']].map(([k, label]) => (
                <button key={k} type="button" aria-pressed={kind === k} onClick={() => { setKind(k); setError(null); }}
                  className={cx('h-8 rounded-md px-4 text-sm transition-ui', kind === k ? 'bg-surface-2 font-medium text-fg shadow-[inset_0_0_0_1px_var(--color-line)]' : 'text-fg-2 hover:text-fg')}>
                  {label}
                </button>
              ))}
            </div>
            <Field label={kind === 'mc' ? 'MC number' : 'USDOT number'}>
              <Input value={number} onChange={(e) => setNumber(e.target.value)} inputMode="numeric" autoComplete="off" placeholder={kind === 'mc' ? '1248213' : '3636864'} autoFocus />
            </Field>
            <p className="text-xs text-muted">We email a 6-digit code to the address FMCSA has on file for this number. Only the person who reads that email can sign in.</p>
            {error && <p role="alert" className="text-sm text-c-red">{error}</p>}
            <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!number.trim()}>Send my code</Button>
          </form>
        ) : (
          <form onSubmit={verify} className="space-y-3">
            <div className="rounded-lg border border-line bg-surface-2 px-3 py-2">
              <p className="font-medium">{sent.name || `USDOT ${sent.dot}`}</p>
              <p className="text-xs text-muted tabular">USDOT {sent.dot} · not you? <button type="button" className="text-brand-700 hover:underline dark:text-brand-300" onClick={() => { setSent(null); setError(null); }}>Change the number</button></p>
            </div>
            {sent.devCode ? (
              // Local development only (EXPOSE_DEV_TOKENS): the server emails nothing and returns the code.
              <p className="rounded-lg border border-c-amber/30 bg-c-amber-soft px-3 py-2 text-sm text-fg-2">Local test server: no email was sent to {sent.maskedEmail}. Your code is <button type="button" className="font-mono font-medium text-fg underline" onClick={() => setCode(sent.devCode)}>{sent.devCode}</button>. On the live site this code is emailed from {senderParts(sent.sender)?.address || 'the DispatchDesk platform address'}, never from a dispatcher's mailbox.</p>
            ) : (
              <div className="flex items-start gap-2 text-sm text-fg-2">
                <Mail className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                <p>
                  We emailed a code to <span className="font-medium text-fg">{sent.maskedEmail}</span>, the address FMCSA has for this USDOT. It works for {sent.expiresInMinutes} minutes.
                  {' '}Look for an email from <span className="font-medium text-fg">{senderParts(sent.sender)?.name || 'DispatchDesk'}</span>{senderParts(sent.sender)?.address ? <> (<span className="font-mono text-xs">{senderParts(sent.sender).address}</span>)</> : null}.
                </p>
              </div>
            )}
            <Field label="6-digit code">
              <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="123456" autoFocus className="text-center font-mono text-lg tracking-[0.3em]" />
            </Field>
            {error && <p role="alert" className="text-sm text-c-red">{error}</p>}
            <Button type="submit" size="lg" className="w-full" loading={busy} disabled={code.length !== 6}>Sign in</Button>
            <div className="flex flex-wrap justify-end gap-2 text-sm">
              <button type="button" className="text-brand-700 hover:underline dark:text-brand-300" disabled={busy} onClick={start}>Send a new code</button>
            </div>
            <p className="text-xs text-muted">No email? Check spam and promotions. If that address is old, update your MCS-150 with FMCSA first.</p>
          </form>
        )}
      </section>
      <p className="flex items-start gap-2 text-xs text-muted"><ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />Each dispatcher sees only what you share with them. No dispatcher can see which other dispatchers you work with.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------

function Home({ data, onChange, reload }) {
  const [tab, setTab] = useState(data.connections.length ? 'dispatchers' : 'documents');
  const [statementsOf, setStatementsOf] = useState(null);
  const a = data.account;
  if (statementsOf) return <ConnectionStatements connection={statementsOf} onBack={() => setStatementsOf(null)} />;
  return (
    <div className="space-y-4">
      <section className="space-y-1">
        <h1 className="text-2xl font-medium leading-tight">{a.legalName || `USDOT ${a.dotNumber}`}</h1>
        <p className="font-mono text-xs tabular text-muted">USDOT {a.dotNumber}</p>
        <p className="inline-flex items-center gap-1.5 text-xs text-c-green"><CheckCircle2 className="size-3.5" aria-hidden />Verified with the FMCSA email {a.email}</p>
      </section>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'dispatchers', label: 'Dispatchers', count: data.connections.filter((c) => !c.share?.hidden).length }, { value: 'documents', label: 'My documents', count: data.documents.length }]} />
      {tab === 'dispatchers'
        ? <Dispatchers data={data} onChange={onChange} onStatements={setStatementsOf} onUpload={() => setTab('documents')} />
        : <Documents data={data} reload={reload} />}
      <p className="flex items-start gap-2 text-xs text-muted"><ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />Each dispatcher sees only what you share with them. No dispatcher can see which other dispatchers you work with. Files a dispatcher already received stay with them if you stop sharing.</p>
      <button type="button" className="text-xs text-muted hover:text-c-red hover:underline" onClick={async () => {
        if (!window.confirm('Delete your carrier profile and all documents in it? Dispatchers keep the copies they already received. You can sign in again later to start over.')) return;
        await carrierCall('DELETE', '/me').catch(() => {});
        reload();
      }}>Delete my carrier profile</button>
    </div>
  );
}

const REL = { customer: ['green', 'You work with them'], invited: ['blue', 'Invited you'], paused: ['amber', 'Paused'], churned: ['gray', 'Ended'] };
const AGREEMENT = { signed: 'Agreement signed', pending: 'Agreement waiting for you', expired: 'Agreement link expired', revoked: 'Agreement link turned off' };

function Dispatchers({ data, onChange, onStatements, onUpload }) {
  const [sharing, setSharing] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const label = Object.fromEntries(data.types.map((t) => [t.value, t.label]));
  const shown = data.connections.filter((c) => !c.share?.hidden);
  const hidden = data.connections.length - shown.length;
  const stop = async (c, hide = false) => {
    setBusy(c.id);
    setError(null);
    try {
      const res = await carrierCall('POST', `/connections/${encodeURIComponent(c.id)}/stop`, { hide });
      onChange({ ...data, connections: res.connections });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };
  if (!shown.length) {
    return (
      <section className="rounded-2xl border border-line bg-surface p-2">
        <EmptyState icon={Users} title="No dispatcher yet">
          When a dispatcher on DispatchDesk sends you their agreement link (for USDOT {data.account.dotNumber}), they show up here and you can share your documents with them in one tap.{hidden ? ` ${hidden} hidden.` : ''}
        </EmptyState>
      </section>
    );
  }
  return (
    <div className="space-y-3">
      {error && <p role="alert" className="text-sm text-c-red">{error}</p>}
      {shown.map((c) => {
        const [tone, rel] = REL[c.relationship] || REL.invited;
        const s = c.share;
        return (
          <section key={c.id} className="space-y-3 rounded-2xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">{c.dispatcher.company || c.dispatcher.name}</p>
                {c.dispatcher.company && c.dispatcher.name !== c.dispatcher.company && <p className="text-sm text-fg-2">{c.dispatcher.name}</p>}
                {c.agreement && <p className="text-xs text-muted">{AGREEMENT[c.agreement.status]}{c.agreement.status === 'signed' && c.agreement.signedAt ? ` ${relative(c.agreement.signedAt)}` : ''}</p>}
              </div>
              <Badge color={tone}>{rel}</Badge>
            </div>
            <p className={cx('rounded-xl px-3 py-2 text-sm', s?.active ? 'bg-c-green-soft text-c-green' : 'bg-surface-2 text-fg-2')}>
              {s?.active
                ? <>Sharing {s.docTypes.map((t) => label[t]).join(', ')}{s.autoUpdate ? ' · new uploads go to them too' : ''}</>
                : s?.filesShared ? `Not sharing now (${s.filesShared} file${s.filesShared === 1 ? '' : 's'} sent before)` : 'Not sharing any documents'}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={Share2} onClick={() => setSharing(c)} disabled={!data.documents.length} title={!data.documents.length ? 'Upload a document first' : undefined}>{s?.active ? 'Change what I share' : 'Share documents'}</Button>
              {s?.active && <Button size="sm" variant="secondary" loading={busy === c.id} onClick={() => stop(c)}>Stop sharing</Button>}
              {c.statements && <Button size="sm" variant="secondary" icon={FileText} onClick={() => onStatements(c)}>Statements</Button>}
              {c.dispatcher.phone && <Button size="sm" variant="ghost" icon={Phone} href={`tel:${c.dispatcher.phone}`}>Call</Button>}
              <Button size="sm" variant="ghost" icon={EyeOff} onClick={() => stop(c, true)} title="Stop sharing and hide this dispatcher">Not my dispatcher</Button>
            </div>
            {!data.documents.length && <p className="text-xs text-muted">Upload your documents first, then share them here. <button type="button" className="text-brand-700 hover:underline dark:text-brand-300" onClick={onUpload}>Upload now</button></p>}
          </section>
        );
      })}
      {hidden > 0 && <p className="text-xs text-muted">{hidden} hidden dispatcher{hidden === 1 ? '' : 's'}: you told us you do not work with them.</p>}
      {sharing && <ShareDialog data={data} connection={sharing} onClose={() => setSharing(null)} onDone={(res) => { onChange({ ...data, connections: res.connections }); setSharing(null); }} />}
    </div>
  );
}

function ShareDialog({ data, connection, onClose, onDone }) {
  const have = new Set(data.documents.map((d) => d.type));
  const initial = connection.share?.active ? connection.share.docTypes : data.defaultShare.filter((t) => have.has(t));
  const [types, setTypes] = useState(new Set(initial));
  const [autoUpdate, setAutoUpdate] = useState(connection.share ? connection.share.autoUpdate !== false : true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const who = connection.dispatcher.company || connection.dispatcher.name;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await carrierCall('PUT', `/connections/${encodeURIComponent(connection.id)}/share`, { docTypes: [...types], autoUpdate }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Share with ${who}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!types.size} onClick={save}>Share {types.size || ''}</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-fg-2">{who} gets a copy of the documents you tick. They see only these, never your other dispatchers.</p>
        <ul className="space-y-2">
          {data.types.filter((t) => have.has(t.value)).map((t) => (
            <li key={t.value}>
              <Checkbox label={t.label} checked={types.has(t.value)} onChange={(e) => setTypes((prev) => { const n = new Set(prev); if (e.target.checked) n.add(t.value); else n.delete(t.value); return n; })} />
            </li>
          ))}
        </ul>
        <Switch label="When I upload a newer version (like a renewed insurance certificate), send it to them too" checked={autoUpdate} onChange={setAutoUpdate} />
        {error && <p role="alert" className="text-sm text-c-red">{error}</p>}
      </div>
    </Modal>
  );
}

const EXPIRES = new Set(['coi', 'cdl', 'registration']);
const daysLeft = (d) => (d ? Math.ceil((new Date(d).getTime() - Date.now()) / 86_400_000) : null);

function Documents({ data, reload }) {
  const [type, setType] = useState('w9');
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const input = useRef(null);
  const upload = async (file) => {
    if (!file) return;
    setError(null);
    setNotice(null);
    if (file.size > 15 * 1024 * 1024) { setError('This file is larger than 15 MB. Take a photo instead or send a smaller PDF.'); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('type', type);
      fd.append('expiresAt', EXPIRES.has(type) ? expires : '');
      const ext = /\.(pdf|jpe?g|png)$/i.test(file.name) ? '' : file.type === 'application/pdf' ? '.pdf' : file.type === 'image/png' ? '.png' : '.jpg';
      fd.append('file', file, `${file.name || type}${ext}`);
      const res = await carrierCall('POST', '/documents', fd);
      setNotice(res.sentTo ? `Saved and sent to ${res.sentTo} dispatcher${res.sentTo === 1 ? '' : 's'} you share it with.` : 'Saved.');
      setExpires('');
      reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  const remove = async (d) => {
    if (!window.confirm(`Delete ${d.label} from your profile? Dispatchers keep the copies they already received.`)) return;
    try {
      await carrierCall('DELETE', `/documents/${encodeURIComponent(d.id)}`);
      reload();
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <div className="space-y-3">
      <section className="space-y-3 rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-medium">Add a document</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Document">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {data.types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
          </Field>
          {EXPIRES.has(type) && <Field label="Expires on"><Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>}
        </div>
        <input ref={input} type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => upload(e.target.files?.[0])} />
        <Button icon={busy ? Loader2 : Upload} loading={busy} onClick={() => input.current?.click()}>Choose file or take a photo</Button>
        <p className="text-xs text-muted">PDF, JPG or PNG up to 15 MB. A new upload of the same document replaces the old one.</p>
        {error && <p role="alert" className="text-sm text-c-red">{error}</p>}
        {notice && <p role="status" className="text-sm text-c-green">{notice}</p>}
      </section>
      <section className="rounded-2xl border border-line bg-surface">
        {!data.documents.length ? <EmptyState icon={FileText} title="No documents yet">Add your W-9, certificate of insurance and MC authority letter. Then share them with any dispatcher in one tap.</EmptyState> : (
          <ul className="divide-y divide-line">
            {data.documents.map((d) => {
              const left = daysLeft(d.expiresAt);
              return (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <span className="min-w-0">
                    <span className="block font-medium">{d.label}</span>
                    <span className="block truncate text-xs text-muted">{d.originalName} · added {date(d.createdAt)}</span>
                    {d.expiresAt && <Badge className="mt-1" color={left < 0 ? 'red' : left <= 30 ? 'amber' : 'gray'}>{left < 0 ? `Expired ${date(d.expiresAt)}` : `Expires ${date(d.expiresAt)}`}</Badge>}
                  </span>
                  <span className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" icon={Download} href={`${API}/documents/${encodeURIComponent(d.id)}/file`}>Download</Button>
                    <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Delete ${d.label}`} onClick={() => remove(d)} />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function ConnectionStatements({ connection, onBack }) {
  const base = `${API}/connections/${encodeURIComponent(connection.id)}`;
  const q = useQuery({ queryKey: ['carrier-statements', connection.id], queryFn: () => carrierGet(`${base}/statements`), retry: false });
  return (
    <div className="space-y-4">
      <Button variant="ghost" icon={ArrowLeft} onClick={onBack}>My profile</Button>
      <DispatcherCard dispatcher={connection.dispatcher} title="Statements from" />
      {q.isLoading ? <Loading /> : q.isError ? <p className="text-sm text-c-red">{q.error.message}</p>
        : <StatementsView base={base} docBase={`${base}/documents`} get={carrierGet} summary={q.data} queryKey={['carrier-statements', connection.id]} />}
    </div>
  );
}
