import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { AlertTriangle, CheckCircle2, Clock, Eraser, FileCheck2, FileText, Loader2, PauseCircle, PenLine, ShieldCheck, Type, Upload } from 'lucide-react';
import { Logo } from '../../components/Logo.jsx';
import { Badge, Button, Checkbox, Field, Input, cx } from '../../components/ui.jsx';
import { SCRIPT_FONT, hasInk, strokesToPath } from './signaturePad.js';

/**
 * Public carrier onboarding page (/onboard/:token). No login: the secret link is the credential. The carrier reads the
 * dispatch agreement, agrees to sign electronically, signs (typed or drawn), then uploads the documents the dispatcher
 * asked for. The page shows only the carrier and dispatcher names, the agreement and the requested documents.
 */

const MAX_MB = 15;
const ACCEPT = 'application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png';

const when = (d) => (d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const day = (d) => (d ? new Date(d).toLocaleDateString([], { month: 'long', day: 'numeric' }) : '');

/** 10 digits for a valid US number ("+1 (214) 555-0188" works), else null. Same rule as the server. */
function usPhone(input) {
  let d = String(input ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? d : null;
}
/** "(214) 555-0188": the server formats the number in the consent text exactly this way. */
const phoneText = (digits) => `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;

class LinkError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Call the public API for this link (no cookies, no CSRF: the token is the credential). */
async function call(token, method, path = '', body) {
  const opts = { method, credentials: 'omit', headers: { Accept: 'application/json' } };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(`/api/public/onboarding/${encodeURIComponent(token)}${path}`, opts);
  } catch {
    throw new LinkError(0, 'No connection. Check your signal and try again.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new LinkError(res.status, data?.error || `Something went wrong (${res.status}). Try again.`, data?.code || data?.details?.code);
  return data;
}

const nextStep = (d) => {
  if (d.state !== 'signed') return 'sign';
  return d.uploads.open && d.requestedDocs.some((x) => !x.uploaded) ? 'docs' : 'done';
};

export default function CarrierOnboarding() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [step, setStep] = useState('sign');

  const load = useCallback(async () => {
    try {
      const d = await call(token, 'GET');
      setData(d);
      setStep(nextStep(d));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [token]);

  useEffect(() => {
    document.title = 'Dispatch agreement';
    load();
  }, [load]);

  useEffect(() => { window.scrollTo?.(0, 0); }, [step]);

  if (error && (!data || error.status === 404 || error.status === 410)) return <Shell><LinkProblem error={error} onRetry={load} /></Shell>;
  if (!data) return <Shell><div className="flex justify-center py-20"><Loader2 className="size-8 animate-spin text-muted" aria-label="Loading" /></div></Shell>;

  const hasDocs = data.requestedDocs.length > 0;
  return (
    <Shell>
      <section className="space-y-1">
        <p className="text-sm text-muted">{data.dispatcher.company}{data.dispatcher.company !== data.dispatcher.name ? ` · ${data.dispatcher.name}` : ''}</p>
        <h1 className="text-2xl font-medium leading-tight">{data.agreement.title}</h1>
        <p className="text-[15px] text-fg-2">For {data.carrier.companyName}</p>
      </section>
      <Steps step={step} hasDocs={hasDocs} />
      {step === 'sign' && <SignStep token={token} data={data} onSigned={(d) => { setData(d); setStep(nextStep(d)); }} onReload={load} />}
      {step === 'docs' && <DocsStep token={token} data={data} onChange={setData} onDone={() => setStep('done')} />}
      {step === 'done' && <DoneStep data={data} onUpload={() => setStep('docs')} />}
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-line bg-surface/95 px-4 backdrop-blur">
        <Logo compact />
        <span className="text-sm text-muted">Carrier onboarding</span>
      </header>
      <main className="mx-auto max-w-xl space-y-4 px-4 pb-10 pt-5">{children}</main>
    </div>
  );
}

const GONE_TITLE = { EXPIRED: 'This link has expired', REVOKED: 'This link was turned off', CLOSED: 'This link has closed' };

function LinkProblem({ error, onRetry }) {
  const gone = error.status === 410;
  const invalid = error.status === 404;
  const Icon = gone ? (error.code === 'CLOSED' ? FileCheck2 : PauseCircle) : AlertTriangle;
  return (
    <div className="rounded-2xl border border-line bg-surface p-6 text-center">
      <Icon className="mx-auto size-10 text-muted" aria-hidden />
      <h1 className="mt-3 text-xl font-medium">{gone ? GONE_TITLE[error.code] || 'This link is no longer active' : invalid ? 'This link is not valid' : 'Could not load the agreement'}</h1>
      <p className="mt-2 text-fg-2">{error.message}</p>
      {!gone && !invalid && <Button variant="secondary" className="mt-4" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

function Steps({ step, hasDocs }) {
  const items = [['sign', 'Sign'], ...(hasDocs ? [['docs', 'Documents']] : []), ['done', 'Done']];
  const at = items.findIndex(([k]) => k === step);
  return (
    <ol className="flex items-center gap-2 text-[13px]" aria-label="Progress">
      {items.map(([k, text], i) => (
        <li key={k} className="flex flex-1 items-center gap-2" aria-current={i === at ? 'step' : undefined}>
          <span className={cx('flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium',
            i < at ? 'bg-c-green-soft text-c-green' : i === at ? 'bg-brand-600 text-white' : 'bg-surface-2 text-muted')}>
            {i < at ? <CheckCircle2 className="size-4" aria-hidden /> : i + 1}
          </span>
          <span className={cx(i === at ? 'font-medium text-fg' : 'text-muted')}>{text}</span>
          {i < items.length - 1 && <span className="h-px flex-1 bg-line" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

function AgreementText({ data, className }) {
  return (
    <section className={cx('rounded-2xl border border-line bg-surface', className)}>
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <FileText className="size-4 text-muted" aria-hidden />
        <h2 className="text-sm font-medium">{data.agreement.title}</h2>
        {data.feePercent != null && <Badge color="teal" className="ml-auto">Fee {data.feePercent}%</Badge>}
      </header>
      {/* Focusable so keyboard users can scroll it. */}
      <div tabIndex={0} aria-label="Agreement text" className="max-h-[55vh] overflow-y-auto whitespace-pre-wrap break-words px-4 py-3 text-[14px] leading-relaxed text-fg-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30">
        {data.agreement.body}
      </div>
    </section>
  );
}

function SignStep({ token, data, onSigned, onReload }) {
  const [consent, setConsent] = useState(!!data.consentAt);
  const [consentBusy, setConsentBusy] = useState(false);
  const [f, setF] = useState({ name: '', title: '', email: '' });
  const [mode, setMode] = useState('typed');
  const [typed, setTyped] = useState('');
  const [typedTouched, setTypedTouched] = useState(false);
  const [drawn, setDrawn] = useState({ path: '', ink: false });
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  // Optional consent to automated calls and texts (only when the dispatcher asked for it). Never required to sign.
  const cc = data.contactConsent?.asked && typeof data.contactConsent.before === 'string' ? data.contactConsent : null;
  const [callOk, setCallOk] = useState(false);
  const [callPhone, setCallPhone] = useState(() => (usPhone(cc?.phone) ? phoneText(usPhone(cc.phone)) : ''));
  const callDigits = usPhone(callPhone);
  const callText = cc ? `${cc.before}${callDigits ? phoneText(callDigits) : '[your phone number]'}${cc.after}` : '';
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const typedValue = typedTouched ? typed : f.name;

  const onConsent = async (checked) => {
    setErr(null);
    if (!checked) { setConsent(false); return; }
    setConsent(true);
    if (data.consentAt) return;
    setConsentBusy(true);
    try {
      await call(token, 'POST', '/consent', { agree: true });
    } catch (e) {
      setConsent(false);
      setErr(e.message);
    } finally {
      setConsentBusy(false);
    }
  };

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim());
  const sigOk = mode === 'typed' ? typedValue.trim().length >= 2 : drawn.ink && !!drawn.path;
  const callReady = !cc || !callOk || !!callDigits;
  const ready = consent && !consentBusy && agree && f.name.trim().length >= 2 && f.title.trim() && emailOk && sigOk && callReady;

  const sign = async (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const d = await call(token, 'POST', '/sign', {
        signerName: f.name.trim(), signerTitle: f.title.trim(), signerEmail: f.email.trim(),
        signatureType: mode, signatureData: mode === 'typed' ? typedValue.trim() : drawn.path,
        agreementHash: data.agreement.hash, agree: true,
        ...(cc && callOk && callDigits ? { contactConsent: { agree: true, phone: callDigits, text: callText } } : {}),
      });
      onSigned(d);
    } catch (e2) {
      if (e2.code === 'ALREADY_SIGNED' || e2.status === 410) { onReload(); return; }
      if (e2.code === 'AGREEMENT_CHANGED' || e2.code === 'CONSENT_TEXT_CHANGED') onReload();
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="space-y-4" onSubmit={sign} noValidate>
      <AgreementText data={data} />

      <section className="space-y-3 rounded-2xl border border-line bg-surface p-4">
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-c-teal" aria-hidden />
          <h2 className="text-sm font-medium">Sign electronically</h2>
        </div>
        <p className="text-[13px] text-fg-2">
          You can sign this agreement on this page. Your electronic signature has the same effect as signing on paper.
          You can ask {data.dispatcher.name} for a paper copy instead, at no cost, and you can stop at any time before you sign by closing this page.
          To view and keep the agreement you need a phone or computer with a web browser; you can print this page or save it as a PDF.
        </p>
        <Checkbox checked={consent} disabled={consentBusy} onChange={(e) => onConsent(e.target.checked)}
          label={<span className="text-[14px]">I agree to use electronic records and signatures for this agreement.</span>} />
      </section>

      <fieldset disabled={!consent} className={cx('space-y-4 rounded-2xl border border-line bg-surface p-4 transition-opacity', !consent && 'opacity-60')}>
        <legend className="sr-only">Your details and signature</legend>
        <h2 className="text-sm font-medium">Your details</h2>
        <Field label="Full name" required><Input value={f.name} onChange={set('name')} autoComplete="name" maxLength={120} className="h-11 text-base" /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Title" required hint="For example Owner or President"><Input value={f.title} onChange={set('title')} autoComplete="organization-title" maxLength={80} className="h-11 text-base" /></Field>
          <Field label="Email" required error={f.email && !emailOk ? 'Enter a valid email address' : null}>
            <Input type="email" inputMode="email" value={f.email} onChange={set('email')} autoComplete="email" maxLength={254} className="h-11 text-base" />
          </Field>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">Signature</h2>
            <div className="inline-flex rounded-lg border border-line-strong p-0.5" role="group" aria-label="How to sign">
              {[['typed', 'Type', Type], ['drawn', 'Draw', PenLine]].map(([k, text, Icon]) => (
                <button key={k} type="button" aria-pressed={mode === k} onClick={() => setMode(k)}
                  className={cx('inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-ui', mode === k ? 'bg-brand-600 text-white' : 'text-fg-2 hover:bg-surface-2')}>
                  <Icon className="size-3.5" aria-hidden />{text}
                </button>
              ))}
            </div>
          </div>
          {mode === 'typed' ? (
            <div className="space-y-2">
              <Field label="Type your name to sign">
                <Input value={typedValue} onChange={(e) => { setTypedTouched(true); setTyped(e.target.value); }} maxLength={120} className="h-11 text-base" />
              </Field>
              <div className="flex min-h-20 items-end rounded-lg border border-dashed border-line-strong bg-surface-2/50 px-4 pb-2 pt-4" aria-hidden>
                <span className="truncate text-[30px] leading-tight text-fg" style={{ fontFamily: SCRIPT_FONT, fontStyle: 'italic' }}>{typedValue || ' '}</span>
              </div>
            </div>
          ) : (
            <SignaturePad onChange={setDrawn} disabled={!consent} />
          )}
        </div>

        <Checkbox checked={agree} onChange={(e) => setAgree(e.target.checked)}
          label={<span className="text-[14px]">I have read the agreement above and I agree to its terms for {data.carrier.companyName}.</span>} />
      </fieldset>

      {cc && (
        <fieldset disabled={!consent} className={cx('space-y-3 rounded-2xl border border-line bg-surface p-4 transition-opacity', !consent && 'opacity-60')}>
          <legend className="sr-only">Calls and texts, optional</legend>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-medium">Calls and texts</h2>
            <Badge color="gray">Optional</Badge>
          </div>
          <p className="text-[13px] text-fg-2">You can sign the agreement without this. Leave the box unticked if you do not want automated calls and texts.</p>
          <Field label="Phone number for calls and texts" error={callOk && !callDigits ? 'Enter a 10-digit US phone number, or untick the box' : null}>
            <Input type="tel" inputMode="tel" autoComplete="tel-national" value={callPhone} onChange={(e) => setCallPhone(e.target.value)} maxLength={20}
              placeholder="(555) 555-0123" className="h-11 text-base" />
          </Field>
          <Checkbox checked={callOk} onChange={(e) => setCallOk(e.target.checked)} className="items-start! [&>input]:mt-1"
            label={<span className="text-[14px] leading-relaxed">{callText}</span>} />
        </fieldset>
      )}

      {err && <p role="alert" className="flex items-start gap-2 rounded-lg bg-c-red-soft px-3 py-2 text-sm text-c-red"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{err}</p>}
      <Button type="submit" size="lg" className="w-full" icon={PenLine} loading={busy} disabled={!ready}>Sign agreement</Button>
      <p className="text-center text-xs text-muted">This link works until {when(data.expiresAt)}.</p>
    </form>
  );
}

/** Finger, pen or mouse signature pad (pointer events). Reports { path, ink } after each stroke. */
function SignaturePad({ onChange, disabled }) {
  const canvasRef = useRef(null);
  const strokes = useRef([]);
  const current = useRef(null);
  const [empty, setEmpty] = useState(true);

  const redraw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext?.('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 2.5 * dpr;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = getComputedStyle(c).color || '#111';
    for (const s of strokes.current) {
      if (!s.length) continue;
      ctx.beginPath();
      ctx.moveTo(s[0].x * w, s[0].y * h);
      if (s.length === 1) ctx.lineTo(s[0].x * w + 0.1, s[0].y * h);
      for (let i = 1; i < s.length; i += 1) ctx.lineTo(s[i].x * w, s[i].y * h);
      ctx.stroke();
    }
  }, []);

  useEffect(() => {
    redraw();
    const c = canvasRef.current;
    if (!c || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => redraw());
    ro.observe(c);
    return () => ro.disconnect();
  }, [redraw]);

  const point = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - rect.left) / (rect.width || 1))), y: Math.min(1, Math.max(0, (e.clientY - rect.top) / (rect.height || 1))) };
  };
  const report = () => onChange({ path: strokesToPath(strokes.current), ink: hasInk(strokes.current) });

  const down = (e) => {
    if (disabled) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    current.current = [point(e)];
    strokes.current.push(current.current);
    setEmpty(false);
    redraw();
  };
  const move = (e) => {
    if (!current.current) return;
    e.preventDefault();
    const events = e.nativeEvent?.getCoalescedEvents?.() || [e];
    for (const ev of events.length ? events : [e]) current.current.push(point(ev));
    redraw();
  };
  const up = () => {
    if (!current.current) return;
    current.current = null;
    report();
  };
  const clear = () => {
    strokes.current = [];
    current.current = null;
    setEmpty(true);
    redraw();
    onChange({ path: '', ink: false });
  };

  return (
    <div className="space-y-2">
      <div className="relative">
        <canvas ref={canvasRef} role="img" aria-label="Signature drawing area. Sign with your finger, a pen or the mouse."
          className="block aspect-[3/1] w-full touch-none select-none rounded-lg border border-dashed border-line-strong bg-surface-2/50 text-fg"
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up} />
        {empty && <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted">Sign here with your finger</span>}
        <span className="pointer-events-none absolute inset-x-6 bottom-6 h-px bg-line-strong" aria-hidden />
      </div>
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" icon={Eraser} onClick={clear} disabled={empty}>Clear</Button>
      </div>
    </div>
  );
}

function DocsStep({ token, data, onChange, onDone }) {
  const [busy, setBusy] = useState(null);
  const [errors, setErrors] = useState({});
  const inputs = useRef({});
  const left = data.uploads.maxFiles - data.uploads.used;
  const missing = data.requestedDocs.filter((d) => !d.uploaded).length;

  const upload = async (kind, file) => {
    if (!file) return;
    setErrors((e) => ({ ...e, [kind]: null }));
    if (file.size > MAX_MB * 1024 * 1024) { setErrors((e) => ({ ...e, [kind]: `This file is larger than ${MAX_MB} MB. Take a photo instead or send a smaller PDF.` })); return; }
    if (!/\.(pdf|jpe?g|png)$/i.test(file.name) && !/^(application\/pdf|image\/(jpeg|png))$/.test(file.type)) {
      setErrors((e) => ({ ...e, [kind]: 'Upload a PDF, JPG or PNG file.' }));
      return;
    }
    setBusy(kind);
    try {
      const fd = new FormData();
      fd.append('type', kind);
      // Phones may hand over a photo without an extension: name it from its type so the server can check it.
      const ext = /\.(pdf|jpe?g|png)$/i.test(file.name) ? '' : file.type === 'application/pdf' ? '.pdf' : file.type === 'image/png' ? '.png' : '.jpg';
      fd.append('file', file, `${file.name || kind}${ext}`);
      const d = await call(token, 'POST', '/documents', fd);
      const { document: _doc, ...view } = d;
      onChange(view);
    } catch (err) {
      setErrors((e) => ({ ...e, [kind]: err.message }));
    } finally {
      setBusy(null);
      if (inputs.current[kind]) inputs.current[kind].value = '';
    }
  };

  return (
    <div className="space-y-4">
      {data.state === 'signed' && (
        <p className="flex items-start gap-2 rounded-2xl border border-c-green/30 bg-c-green-soft px-4 py-3 text-sm text-c-green">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />Agreement signed{data.signedAt ? ` ${when(data.signedAt)}` : ''}. Now upload your documents.
        </p>
      )}
      <section className="rounded-2xl border border-line bg-surface">
        <header className="border-b border-line px-4 py-3">
          <h2 className="font-medium">Upload your documents</h2>
          <p className="mt-0.5 text-[13px] text-fg-2">PDF, JPG or PNG, up to {MAX_MB} MB each. A clear photo from your phone is fine.</p>
        </header>
        <ul className="divide-y divide-line">
          {data.requestedDocs.map((d) => (
            <li key={d.kind} className="space-y-2 px-4 py-3">
              <div className="flex items-center gap-3">
                <span className={cx('flex size-9 shrink-0 items-center justify-center rounded-xl', d.uploaded ? 'bg-c-green-soft text-c-green' : 'bg-surface-2 text-muted')}>
                  {d.uploaded ? <CheckCircle2 className="size-5" aria-hidden /> : <Clock className="size-5" aria-hidden />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-medium">{d.label}</p>
                  <p className="text-xs text-muted">{d.uploaded ? `Uploaded${d.uploaded > 1 ? ` (${d.uploaded} files)` : ''}` : 'Needed'}</p>
                </div>
                <input ref={(el) => { inputs.current[d.kind] = el; }} type="file" accept={ACCEPT} className="sr-only" tabIndex={-1} aria-hidden
                  onChange={(e) => upload(d.kind, e.target.files?.[0])} />
                <Button size="sm" variant={d.uploaded ? 'ghost' : 'secondary'} icon={Upload} loading={busy === d.kind} disabled={!!busy || left <= 0}
                  onClick={() => inputs.current[d.kind]?.click()} aria-label={`${d.uploaded ? 'Add another' : 'Upload'} ${d.label}`}>
                  {d.uploaded ? 'Add' : 'Upload'}
                </Button>
              </div>
              {errors[d.kind] && <p role="alert" className="text-sm text-c-red">{errors[d.kind]}</p>}
            </li>
          ))}
        </ul>
      </section>
      {left <= 0 && <p className="text-sm text-fg-2">This link has taken the most files it can. Send anything else to {data.dispatcher.name} directly.</p>}
      <Button size="lg" className="w-full" variant={missing ? 'secondary' : 'primary'} onClick={onDone} disabled={!!busy}>
        {missing ? 'Finish and send the rest later' : 'Finish'}
      </Button>
      {missing > 0 && data.uploads.open && <p className="text-center text-xs text-muted">You can come back to this link until {day(data.uploads.closesAt)} to upload the rest.</p>}
    </div>
  );
}

function DoneStep({ data, onUpload }) {
  const [show, setShow] = useState(false);
  const missing = data.requestedDocs.filter((d) => !d.uploaded);
  const canUpload = data.uploads.open && data.requestedDocs.length > 0;
  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-line bg-surface p-6 text-center">
        <CheckCircle2 className="mx-auto size-12 text-c-green" aria-hidden />
        <h2 className="mt-3 text-xl font-medium">{data.state === 'signed' ? 'Agreement signed' : 'All set'}</h2>
        <p className="mt-2 text-fg-2">
          {data.signerName ? `Signed by ${data.signerName}` : 'Signed'}{data.signedAt ? ` on ${when(data.signedAt)}` : ''}. {data.dispatcher.name} has been notified.
        </p>
        {data.contactConsent?.given && !data.contactConsent.given.revoked && (
          <p className="mt-2 text-sm text-fg-2">
            You agreed that {data.dispatcher.company || data.dispatcher.name} may call and text you at {data.contactConsent.given.phone}. To opt out at any time, reply STOP to a text or tell {data.dispatcher.company || data.dispatcher.name}.
          </p>
        )}
        {missing.length > 0 && (
          <p className="mt-2 text-sm text-fg-2">Still needed: {missing.map((d) => d.label).join(', ')}.{canUpload ? ` You can upload them here until ${day(data.uploads.closesAt)}.` : ''}</p>
        )}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-center">
          {canUpload && <Button variant="secondary" icon={Upload} onClick={onUpload}>{missing.length ? 'Upload documents' : 'Upload another document'}</Button>}
          <Button variant="ghost" icon={FileText} onClick={() => setShow((v) => !v)} aria-expanded={show}>{show ? 'Hide the agreement' : 'Read the signed agreement'}</Button>
        </div>
      </section>
      {show && <AgreementText data={data} />}
      {data.uploads.open && <p className="text-center text-xs text-muted">This page stays available until {day(data.uploads.closesAt)}. Save or print it if you want a copy.</p>}
    </div>
  );
}
