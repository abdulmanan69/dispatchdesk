import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ArrowUpRight, Search } from 'lucide-react';
import { Select, cx } from '../ui.jsx';
import { itemId, searchAdmin } from './adminPages.js';

const countText = (n) => (n > 99 ? '99+' : String(n));

/** "Find a page or setting": type, then pick with the mouse or the arrow keys and Enter. */
export function AdminSearch({ menu, onGo }) {
  const id = useId();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const results = useMemo(() => searchAdmin(menu, q), [menu, q]);
  const shown = open && q.trim().length > 0;
  const go = (r) => { onGo(r); setQ(''); setOpen(false); };
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
      <input type="search" role="combobox" aria-label="Find a page or setting" aria-autocomplete="list"
        aria-expanded={shown} aria-controls={`${id}-results`} aria-activedescendant={shown && results[active] ? `${id}-r${active}` : undefined}
        value={q} placeholder="Find a page or setting" autoComplete="off" spellCheck={false}
        onChange={(e) => { setQ(e.target.value); setActive(0); setOpen(true); }}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, Math.max(results.length - 1, 0))); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === 'Enter' && shown && results[active]) { e.preventDefault(); go(results[active]); }
          else if (e.key === 'Escape') { setQ(''); setOpen(false); }
        }}
        className="h-9 w-full rounded-lg border border-line-strong bg-surface pl-8 pr-3 text-sm text-fg placeholder:text-muted transition-ui focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/15" />
      {shown && (
        <ul id={`${id}-results`} role="listbox" aria-label="Pages and settings"
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-96 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-lg">
          {results.length === 0 ? (
            <li role="presentation" className="px-3 py-2 text-sm text-muted">Nothing matches “{q.trim()}”</li>
          ) : results.map((r, i) => {
            const Icon = r.item.icon;
            return (
              <li key={`${r.kind}:${r.settingKey || itemId(r.item)}`} id={`${id}-r${i}`} role="option" aria-selected={i === active}
                onMouseDown={(e) => { e.preventDefault(); go(r); }} onMouseEnter={() => setActive(i)}
                className={cx('flex cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2', i === active && 'bg-surface-2')}>
                <Icon className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">{r.label}</span>
                  <span className="block truncate text-xs text-muted">{r.kind === 'setting' ? `Setting · ${r.sub}` : r.sub}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The admin menu: pages in groups, with counts of what needs attention. */
export function AdminMenu({ menu, currentId, counts = {}, onGo }) {
  return (
    <nav aria-label="Admin" className="space-y-5">
      {menu.map((g) => (
        <div key={g.group}>
          <p className="mb-1 px-2.5 text-xs font-medium text-muted">{g.group}</p>
          <ul className="space-y-0.5">
            {g.items.map((it) => {
              const iid = itemId(it);
              const active = iid === currentId;
              const n = it.count ? counts[it.count] : 0;
              const body = (
                <>
                  {active && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r bg-brand-600" aria-hidden />}
                  <it.icon className={cx('size-4 shrink-0', active ? 'text-brand-600 dark:text-brand-400' : 'text-muted')} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {it.to && <ArrowUpRight className="size-3.5 shrink-0 text-muted" aria-hidden />}
                  {n > 0 && (
                    <span className={cx('min-w-5 rounded-full px-1.5 text-center text-[11px] font-medium leading-5 tabular', it.urgent ? 'bg-c-red-soft text-c-red' : 'bg-c-amber-soft text-c-amber')}
                      aria-label={`${n} need attention`}>{countText(n)}</span>
                  )}
                </>
              );
              const cls = cx('relative flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-ui',
                active ? 'bg-surface-2 font-medium text-fg' : 'text-fg-2 hover:bg-surface-2 hover:text-fg');
              return (
                <li key={iid}>
                  {it.to
                    ? <Link to={it.to} className={cls}>{body}</Link>
                    : <button type="button" className={cls} aria-current={active ? 'page' : undefined} onClick={() => onGo({ item: it })}>{body}</button>}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Small screens: the same menu as one dropdown. */
export function AdminMenuSelect({ menu, currentId, counts = {}, onGo }) {
  const all = menu.flatMap((g) => g.items);
  return (
    <Select aria-label="Admin page" value={currentId} onChange={(e) => {
      const it = all.find((x) => itemId(x) === e.target.value);
      if (it) onGo({ item: it });
    }}>
      {menu.map((g) => (
        <optgroup key={g.group} label={g.group}>
          {g.items.map((it) => {
            const n = it.count ? counts[it.count] : 0;
            return <option key={itemId(it)} value={itemId(it)}>{it.label}{n > 0 ? ` (${countText(n)})` : ''}</option>;
          })}
        </optgroup>
      ))}
    </Select>
  );
}
