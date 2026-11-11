import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { FileUp, Download, CheckCircle2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { Button, Card, Field, PageHeader, Select, StatCard } from '../../components/ui.jsx';
import { STAGES } from '../../components/carriers/shared.jsx';

const TEMPLATE_HEADERS = ['Company Name', 'DBA', 'USDOT', 'MC', 'Phone', 'Email', 'Address', 'City', 'State', 'ZIP', 'Equipment', 'Power Units', 'Drivers', 'Authority Status', 'Authority Date', 'Contact Name', 'Notes'];

const COLUMN_HELP = [
  ['Company name', 'company, legal name, carrier name, name'],
  ['USDOT', 'usdot, dot, dot number'],
  ['MC', 'mc, mc number, docket'],
  ['Phone / Email', 'phone, telephone, mobile / email, email address'],
  ['Address', 'address, street, city, state, zip'],
  ['Equipment', 'equipment, trailer type — e.g. "Dry Van, Reefer"'],
  ['Fleet', 'power units, trucks, fleet size; drivers'],
  ['Authority', 'authority status (active/inactive/pending), authority date'],
  ['Extras', 'contact name, notes'],
];

/** Header-only template, generated in the browser. */
function downloadTemplate() {
  const blob = new Blob([`${TEMPLATE_HEADERS.join(',')}\n`], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'carrier-import-template.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export default function ImportCsv() {
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [mode, setMode] = useState('skip');
  const [stage, setStage] = useState('lead');
  const [result, setResult] = useState(null);

  const onFile = async (f) => {
    setResult(null);
    setFile(f || null);
    if (!f) return setPreview(null);
    const text = await f.slice(0, 20000).text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    setPreview({ headers: lines[0]?.split(',').map((h) => h.replace(/^"|"$/g, '').trim()) || [], rows: Math.max(0, text.split(/\r?\n/).filter(Boolean).length - 1), truncated: f.size > 20000 });
  };

  const upload = useApiMutation(() => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('mode', mode);
    fd.append('stage', stage);
    return api.upload('/api/carriers/import', fd);
  }, {
    success: (d) => `Import finished: ${d.created} created, ${d.updated} updated, ${d.skipped} skipped`,
    invalidate: [['carriers'], ['pipeline'], ['dashboard']],
    onSuccess: (d) => { setResult(d); setFile(null); setPreview(null); if (fileRef.current) fileRef.current.value = ''; },
  });

  return (
    <div className="max-w-4xl">
      <PageHeader title="Import carriers from CSV" subtitle="Upload a spreadsheet export from a load board, lead list or another CRM. Duplicates (same USDOT, MC or phone) are detected."
        actions={<Button variant="secondary" icon={Download} onClick={downloadTemplate}>Download template</Button>} />

      <div className="grid gap-4 md:grid-cols-[1fr_280px]">
        <Card title="Upload">
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (file) upload.mutate(); }}>
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-line px-4 py-8 text-center hover:border-brand-400"
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files[0]); }}>
              <FileUp className="size-7 text-muted" />
              <span className="text-sm font-medium">{file ? file.name : 'Choose a .csv file or drop it here'}</span>
              <span className="text-xs text-muted">Up to 5,000 rows, 10 MB</span>
              <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => onFile(e.target.files[0])} />
            </label>
            {preview && (
              <div className="rounded-md border border-line p-3 text-sm">
                <p><span className="font-medium">{preview.rows}{preview.truncated ? '+' : ''}</span> data rows detected. Columns:</p>
                <p className="mt-1 flex flex-wrap gap-1">{preview.headers.map((h) => <code key={h} className="rounded bg-surface-2 px-1.5 py-0.5 text-xs">{h}</code>)}</p>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="When a carrier already exists">
                <Select value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="skip">Skip it</option>
                  <option value="update">Update empty/changed fields</option>
                </Select>
              </Field>
              <Field label="Put new carriers in">
                <Select value={stage} onChange={(e) => setStage(e.target.value)}>{STAGES.filter((s) => s.key !== 'archived').map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}</Select>
              </Field>
            </div>
            <Button type="submit" icon={FileUp} disabled={!file} loading={upload.isPending}>Import</Button>
          </form>
        </Card>
        <Card title="Recognised columns">
          <dl className="space-y-2 text-xs">
            {COLUMN_HELP.map(([k, v]) => <div key={k}><dt className="font-medium text-fg">{k}</dt><dd className="text-muted">{v}</dd></div>)}
          </dl>
        </Card>
      </div>

      {result && (
        <Card title="Import results" className="mt-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <StatCard label="Created" value={result.created} icon={CheckCircle2} tone="green" />
            <StatCard label="Updated" value={result.updated} />
            <StatCard label="Skipped (duplicates)" value={result.skipped} tone="muted" />
            <StatCard label="Errors" value={result.errorCount ?? result.errors.length} tone={result.errors.length ? 'red' : 'muted'} />
          </div>
          <p className="mt-3 text-sm text-muted">
            Mapped: {Object.entries(result.mapping).map(([h, f]) => `${h} → ${f}`).join(', ')}
            {result.unmapped.length > 0 && <> · Ignored: {result.unmapped.join(', ')}</>}
          </p>
          {result.errors.length > 0 && (
            <div className="mt-3 max-h-64 overflow-y-auto rounded-md border border-line">
              <table className="w-full text-sm"><thead><tr className="border-b border-line text-left text-xs text-muted"><th className="px-3 py-2">Line</th><th className="px-3 py-2">Problem</th></tr></thead>
                <tbody>{result.errors.map((e) => <tr key={e.line} className="border-b border-line/60 last:border-0"><td className="px-3 py-1.5 tabular">{e.line}</td><td className="px-3 py-1.5">{e.error}</td></tr>)}</tbody></table>
              {result.errorCount > result.errors.length && <p className="px-3 py-2 text-xs text-muted">Showing the first {result.errors.length} of {result.errorCount} problems.</p>}
            </div>
          )}
          <div className="mt-4 flex gap-2"><Button to="/app/carriers">View carrier list</Button><Button variant="secondary" to="/app/prospecting">Start prospecting</Button></div>
        </Card>
      )}
      <p className="mt-4 text-xs text-muted">Imported records are marked with source “CSV import”. They are not verified against FMCSA until you run <Link to="/app/carriers" className="underline">Enrich</Link> on them.</p>
    </div>
  );
}
