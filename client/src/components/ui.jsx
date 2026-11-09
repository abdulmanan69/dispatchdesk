import { forwardRef, useId, isValidElement, cloneElement } from 'react';
import { Link } from 'react-router';
import { Loader2, AlertTriangle, Inbox, ChevronLeft, ChevronRight, ArrowUp, ArrowDown } from 'lucide-react';
import { initials } from '../lib/format.js';

export const cx = (...c) => c.filter(Boolean).join(' ');

/** Drop the base full width when the caller sets its own width (otherwise w-full wins in the cascade). */
// max-w-* only caps the width, so it keeps the base w-full.
const HAS_WIDTH = /(^|\s)(sm:|md:|lg:)?(w-|min-w-|flex-1|basis-)/;
const sized = (base, className) => cx(HAS_WIDTH.test(className || '') ? base.replace('w-full ', '') : base, className);

const BTN = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-600/50 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]',
  secondary: 'bg-surface text-fg border border-line-strong hover:bg-surface-2',
  ghost: 'text-fg-2 hover:bg-surface-2 hover:text-fg',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-600/50',
  signal: 'bg-fg text-bg hover:opacity-90',
  link: 'text-brand-700 dark:text-brand-300 hover:underline px-0',
};
const SIZES = { sm: 'h-8 px-3 text-[13px] gap-1.5', md: 'h-9 px-4 text-sm gap-2', lg: 'h-12 px-5 text-[15px] gap-2' };

export const Button = forwardRef(function Button({ variant = 'primary', size = 'md', loading, icon: Icon, className, children, to, href, ...props }, ref) {
  const cls = cx('inline-flex items-center justify-center rounded-lg font-medium whitespace-nowrap transition-ui active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100', BTN[variant], variant !== 'link' && SIZES[size], className);
  const inner = (
    <>
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : Icon ? <Icon className="size-4 shrink-0" aria-hidden /> : null}
      {children}
    </>
  );
  if (to) return <Link ref={ref} to={to} className={cls} {...props}>{inner}</Link>;
  if (href) return <a ref={ref} href={href} className={cls} {...props}>{inner}</a>;
  return <button ref={ref} type={props.type || 'button'} className={cls} disabled={loading || props.disabled} {...props}>{inner}</button>;
});

