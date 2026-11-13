import { Suspense, lazy, memo, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate, useNavigation } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LayoutDashboard, Radar, Truck, Upload, KanbanSquare, PhoneCall, ListOrdered, CalendarClock, Handshake, BadgeCheck,
  Building2, Package, Calculator, Mail, Workflow, Bot, GraduationCap, Store, MessagesSquare, Users, CreditCard, Settings,
  Shield, Bell, Search, Menu, X, Sun, Moon, LogOut, ChevronDown, Monitor, PanelLeftClose, PanelLeftOpen, PhoneOutgoing, ScrollText, Wrench, Puzzle, Crosshair, Map as MapIcon, MapPinned,
  Sun as SunIcon, ShieldCheck, Receipt, FileStack, BadgePlus, Megaphone, Download, Share, WifiOff, BarChart3,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { applyTheme, storedTheme } from '../context/theme.js';
import { sharedQueryFn } from '../context/tabSync.js';
import { promptInstall, registerServiceWorker, useInstallPrompt } from '../context/pwa.js';
import { syncPushSubscription } from '../context/push.js';
import { api } from '../lib/api.js';
import { relative, zoneClock } from '../lib/format.js';
import { callableAt } from '../components/calling/callWindow.js';
import { Avatar, Button, ErrorBoundary, Loading, cx } from '../components/ui.jsx';
import { Modal } from '../components/Modal.jsx';
import { useToast } from '../components/Toast.jsx';
import { Logo } from '../components/Logo.jsx';
import CommandPalette, { CommandHint } from '../components/CommandPalette.jsx';
import FloatingDock from '../components/market/FloatingDock.jsx';

// Guided tours load after the shell (driver.js itself loads only when a tour starts).
const TourHost = lazy(() => import('../components/tour/TourHost.jsx'));

const NAV = [
  { hue: 'teal', group: null, items: [{ to: '/app', label: 'Dashboard', icon: LayoutDashboard, end: true }] },
  { hue: 'blue', group: 'Leads', items: [
    { to: '/app/lead-generator', label: 'Lead generator', icon: Crosshair },
    { to: '/app/discover', label: 'Find carriers', icon: Radar },
    { to: '/app/carrier-check', label: 'Carrier check', icon: ShieldCheck },
    { to: '/app/carriers', label: 'Carrier list', icon: Truck },
    { to: '/app/market', label: 'Market', icon: MapIcon },
    { to: '/app/new-authority', label: 'New authority', icon: BadgePlus },
    { to: '/app/import', label: 'Import CSV', icon: Upload },
  ] },
  { hue: 'green', group: 'Sales', items: [
    { to: '/app/pipeline', label: 'Pipeline', icon: KanbanSquare },
    { to: '/app/prospecting', label: 'Prospecting', icon: PhoneCall, count: 'queue' },
    { to: '/app/dialer', label: 'Power dialer', icon: PhoneOutgoing },
    { to: '/app/call-scripts', label: 'Call scripts', icon: ScrollText },
    { to: '/app/sequences', label: 'Sequences', icon: ListOrdered },
    { to: '/app/follow-ups', label: 'Follow-ups', icon: CalendarClock, count: 'followUps' },
    { to: '/app/opportunities', label: 'Opportunities', icon: Handshake },
    { to: '/app/customers', label: 'Customers', icon: BadgeCheck },
  ] },
  { hue: 'amber', group: 'Dispatch', items: [
    { to: '/app/today', label: 'Today', icon: SunIcon },
    { to: '/app/brokers', label: 'Brokers', icon: Building2 },
    { to: '/app/fleet', label: 'Fleet map', icon: MapPinned },
    { to: '/app/loads', label: 'Loads', icon: Package, end: true },
    { to: '/app/invoices', label: 'Invoices', icon: Receipt },
    { to: '/app/reports', label: 'Reports', icon: BarChart3 },
    { to: '/app/truck-posts', label: 'Post trucks', icon: Megaphone },
    { to: '/app/loads/calculator', label: 'Rate calculator', icon: Calculator },
    { to: '/app/tools', label: 'Dispatch tools', icon: Wrench },
  ] },
  { hue: 'purple', group: 'Outreach', items: [
    { to: '/app/email', label: 'Email', icon: Mail },
    { to: '/app/templates', label: 'Templates', icon: FileStack },
    { to: '/app/automations', label: 'Automations', icon: Workflow },
    { to: '/app/ai', label: 'AI dispatcher', icon: Bot },
  ] },
  { hue: 'pink', group: 'Grow', items: [
    { to: '/app/training', label: 'Training', icon: GraduationCap },
    { to: '/app/marketplace', label: 'Marketplace', icon: Store },
    { to: '/app/community', label: 'Community', icon: MessagesSquare },
    { to: '/app/team', label: 'Team', icon: Users },
  ] },
  { hue: 'gray', group: 'Account', items: [
    { to: '/app/billing', label: 'Billing', icon: CreditCard },
    { to: '/app/settings', label: 'Settings', icon: Settings },
    { to: '/app/extension', label: 'Browser extension', icon: Puzzle },
    { to: '/app/admin', label: 'Admin', icon: Shield, perm: 'admin.access' },
  ] },
];

