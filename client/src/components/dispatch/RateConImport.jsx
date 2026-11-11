import { useRef, useState } from 'react';
import { FileUp, ClipboardPaste, FileText, X } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Button, Textarea, cx } from '../ui.jsx';
import { MAX_TEXT, pdfToText } from './pdfText.js';

/**
 * "Import rate con": drop or pick a PDF (text extracted on this device with pdf.js) or paste the text, then parse it
 * with POST /api/loads/parse. onParsed({ parsed, file, text }) receives the result; `file` is the original PDF so the
 * caller can offer to attach it to the load as its rate confirmation. Nothing is saved here.
 */
export default function RateConImport({ onParsed, className, defaultPaste = false }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(null); // 'reading' | 'parsing'
  const [error, setError] = useState(null);
  const [drag, setDrag] = useState(false);
  const [paste, setPaste] = useState(defaultPaste);
  const [text, setText] = useState('');
  const [last, setLast] = useState(null);

  const parse = async (raw, file = null) => {
    const body = String(raw || '').trim().slice(0, MAX_TEXT);
    if (body.length < 5) {
      setError(file ? 'No text found in this PDF. It may be a scanned image: paste the text or type the details.' : 'Paste some rate con text first.');
      return;
    }
    setBusy('parsing');
    try {
      const parsed = await api.post('/api/loads/parse', { text: body });
      setLast({ name: file?.name || 'Pasted text', found: parsed.found.length });
      onParsed?.({ parsed, file, text: body });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const readFile = async (file) => {
    if (!file) return;
    setError(null);
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const isText = file.type.startsWith('text/') || /\.(txt|eml)$/i.test(file.name);
    if (!isPdf && !isText) {
      setError('Choose a PDF or a text file.');
      return;
    }
    setBusy('reading');
    try {
      const raw = isPdf ? (await pdfToText(file)).text : (await file.text()).slice(0, MAX_TEXT);
      await parse(raw, isPdf ? file : null);
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

  return (
    <div className={cx('space-y-2', className)}>
      <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
        className={cx('flex flex-col gap-3 rounded-lg border border-dashed p-3 transition-ui sm:flex-row sm:items-center', drag ? 'border-c-blue bg-c-blue-soft' : 'border-line-strong bg-surface-2/40')}>
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-c-blue-soft text-c-blue"><FileUp className="size-4" aria-hidden /></span>
          <div className="min-w-0 text-sm">
            <p className="font-medium">Import a rate con</p>
            <p className="text-xs text-muted">Drop a PDF here or choose one. It is read on this device; only its text is sent to fill the form, and nothing is saved until you save the load.</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <input ref={inputRef} type="file" accept="application/pdf,.pdf,text/plain,.txt" className="hidden" aria-label="Choose a rate con PDF" onChange={(e) => readFile(e.target.files?.[0])} />
          <Button size="sm" icon={FileText} loading={!!busy} onClick={() => inputRef.current?.click()}>
            {busy === 'reading' ? 'Reading PDF…' : busy === 'parsing' ? 'Filling in…' : 'Choose PDF'}
          </Button>
          <Button size="sm" variant="secondary" icon={ClipboardPaste} onClick={() => setPaste((v) => !v)} aria-expanded={paste}>Paste text</Button>
        </div>
      </div>
      {paste && (
        <div className="space-y-2">
          <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} aria-label="Rate con or load text" maxLength={MAX_TEXT}
            placeholder={'Paste the rate con, load board row or broker email.\ne.g. Dallas, TX → Atlanta, GA  11/12 08:00-14:00  Van  42,000 lbs  781 mi  $2,350\nBroker: Summit Logistics MC# 123456'} />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" loading={busy === 'parsing'} disabled={text.trim().length < 5} onClick={() => { setError(null); parse(text); }}>Fill in from text</Button>
            <span className="text-xs text-muted">Use text you can already see in your own load board or inbox.</span>
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-c-red">{error}</p>}
      {last && !error && (
        <p className="flex items-center gap-1.5 text-xs text-muted" role="status">
          <FileText className="size-3.5" aria-hidden />{last.name}: {last.found ? `filled ${last.found} of 7 key fields. Check everything before saving.` : 'nothing recognized. Fill the form by hand.'}
          <button type="button" className="ml-1 rounded p-0.5 hover:text-fg" aria-label="Dismiss" onClick={() => setLast(null)}><X className="size-3" /></button>
        </p>
      )}
    </div>
  );
}
