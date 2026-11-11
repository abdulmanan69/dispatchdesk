import { useCallback, useEffect, useRef, useState } from 'react';
import { Eraser, FileSignature, MapPin, X } from 'lucide-react';
import { Button, Field, Input, Textarea, cx } from '../../components/ui.jsx';
import { hasInk } from '../onboard/signaturePad.js';
import { composeReceipt } from './receipt.js';

/** Limits the server checks (routes/track.js POD_LIMITS). */
export const POD_MAX = { receiverName: 80, receiverTitle: 80, pieces: 40, exceptions: 500 };

/**
 * Full-screen "Get signature" view on the driver page: the receiver prints their name, adds pieces and any exceptions
 * (over, short, damaged) and signs with a finger. The phone then composes the POD receipt (see ./receipt.js) and hands
 * it to onSave({ blob, meta }), which queues it like a POD photo so it is sent even after a spell without signal.
 * stop: the delivery stop ({ loadId, referenceNumber, facility, address, city, state, tz }).
 */
export default function PodSignature({ stop, driverName, company, getPosition, onClose, onSave }) {
  const [f, setF] = useState({ receiverName: '', receiverTitle: '', pieces: '', exceptions: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const strokes = useRef([]);
  const nameRef = useRef(null);
  const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }));

  // Full screen: the page behind does not scroll, Escape closes, and the name field is ready to type.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    nameRef.current?.focus();
    return () => { document.body.style.overflow = prev; };
  }, []);
  useEffect(() => {
    const key = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [busy, onClose]);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const name = f.receiverName.trim();
    if (!name) { setError('Enter the receiver\'s printed name.'); nameRef.current?.focus(); return; }
    if (!hasInk(strokes.current)) { setError('Ask the receiver to sign in the box.'); return; }
    setBusy(true);
    setError(null);
    try {
      const signedAt = Date.now();
      const position = getPosition?.() || null;
      const fields = { receiverName: name, receiverTitle: f.receiverTitle.trim(), pieces: f.pieces.trim(), exceptions: f.exceptions.trim() };
      const { blob } = await composeReceipt({
        reference: stop.referenceNumber, facility: stop.facility, address: stop.address, city: stop.city, state: stop.state, tz: stop.tz,
        deliveredAt: new Date(signedAt), ...fields, strokes: strokes.current, driverName, company, position,
      });
      await onSave({
        blob,
        meta: { ...fields, signedAt, ...(position ? { lat: position.lat, lng: position.lng, ...(position.accuracy != null ? { accuracy: Math.round(position.accuracy) } : {}) } : {}) },
      });
    } catch (err) {
      setError(err?.message || 'Could not save the signature. Try again.');
      setBusy(false);
    }
  };

  const place = [stop.city, stop.state].filter(Boolean).join(', ');
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="pod-sign-title" className="fixed inset-0 z-50 flex flex-col bg-bg text-fg">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-surface px-4">
        <h1 id="pod-sign-title" className="flex items-center gap-2 text-lg font-medium"><FileSignature className="size-5" aria-hidden />Proof of delivery</h1>
        <button type="button" onClick={onClose} disabled={busy} aria-label="Close without saving"
          className="-mr-2 flex size-11 items-center justify-center rounded-xl text-fg-2 hover:bg-surface-2 disabled:opacity-50"><X className="size-6" aria-hidden /></button>
      </header>
      <form onSubmit={submit} noValidate className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-md space-y-4 px-4 py-4 pb-8">
          <div className="flex items-start gap-3 rounded-2xl border border-line bg-surface p-3">
            <MapPin className="mt-0.5 size-5 shrink-0 text-c-green" aria-hidden />
            <div className="min-w-0 text-sm">
              <p className="font-medium text-fg">{stop.facility || place || 'Delivery'}</p>
              {stop.address && <p className="text-fg-2">{stop.address}</p>}
              {stop.facility && place && <p className="text-fg-2">{place}</p>}
              {stop.referenceNumber && <p className="text-muted">Ref {stop.referenceNumber}</p>}
            </div>
          </div>

          <Field label="Receiver's printed name" required>
            <Input ref={nameRef} value={f.receiverName} onChange={set('receiverName')} maxLength={POD_MAX.receiverName} autoComplete="off" autoCapitalize="words" enterKeyHint="next" className="h-12 text-base" />
          </Field>
          <Field label="Title or company">
            <Input value={f.receiverTitle} onChange={set('receiverTitle')} maxLength={POD_MAX.receiverTitle} autoComplete="off" autoCapitalize="words" enterKeyHint="next" className="h-12 text-base" />
          </Field>
          <Field label="Pieces or pallets received" hint="For example 24 pallets">
            <Input value={f.pieces} onChange={set('pieces')} maxLength={POD_MAX.pieces} autoComplete="off" enterKeyHint="next" className="h-12 text-base" />
          </Field>
          <Field label="Exceptions (OS&D)" hint="Over, short or damaged freight. Leave empty if none.">
            <Textarea value={f.exceptions} onChange={set('exceptions')} maxLength={POD_MAX.exceptions} rows={3} className="text-base" />
          </Field>

          <div className="space-y-2">
            <p className="text-[13px] font-medium text-fg">Receiver's signature<span className="text-red-600"> *</span></p>
            <SignatureBox disabled={busy} onChange={(s) => { strokes.current = s; if (error) setError(null); }} />
            <p className="text-sm leading-relaxed text-fg-2">By signing, the receiver confirms the shipment above was received as described, with any exceptions noted, and agrees to sign electronically.</p>
          </div>

          {error && <p role="alert" className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-800 dark:border-red-900 dark:bg-red-900/20 dark:text-red-200">{error}</p>}
          <Button type="submit" size="lg" icon={FileSignature} loading={busy} className="w-full">Save signed POD</Button>
          <Button variant="secondary" size="lg" onClick={onClose} disabled={busy} className="w-full">Cancel</Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Finger or pen signature box: black ink on white in light and dark mode (readable in sunlight and the same as on the
 * receipt). Strokes are points normalized to 0..1 of the box, the shape signaturePad.js works with.
 */
function SignatureBox({ onChange, disabled }) {
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
    ctx.lineWidth = 3 * dpr;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111111';
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
  const report = () => onChange(strokes.current.map((s) => s.slice()));
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
    onChange([]);
  };

  return (
    <div className="space-y-2">
      <div className="relative">
        <canvas ref={canvasRef} role="img" aria-label="Signature box. The receiver signs here with a finger or a pen."
          className={cx('block aspect-[3/1] w-full touch-none select-none rounded-xl border-2 border-line-strong bg-white', disabled && 'opacity-60')}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up} />
        {empty && <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-base text-neutral-500">Receiver signs here</span>}
        <span className="pointer-events-none absolute inset-x-6 bottom-6 h-px bg-neutral-400" aria-hidden />
      </div>
      <div className="flex justify-end">
        <Button variant="secondary" size="lg" icon={Eraser} onClick={clear} disabled={empty || disabled}>Clear signature</Button>
      </div>
    </div>
  );
}
