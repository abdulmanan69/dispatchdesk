import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigation } from 'react-router';
import { Menu, X, Moon, Sun } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { applyTheme } from '../context/theme.js';
import { Button, cx } from '../components/ui.jsx';
import { Logo } from '../components/Logo.jsx';

const NAV = [
  { to: '/features', label: 'Product' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/training', label: 'Training' },
  { to: '/marketplace', label: 'Marketplace' },
  { to: '/community', label: 'Community' },
];

const FOOTER = [
  { title: 'Product', links: [['/features#leads', 'Lead generator'], ['/features#calling', 'Power dialer'], ['/features#sequences', 'Sequences'], ['/features#fleet', 'Fleet map'], ['/features#extension', 'Chrome extension'], ['/pricing', 'Pricing']] },
  { title: 'Learn', links: [['/training', 'Training'], ['/community', 'Community'], ['/marketplace', 'Marketplace']] },
  { title: 'Company', links: [['/terms', 'Terms'], ['/privacy', 'Privacy'], ['/login', 'Log in'], ['/register', 'Create account']] },
];

function ThemeButton() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    const next = dark ? 'light' : 'dark';
    applyTheme(next);
    setDark(!dark);
  };
  useEffect(() => { setDark(document.documentElement.classList.contains('dark')); }, []);
  return (
    <button type="button" onClick={toggle} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      className="rounded-lg p-2 text-fg-2 transition-ui hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

/** Thin bar at the top while the next page's code loads (pages load on demand). */
function RouteProgress() {
  const navigation = useNavigation();
  if (navigation.state === 'idle') return null;
  return <div className="pointer-events-none fixed inset-x-0 top-0 z-[70] h-0.5 animate-pulse bg-brand-600" role="progressbar" aria-label="Loading page" />;
}

export default function PublicLayout() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const { pathname, hash } = useLocation();
  useEffect(() => { setOpen(false); }, [pathname]);
  // Keep the tab title in sync on client-side navigation (the server sets it for the first load and for link previews).
  useEffect(() => {
    const T = { '/': 'DispatchDesk · CRM and dispatch desk for truck dispatchers', '/features': 'Features · DispatchDesk', '/pricing': 'Pricing · DispatchDesk',
      '/training': 'Dispatch training · DispatchDesk', '/marketplace': 'Marketplace · DispatchDesk', '/community': 'Community · DispatchDesk',
      '/login': 'Log in · DispatchDesk', '/register': 'Create your free account · DispatchDesk', '/terms': 'Terms of service · DispatchDesk', '/privacy': 'Privacy policy · DispatchDesk' };
    const key = pathname.replace(/\/$/, '') || '/';
    if (T[key]) document.title = T[key];
  }, [pathname]);
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
    else window.scrollTo(0, 0);
  }, [pathname, hash]);
  return (
    <div className="flex min-h-full flex-col">
      <RouteProgress />
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:text-sm">Skip to content</a>
      <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Link to="/" className="shrink-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" aria-label="DispatchDesk home"><Logo /></Link>
          <nav className="hidden flex-1 items-center gap-1 md:flex" aria-label="Main">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to}
                className={({ isActive }) => cx('rounded-lg px-3 py-2 text-sm transition-ui focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500', isActive ? 'bg-surface-2 font-medium text-fg' : 'text-fg-2 hover:bg-surface-2 hover:text-fg')}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto hidden items-center gap-2 md:flex">
            <ThemeButton />
            {user ? <Button to="/app">Open app</Button> : (
              <>
                <Button variant="ghost" to="/login">Log in</Button>
                <Button to="/register">Start free</Button>
              </>
            )}
          </div>
          <div className="ml-auto flex items-center gap-1 md:hidden">
            <ThemeButton />
            <button type="button" className="rounded-lg p-2 text-fg-2 hover:bg-surface-2" onClick={() => setOpen(!open)} aria-label="Toggle menu" aria-expanded={open}>
              {open ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>
        </div>
        {open && (
          <nav className="border-t border-line bg-bg px-4 py-3 md:hidden" aria-label="Mobile">
            {NAV.map((n) => <Link key={n.to} to={n.to} className="block rounded-lg px-2 py-2.5 text-[15px] text-fg hover:bg-surface-2">{n.label}</Link>)}
            <div className="mt-3 flex gap-2">
              {user ? <Button to="/app" className="flex-1">Open app</Button> : (<><Button variant="secondary" to="/login" className="flex-1">Log in</Button><Button to="/register" className="flex-1">Start free</Button></>)}
            </div>
          </nav>
        )}
      </header>
      <main id="main" className="flex-1"><Outlet /></main>
      <footer className="border-t border-line bg-surface">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Logo />
            <p className="mt-4 max-w-sm text-sm leading-6 text-fg-2">The sales CRM and dispatch desk for truck dispatchers: carrier leads, calling, sequences, follow-ups and trip planning in one place.</p>
            <div className="mt-5 flex flex-wrap gap-1.5">
              {[['FMCSA', 'bg-c-blue'], ['EIA', 'bg-c-amber'], ['NWS', 'bg-c-red'], ['OpenStreetMap', 'bg-c-green']].map(([s, c]) => (
                <span key={s} className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs text-fg-2"><span className={cx('size-1.5 rounded-full', c)} />{s}</span>
              ))}
            </div>
          </div>
          {FOOTER.map((col) => (
            <div key={col.title}>
              <h2 className="text-sm font-semibold text-fg">{col.title}</h2>
              <ul className="mt-3 space-y-2 text-sm">
                {col.links.map(([to, l]) => <li key={to}><Link to={to} className="text-fg-2 transition-ui hover:text-fg">{l}</Link></li>)}
              </ul>
            </div>
          ))}
        </div>
        <div className="border-t border-line">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-5 text-xs text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <span>© {new Date().getFullYear()} DispatchDesk</span>
            <span>Carrier data from FMCSA public datasets where indicated. Calls are never placed without your click.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
