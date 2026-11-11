import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CheckCircle2, CloudOff, FileUp, ImagePlus, Loader2, RotateCw, Trash2, X } from 'lucide-react';
import { cx } from '../../components/ui.jsx';
import { compressImage } from './capture.js';
import { jpegsToPdf } from './pdf.js';
import { enqueue, list, remove, update } from './uploadQueue.js';

export const DOC_TYPES = [
  ['bol', 'BOL'], ['pod', 'POD'], ['lumper_receipt', 'Lumper receipt'], ['scale_ticket', 'Scale ticket'], ['fuel_receipt', 'Fuel receipt'], ['other', 'Other'],
];
const LABEL = Object.fromEntries(DOC_TYPES);
const MAX_PAGES = 10;
const MAX_PDF_BYTES = 8 * 1024 * 1024;
const RETRY_MS = 30_000;

/** Send one queued file. Errors carry retry=true when it should be tried again later (no signal, server busy). */
async function upload(token, secret, item) {
  const fd = new FormData();
  fd.append('type', item.type);
  fd.append('pages', String(item.pages || 1));
  // The trip shown when the photo was taken: a POD sent after "Delivered" belongs to that trip, not the next one.
  if (item.loadId) fd.append('loadId', item.loadId);
  // A POD signed on the phone carries the receiver's name, pieces, exceptions, time and position.
  for (const [k, v] of Object.entries(item.meta || {})) if (v != null && v !== '') fd.append(k, String(v));
  fd.append('file', item.blob, item.name);
  let res;
  try {
    res = await fetch(`/api/public/track/${encodeURIComponent(token)}/documents`, { method: 'POST', body: fd, headers: secret ? { 'X-Track-Device': secret } : {}, credentials: 'omit' });
  } catch {
    throw Object.assign(new Error('No signal. It will be sent when you are back online.'), { retry: true });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const code = data?.details?.code;
    throw Object.assign(new Error(data?.error || `Could not send (${res.status})`), { status: res.status, code, retry: res.status >= 500 || (res.status === 429 && code !== 'UPLOAD_CAP') });
  }
  return data;
}

const ago = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const itemLabel = (item) => (item.meta?.receiverName ? 'Signed POD' : LABEL[item.type] || 'File');

/**
 * "Send photos" on the driver page: pick the paper type, take one or more photos (or choose a PDF), and send.
 * Photos are made upright and compressed on the phone; several pages go as one PDF. Without signal the file waits on the
 * phone and is sent automatically when the connection is back.
 * The same queue also sends signed PODs composed in PodSignature; bump `kick` after queueing one to send it now.
 */
