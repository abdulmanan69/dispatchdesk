import { useEffect, useRef, useState } from 'react';
import { FileUp, ClipboardPaste, FileText, ScanText, X } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Button, Textarea, cx } from '../ui.jsx';
import { ProgressBar } from '../training/ProgressBar.jsx';
import { MAX_TEXT, pdfToText } from './pdfText.js';
import { ACCEPT, fileKind, isCancelled, needsOcr, ocrFile } from './ocr.js';

const ocrLabel = ({ phase, page, count, kind }) => {
  if (phase === 'loading') return 'Preparing the text reader…';
  if (count > 1) return `Reading page ${page} of ${count}…`;
  return kind === 'image' ? 'Reading the photo…' : 'Reading the scan…';
};

/**
 * "Import rate con": drop or pick a PDF or a photo, or paste the text, then parse it with POST /api/loads/parse.
 * A PDF's text layer is read with pdf.js; a scan without one, or a photo (JPG, PNG, WebP), is read with OCR
 * (tesseract.js, see ocr.js). Both run on this device: only the text is sent. onParsed({ parsed, file, text })
 * receives the result; `file` is the original PDF or photo so the caller can offer to attach it to the load as its rate
 * confirmation. Nothing is saved here.
 */
export default function RateConImport({ onParsed, className, defaultPaste = false }) {
  const inputRef = useRef(null);
  const ocrRef = useRef(null); // AbortController of the OCR run in progress
  const [busy, setBusy] = useState(null); // 'reading' | 'ocr' | 'parsing'
  const [ocr, setOcr] = useState(null); // { phase, page, count, percent, kind } while OCR runs
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [drag, setDrag] = useState(false);
  const [paste, setPaste] = useState(defaultPaste);
  const [text, setText] = useState('');
  const [last, setLast] = useState(null);

  // Leaving the form stops OCR and terminates its worker.
  useEffect(() => () => ocrRef.current?.abort(), []);

  const parse = async (raw, file = null, { scanned = false } = {}) => {
    const body = String(raw || '').trim().slice(0, MAX_TEXT);
    if (body.length < 5) {
      setError(file ? 'No text could be read from this file. Paste the text or type the details.' : 'Paste some rate con text first.');
      setBusy(null);
      return;
    }
    setBusy('parsing');
    try {
      const parsed = await api.post('/api/loads/parse', { text: body });
      setLast({ name: file?.name || 'Pasted text', found: parsed.found.length, scanned });
      onParsed?.({ parsed, file, text: body });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const runOcr = async (file, kind) => {
    const ctrl = new AbortController();
    ocrRef.current = ctrl;
    setBusy('ocr');
    setOcr({ phase: 'loading', page: 0, count: 0, percent: 0, kind });
    try {
      const { text: read } = await ocrFile(file, kind, {
        signal: ctrl.signal,
        onProgress: (p) => { if (!ctrl.signal.aborted) setOcr({ ...p, kind }); },
      });
      setOcr(null);
      await parse(read, file, { scanned: true });
    } catch (err) {
      if (isCancelled(err)) setNotice('Stopped reading the scan. Paste the text or choose another file.');
      else setError(err?.message || 'The text in this file could not be read. Paste the text or type the details.');
      setBusy(null);
    } finally {
      if (ocrRef.current === ctrl) ocrRef.current = null;
      setOcr(null);
    }
  };

  const readFile = async (file) => {
    if (!file || busy) return;
    setError(null);
    setNotice(null);
    setLast(null);
    const kind = fileKind(file);
    if (!kind) {
      setError('Choose a PDF, a photo (JPG, PNG or WebP) or a text file.');
      return;
    }
    try {
      if (kind === 'image') {
        await runOcr(file, kind);
      } else if (kind === 'pdf') {
        setBusy('reading');
        const { text: layer } = await pdfToText(file);
        if (needsOcr(kind, layer)) await runOcr(file, kind);
        else await parse(layer, file);
      } else {
        setBusy('reading');
        await parse((await file.text()).slice(0, MAX_TEXT));
      }
    } catch (err) {
      setError(err.message || 'This file could not be read.');
      setBusy(null);
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDrag(false);
    readFile(e.dataTransfer?.files?.[0]);
  };

  const openPaste = !paste && (error || notice) ? (
    <Button size="sm" variant="link" className="ml-1" onClick={() => setPaste(true)}>Paste text instead</Button>
  ) : null;

  return (
    <div className={cx('space-y-2', className)}>
      <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
        className={cx('flex flex-col gap-3 rounded-lg border border-dashed p-3 transition-ui sm:flex-row sm:items-center', drag ? 'border-c-blue bg-c-blue-soft' : 'border-line-strong bg-surface-2/40')}>
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-c-blue-soft text-c-blue"><FileUp className="size-4" aria-hidden /></span>
          <div className="min-w-0 text-sm">
            <p className="font-medium">Import a rate con</p>
            <p className="text-xs text-muted">Drop a PDF or a photo here, or choose one. It is read on this device, scans included; only its text is sent to fill the form, and nothing is saved until you save the load.</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <input ref={inputRef} type="file" accept={ACCEPT} className="hidden" aria-label="Choose a rate con PDF or photo" onChange={(e) => readFile(e.target.files?.[0])} />
          <Button size="sm" icon={FileText} loading={!!busy} onClick={() => inputRef.current?.click()}>
            {busy === 'reading' ? 'Reading file…' : busy === 'ocr' ? 'Reading scan…' : busy === 'parsing' ? 'Filling in…' : 'Choose file'}
          </Button>
          <Button size="sm" variant="secondary" icon={ClipboardPaste} onClick={() => setPaste((v) => !v)} aria-expanded={paste}>Paste text</Button>
        </div>
      </div>
      {ocr && (
        <div className="rounded-lg border border-line bg-surface p-3" role="status" aria-live="polite">
          <div className="flex items-center gap-2">
            <ScanText className="size-4 shrink-0 text-c-blue" aria-hidden />
            <p className="min-w-0 flex-1 text-sm font-medium">{ocrLabel(ocr)}</p>
            <Button size="sm" variant="secondary" icon={X} onClick={() => ocrRef.current?.abort()}>Cancel</Button>
          </div>
          <ProgressBar percent={ocr.percent} className="mt-2" label="Text recognition progress" />
          <p className="mt-1.5 text-xs text-muted">
            {ocr.kind === 'image' ? 'The photo is read on this device and is not uploaded.' : 'This PDF has no text layer, so it is read on this device and is not uploaded.'}
            {' '}The first time, the text reader (about 3.5 MB) downloads once.
          </p>
        </div>
      )}
      {paste && (
        <div className="space-y-2">
          <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} aria-label="Rate con or load text" maxLength={MAX_TEXT}
            placeholder={'Paste the rate con, load board row or broker email.\ne.g. Dallas, TX → Atlanta, GA  11/12 08:00-14:00  Van  42,000 lbs  781 mi  $2,350\nBroker: Summit Logistics MC# 123456'} />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" loading={busy === 'parsing'} disabled={text.trim().length < 5} onClick={() => { setError(null); setNotice(null); parse(text); }}>Fill in from text</Button>
            <span className="text-xs text-muted">Use text you can already see in your own load board or inbox.</span>
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-c-red">{error}{openPaste}</p>}
      {notice && !error && <p role="status" className="text-sm text-muted">{notice}{openPaste}</p>}
      {last && !error && (
        <p className="flex items-center gap-1.5 text-xs text-muted" role="status">
          <FileText className="size-3.5" aria-hidden />{last.name}: {last.found ? `${last.scanned ? 'read with text recognition, ' : ''}filled ${last.found} of 7 key fields. Check everything before saving.` : 'nothing recognized. Fill the form by hand.'}
          <button type="button" className="ml-1 rounded p-0.5 hover:text-fg" aria-label="Dismiss" onClick={() => setLast(null)}><X className="size-3" /></button>
        </p>
      )}
    </div>
  );
}