// Per-group hue: icon chip, active row tint and the group label dot all share it.
const GROUP_HUE = {
  teal: { chip: 'bg-c-teal-soft text-c-teal', dot: 'bg-c-teal', active: 'bg-c-teal-soft' },
  blue: { chip: 'bg-c-blue-soft text-c-blue', dot: 'bg-c-blue', active: 'bg-c-blue-soft' },
  green: { chip: 'bg-c-green-soft text-c-green', dot: 'bg-c-green', active: 'bg-c-green-soft' },
  amber: { chip: 'bg-c-amber-soft text-c-amber', dot: 'bg-c-amber', active: 'bg-c-amber-soft' },
  purple: { chip: 'bg-c-purple-soft text-c-purple', dot: 'bg-c-purple', active: 'bg-c-purple-soft' },
  pink: { chip: 'bg-c-pink-soft text-c-pink', dot: 'bg-c-pink', active: 'bg-c-pink-soft' },
  gray: { chip: 'bg-c-gray-soft text-c-gray', dot: 'bg-c-gray', active: 'bg-c-gray-soft' },
};

// Nav rows with a live count badge that the NAV entries above do not name themselves (route -> useNavCounts key).
const NAV_COUNT = { '/app/today': 'today' };

// Shell polls run only while the tab is visible (TanStack pauses intervals in hidden tabs), refresh when the tab
// comes back if the data is older than staleTime, and are shared between open tabs (context/tabSync.js).
const POLL = { refetchIntervalInBackground: false, refetchOnWindowFocus: true };

/** The queue count endpoint may not exist on older servers: a 404 means "no badge", not an error. */
async function queueCount({ signal }) {
  try {
    // Contract: { queue, followUps, overdue } (count is an alias of queue).
    const d = await api.get('/api/prospecting/queue/count', undefined, { signal });
    const n = d?.queue ?? d?.count;
    return { count: Number.isFinite(Number(n)) ? Number(n) : null };
  } catch (err) {
    if (err?.status === 404) return { count: null, unavailable: true };
    throw err;
  }
}

/** Today board rows that need action now ({ urgent, total }, served from the server's 30 s board cache). */
async function todayCount({ signal }) {
  try {
    const d = await api.get('/api/today/count', undefined, { signal });
    return { urgent: Number(d?.urgent) || 0, total: Number(d?.total) || 0 };
  } catch (err) {
    if (err?.status === 404 || err?.status === 403) return { urgent: 0, total: 0, unavailable: true };
    throw err;
  }
}

/** Live counts shown at the right edge of nav rows. */
function useNavCounts(uid) {
  const fu = useQuery({
    queryKey: ['follow-ups', 'nav-count', uid],
    queryFn: sharedQueryFn(`fu-count:${uid}`, ({ signal }) => api.get('/api/follow-ups', { view: 'today', pageSize: 1 }, { signal }), 100_000),
    staleTime: 60_000, refetchInterval: 120_000, ...POLL,
  });
  const queue = useQuery({
    queryKey: ['queue', 'nav-count', uid],
    queryFn: sharedQueryFn(`queue-count:${uid}`, queueCount, 100_000),
    staleTime: 60_000,
    refetchInterval: (q) => (q.state.data?.unavailable ? false : 120_000),
    retry: false,
    ...POLL,
  });
  const today = useQuery({
    queryKey: ['today', 'nav-count', uid],
    // Building the board is about ten indexed queries, so this badge polls less often than the others; Today and
    // load changes invalidate ['today'] and refresh it right away.
    queryFn: sharedQueryFn(`today-count:${uid}`, todayCount, 250_000),
    staleTime: 120_000,
    refetchInterval: (q) => (q.state.data?.unavailable ? false : 300_000),
    retry: false,
    ...POLL,
  });
  const c = fu.data?.counts;
  return {
    followUps: c ? (c.overdue || 0) + (c.today || 0) : null,
    followUpsUrgent: !!c?.overdue,
    queue: queue.data?.count ?? null,
    // Only rows that need action now are counted, so the badge means "look at Today".
    today: today.data?.urgent || null,
    todayUrgent: !!today.data?.urgent,
  };
}

