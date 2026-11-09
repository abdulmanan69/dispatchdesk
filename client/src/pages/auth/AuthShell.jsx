import { Crosshair, PhoneOutgoing, CalendarClock, MapPinned, Check } from 'lucide-react';
import ShaderBackground from '../../components/ShaderBackground.jsx';

const POINTS = [
  { icon: Crosshair, cls: 'bg-c-blue-soft text-c-blue', title: 'Carrier leads from the FMCSA census', text: 'Scored, de-duplicated and added to your call queue.' },
  { icon: PhoneOutgoing, cls: 'bg-c-green-soft text-c-green', title: 'Call with the service you use', text: 'Google Voice, 8x8, RingCentral, Dialpad, Teams and more.' },
  { icon: CalendarClock, cls: 'bg-c-purple-soft text-c-purple', title: 'Follow-ups that happen', text: 'Sequences, reminders and the next step after every call.' },
  { icon: MapPinned, cls: 'bg-c-amber-soft text-c-amber', title: 'Every truck on a map', text: 'Plan the next trip with road miles, fuel and weather.' },
];

export default function AuthShell({ title, subtitle, children, footer }) {
  return (
    <div className="relative isolate grid min-h-[calc(100vh-4rem)] lg:grid-cols-[1.05fr_1fr]">
      {/* Value panel */}
      <aside className="relative hidden overflow-hidden border-r border-line lg:block">
        <ShaderBackground className="-z-20" density={7} speed={0.6} />
        <div aria-hidden className="pub-hero-bg absolute inset-0 -z-10" />
        <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-br from-bg/85 via-bg/70 to-bg/40" />
        <div className="flex h-full flex-col justify-center px-12 py-16 xl:px-16">
          <p className="w-fit rounded-full border border-line bg-surface/70 px-3 py-1 text-[13px] font-medium text-fg-2 backdrop-blur">For truck dispatchers</p>
          <h2 className="mt-6 max-w-md text-[32px] font-semibold leading-tight tracking-[-0.025em] text-fg">The desk for finding, calling and dispatching carriers</h2>
          <ul className="mt-10 space-y-5">
            {POINTS.map((p) => (
              <li key={p.title} className="flex gap-4">
                <span className={`inline-flex size-10 shrink-0 items-center justify-center rounded-xl ${p.cls}`}><p.icon className="size-5" strokeWidth={1.9} aria-hidden /></span>
                <div>
                  <p className="text-[15px] font-semibold text-fg">{p.title}</p>
                  <p className="mt-0.5 text-sm text-fg-2">{p.text}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-12 flex items-center gap-2 text-sm text-fg-2"><Check className="size-4 text-c-green" aria-hidden />Free plan, no card required. Calls are never placed without your click.</p>
        </div>
      </aside>

      {/* Form */}
      <div className="flex items-start justify-center px-4 py-12 sm:items-center sm:px-6">
        <div className="w-full max-w-sm">
          <div className="mb-7">
            <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-fg">{title}</h1>
            {subtitle && <p className="mt-1.5 text-[15px] text-fg-2">{subtitle}</p>}
          </div>
          <div className="rounded-2xl border border-line bg-surface p-6 shadow-[var(--shadow-float)]">{children}</div>
          {footer && <div className="mt-5 text-center text-sm text-fg-2">{footer}</div>}
        </div>
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
