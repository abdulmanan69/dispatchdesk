import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { Menu, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { Button, cx } from '../components/ui.jsx';
import { Logo } from '../components/Logo.jsx';

const NAV = [
  { to: '/features', label: 'Product' },
  { to: '/training', label: 'Training' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/marketplace', label: 'Marketplace' },
  { to: '/community', label: 'Community' },
];

export default function PublicLayout() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <Link to="/" className="shrink-0"><Logo /></Link>
          <nav className="hidden flex-1 items-center gap-1 md:flex" aria-label="Main">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => cx('rounded-md px-3 py-1.5 text-sm', isActive ? 'text-fg font-medium' : 'text-muted hover:text-fg')}>{n.label}</NavLink>
            ))}
          </nav>
          <div className="ml-auto hidden items-center gap-2 md:flex">
            {user ? (
              <Button to="/app">Open app</Button>
            ) : (
              <>
                <Button variant="ghost" to="/login">Log in</Button>
                <Button to="/register">Get started free</Button>
              </>
            )}
          </div>
          <button type="button" className="ml-auto rounded p-2 md:hidden" onClick={() => setOpen(!open)} aria-label="Toggle menu" aria-expanded={open}>
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
        {open && (
          <nav className="border-t border-line px-4 py-3 md:hidden" aria-label="Mobile">
            {NAV.map((n) => <Link key={n.to} to={n.to} onClick={() => setOpen(false)} className="block py-2 text-sm">{n.label}</Link>)}
            <div className="mt-2 flex gap-2">
              {user ? <Button to="/app" className="flex-1">Open app</Button> : (<><Button variant="secondary" to="/login" className="flex-1">Log in</Button><Button to="/register" className="flex-1">Sign up</Button></>)}
            </div>
          </nav>
        )}
      </header>
      <main className="flex-1"><Outlet /></main>
      <footer className="border-t border-line bg-surface">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-sm sm:grid-cols-4">
          <div className="sm:col-span-2">
            <Logo />
            <p className="mt-3 max-w-sm text-muted">Carrier leads, sales pipeline, sequences and dispatch tools in one system — built for truck dispatchers.</p>
          </div>
          <div>
            <h3 className="mb-2 font-medium">Product</h3>
            <ul className="space-y-1.5 text-muted">
              <li><Link to="/features" className="hover:text-fg">Features</Link></li>
              <li><Link to="/pricing" className="hover:text-fg">Pricing</Link></li>
              <li><Link to="/training" className="hover:text-fg">Training</Link></li>
            </ul>
          </div>
          <div>
            <h3 className="mb-2 font-medium">Company</h3>
            <ul className="space-y-1.5 text-muted">
              <li><Link to="/marketplace" className="hover:text-fg">Marketplace</Link></li>
              <li><Link to="/community" className="hover:text-fg">Community</Link></li>
              <li><Link to="/terms" className="hover:text-fg">Terms</Link></li>
              <li><Link to="/privacy" className="hover:text-fg">Privacy</Link></li>
            </ul>
          </div>
        </div>
        <div className="border-t border-line py-4 text-center text-xs text-muted">© {new Date().getFullYear()} DispatchDesk. Carrier data from FMCSA public datasets where indicated.</div>
      </footer>
    </div>
  );
}