const Sidebar = memo(function Sidebar({ onNavigate, collapsed }) {
  const { can, user } = useAuth();
  const counts = useNavCounts(user.id);
  return (
    <nav className={cx('flex-1 overflow-y-auto pb-6', collapsed ? 'px-2' : 'px-3')} aria-label="App">
      {NAV.map((section, i) => {
        const items = section.items.filter((it) => !it.perm || can(it.perm));
        if (!items.length) return null;
        const hue = GROUP_HUE[section.hue] || GROUP_HUE.gray;
        return (
          <div key={i} className={i === 0 ? 'mt-1' : collapsed ? 'mt-2 border-t border-line pt-2' : 'mt-5'}>
            {section.group && !collapsed && (
              <div data-tour={`nav-group-${section.group.toLowerCase()}`} className="mb-1 flex h-6 items-center gap-2 px-2.5 text-[11.5px] font-medium uppercase tracking-[0.06em] text-muted">
                <span className="flex w-6 justify-center" aria-hidden><span className={cx('size-1.5 rounded-full', hue.dot)} /></span>
                {section.group}
              </div>
            )}
            <div className="space-y-0.5">
              {items.map((it) => {
                const countKey = it.count || NAV_COUNT[it.to];
                const n = countKey ? counts[countKey] : null;
                const urgent = (countKey === 'followUps' && counts.followUpsUrgent) || (countKey === 'today' && counts.todayUrgent);
                return (
                  <NavLink key={it.to} to={it.to} end={it.end} onClick={onNavigate} title={collapsed ? it.label : undefined} data-tour={`nav-${it.to.split('/').pop()}`}
                    className={({ isActive }) => cx('relative flex h-9 items-center gap-2 rounded-lg text-sm transition-ui', collapsed ? 'justify-center px-0' : 'px-2.5',
                      isActive ? cx(hue.active, 'font-medium text-fg') : 'text-fg-2 hover:bg-surface-2 hover:text-fg')}>
                    {({ isActive }) => (
                      <>
                        {isActive && !collapsed && <span className={cx('absolute inset-y-2 left-0 w-[3px] rounded-r', hue.dot)} aria-hidden />}
                        <span className={cx('flex size-6 shrink-0 items-center justify-center rounded-md', hue.chip)}>
                          <it.icon className="size-[15px]" strokeWidth={2} aria-hidden />
                        </span>
                        <span className={collapsed ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{it.label}</span>
                        {!collapsed && n > 0 && (
                          <span className={cx('ml-auto min-w-6 rounded-full px-1.5 text-center text-[11px] font-medium leading-5 tabular',
                            urgent ? 'bg-c-red-soft text-c-red' : 'bg-surface-2 text-fg-2')}>{n > 99 ? '99+' : n}</span>
                        )}
                        {collapsed && n > 0 && <span className={cx('absolute right-1.5 top-1.5 size-1.5 rounded-full', urgent ? 'bg-c-red' : hue.dot)} aria-hidden />}
                      </>
                    )}
                  </NavLink>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
});

// Same hues as the market map's time zones.
const ZONES = [['PT', 'America/Los_Angeles', 'purple'], ['MT', 'America/Denver', 'amber'], ['CT', 'America/Chicago', 'green'], ['ET', 'America/New_York', 'blue']];

/** Live US time zones (who you can call right now) and today's lead usage. */
const SidebarFooter = memo(function SidebarFooter({ collapsed }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);
  const billing = useQuery({ queryKey: ['billing', 'me'], queryFn: ({ signal }) => api.get('/api/billing/me', undefined, { signal }), staleTime: 60000 });
  const used = billing.data?.usage?.discoveryToday;
  const limit = billing.data?.plan?.limits?.maxDiscoveryPerDay;
  if (collapsed) return null;
  return (
    <div className="border-t border-line px-3 py-3">
      <div className="grid grid-cols-4 gap-1.5" aria-label="US time zones" data-tour="clocks">
        {ZONES.map(([abbr, tz, hueKey]) => {
          const hue = GROUP_HUE[hueKey];
          const clock = zoneClock(now, tz);
          // Same calling-hours rule as the dialer and the server (weekdays 8:00 to 19:00 local).
          const { callable } = callableAt(tz, now);
          return (
            <div key={abbr} title={`${tz.split('/')[1].replace('_', ' ')} time${callable ? ' · business hours' : ' · outside business hours'}`}
              className={cx('rounded-md px-1 py-1 text-center', hue.chip)}>
              <div className="flex items-center justify-center gap-1 text-[10.5px] font-medium">
                <span className={cx('size-1.5 rounded-full', callable ? hue.dot : 'bg-line-strong')} aria-hidden />{abbr}
              </div>
              <div className="font-mono text-[12px] tabular text-fg">{clock.time}<span className="text-[10px] text-muted">{clock.ampm}</span></div>
            </div>
          );
        })}
      </div>
      {used != null && limit != null && (
        <Link to="/app/billing" className="mt-3 block px-0.5 text-[11.5px] text-fg-2 hover:text-fg">
          <div className="flex justify-between"><span>Leads saved today</span><span className="tabular">{used} / {limit < 0 ? '∞' : limit}</span></div>
          {limit > 0 && <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2"><div className={cx('h-full rounded-full', used / limit >= 0.9 ? 'bg-c-red' : used / limit >= 0.7 ? 'bg-c-amber' : 'bg-c-teal')} style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} /></div>}
        </Link>
      )}
    </div>
  );
});

/** Close a menu on an outside click or Escape. Listens only while `active`, with a stable handler. */
function useDismiss(ref, onDismiss, active) {
  const cb = useRef(onDismiss);
  cb.current = onDismiss;
  useEffect(() => {
    if (!active) return undefined;
    const down = (e) => { if (ref.current && !ref.current.contains(e.target)) cb.current(); };
    const key = (e) => { if (e.key === 'Escape') cb.current(); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [ref, active]);
}

function Notifications() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  useDismiss(ref, () => setOpen(false), open);
  // The badge polls a single count; the list loads only when the menu opens.
  const count = useQuery({
    queryKey: ['notifications', 'unread', user.id],
    queryFn: sharedQueryFn(`unread:${user.id}`, ({ signal }) => api.get('/api/notifications/unread-count', undefined, { signal }), 50_000),
    staleTime: 30_000, refetchInterval: 60_000, ...POLL,
  });
  const q = useQuery({
    queryKey: ['notifications', 'menu', user.id],
    queryFn: async ({ signal }) => {
      const d = await api.get('/api/notifications', { pageSize: 8 }, { signal });
      qc.setQueryData(['notifications', 'unread', user.id], { unread: d.unread ?? 0 });
      return d;
    },
    enabled: open,
    staleTime: 15_000,
  });
  const done = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  const readAll = useMutation({ mutationFn: () => api.post('/api/notifications/read-all'), onSuccess: done });
  const readOne = useMutation({ mutationFn: (id) => api.post(`/api/notifications/${id}/read`), onSuccess: done });
  const unread = count.data?.unread ?? 0;
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(!open)} className="relative rounded-md p-2 text-muted hover:bg-surface-2 hover:text-fg" aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`} aria-expanded={open}>
        <Bell className="size-[18px]" />
        {unread > 0 && <span className="absolute right-1 top-1 min-w-4 rounded-full bg-signal-500 px-1 text-center text-[10px] font-medium leading-4 text-stone-950">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-[min(360px,calc(100vw-1.5rem))] rounded-xl border border-line bg-surface shadow-xl">
          <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
            <span className="text-sm font-medium">Notifications</span>
            {unread > 0 && <button type="button" className="text-xs text-brand-700 hover:underline disabled:opacity-60 dark:text-brand-300" disabled={readAll.isPending} onClick={() => readAll.mutate()}>Mark all read</button>}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {q.isLoading ? <Loading /> : q.isError && !q.data ? <p className="px-4 py-8 text-center text-sm text-muted">Couldn't load notifications. <button type="button" className="font-medium text-fg hover:underline" onClick={() => q.refetch()}>Try again</button></p>
              : !q.data?.items?.length ? <p className="px-4 py-8 text-center text-sm text-muted">You're all caught up.</p> : q.data.items.map((n) => (
                <button key={n.id} type="button" onClick={() => { if (!n.readAt) readOne.mutate(n.id); setOpen(false); if (n.link) navigate(n.link); }}
                  className={cx('block w-full border-b border-line/60 px-3.5 py-2.5 text-left last:border-0 hover:bg-surface-2', !n.readAt && 'bg-brand-50/40 dark:bg-brand-900/10')}>
                  <div className="flex items-start gap-2">
                    {!n.readAt && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand-600" />}
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{n.title}</p>
                      {n.body && <p className="truncate text-xs text-muted">{n.body}</p>}
                      <p className="mt-0.5 text-[11px] text-muted">{relative(n.createdAt)}</p>
                    </div>
                  </div>
                </button>
              ))}
          </div>
          <Link to="/app/notifications" onClick={() => setOpen(false)} className="block border-t border-line px-3.5 py-2 text-center text-xs text-muted hover:text-fg">View all</Link>
        </div>
      )}
    </div>
  );
}

function ThemeToggle() {
  const { user, setUser } = useAuth();
  const [theme, setTheme] = useState(storedTheme());
  const order = ['light', 'dark', 'system'];
  const Icon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  const next = async () => {
    const t = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(t);
    applyTheme(t);
    try { const { user: u } = await api.patch('/api/profile', { theme: t }); setUser(u); } catch { /* keep local choice */ }
  };
  return <button type="button" onClick={next} className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-fg" aria-label={`Theme: ${theme}. Switch theme`} title={`Theme: ${theme}`} disabled={!user}><Icon className="size-[18px]" /></button>;
}

function IosInstallHelp({ open, onClose }) {
  return (
    <Modal open={open} onClose={onClose} title="Add DispatchDesk to your Home Screen" size="sm" footer={<Button onClick={onClose}>Done</Button>}>
      <ol className="list-decimal space-y-2 pl-5 text-sm text-fg-2">
        <li>In Safari, tap the Share button <Share className="inline size-4 align-text-bottom" aria-label="Share" />.</li>
        <li>Choose <span className="font-medium text-fg">Add to Home Screen</span>, then tap Add.</li>
        <li>Open DispatchDesk from your Home Screen.</li>
      </ol>
      <p className="mt-3 text-sm text-muted">Push notifications on iPhone and iPad (iOS 16.4 or later) work only in the Home Screen app. Turn them on in Settings, Notifications.</p>
    </Modal>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [iosHelp, setIosHelp] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();
  const toast = useToast();
  const install = useInstallPrompt();
  useDismiss(ref, () => setOpen(false), open);
  const item = 'flex w-full items-center gap-2 px-3.5 py-2 text-left text-sm hover:bg-surface-2';
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-2 rounded-md py-1 pl-1 pr-2 hover:bg-surface-2" aria-haspopup="menu" aria-expanded={open}>
        <Avatar name={user.name} src={user.avatarUrl} size={28} />
        <span className="hidden max-w-32 truncate text-sm font-medium lg:block">{user.name}</span>
        <ChevronDown className="hidden size-3.5 text-muted lg:block" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-40 mt-1 w-56 rounded-xl border border-line bg-surface py-1 shadow-xl">
          <div className="border-b border-line px-3.5 py-2.5">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-muted">{user.email}</p>
            <p className="mt-1 text-[11px] text-muted">{user.roleName}{user.team ? ` · ${user.team.name}` : ''}</p>
          </div>
          <Link role="menuitem" to="/app/settings" onClick={() => setOpen(false)} className="block px-3.5 py-2 text-sm hover:bg-surface-2">Settings</Link>
          <Link role="menuitem" to="/app/billing" onClick={() => setOpen(false)} className="block px-3.5 py-2 text-sm hover:bg-surface-2">Billing</Link>
          <button role="menuitem" type="button" onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('dd:tour', { detail: { id: 'auto' } })); }} className="block w-full px-3.5 py-2 text-left text-sm hover:bg-surface-2">Take the tour</button>
          {install.canInstall && (
            <button role="menuitem" type="button" className={item}
              onClick={async () => { setOpen(false); const outcome = await promptInstall(); if (outcome === 'accepted') toast.success('DispatchDesk was added to this device'); }}>
              <Download className="size-4 text-muted" aria-hidden /> Install app
            </button>
          )}
          {!install.canInstall && install.iosHint && (
            <button role="menuitem" type="button" className={item} onClick={() => { setOpen(false); setIosHelp(true); }}>
              <Download className="size-4 text-muted" aria-hidden /> Add to Home Screen
            </button>
          )}
          <Link role="menuitem" to="/" onClick={() => setOpen(false)} className="block px-3.5 py-2 text-sm hover:bg-surface-2">Public site</Link>
          <button role="menuitem" type="button" onClick={async () => { setOpen(false); await logout(); navigate('/login'); }} className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-sm text-red-600 hover:bg-surface-2">
            <LogOut className="size-4" /> Log out
          </button>
        </div>
      )}
      <IosInstallHelp open={iosHelp} onClose={() => setIosHelp(false)} />
    </div>
  );
}

function VerifyBanner() {
  const { user, refresh } = useAuth();
  const [sent, setSent] = useState(null);
  // Without platform email there is nothing to resend, so the banner would only nag.
  if (!user || user.emailVerified || user.mailConfigured === false) return null;
  const required = !!user.verificationRequired;
  const resend = async () => {
    try {
      const r = await api.post('/api/auth/resend-verification');
      // Verified meanwhile (another tab or device): reload the account so the banner goes away.
      if (r?.alreadyVerified) { setSent('Your email is already verified.'); refresh(); return; }
      setSent(r?.emailSent ? 'Verification email sent.' : `Could not send email: ${r?.reason || 'email not configured'}`);
    } catch (e) { setSent(e.message); }
  };
  return (
    <div role={required ? 'status' : undefined} className={cx('flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-4 py-2 text-[13px] sm:px-6', required ? 'bg-c-amber-soft text-fg' : 'bg-surface text-fg-2')}>
      <span className={cx('size-1.5 shrink-0 rounded-full', required ? 'bg-c-amber' : 'bg-signal-500')} aria-hidden />
      {required ? 'Verify your email to start saving changes. Until then you can look around.' : 'Verify your email address to secure your account'}
      {sent ? <span className="text-fg">· {sent}</span> : <button type="button" className="font-medium text-fg underline-offset-2 hover:underline" onClick={resend}>Resend link</button>}
    </div>
  );
}

/** Seconds until the next automatic retry, ticking. */
function useCountdown(at) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!at) return undefined;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [at]);
  return at ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : 0;
}

/** Shown while the server cannot be reached; the session is kept and checked again automatically. */
function ConnectionNotice({ connection, retryNow, block }) {
  const secs = useCountdown(connection?.retryAt);
  if (!connection) return null;
  const text = `${connection.message} ${secs > 0 ? `Trying again in ${secs} s.` : 'Trying again…'}`;
  if (block) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center" role="status">
        <WifiOff className="size-5 text-muted" aria-hidden />
        <p className="text-sm text-fg-2">{text}</p>
        <Button variant="secondary" size="sm" onClick={retryNow}>Retry now</Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-c-amber/30 bg-c-amber-soft px-4 py-2 text-[13px] text-fg-2 sm:px-6" role="status">
      <WifiOff className="size-4 shrink-0 text-c-amber" aria-hidden />
      <span className="min-w-0 flex-1">{text}</span>
      <button type="button" className="font-medium text-fg hover:underline" onClick={retryNow}>Retry now</button>
    </div>
  );
}

/** Header search: its own state, so typing does not re-render the sidebar and the rest of the shell. */
function HeaderSearch() {
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  const submit = (e) => {
    e.preventDefault();
    if (q.trim()) navigate(`/app/carriers?q=${encodeURIComponent(q.trim())}`);
  };
  return (
    <form onSubmit={submit} className="relative min-w-0 max-w-md flex-1" role="search" data-tour="search">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search carriers, MC or DOT" aria-label="Search carriers by name, MC, DOT or phone"
        className="h-9 w-full rounded-lg border border-line bg-bg pl-8 pr-12 text-sm placeholder:text-muted transition-ui focus:border-brand-500 focus:outline-none" />
      <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-line-strong px-1.5 font-mono text-[11px] text-muted sm:block">Enter</kbd>
    </form>
  );
}

/** Thin bar at the top while the next page's code loads. */
function RouteProgress() {
  const navigation = useNavigation();
  if (navigation.state === 'idle') return null;
  return <div className="pointer-events-none fixed inset-x-0 top-0 z-[70] h-0.5 animate-pulse bg-brand-600" role="progressbar" aria-label="Loading page" />;
}

/** Shell-level effects: in-app navigation requests (toasts, notification clicks), service worker, push sync. */
function useShellEffects(userId) {
  const navigate = useNavigate();
  useEffect(() => {
    const go = (href) => {
      if (typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//')) return false;
      navigate(href);
      return true;
    };
    const onNavigate = (e) => { if (go(e.detail?.href)) e.preventDefault(); };
    const onWorker = (e) => { if (e.data?.type === 'dd:navigate') go(e.data.href); };
    window.addEventListener('dd:navigate', onNavigate);
    navigator.serviceWorker?.addEventListener?.('message', onWorker);
    return () => {
      window.removeEventListener('dd:navigate', onNavigate);
      navigator.serviceWorker?.removeEventListener?.('message', onWorker);
    };
  }, [navigate]);
  useEffect(() => {
    if (!userId) return undefined;
    const t = setTimeout(async () => {
      if (import.meta.env.PROD) await registerServiceWorker();
      await syncPushSubscription(userId);
    }, 3000);
    return () => clearTimeout(t);
  }, [userId]);
}

export default function AppLayout() {
  const { user, loading, connection, retryNow } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('dd:sidebar') === 'collapsed'; } catch { return false; } });
  const toggleCollapsed = () => setCollapsed((c) => { try { localStorage.setItem('dd:sidebar', c ? 'open' : 'collapsed'); } catch { /* storage unavailable */ } return !c; });
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);
  useShellEffects(user?.id);

  if (loading) {
    return connection ? <ConnectionNotice connection={connection} retryNow={retryNow} block /> : <Loading label="Loading your workspace…" className="h-full" />;
  }
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;

  return (
    <div className="flex h-full">
      <RouteProgress />
      <aside className={cx('hidden shrink-0 flex-col border-r border-line bg-sidebar transition-[width] duration-150 lg:flex', collapsed ? 'w-16' : 'w-64')}>
        <div className={cx('flex h-14 items-center', collapsed ? 'justify-center' : 'justify-between pl-[22px] pr-3')}>
          {!collapsed && <Link to="/app"><Logo /></Link>}
          <button type="button" onClick={toggleCollapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="rounded-md p-1.5 text-muted transition-ui hover:bg-surface-2 hover:text-fg">
            {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          </button>
        </div>
        <Sidebar collapsed={collapsed} />
        <SidebarFooter collapsed={collapsed} />
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-sidebar pb-[env(safe-area-inset-bottom)] shadow-xl">
            <div className="flex h-14 items-center justify-between px-4">
              <Logo />
              <button type="button" onClick={() => setMobileOpen(false)} aria-label="Close menu" className="rounded p-1.5"><X className="size-5" /></button>
            </div>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
            <SidebarFooter />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 sm:px-4">
          <button type="button" className="rounded-md p-2 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu"><Menu className="size-5" /></button>
          <HeaderSearch />
          <div className="ml-auto flex items-center gap-1">
            <span className="mr-1 hidden md:inline-flex" data-tour="palette"><CommandHint /></span>
            <ThemeToggle />
            <span className="inline-flex" data-tour="notifications"><Notifications /></span>
            <span className="inline-flex" data-tour="user-menu"><UserMenu /></span>
          </div>
        </header>
        <CommandPalette />
        <FloatingDock />
        <ErrorBoundary fallback={null}>
          <Suspense fallback={null}><TourHost /></Suspense>
        </ErrorBoundary>
        <ConnectionNotice connection={connection} retryNow={retryNow} />
        <VerifyBanner />
        <main className="min-h-0 flex-1 overflow-y-auto">
          {/* Bottom padding keeps the last rows clear of the floating dock (desktop) and the home indicator (phones). */}
          <div key={location.pathname} className="dd-enter mx-auto max-w-[1440px] px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-6 sm:px-8 sm:pb-20 sm:pt-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

/** Route guard for permission-gated pages (backend enforces too). Kept for imports; the router has its own copy. */
export function RequirePermission({ perm, children }) {
  const { can } = useAuth();
  if (!can(perm)) return <div className="py-16 text-center"><p className="font-medium">Access denied</p><p className="mt-1 text-sm text-muted">Your role does not include access to this area.</p></div>;
  return children;
}
