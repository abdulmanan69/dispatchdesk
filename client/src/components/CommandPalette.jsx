import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import {
  Search, CornerDownLeft, LayoutDashboard, Radar, Truck, Upload, KanbanSquare, PhoneCall, PhoneOutgoing, ScrollText, ListOrdered,
  CalendarClock, Handshake, BadgeCheck, Building2, Package, Calculator, Wrench, Mail, Workflow, Bot, GraduationCap, Store,
  MessagesSquare, Users, CreditCard, Settings, Puzzle, Plus, Shield, Bell,
  Crosshair,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { cx } from './ui.jsx';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const OPEN_EVENT = 'dd:palette';

const ACTIONS = [
  { id: 'a-carrier', group: 'Actions', label: 'Add carrier', to: '/app/carriers?new=1', icon: Plus, keywords: 'new create lead' },
  { id: 'a-load', group: 'Actions', label: 'Log a load', to: '/app/loads?new=1', icon: Plus, keywords: 'new create shipment' },
  { id: 'a-dialer', group: 'Actions', label: 'Start dialer session', to: '/app/dialer', icon: PhoneOutgoing, keywords: 'call phone queue power' },
  { id: 'a-email', group: 'Actions', label: 'New email', to: '/app/email?tab=compose', icon: Mail, keywords: 'compose send write' },
  { id: 'a-ai', group: 'Actions', label: 'Ask the AI dispatcher', to: '/app/ai', icon: Bot, keywords: 'question help assistant chat' },
  { id: 'a-lookup', group: 'Actions', label: 'FMCSA lookup by USDOT or MC', to: '/app/tools?tool=lookup', icon: Search, keywords: 'safer authority dot mc check' },
  { id: 'a-rpm', group: 'Actions', label: 'Calculate rate per mile', to: '/app/tools?tool=rate', icon: Calculator, keywords: 'rpm deadhead fuel' },
];

const PAGES = [
  ['Dashboard', '/app', LayoutDashboard], ['Lead generator', '/app/lead-generator', Crosshair], ['Market', '/app/market', Radar], ['Fleet map', '/app/fleet', Truck], ['Today', '/app/today', CalendarClock], ['Invoices', '/app/invoices', Calculator], ['Templates', '/app/templates', Mail], ['New authority', '/app/new-authority', Radar], ['Post trucks', '/app/truck-posts', Truck], ['Find carriers', '/app/discover', Radar], ['Carrier list', '/app/carriers', Truck],
  ['Import CSV', '/app/import', Upload], ['Pipeline', '/app/pipeline', KanbanSquare], ['Prospecting', '/app/prospecting', PhoneCall],
  ['Power dialer', '/app/dialer', PhoneOutgoing], ['Call scripts', '/app/call-scripts', ScrollText], ['Sequences', '/app/sequences', ListOrdered],
  ['Follow-ups', '/app/follow-ups', CalendarClock], ['Opportunities', '/app/opportunities', Handshake], ['Customers', '/app/customers', BadgeCheck],
  ['Brokers', '/app/brokers', Building2], ['Loads', '/app/loads', Package], ['Rate calculator', '/app/loads/calculator', Calculator],
  ['Dispatch tools', '/app/tools', Wrench], ['Email', '/app/email', Mail], ['Automations', '/app/automations', Workflow],
  ['AI dispatcher', '/app/ai', Bot], ['Knowledge base', '/app/ai/knowledge', Bot], ['Training', '/app/training', GraduationCap],
  ['Marketplace', '/app/marketplace', Store], ['Community', '/app/community', MessagesSquare], ['Team', '/app/team', Users],
  ['Billing', '/app/billing', CreditCard], ['Settings', '/app/settings', Settings], ['Notifications', '/app/notifications', Bell],
  ['Browser extension', '/app/extension', Puzzle], ['Admin', '/app/admin', Shield, 'admin.access'],
].map(([label, to, icon, perm]) => ({ id: `p-${to}`, group: 'Go to', label, to, icon, perm }));

/** Subsequence fuzzy score: higher is better, -1 when no match. */
function score(query, text) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 100 - idx;
  let ti = 0; let s = 0; let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    s += 1 + streak;
    ti = found + 1;
  }
  return s;
}

