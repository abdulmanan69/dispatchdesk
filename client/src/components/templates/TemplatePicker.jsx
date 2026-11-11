import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { FileText, Loader2, Search, BookOpen, ExternalLink } from 'lucide-react';
import { Button, cx } from '../ui.jsx';
import { useToast } from '../Toast.jsx';
import { errorToast } from '../../lib/hooks.js';
import { TEMPLATE_CATEGORIES, byUse, categoryMeta, installStarter, invalidateFor, renderTemplate, templatesKey, useTemplates } from './templateApi.js';

const PANEL_MAX_H = 440;

function usePanelPosition(anchorRef, open, align) {
  const [pos, setPos] = useState(null);
  const update = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.min(380, window.innerWidth - 16);
    const preferred = align === 'right' ? r.right - width : r.left;
    const left = Math.min(Math.max(8, preferred), window.innerWidth - width - 8);
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const up = below < Math.min(PANEL_MAX_H, 260) && above > below;
    setPos({ left, width, top: up ? undefined : r.bottom + 4, bottom: up ? window.innerHeight - r.top + 4 : undefined, maxHeight: Math.max(200, Math.min(PANEL_MAX_H, up ? above : below)) });
  }, [anchorRef, align]);
  useLayoutEffect(() => {
    if (!open) return undefined;
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [open, update]);
  return pos;
}

/**
 * Template picker (shared contract).
 *
 * <TemplatePicker channel="sms" | "email" category? carrierId? loadId? brokerId? invoiceId? extra?={…merge values}
 *   onPick={({ subject, body, template, unresolved, unknown }) => …} size? label? align? />
 *
 * Lists the user's templates for the channel (searchable, grouped by category), renders the chosen one with merge
 * fields filled through POST /api/templates/render { channel, templateId, carrierId?, loadId?, brokerId?, extra? }
 * and calls onPick with the rendered text. Tokens it cannot fill stay visible (listed in `unresolved`).
 * It never sends anything itself. `category` preselects a category filter; the user can switch to All.
 */