export function IconButton({ icon: Icon, label, className, ...props }) {
  return (
    <button type="button" aria-label={label} title={label} className={cx('inline-flex size-8 items-center justify-center rounded-lg text-muted transition-ui hover:bg-surface-2 hover:text-fg', className)} {...props}>
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

const inputBase = 'w-full rounded-lg border border-line-strong bg-surface px-3 text-sm text-fg placeholder:text-muted transition-ui focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/15 disabled:opacity-60';

export const Input = forwardRef(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={sized(`${inputBase} h-9`, className)} {...props} />;
});
export const Textarea = forwardRef(function Textarea({ className, rows = 4, ...props }, ref) {
  return <textarea ref={ref} rows={rows} className={sized(`${inputBase} py-2`, className)} {...props} />;
});
// Themed dropdown and combo box (no native <select>/<datalist> popups).
export { Select, ComboInput } from './controls.jsx';

/** Label + control + hint/error, with ids wired for accessibility. */
export function Field({ label, hint, error, children, className, required }) {
  const autoId = useId();
  const id = isValidElement(children) && children.props.id ? children.props.id : autoId;
  const child = typeof children === 'function'
    ? children(id)
    : isValidElement(children) ? cloneElement(children, { id, 'aria-invalid': error ? true : undefined, required: children.props.required ?? required }) : children;
  return (
    <div className={cx('space-y-1', className)}>
      {label && <label htmlFor={id} className="block text-[13px] font-medium text-fg">{label}{required && <span className="text-red-600"> *</span>}</label>}
      {child}
      {error ? <p className="text-xs text-red-600">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function Checkbox({ label, className, ...props }) {
  return (
    <label className={cx('inline-flex cursor-pointer items-center gap-2 text-sm', className)}>
      <input type="checkbox" className="dd-check" {...props} />
      {label}
    </label>
  );
}

export function Switch({ checked, onChange, label, disabled }) {
  return (
    <label className="flex w-fit cursor-pointer items-center gap-2.5 text-sm">
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
        className={cx('relative h-5 w-9 shrink-0 rounded-full transition-ui', checked ? 'bg-brand-600' : 'bg-line-strong', disabled && 'opacity-50')}>
        <span className={cx('absolute left-0 top-0.5 size-4 rounded-full bg-white shadow-sm transition-ui', checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
      </button>
      {label}
    </label>
  );
}

const BADGE = {
  gray: 'bg-c-gray-soft text-fg-2 border-line',
  brand: 'bg-c-teal-soft text-c-teal border-c-teal/30',
  teal: 'bg-c-teal-soft text-c-teal border-c-teal/30',
  green: 'bg-c-green-soft text-c-green border-c-green/30',
  amber: 'bg-c-amber-soft text-c-amber border-c-amber/30',
  red: 'bg-c-red-soft text-c-red border-c-red/30',
  blue: 'bg-c-blue-soft text-c-blue border-c-blue/30',
  violet: 'bg-c-purple-soft text-c-purple border-c-purple/30',
  purple: 'bg-c-purple-soft text-c-purple border-c-purple/30',
  pink: 'bg-c-pink-soft text-c-pink border-c-pink/30',
  orange: 'bg-c-orange-soft text-c-orange border-c-orange/30',
};
export function Badge({ color = 'gray', children, className, style }) {
  return <span style={style} className={cx('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11.5px] font-medium leading-none whitespace-nowrap', BADGE[color], className)}>{children}</span>;
}

export function Card({ title, actions, children, className, bodyClass, footer }) {
  return (
    <section className={cx('rounded-xl border border-line bg-surface', className)}>
      {(title || actions) && (
        <header className="flex min-h-12 items-center justify-between gap-3 border-b border-line px-5 py-2">
          {typeof title === 'string' ? <h2 className="text-sm font-medium">{title}</h2> : title}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx('p-5', bodyClass)}>{children}</div>
      {footer && <footer className="border-t border-line px-5 py-3">{footer}</footer>}
    </section>
  );
}

export function Spinner({ className, label = 'Loading' }) {
  return <Loader2 className={cx('size-5 animate-spin text-muted', className)} aria-label={label} />;
}

export function Loading({ label = 'Loading…', className }) {
  return (
    <div className={cx('flex items-center justify-center gap-2 py-12 text-sm text-muted', className)} role="status">
      <Spinner /> {label}
    </div>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, children, action }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <Icon className="mb-3 size-5 text-muted" strokeWidth={1.5} aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'Could not load this' }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center" role="alert">
      <AlertTriangle className="mb-3 size-5 text-muted" strokeWidth={1.5} aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-md text-sm text-muted">{error?.message || String(error || 'Unknown error')}</p>
      {onRetry && <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

/** Standard query renderer: loading / error / content. */
export function QueryState({ query, children, empty, isEmpty, loadingLabel }) {
  if (query.isLoading) return <Loading label={loadingLabel} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  if (isEmpty && isEmpty(query.data)) return empty ?? <EmptyState title="Nothing here yet" />;
  return children(query.data);
}

export function PageHeader({ title, subtitle, actions, breadcrumb }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {breadcrumb && <div className="mb-1 text-[13px] text-muted">{breadcrumb}</div>}
        <h1 className="truncate text-2xl font-medium tracking-[-0.01em]">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-fg-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Tabs({ tabs, value, onChange, className }) {
  return (
    <div role="tablist" className={cx('flex gap-1 overflow-x-auto border-b border-line', className)}>
      {tabs.map((t) => {
        const key = t.value ?? t.key;
        const active = key === value;
        return (
          <button key={key} role="tab" aria-selected={active} type="button" onClick={() => onChange(key)}
            className={cx('-mb-px flex h-10 items-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm transition-ui', active ? 'border-fg font-medium text-fg' : 'border-transparent text-fg-2 hover:text-fg')}>
            {t.label}
            {t.count != null && <span className="font-mono text-xs tabular text-muted">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function Pagination({ page, pages, total, onPage }) {
  if (!pages || pages <= 1) return total != null ? <p className="px-1 py-2 text-xs text-muted">{total} total</p> : null;
  return (
    <div className="flex items-center justify-between gap-3 px-1 py-2 text-sm">
      <span className="text-xs text-muted tabular">{total} total · page {page} of {pages}</span>
      <div className="flex gap-1">
        <IconButton icon={ChevronLeft} label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)} className="disabled:opacity-40" />
        <IconButton icon={ChevronRight} label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)} className="disabled:opacity-40" />
      </div>
    </div>
  );
}

export function Avatar({ name, src, size = 32, className }) {
  const style = { width: size, height: size, fontSize: Math.max(10, size * 0.38) };
  if (src) return <img src={src} alt="" style={style} className={cx('shrink-0 rounded-full object-cover', className)} />;
  const hue = HUES[hashString(name || '') % HUES.length];
  return <span style={style} className={cx('inline-flex shrink-0 items-center justify-center rounded-full font-medium', HUE_SOFT[hue], className)} aria-hidden>{initials(name)}</span>;
}

/** Stable hue for a string (avatars, series, categories). */
export const HUES = ['blue', 'green', 'purple', 'amber', 'pink', 'teal', 'orange', 'red'];
export function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}
export const HUE_SOFT = {
  blue: 'bg-c-blue-soft text-c-blue', green: 'bg-c-green-soft text-c-green', purple: 'bg-c-purple-soft text-c-purple', amber: 'bg-c-amber-soft text-c-amber',
  pink: 'bg-c-pink-soft text-c-pink', teal: 'bg-c-teal-soft text-c-teal', orange: 'bg-c-orange-soft text-c-orange', red: 'bg-c-red-soft text-c-red', gray: 'bg-c-gray-soft text-c-gray',
};
const HUE_BAR = {
  blue: 'bg-c-blue', green: 'bg-c-green', purple: 'bg-c-purple', amber: 'bg-c-amber', pink: 'bg-c-pink', teal: 'bg-c-teal', orange: 'bg-c-orange', red: 'bg-c-red', gray: 'bg-c-gray',
};
const TONE_HUE = { green: 'green', red: 'red', signal: 'amber', amber: 'amber', muted: 'gray', brand: 'teal', blue: 'blue', purple: 'purple', pink: 'pink', orange: 'orange', teal: 'teal' };

/** A number card: colored accent per metric, label, figure, and what the figure compares to. `color` picks the hue explicitly. */
export function StatCard({ label, value, sub, icon: Icon, tone, to, accent, color }) {
  const hue = color || TONE_HUE[tone] || (accent ? 'teal' : HUES[hashString(String(label || '')) % HUES.length]);
  const body = (
    <div className={cx('relative h-full overflow-hidden rounded-xl border border-line bg-surface px-5 py-4', to && 'transition-ui hover:bg-surface-2/60')}>
      <span className={cx('absolute inset-x-0 top-0 h-[3px]', HUE_BAR[hue])} aria-hidden />
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-[13px] font-medium text-fg-2">
          {!Icon && <span className={cx('size-2 shrink-0 rounded-full', HUE_BAR[hue])} aria-hidden />}
          {label}
        </div>
        {Icon && <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-lg', HUE_SOFT[hue])}><Icon className="size-4" aria-hidden /></span>}
      </div>
      <div className="mt-2 text-[28px] font-medium leading-none tabular tracking-[-0.01em] text-fg">{value}</div>
      {sub && <div className="mt-2 text-xs text-muted">{sub}</div>}
    </div>
  );
  return to ? <Link to={to} className="block h-full">{body}</Link> : body;
}

/** Signature detail: a carrier's live local clock, e.g. "9:42 local · CT". */
export function LocalClock({ timezone, className }) {
  if (!timezone) return null;
  let text;
  try {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).replace(' ', ' ');
    const abbr = now.toLocaleTimeString('en-US', { timeZone: timezone, timeZoneName: 'short' }).split(' ').pop().replace(/[SD]T$/, 'T');
    text = `${time} local · ${abbr}`;
  } catch { return null; }
  return <span className={cx('dd-clock', className)}>{text}</span>;
}

/**
 * Table with optional sortable headers and row selection.
 * columns: [{ key, header, render?(row), sortable?, className? }]
 */
export function DataTable({ columns, rows, rowKey = 'id', sort, onSort, selected, onSelect, onRowClick, empty, dense }) {
  const allSelected = selected && rows.length > 0 && rows.every((r) => selected.has(r[rowKey]));
  const toggleAll = () => {
    const next = new Set(selected);
    if (allSelected) rows.forEach((r) => next.delete(r[rowKey]));
    else rows.forEach((r) => next.add(r[rowKey]));
    onSelect(next);
  };
  const toggle = (id) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    onSelect(next);
  };
  if (!rows.length) return empty ?? <EmptyState title="No records" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs text-muted">
            {selected && (
              <th className="w-10 px-3 py-2"><input type="checkbox" aria-label="Select all" checked={allSelected} onChange={toggleAll} className="size-4 accent-brand-600" /></th>
            )}
            {columns.map((c) => {
              const active = sort?.field === c.key;
              return (
                <th key={c.key} className={cx('px-3 py-2 font-medium whitespace-nowrap', c.className)}>
                  {c.sortable && onSort ? (
                    <button type="button" className="inline-flex items-center gap-1 hover:text-fg" onClick={() => onSort({ field: c.key, dir: active && sort.dir === 'asc' ? 'desc' : 'asc' })}>
                      {c.header}
                      {active && (sort.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                    </button>
                  ) : c.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[rowKey]} onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cx('border-b border-line last:border-0', onRowClick && 'cursor-pointer transition-ui hover:bg-surface-2/70', selected?.has(row[rowKey]) && 'bg-surface-2')}>
              {selected && (
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" aria-label="Select row" checked={selected.has(row[rowKey])} onChange={() => toggle(row[rowKey])} className="size-4 accent-brand-600" />
                </td>
              )}
              {columns.map((c) => (
                <td key={c.key} className={cx('px-3 align-middle', dense ? 'py-1.5' : 'py-2.5', c.className)}>{c.render ? c.render(row) : row[c.key] ?? '—'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Very small, safe markdown renderer (escapes HTML first). Supports headings, lists, bold, italics, code, links. */
export function Markdown({ text, className }) {
  return <div className={cx('prose-dd text-sm', className)} dangerouslySetInnerHTML={{ __html: renderMarkdown(text || '') }} />;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
export function renderMarkdown(src) {
  const lines = esc(src).split(/\r?\n/);
  const out = [];
  let list = null;
  let inCode = false;
  let code = [];
  let table = null;
  const flushList = () => { if (list) { out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`); list = null; } };
  const flushTable = () => {
    if (!table) return;
    const [head, ...body] = table.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
    const cells = (r) => r.replace(/^\s*\||\|\s*$/g, '').split('|').map((c) => inline(c.trim()));
    out.push(`<table><thead><tr>${cells(head).map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    table = null;
  };
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) { out.push(`<pre><code>${code.join('\n')}</code></pre>`); code = []; inCode = false; } else { flushList(); flushTable(); inCode = true; }
      continue;
    }
    if (inCode) { code.push(line); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { flushList(); (table ||= []).push(line); continue; }
    flushTable();
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { flushList(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { if (list?.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { if (list?.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = line.match(/^&gt;\s?(.*)$/))) { flushList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    flushList();
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode) out.push(`<pre><code>${code.join('\n')}</code></pre>`);
  flushList();
  flushTable();
  return out.join('\n');
}
