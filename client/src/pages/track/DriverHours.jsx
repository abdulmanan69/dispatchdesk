import { useState } from 'react';
import { CheckCircle2, Gauge, Loader2 } from 'lucide-react';

/** Minutes from "6:30", "6.5" or "6"; null when empty, NaN when unreadable. */
export function parseHours(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (m) return Number(m[1]) * 60 + Number(m[2] || 0);
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 60) : NaN;
}

const FIELDS = [['drive', 'Driving left', '11 h clock', 660], ['shift', 'On-duty window left', '14 h clock', 840], ['cycle', 'Week left', '70 h clock', 4200]];

/**
 * Optional "hours left" for the driver: lets dispatch plan a legal arrival time (breaks and the 10-hour rest).
 * A planning aid only; it is not a log and the driver's ELD stays the record.
 */
export default function DriverHours({ send }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ drive: '', shift: '', cycle: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { ok, text }
  const submit = async (e) => {
    e.preventDefault();
    const body = {};
    for (const [k, , , max] of FIELDS) {
      const m = parseHours(v[k]);
      if (Number.isNaN(m)) { setMsg({ ok: false, text: 'Write hours like 6:30 or 6.5' }); return; }
      if (m != null && m > max) { setMsg({ ok: false, text: `That is more than the ${max / 60} hour limit` }); return; }
      if (m != null) body[`${k}LeftMin`] = m;
    }
    if (!Object.keys(body).length) { setMsg({ ok: false, text: 'Enter at least one' }); return; }
    setBusy(true);
    setMsg(null);
    try {
      await send(body);
      setMsg({ ok: true, text: 'Sent to dispatch' });
      setOpen(false);
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally { setBusy(false); }
  };
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="flex min-h-12 w-full items-center gap-3 text-left">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-c-purple-soft text-c-purple"><Gauge className="size-5" aria-hidden /></span>
          <span>
            <span className="block font-medium">Hours left</span>
            <span className="block text-sm text-fg-2">Tell dispatch how many hours you have, so they book times you can make.</span>
          </span>
        </button>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <p className="font-medium">Hours left</p>
          <div className="grid grid-cols-3 gap-2">
            {FIELDS.map(([k, label, hint]) => (
              <label key={k} className="space-y-1 text-xs text-fg-2">
                <span className="block font-medium text-fg">{label}</span>
                <input inputMode="decimal" value={v[k]} onChange={(e) => setV((x) => ({ ...x, [k]: e.target.value }))} placeholder="6:30"
                  className="h-12 w-full rounded-xl border border-line-strong bg-surface px-2 text-center text-base text-fg placeholder:text-muted focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/15" />
                <span className="block text-muted">{hint}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted">For planning only. Your ELD is still the record.</p>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setOpen(false)} className="min-h-12 rounded-2xl border border-line-strong font-medium">Cancel</button>
            <button type="submit" disabled={busy} className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-brand-600 font-medium text-white disabled:opacity-50">{busy && <Loader2 className="size-4 animate-spin" aria-hidden />}Send</button>
          </div>
        </form>
      )}
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'mt-2 flex items-center gap-1.5 text-sm text-c-green' : 'mt-2 text-sm text-red-700 dark:text-red-300'}>{msg.ok && <CheckCircle2 className="size-4" aria-hidden />}{msg.text}</p>}
    </section>
  );
}