export default function TemplatePicker({
  channel = 'sms', category, carrierId, loadId, brokerId, invoiceId, extra, onPick, size = 'sm', label = 'Templates',
  variant = 'secondary', align = 'left', disabled, className,
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState(category || '');
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(null); // template id being rendered | 'starter'
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  const inputRef = useRef(null);
  const listId = `${useId()}-templates`;
  const templates = useTemplates(channel, { enabled: open });
  const pos = usePanelPosition(btnRef, open, align);
  const all = useMemo(() => templates.data?.items || [], [templates.data]);

  const counts = useMemo(() => {
    const m = {};
    for (const t of all) m[t.category] = (m[t.category] || 0) + 1;
    return m;
  }, [all]);
  // Fall back to All when the preselected category has no templates.
  const effectiveCat = cat && counts[cat] ? cat : '';
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = all.filter((t) => (!effectiveCat || t.category === effectiveCat)
      && (!q || t.name.toLowerCase().includes(q) || String(t.body).toLowerCase().includes(q) || String(t.subject || '').toLowerCase().includes(q)));
    // Group order follows the category list; inside a group the most used come first.
    const order = TEMPLATE_CATEGORIES.map((c) => c.value);
    const rank = (c) => { const i = order.indexOf(c); return i < 0 ? order.length : i; };
    return list.sort((a, b) => rank(a.category) - rank(b.category) || byUse(a, b));
  }, [all, query, effectiveCat]);

  useEffect(() => { setActive(0); }, [query, effectiveCat]);
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  const close = useCallback((focus = true) => { setOpen(false); setQuery(''); if (focus) btnRef.current?.focus(); }, []);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!btnRef.current?.contains(e.target) && !panelRef.current?.contains(e.target)) close(false); };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, close]);
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 0); }, [open]);

  const pick = async (t) => {
    if (!t || busy) return;
    setBusy(t.id);
    try {
      const out = await renderTemplate({ channel, templateId: t.id, carrierId: carrierId || undefined, loadId: loadId || undefined, brokerId: brokerId || undefined, invoiceId: invoiceId || undefined, extra, use: true });
      onPick?.({ ...out, template: t });
      qc.invalidateQueries({ queryKey: templatesKey(channel) });
      close();
    } catch (err) {
      errorToast(toast, err);
    } finally {
      setBusy(null);
    }
  };

  const addStarters = async () => {
    setBusy('starter');
    try {
      const res = await installStarter(channel);
      await Promise.all(invalidateFor(channel).map((k) => qc.invalidateQueries({ queryKey: k })));
      toast.success(res.created ? `Added ${res.created} starter templates` : 'Starter templates are already in your library');
    } catch (err) { errorToast(toast, err); } finally { setBusy(null); }
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(visible.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(visible[active]); }
    else if (e.key === 'Tab') close(false);
  };

  const manageHref = `/app/templates?tab=${channel === 'email' ? 'email' : 'sms'}`;
  const noun = channel === 'email' ? 'email' : 'text';
  let lastCat = null;

  return (
    <>
      <Button ref={btnRef} size={size} variant={variant} icon={FileText} disabled={disabled} className={className}
        aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
        {label}
      </Button>
      {open && pos && createPortal(
        <div ref={panelRef} role="dialog" aria-label={`Choose ${noun === 'email' ? 'an email' : 'a text'} template`} onKeyDown={onKey}
          className="dd-pop fixed z-[1000] flex flex-col overflow-hidden rounded-lg border border-line-strong bg-surface shadow-lg shadow-black/10"
          style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxHeight }}>
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-2.5">
            <Search className="size-3.5 shrink-0 text-muted" aria-hidden />
            <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${noun} templates`}
              aria-label={`Search ${noun} templates`} aria-controls={listId} aria-activedescendant={visible[active] ? `${listId}-${active}` : undefined}
              className="h-10 w-full bg-transparent text-sm text-fg placeholder:text-muted focus:outline-none" />
          </div>
          {all.length > 0 && (
            <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-2 py-1.5" role="group" aria-label="Category">
              {[{ value: '', label: 'All' }, ...TEMPLATE_CATEGORIES.filter((c) => counts[c.value])].map((c) => (
                <button key={c.value || 'all'} type="button" aria-pressed={effectiveCat === c.value} onClick={() => setCat(c.value)}
                  className={cx('h-7 shrink-0 rounded-md px-2 text-xs transition-ui', effectiveCat === c.value ? 'bg-fg text-bg' : 'text-fg-2 hover:bg-surface-2')}>
                  {c.label}{c.value ? <span className="ml-1 tabular opacity-70">{counts[c.value]}</span> : null}
                </button>
              ))}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {templates.isLoading ? (
              <p className="flex items-center gap-2 px-2.5 py-3 text-sm text-muted"><Loader2 className="size-4 animate-spin" aria-hidden />Loading templates</p>
            ) : templates.isError ? (
              <p className="px-2.5 py-3 text-sm text-red-600 dark:text-red-400">{templates.error?.message || 'Could not load templates'}</p>
            ) : !all.length ? (
              <div className="px-3 py-5 text-center">
                <p className="text-sm font-medium">No {noun} templates yet</p>
                <p className="mt-1 text-xs text-muted">Start from the starter pack, then edit the wording to sound like you.</p>
                <Button size="sm" className="mt-3" icon={BookOpen} loading={busy === 'starter'} onClick={addStarters}>Add starter templates</Button>
              </div>
            ) : !visible.length ? (
              <p className="px-2.5 py-3 text-sm text-muted">No templates match</p>
            ) : (
              <ul id={listId} role="listbox" aria-label="Templates">
                {visible.map((t, i) => {
                  const header = !effectiveCat && t.category !== lastCat ? categoryMeta(t.category).label : null;
                  lastCat = t.category;
                  return (
                    <li key={t.id} role="presentation">
                      {header && <div className="px-2.5 pb-1 pt-2 text-[11.5px] font-medium text-muted">{header}</div>}
                      <button type="button" role="option" id={`${listId}-${i}`} data-index={i} aria-selected={i === active}
                        onPointerMove={() => setActive(i)} onClick={() => pick(t)} disabled={!!busy}
                        className={cx('flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-ui disabled:cursor-wait', i === active ? 'bg-surface-2' : '')}>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-fg">{t.name}</span>
                          <span className="block truncate text-xs text-muted">{channel === 'email' ? t.subject : t.body}</span>
                        </span>
                        {busy === t.id ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted" aria-label="Filling in" />
                          : t.useCount > 0 ? <span className="mt-0.5 shrink-0 font-mono text-[11px] tabular text-muted" title={`Used ${t.useCount} times`}>{t.useCount}×</span> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-line px-3 py-2 text-xs text-muted">
            <span>Fills in the details. You review before sending.</span>
            <Link to={manageHref} target="_blank" rel="noopener" className="inline-flex shrink-0 items-center gap-1 font-medium text-fg-2 hover:text-fg">
              Manage<ExternalLink className="size-3" aria-hidden />
            </Link>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