function isTyping(el) {
  return el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

export function Keycap({ children, className }) {
  return <kbd className={cx('inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong px-1 font-mono text-[11px] text-muted', className)}>{children}</kbd>;
}

/** Small button that opens the palette; shows the shortcut. */
export function CommandHint({ className }) {
  return (
    <button type="button" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_EVENT))}
      className={cx('hidden items-center gap-2 rounded-lg px-2 py-1 text-xs text-muted transition-ui hover:bg-surface-2 hover:text-fg md:inline-flex', className)}
      aria-label="Open command palette">
      Jump to <Keycap>{isMac ? '⌘' : 'Ctrl'}</Keycap><Keycap>K</Keycap>
    </button>
  );
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [carriers, setCarriers] = useState({ q: '', items: [], loading: false });
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const navigate = useNavigate();
  const { can } = useAuth();

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); return; }
      if (e.key === '/' && !open && !isTyping(document.activeElement)) { e.preventDefault(); setOpen(true); }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener(OPEN_EVENT, onOpen); };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    setQuery(''); setActive(0); setCarriers({ q: '', items: [], loading: false });
    const prev = document.activeElement;
    const t = setTimeout(() => inputRef.current?.focus(), 10);
    return () => { clearTimeout(t); prev?.focus?.(); };
  }, [open]);

  // Debounced live carrier search.
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2) { setCarriers({ q, items: [], loading: false }); return undefined; }
    setCarriers((c) => ({ ...c, loading: true }));
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await api.get('/api/carriers', { q, pageSize: 6 });
        if (!cancelled) setCarriers({ q, items: res.items || [], loading: false });
      } catch {
        if (!cancelled) setCarriers({ q, items: [], loading: false });
      }
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, open]);

  const results = useMemo(() => {
    const q = query.trim();
    const base = [...ACTIONS, ...PAGES.filter((p) => !p.perm || can(p.perm))]
      .map((it) => ({ ...it, s: score(q, `${it.label} ${it.keywords || ''}`) }))
      .filter((it) => it.s >= 0)
      .sort((a, b) => (q ? b.s - a.s : 0));
    const carrierItems = carriers.items.map((c) => ({
      id: `c-${c.id}`, group: 'Carriers', label: c.companyName, to: `/app/carriers/${c.id}`, icon: Truck,
      meta: [c.mcNumber && `MC ${c.mcNumber}`, c.dotNumber && `DOT ${c.dotNumber}`, c.state].filter(Boolean).join(' · '),
    }));
    const limited = q ? base.slice(0, 8) : base.filter((x) => x.group === 'Actions').concat(base.filter((x) => x.group === 'Go to').slice(0, 6));
    return [...carrierItems, ...limited];
  }, [query, carriers.items, can]);

  useEffect(() => { setActive(0); }, [query, carriers.items.length]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const go = (item) => { if (!item) return; setOpen(false); navigate(item.to); };
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(results[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };

  let lastGroup = null;
  const activeId = results[active] ? `cmd-${results[active].id}` : undefined;

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/30 px-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="dd-enter w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-surface shadow-[var(--shadow-float)]">
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search className="size-4 shrink-0 text-muted" aria-hidden />
          <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown}
            role="combobox" aria-expanded="true" aria-controls="cmd-list" aria-activedescendant={activeId} aria-autocomplete="list"
            placeholder="Search carriers, pages and actions" className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted" />
          {carriers.loading && <span className="font-mono text-xs text-muted">Searching</span>}
          <Keycap>Esc</Keycap>
        </div>
        <ul ref={listRef} id="cmd-list" role="listbox" aria-label="Results" className="max-h-[56vh] overflow-y-auto p-2">
          {!results.length && <li className="px-3 py-8 text-center text-sm text-muted">No matches for “{query}”</li>}
          {results.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            const Icon = it.icon;
            return (
              <li key={it.id} role="presentation">
                {header && <div className="px-3 pb-1 pt-3 text-xs text-muted first:pt-1">{header}</div>}
                <div id={`cmd-${it.id}`} role="option" aria-selected={i === active} data-index={i}
                  onMouseMove={() => setActive(i)} onClick={() => go(it)}
                  className={cx('flex h-10 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm', i === active ? 'bg-surface-2 text-fg' : 'text-fg-2')}>
                  <Icon className={cx('size-4 shrink-0', i === active ? 'text-brand-600 dark:text-brand-300' : 'text-muted')} strokeWidth={1.75} aria-hidden />
                  <span className="truncate">{it.label}</span>
                  {it.meta && <span className="truncate font-mono text-xs text-muted">{it.meta}</span>}
                  {i === active && <CornerDownLeft className="ml-auto size-3.5 shrink-0 text-muted" aria-hidden />}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-xs text-muted">
          <span className="flex items-center gap-1"><Keycap>↑</Keycap><Keycap>↓</Keycap> move</span>
          <span className="flex items-center gap-1"><Keycap>Enter</Keycap> open</span>
          <span className="ml-auto flex items-center gap-1"><Keycap>{isMac ? '⌘' : 'Ctrl'}</Keycap><Keycap>K</Keycap> toggle</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
