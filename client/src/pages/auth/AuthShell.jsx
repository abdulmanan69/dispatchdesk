import { Link } from 'react-router';
import { Logo } from '../../components/Logo.jsx';
import ShaderBackground from '../../components/ShaderBackground.jsx';

export default function AuthShell({ title, subtitle, children, footer }) {
  return (
    <div className="relative isolate flex min-h-[calc(100vh-3.5rem)] items-start justify-center overflow-hidden px-4 py-12 sm:items-center">
      <ShaderBackground className="-z-20" density={7} speed={0.7} />
      <div aria-hidden className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,var(--bg)_25%,transparent_75%)]" />
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <Link to="/" className="inline-block"><Logo /></Link>
          <h1 className="mt-5 text-xl font-medium tracking-[-0.01em]">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-fg-2">{subtitle}</p>}
        </div>
        <div className="rounded-xl border border-line bg-surface p-6 shadow-[var(--shadow-float)]">{children}</div>
        {footer && <div className="mt-5 text-center text-sm text-fg-2">{footer}</div>}
      </div>
    </div>
  );
}

export function FormError({ error }) {
  if (!error) return null;
  return <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{error}</p>;
}

/** Only allow same-site relative redirects after login. */
export function safeNext(next, fallback = '/app') {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : fallback;
}
