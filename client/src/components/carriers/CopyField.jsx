import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Pencil, X } from 'lucide-react';
import { useToast } from '../Toast.jsx';
import { cx } from '../ui.jsx';

export async function copyText(text) {
  try { await navigator.clipboard.writeText(String(text)); return true; } catch { return false; }
}

/**
 * A field you click to copy; the pencil edits it in place (Enter saves, Escape cancels).
 * `display` renders the read view (defaults to the value); `action` sits on the right (e.g. a Call button).
 */
export default function CopyField({ label, value, display, onSave, editable = true, mono, type = 'text', placeholder, action, className, inputProps }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { if (!editing) setDraft(value ?? ''); }, [value, editing]);
  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  const empty = value == null || value === '';
  const copy = async () => {
    if (empty) { if (editable && onSave) setEditing(true); return; }
    if (await copyText(value)) toast.success(`${label} copied`);
  };
  const save = async () => {
    const next = typeof draft === 'string' ? draft.trim() : draft;
    if (next === (value ?? '')) { setEditing(false); return; }
    setSaving(true);
    try { await onSave(next === '' ? null : next); setEditing(false); } catch { /* the mutation shows its own error */ } finally { setSaving(false); }
  };

  return (
    <div className={cx('group relative min-w-0 rounded-lg border border-line bg-surface px-3 py-2.5 transition-ui', !editing && 'hover:border-line-strong', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted">{label}</span>
        <span className="flex items-center gap-1">
          {action}
          {editable && onSave && !editing && (
            <button type="button" aria-label={`Edit ${label}`} onClick={() => setEditing(true)}
              className="rounded p-1 text-muted opacity-60 transition-ui hover:bg-surface-2 hover:text-fg group-hover:opacity-100 focus-visible:opacity-100">
              <Pencil className="size-3.5" />
            </button>
          )}
        </span>
      </div>
      {editing ? (
        <form className="mt-1 flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <input ref={inputRef} type={type} value={draft ?? ''} onChange={(e) => setDraft(e.target.value)} placeholder={placeholder} aria-label={label}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(false); } }}
            className={cx('h-8 min-w-0 flex-1 rounded-md border border-brand-500 bg-surface px-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-brand-500/15', mono && 'font-mono')} {...inputProps} />
          <button type="submit" aria-label="Save" disabled={saving} className="rounded-md p-1.5 text-brand-700 hover:bg-surface-2 dark:text-brand-300"><Check className="size-4" /></button>
          <button type="button" aria-label="Cancel" onClick={() => setEditing(false)} className="rounded-md p-1.5 text-muted hover:bg-surface-2"><X className="size-4" /></button>
        </form>
      ) : (
        <button type="button" onClick={copy} title={empty ? (editable && onSave ? `Add ${label.toLowerCase()}` : undefined) : 'Click to copy'}
          className={cx('mt-0.5 flex w-full min-w-0 items-center gap-2 text-left text-[15px] font-medium text-fg', mono && 'font-mono text-sm', empty && 'font-normal text-muted')}>
          <span className="min-w-0 truncate">{empty ? (editable && onSave ? 'Add' : '—') : (display ?? value)}</span>
          {!empty && <Copy className="size-3.5 shrink-0 text-muted opacity-0 transition-ui group-hover:opacity-100" aria-hidden />}
        </button>
      )}
    </div>
  );
}