const DriverPhotos = forwardRef(function DriverPhotos({ token, tripId, getSecret, uploads, preferType, onSent, onLinkGone, kick }, ref) {
  const [type, setType] = useState(preferType || 'bol');
  const [pages, setPages] = useState([]); // { id, blob, url, width, height }
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const [queue, setQueue] = useState([]);
  const [sent, setSent] = useState([]);
  const [left, setLeft] = useState(uploads?.left ?? null);
  const camera = useRef(null);
  const picker = useRef(null);
  const busy = useRef(false);

  useEffect(() => { if (preferType) setType(preferType); }, [preferType]);
  useEffect(() => () => pages.forEach((p) => URL.revokeObjectURL(p.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(async () => setQueue(await list(token)), [token]);

  const drain = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      for (const item of await list(token)) {
        if (item.error && !item.retry) continue;
        try {
          const r = await upload(token, getSecret(), item);
          await remove(item.id);
          setSent((s) => [{ id: item.id, type: item.type, label: itemLabel(item), pages: item.pages, at: Date.now() }, ...s].slice(0, 10));
          if (r?.uploadsLeft != null) setLeft(r.uploadsLeft);
          onSent?.(item);
        } catch (err) {
          await update({ ...item, attempts: (item.attempts || 0) + 1, error: err.message, retry: !!err.retry });
          if (err.status === 410 || err.code === 'DEVICE_MISMATCH') { onLinkGone?.(err); break; }
          if (err.retry) break; // still offline: try the rest later
        }
      }
    } finally {
      busy.current = false;
      await refresh();
    }
  }, [token, getSecret, onSent, onLinkGone, refresh]);

  useEffect(() => {
    drain();
    const online = () => drain();
    window.addEventListener('online', online);
    const t = setInterval(() => { if (navigator.onLine !== false) drain(); }, RETRY_MS);
    return () => { window.removeEventListener('online', online); clearInterval(t); };
  }, [drain]);
  useEffect(() => { if (kick) drain(); }, [kick]); // eslint-disable-line react-hooks/exhaustive-deps

  const addFiles = async (files) => {
    setError(null);
    const list2 = [...(files || [])];
    if (!list2.length) return;
    const pdf = list2.find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (pdf) {
      if (pdf.size > MAX_PDF_BYTES) { setError('That PDF is larger than 8 MB.'); return; }
      await enqueue({ token, loadId: tripId || null, type, pages: 1, name: `${type}.pdf`, mime: 'application/pdf', blob: pdf });
      await refresh();
      drain();
      return;
    }
    setWorking(true);
    try {
      const next = [];
      for (const f of list2.slice(0, MAX_PAGES - pages.length)) {
        const { blob, width, height } = await compressImage(f);
        next.push({ id: `${Date.now()}-${Math.random()}`, blob, width, height, url: URL.createObjectURL(blob) });
      }
      setPages((p) => [...p, ...next]);
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  };

  const removePage = (id) => setPages((p) => {
    const hit = p.find((x) => x.id === id);
    if (hit) URL.revokeObjectURL(hit.url);
    return p.filter((x) => x.id !== id);
  });

  const send = async () => {
    if (!pages.length) return;
    setWorking(true);
    setError(null);
    try {
      let blob;
      let name;
      if (pages.length === 1) {
        blob = pages[0].blob;
        name = `${type}.jpg`;
      } else {
        const parts = await Promise.all(pages.map(async (p) => ({ bytes: new Uint8Array(await p.blob.arrayBuffer()), width: p.width, height: p.height })));
        blob = new Blob([jpegsToPdf(parts)], { type: 'application/pdf' });
        name = `${type}.pdf`;
        if (blob.size > MAX_PDF_BYTES) throw new Error('These pages are larger than 8 MB together. Send them in two parts.');
      }
      await enqueue({ token, loadId: tripId || null, type, pages: pages.length, name, mime: blob.type, blob });
      pages.forEach((p) => URL.revokeObjectURL(p.url));
      setPages([]);
      await refresh();
      drain();
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  };

  const discard = async (item) => { await remove(item.id); refresh(); };
  const retry = async (item) => { await update({ ...item, error: null, retry: true }); drain(); };
  const capped = left === 0;
  const waiting = queue.filter((q) => !q.error || q.retry);
  const failed = queue.filter((q) => q.error && !q.retry);

  return (
    <section ref={ref} className="space-y-3 rounded-2xl border border-line bg-surface p-4" aria-labelledby="photos-title">
      <div>
        <h2 id="photos-title" className="text-lg font-medium">Send photos</h2>
        <p className="text-sm text-fg-2">BOL, POD and receipts go straight to your dispatcher.{left != null && !capped ? ` ${left} more today.` : ''}</p>
      </div>
      <div role="radiogroup" aria-label="What are you sending" className="flex flex-wrap gap-2">
        {DOC_TYPES.map(([k, l]) => (
          <button key={k} type="button" role="radio" aria-checked={type === k} onClick={() => setType(k)}
            className={cx('min-h-11 rounded-xl border px-3.5 text-sm font-medium transition-ui', type === k ? 'border-brand-600 bg-brand-600 text-white' : 'border-line-strong bg-surface text-fg hover:bg-surface-2')}>{l}</button>
        ))}
      </div>

      {pages.length > 0 && (
        <ul className="grid grid-cols-3 gap-2" aria-label="Pages to send">
          {pages.map((p, i) => (
            <li key={p.id} className="relative overflow-hidden rounded-xl border border-line">
              <img src={p.url} alt={`Page ${i + 1}`} className="aspect-[3/4] w-full object-cover" />
              <span className="absolute left-1.5 top-1.5 rounded-md bg-black/60 px-1.5 text-xs text-white">{i + 1}</span>
              <button type="button" onClick={() => removePage(p.id)} aria-label={`Remove page ${i + 1}`} className="absolute right-1 top-1 flex size-8 items-center justify-center rounded-full bg-black/60 text-white"><X className="size-4" aria-hidden /></button>
            </li>
          ))}
        </ul>
      )}

      <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
      <input ref={picker} type="file" accept="image/*,application/pdf" multiple className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
      <div className="grid grid-cols-2 gap-2">
        <button type="button" disabled={capped || working || pages.length >= MAX_PAGES} onClick={() => camera.current?.click()}
          className="flex min-h-14 items-center justify-center gap-2 rounded-2xl border border-line-strong bg-surface px-3 text-base font-medium hover:bg-surface-2 disabled:opacity-50">
          <Camera className="size-5" aria-hidden />{pages.length ? 'Add a page' : 'Take photo'}
        </button>
        <button type="button" disabled={capped || working || pages.length >= MAX_PAGES} onClick={() => picker.current?.click()}
          className="flex min-h-14 items-center justify-center gap-2 rounded-2xl border border-line-strong bg-surface px-3 text-base font-medium hover:bg-surface-2 disabled:opacity-50">
          <ImagePlus className="size-5" aria-hidden />From phone
        </button>
      </div>
      {pages.length > 0 && (
        <button type="button" disabled={working || capped} onClick={send}
          className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand-600 px-4 text-base font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {working ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <FileUp className="size-5" aria-hidden />}
          Send {LABEL[type]}{pages.length > 1 ? ` (${pages.length} pages)` : ''}
        </button>
      )}
      {working && !pages.length && <p className="flex items-center gap-2 text-sm text-fg-2"><Loader2 className="size-4 animate-spin" aria-hidden />Preparing the photo…</p>}
      {capped && <p className="text-sm text-fg-2">This link has sent the most files allowed today. Ask your dispatcher if you need to send more.</p>}
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}

      {waiting.length > 0 && (
        <div className="rounded-xl border border-c-amber/40 bg-c-amber-soft p-3 text-sm" role="status">
          <p className="flex items-center gap-2 font-medium"><CloudOff className="size-4" aria-hidden />{waiting.length === 1 ? '1 file' : `${waiting.length} files`} waiting to send</p>
          <p className="mt-0.5 text-fg-2">{waiting[0].error || 'Sending…'} They stay on this phone until they are sent.</p>
          <button type="button" onClick={drain} className="mt-2 flex min-h-11 items-center gap-1.5 rounded-xl border border-line-strong bg-surface px-3 text-sm font-medium"><RotateCw className="size-4" aria-hidden />Try now</button>
        </div>
      )}
      {failed.map((item) => (
        <div key={item.id} className="rounded-xl border border-red-300 p-3 text-sm dark:border-red-900" role="alert">
          <p className="font-medium text-red-700 dark:text-red-300">{itemLabel(item)} not sent</p>
          <p className="text-fg-2">{item.error}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => retry(item)} className="flex min-h-11 items-center gap-1.5 rounded-xl border border-line-strong px-3 font-medium"><RotateCw className="size-4" aria-hidden />Try again</button>
            <button type="button" onClick={() => discard(item)} className="flex min-h-11 items-center gap-1.5 rounded-xl border border-line-strong px-3 font-medium"><Trash2 className="size-4" aria-hidden />Remove</button>
          </div>
        </div>
      ))}
      {sent.length > 0 && (
        <ul className="space-y-1 text-sm">
          {sent.map((s) => (
            <li key={s.id} className="flex items-center gap-2 text-c-green"><CheckCircle2 className="size-4 shrink-0" aria-hidden /><span className="text-fg">{s.label}{s.pages > 1 ? ` (${s.pages} pages)` : ''} sent at {ago(s.at)}</span></li>
          ))}
        </ul>
      )}
    </section>
  );
});

export default DriverPhotos;
