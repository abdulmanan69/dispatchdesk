import { Suspense, lazy, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Crosshair, PhoneCall, PhoneOutgoing, ListOrdered, CalendarClock, MapPinned, Map as MapIcon, Puzzle, Bot, Mail, Users,
  ArrowRight, Check, ChevronDown, Truck, MessageSquare, Clock, Route, CloudSun,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { Button, cx } from '../../components/ui.jsx';
import { BY_CODE, localTime } from '../../components/market/usStates.js';

const MarketMap = lazy(() => import('../../components/market/MarketMap.jsx'));

/** Colored icon chip. hue: blue | green | amber | purple | pink | teal | orange | red */
export function Chip({ icon: Icon, hue = 'teal', size = 'md' }) {
  const s = size === 'lg' ? 'size-11 rounded-xl [&>svg]:size-5' : 'size-9 rounded-lg [&>svg]:size-[18px]';
  return <span className={cx('inline-flex shrink-0 items-center justify-center', s, `bg-c-${hue}-soft text-c-${hue}`)}><Icon strokeWidth={1.9} aria-hidden /></span>;
}

export function SectionHead({ eyebrow, hue = 'teal', title, sub, center }) {
  return (
    <div className={cx('max-w-2xl', center && 'mx-auto text-center')}>
      {eyebrow && <p className={cx('mb-3 text-[13px] font-semibold', `text-c-${hue}`)}>{eyebrow}</p>}
      <h2 className="text-[30px] font-semibold leading-tight tracking-[-0.02em] text-fg sm:text-[38px]">{title}</h2>
      {sub && <p className="mt-3 text-[17px] leading-7 text-fg-2">{sub}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Hero product preview: call queue + dialer (example data)            */
/* ------------------------------------------------------------------ */

const QUEUE = [
  { name: 'Red River Transport LLC', meta: 'MC 1184420 · Shreveport, LA · 4 trucks', tz: 'America/Chicago', step: 'Call · step 2 of 4', hue: 'blue', stage: 'Sequence' },
  { name: 'Blue Ridge Reefer Co', meta: 'MC 1093317 · Roanoke, VA · 2 trucks', tz: 'America/New_York', step: 'Follow-up due', hue: 'amber', stage: 'Prospecting' },
  { name: 'Sunbelt Flatbed Inc', meta: 'MC 1240085 · Mesa, AZ · 7 trucks', tz: 'America/Phoenix', step: 'Rate talk', hue: 'purple', stage: 'Opportunity' },
  { name: 'Lone Pine Hauling', meta: 'MC 1312906 · Missoula, MT · 1 truck', tz: 'America/Denver', step: 'First call', hue: 'green', stage: 'New lead' },
];
const OUTCOMES = [['1', 'No answer', 'gray'], ['2', 'Voicemail', 'blue'], ['3', 'Interested', 'green'], ['4', 'Call back', 'amber'], ['5', 'Not interested', 'red'], ['6', 'Signed', 'teal']];

function useNow(ms = 30000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

function WindowChrome({ title, children, className }) {
  return (
    <div className={cx('overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_24px_60px_-20px_rgba(0,0,0,0.35)]', className)}>
      <div className="flex items-center gap-2 border-b border-line bg-surface-2/70 px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-[#ff5f57]" /><span className="size-2.5 rounded-full bg-[#febc2e]" /><span className="size-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-3 truncate text-xs text-muted">{title}</span>
      </div>
      {children}
    </div>
  );
}

export function HeroPreview() {
  const now = useNow();
  return (
    <WindowChrome title="dispatchdesk · Power dialer" className="pub-float">
      <div className="grid md:grid-cols-[1.25fr_1fr]">
        <div className="border-b border-line md:border-b-0 md:border-r">
          <div className="flex items-center justify-between px-4 py-3">
            <span className="flex items-center gap-2 text-sm font-semibold"><Chip icon={PhoneCall} hue="blue" size="sm" />Today's call queue</span>
            <span className="rounded-full bg-c-red-soft px-2 py-0.5 text-[11px] font-semibold text-c-red">1 overdue</span>
          </div>
          <ul className="divide-y divide-line">
            {QUEUE.map((c, i) => (
              <li key={c.name} className={cx('flex items-center gap-3 px-4 py-2.5', i === 0 && 'bg-c-blue-soft/50')}>
                <span className={cx('h-8 w-1 shrink-0 rounded-full', `bg-c-${c.hue}`)} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold text-fg">{c.name}</p>
                  <p className="truncate font-mono text-[11px] text-muted">{c.meta}</p>
                </div>
                <div className="hidden shrink-0 text-right sm:block">
                  <p className="font-mono text-[11px] text-fg-2">{localTime(c.tz, now)}</p>
                  <p className={cx('text-[11px] font-medium', `text-c-${c.hue}`)}>{c.step}</p>
                </div>
              </li>
            ))}
          </ul>
          <div className="flex items-end justify-between gap-4 border-t border-line bg-bg/60 px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-[11px] text-muted">Rate check · Dallas, TX to Atlanta, GA · dry van</p>
              <p className="mt-0.5 font-mono text-xs text-fg-2">$2,200 ÷ 781 loaded mi</p>
            </div>
            <p className="shrink-0 text-right"><span className="block text-2xl font-semibold leading-none text-c-teal tabular">$2.82</span><span className="font-mono text-[10px] text-muted">per loaded mile</span></p>
          </div>
        </div>
        <div className="space-y-3 p-4">
          <div className="rounded-xl border border-line bg-bg p-3">
            <p className="text-[11px] font-medium text-muted">Calling with</p>
            <p className="mt-0.5 flex items-center gap-2 text-sm font-semibold"><span className="size-2 rounded-full bg-c-green" />Google Voice</p>
            <p className="mt-2 font-mono text-lg text-fg tabular">(318) 555-0142</p>
            <div className="mt-2 flex items-center gap-2 text-[11px] text-muted"><Clock className="size-3.5" />{localTime('America/Chicago', now)} in Shreveport · good time to call</div>
          </div>
          <div>
            <p className="mb-1.5 text-[11px] font-medium text-muted">Disposition</p>
            <div className="grid grid-cols-2 gap-1.5">
              {OUTCOMES.map(([k, l, h]) => (
                <span key={k} className={cx('flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] font-medium', `border-c-${h}/30 bg-c-${h}-soft text-c-${h}`)}>
                  <kbd className="rounded bg-surface px-1 font-mono text-[10px] text-fg-2">{k}</kbd>{l}
                </span>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-lg bg-c-purple-soft px-3 py-2 text-[11px] font-medium text-c-purple"><Mail className="size-3.5" />Next: email step · template "Intro + rate sheet"</div>
        </div>
      </div>
    </WindowChrome>
  );
}

/* ------------------------------------------------------------------ */
/* Workflow strip                                                      */
/* ------------------------------------------------------------------ */

const FLOW = [
  { icon: Crosshair, hue: 'blue', title: 'Find leads', text: 'Filter the FMCSA census by state, fleet size, cargo and authority age.' },
  { icon: ListOrdered, hue: 'purple', title: 'Add to a sequence', text: 'Call, email and text steps scheduled day by day.' },
  { icon: PhoneOutgoing, hue: 'green', title: 'Call with Google Voice', text: 'Or 8x8, RingCentral, Dialpad, Teams, Zoom or Twilio. You press call.' },
  { icon: MessageSquare, hue: 'amber', title: 'Disposition', text: 'One key logs the outcome, notes and the next step.' },
  { icon: CalendarClock, hue: 'pink', title: 'Follow up', text: 'Reminders, snooze, repeat, and the email or text ready to send.' },
];

export function WorkflowStrip() {
  return (
    <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {FLOW.map((f, i) => (
        <li key={f.title} className="relative rounded-2xl border border-line bg-surface p-5 transition-ui hover:-translate-y-0.5 hover:shadow-[var(--shadow-float)]">
          <div className="flex items-center justify-between">
            <Chip icon={f.icon} hue={f.hue} />
            <span className="font-mono text-xs text-muted">{String(i + 1).padStart(2, '0')}</span>
          </div>
          <h3 className="mt-4 text-[15px] font-semibold text-fg">{f.title}</h3>
          <p className="mt-1.5 text-sm leading-6 text-fg-2">{f.text}</p>
          {i < FLOW.length - 1 && <ArrowRight className="absolute -right-2.5 top-1/2 z-10 hidden size-5 -translate-y-1/2 rounded-full bg-bg p-0.5 text-muted lg:block" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/* Feature grid                                                        */
/* ------------------------------------------------------------------ */

export const FEATURES = [
  { icon: Crosshair, hue: 'blue', title: 'Lead generator', text: 'Saved FMCSA Census searches that add fresh, scored carriers to your CRM, by hand or on a schedule.', to: '/features#leads' },
  { icon: PhoneOutgoing, hue: 'green', title: 'Power dialer', text: 'Work the queue with click-to-call through your own phone provider, scripts and 1–8 outcome keys.', to: '/features#calling' },
  { icon: ListOrdered, hue: 'purple', title: 'Sequences', text: 'Call, email and text steps on a schedule. Emails send from your mailbox; texts wait for you.', to: '/features#sequences' },
  { icon: CalendarClock, hue: 'pink', title: 'Follow-ups', text: 'Overdue, today and upcoming in one place, with priorities, repeats, reminders and snooze.', to: '/features#followups' },
  { icon: MapPinned, hue: 'amber', title: 'Fleet map', text: 'Every truck on a live street map. Plan the next trip with road miles, deadhead, fuel and weather.', to: '/features#fleet' },
  { icon: MapIcon, hue: 'teal', title: 'Market map', text: 'States by time zone, active carriers per state, diesel by region and a trip fuel calculator.', to: '/features#market' },
  { icon: Puzzle, hue: 'orange', title: 'Chrome extension', text: 'Dialer and Google Voice side by side, a side panel for dispositions, and lookups from any page.', to: '/features#extension' },
  { icon: Mail, hue: 'blue', title: 'Your own mailbox', text: 'Connect Google, Microsoft or any SMTP mailbox. Templates, scheduling, limits and opt-outs.', to: '/features#email' },
  { icon: Bot, hue: 'purple', title: 'AI dispatcher', text: 'Drafts broker emails, scripts and objection replies from your own documents. It never invents rates.', to: '/features#ai' },
  { icon: Users, hue: 'green', title: 'Teams', text: 'Private pipelines per dispatcher, a team board, roles, permissions and a leaderboard.', to: '/features#teams' },
];

export function FeatureGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      {FEATURES.map((f) => (
        <Link key={f.title} to={f.to} className="group rounded-2xl border border-line bg-surface p-5 transition-ui hover:-translate-y-0.5 hover:border-line-strong hover:shadow-[var(--shadow-float)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
          <Chip icon={f.icon} hue={f.hue} />
          <h3 className="mt-4 text-[15px] font-semibold text-fg">{f.title}</h3>
          <p className="mt-1.5 text-sm leading-6 text-fg-2">{f.text}</p>
          <span className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-brand-700 opacity-0 transition-ui group-hover:opacity-100 group-focus-visible:opacity-100 dark:text-brand-300">Learn more<ArrowRight className="size-3.5" /></span>
        </Link>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sequence preview                                                    */
/* ------------------------------------------------------------------ */

const SEQ = [
  { day: 'Day 1', type: 'Call', hue: 'blue', icon: PhoneCall, text: 'Intro call · script "New authority"' },
  { day: 'Day 1', type: 'Email', hue: 'purple', icon: Mail, text: 'Sent from your Gmail · "Rates and how we work"' },
  { day: 'Day 3', type: 'Text', hue: 'green', icon: MessageSquare, text: 'Opens in Google Voice with the message ready' },
  { day: 'Day 5', type: 'Call', hue: 'blue', icon: PhoneCall, text: 'Follow-up call · local time 10:00' },
  { day: 'Day 8', type: 'Task', hue: 'amber', icon: CalendarClock, text: 'Send carrier packet if interested' },
];

export function SequencePreview() {
  return (
    <WindowChrome title="Sequence · New authority, small fleets">
      <ol className="relative space-y-1 p-4">
        <span className="absolute bottom-6 left-[34px] top-6 w-px bg-line" aria-hidden />
        {SEQ.map((s, i) => (
          <li key={i} className="relative flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-surface-2/60">
            <Chip icon={s.icon} hue={s.hue} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-fg">{s.type} <span className="font-normal text-muted">· {s.day}</span></p>
              <p className="truncate text-xs text-fg-2">{s.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </WindowChrome>
  );
}

/* ------------------------------------------------------------------ */
/* Market map showcase (real map component, demo data only)            */
/* ------------------------------------------------------------------ */

const DEMO_ROUTE = [{ lat: 32.7767, lon: -96.797, label: 'Dallas, TX' }, { lat: 35.1495, lon: -90.049, label: 'Memphis, TN' }, { lat: 33.749, lon: -84.388, label: 'Atlanta, GA' }];

export function MapShowcase() {
  const [sel, setSel] = useState('TX');
  const now = useNow();
  const st = BY_CODE[sel];
  return (
    <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
      <div className="rounded-2xl border border-line bg-surface p-3 sm:p-5">
        <Suspense fallback={<div className="aspect-[975/610] animate-pulse rounded-xl bg-surface-2" />}>
          <MarketMap mode="zones" selected={sel} onSelect={(c) => c && setSel(c)} route={DEMO_ROUTE} />
        </Suspense>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-fg-2">
          {[['Eastern', '#3b82f6'], ['Central', '#16a34a'], ['Mountain', '#f59e0b'], ['Pacific', '#8b5cf6'], ['Alaska and Hawaii', '#ef4444']].map(([l, c]) => (
            <span key={l} className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ background: c }} />{l}</span>
          ))}
        </div>
      </div>
      <div className="space-y-3">
        <div className="rounded-2xl border border-line bg-surface p-5">
          <p className="text-xs font-medium text-muted">Selected state · tap the map</p>
          <p className="mt-1 text-2xl font-semibold text-fg">{st?.name || sel}</p>
          <p className="mt-1 text-sm text-fg-2">{st?.tz ? `Local time ${localTime(st.tz, now)}` : ''}</p>
          <p className="mt-4 text-sm leading-6 text-fg-2">In the app this panel shows active carriers registered there (FMCSA), how many you already have, and diesel for the region (EIA).</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-fg"><Route className="size-4 text-c-amber" />Trip planner</p>
          <p className="mt-1 text-sm text-fg-2">Dallas, TX → Memphis, TN → Atlanta, GA</p>
          <p className="mt-3 text-xs leading-5 text-muted">Enter the truck's MPG and tank size to get gallons, fuel cost per mile and fill-ups for the route. Example route shown.</p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Fleet map preview (static illustration of the live map)             */
/* ------------------------------------------------------------------ */

const TRUCKS = [
  { x: 120, y: 210, hue: '#16a34a', label: 'Available' },
  { x: 300, y: 120, hue: '#2563eb', label: 'Loaded' },
  { x: 430, y: 250, hue: '#16a34a', label: 'Available' },
  { x: 520, y: 150, hue: '#d97706', label: 'No status' },
  { x: 220, y: 300, hue: '#71717a', label: 'Off duty' },
];

export function FleetPreview() {
  return (
    <WindowChrome title="Fleet map · trucks and planned trips">
      <div className="relative">
        <svg viewBox="0 0 640 360" className="block w-full bg-[#eef2f6] dark:bg-[#151a22]" role="img" aria-label="Illustration of the fleet map with trucks and a planned route">
          <defs>
            <pattern id="pub-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" className="stroke-[#d9e0e8] dark:stroke-[#222a35]" strokeWidth="1" /></pattern>
          </defs>
          <rect width="640" height="360" fill="url(#pub-grid)" />
          <path d="M0 260 C120 230 180 280 300 240 S520 200 640 230" className="stroke-[#c8d2de] dark:stroke-[#2a3442]" strokeWidth="10" fill="none" />
          <path d="M60 0 C90 120 200 160 230 360" className="stroke-[#c8d2de] dark:stroke-[#2a3442]" strokeWidth="7" fill="none" />
          <path d="M120 210 C200 160 260 140 300 120" stroke="#71717a" strokeWidth="3" strokeDasharray="6 6" fill="none" />
          <path d="M300 120 C380 100 450 130 520 90" stroke="#2563eb" strokeWidth="4" fill="none" strokeLinecap="round" />
          {TRUCKS.map((t, i) => (
            <g key={i}>
              <circle cx={t.x} cy={t.y} r="15" fill={t.hue} opacity="0.18" />
              <circle cx={t.x} cy={t.y} r="9" fill={t.hue} stroke="#fff" strokeWidth="2.5" />
            </g>
          ))}
          <circle cx="520" cy="90" r="7" fill="#fff" stroke="#2563eb" strokeWidth="3" />
        </svg>
        <div className="absolute left-3 top-3 rounded-xl border border-line bg-surface/95 p-3 text-xs shadow-[var(--shadow-float)] backdrop-blur sm:w-56">
          <p className="flex items-center gap-1.5 font-semibold text-fg"><Truck className="size-3.5 text-c-green" />Next trip</p>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-fg-2">
            <span className="text-muted">Empty miles</span><span className="text-right font-mono">Live estimate</span>
            <span className="text-muted">Road route</span><span className="text-right font-mono">OSRM</span>
            <span className="text-muted">Weather</span><span className="flex items-center justify-end gap-1"><CloudSun className="size-3.5" />NWS</span>
          </div>
        </div>
        <div className="absolute bottom-3 right-3 flex flex-wrap gap-1.5">
          {[['Available', 'green'], ['Loaded', 'blue'], ['Off duty', 'gray'], ['No status', 'amber']].map(([l, h]) => (
            <span key={l} className={cx('rounded-full px-2 py-0.5 text-[11px] font-medium', `bg-c-${h}-soft text-c-${h}`)}>{l}</span>
          ))}
        </div>
      </div>
    </WindowChrome>
  );
}

/* ------------------------------------------------------------------ */
/* Extension preview                                                    */
/* ------------------------------------------------------------------ */

export function ExtensionPreview() {
  return (
    <WindowChrome title="Chrome · DispatchDesk workspace">
      <div className="grid grid-cols-[1fr_1fr_0.85fr] text-[11px]">
        <div className="border-r border-line p-3">
          <p className="font-semibold text-fg">Power dialer</p>
          <div className="mt-2 space-y-1.5">
            {['Red River Transport', 'Blue Ridge Reefer', 'Sunbelt Flatbed'].map((n, i) => (
              <div key={n} className={cx('truncate rounded-md px-2 py-1.5', i === 0 ? 'bg-c-blue-soft text-c-blue' : 'bg-surface-2 text-fg-2')}>{n}</div>
            ))}
          </div>
        </div>
        <div className="border-r border-line bg-surface-2/50 p-3">
          <p className="font-semibold text-fg">Google Voice</p>
          <div className="mt-2 rounded-md border border-line bg-surface p-2">
            <p className="font-mono text-fg">(318) 555-0142</p>
            <span className="mt-2 inline-block rounded-full bg-c-green px-2.5 py-1 text-[10px] font-semibold text-white">Call</span>
          </div>
          <p className="mt-2 text-muted">Number loaded in your open Voice tab. You press call.</p>
        </div>
        <div className="p-3">
          <p className="font-semibold text-fg">Side panel</p>
          <div className="mt-2 grid gap-1">
            {[['1', 'No answer', 'gray'], ['3', 'Interested', 'green'], ['4', 'Call back', 'amber']].map(([k, l, h]) => (
              <span key={k} className={cx('flex items-center gap-1 rounded px-1.5 py-1 font-medium', `bg-c-${h}-soft text-c-${h}`)}><kbd className="font-mono">{k}</kbd>{l}</span>
            ))}
          </div>
        </div>
      </div>
    </WindowChrome>
  );
}

/* ------------------------------------------------------------------ */
/* Data sources                                                        */
/* ------------------------------------------------------------------ */

export const SOURCES = [
  { name: 'FMCSA Company Census', what: 'Carrier leads and counts', hue: 'blue' },
  { name: 'U.S. EIA', what: 'Weekly diesel and gasoline', hue: 'amber' },
  { name: 'National Weather Service', what: 'Weather alerts', hue: 'red' },
  { name: 'Open-Meteo', what: 'Current weather', hue: 'teal' },
  { name: 'OpenStreetMap · OpenFreeMap', what: 'Street map tiles', hue: 'green' },
  { name: 'OSRM', what: 'Road routes and miles', hue: 'purple' },
];

export function SourcesStrip() {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {SOURCES.map((s) => (
        <li key={s.name} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
          <span className={cx('size-2.5 shrink-0 rounded-full', `bg-c-${s.hue}`)} aria-hidden />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-fg">{s.name}</p>
            <p className="truncate text-xs text-muted">{s.what}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* Pricing teaser (real plans)                                         */
/* ------------------------------------------------------------------ */

const lim = (v) => (v == null ? '—' : v < 0 ? 'Unlimited' : Number(v).toLocaleString('en-US'));
const money = (c) => (c === 0 ? '$0' : `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0 })}`);
const PLAN_HUE = { free: 'gray', pro: 'teal', annual: 'purple', teams: 'blue', company: 'amber' };

export function PricingTeaser({ user }) {
  const q = useQuery({ queryKey: ['plans'], queryFn: () => api.get('/api/billing/plans') });
  if (q.isLoading) return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-64 animate-pulse rounded-2xl bg-surface-2" />)}</div>;
  if (q.isError || !q.data?.plans?.length) return <p className="text-sm text-muted">Plans could not be loaded. <Link to="/pricing" className="underline">Open pricing</Link></p>;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {q.data.plans.map((p) => {
        const hue = PLAN_HUE[p.key] || 'teal';
        const hot = p.key === 'pro';
        return (
          <div key={p.key} className={cx('flex flex-col rounded-2xl border bg-surface p-6', hot ? 'border-brand-600 ring-1 ring-brand-600' : 'border-line')}>
            <span className={cx('w-fit rounded-full px-2.5 py-0.5 text-xs font-semibold', `bg-c-${hue}-soft text-c-${hue}`)}>{p.name}</span>
            <p className="mt-4 text-3xl font-semibold tracking-tight text-fg tabular">{money(p.priceCents)}<span className="text-sm font-normal text-muted"> /{p.interval}{p.perSeat ? ' per seat' : ''}</span></p>
            <p className="mt-2 min-h-12 text-sm leading-6 text-fg-2">{p.description}</p>
            <ul className="mt-4 space-y-2 text-sm text-fg-2">
              <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-c-green" />{lim(p.limits.maxCarriers)} carrier records</li>
              <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-c-green" />{lim(p.limits.monthlyLeadGenLimit)} generated leads a month</li>
              <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-c-green" />{lim(p.limits.dailyEmailLimit)} emails a day</li>
              <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-c-green" />{lim(p.limits.monthlyAiMessages)} AI messages a month</li>
              {p.leadGenAutoRun && <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-c-green" />Scheduled lead generation</li>}
              {p.teamFeatures && <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-c-green" />Team board and permissions</li>}
            </ul>
            <div className="mt-auto pt-6">
              <Button className="w-full" variant={hot ? 'primary' : 'secondary'} to={p.key === 'free' ? (user ? '/app' : '/register') : '/pricing'}>
                {p.key === 'free' ? (user ? 'Open app' : 'Start free') : `See ${p.name}`}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* FAQ                                                                 */
/* ------------------------------------------------------------------ */

export const FAQ = [
  ['Is the free plan really free?', 'Yes. The Free plan has no time limit and needs no card. It includes carrier discovery, the CRM, pipeline, prospecting, one sequence and the lead generator with a monthly allowance. Paid plans raise the limits.'],
  ['Does DispatchDesk dial calls automatically?', 'No. Every call starts with your click, through the phone service you choose: Google Voice, 8x8, RingCentral, Dialpad, Microsoft Teams, Zoom Phone, your phone app, or a Twilio bridge. Texts in sequences are never sent automatically either.'],
  ['Where do the carrier leads come from?', 'From the public FMCSA Company Census on data.transportation.gov. Each run checks the live dataset, skips carriers already in your CRM, and scores leads on contact details, authority age and fleet size.'],
  ['Which email accounts can I connect?', 'Google and Microsoft accounts with one click once your administrator enables them, or any mailbox with SMTP such as Gmail with an app password, Outlook, Yahoo, Zoho, iCloud, Hostinger, GoDaddy and Fastmail. Emails go out from your own address.'],
  ['Where do fuel prices, weather and maps come from?', 'Diesel and gasoline from the U.S. Energy Information Administration, weather alerts from the National Weather Service, current weather from Open-Meteo, map tiles from OpenFreeMap with OpenStreetMap data, and road routes from OSRM. Every number links to its source.'],
  ['Can my team use it together?', 'Yes. Each dispatcher keeps a private pipeline. Team owners and managers see a shared board, activity and a leaderboard, with roles and permissions.'],
];

export function FaqList() {
  return (
    <div className="divide-y divide-line rounded-2xl border border-line bg-surface">
      {FAQ.map(([q, a]) => (
        <details key={q} className="group px-5 py-4 [&_summary::-webkit-details-marker]:hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded text-[15px] font-semibold text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            {q}<ChevronDown className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
          </summary>
          <p className="mt-3 text-sm leading-7 text-fg-2">{a}</p>
        </details>
      ))}
    </div>
  );
}

export function CtaBand({ user }) {
  return (
    <section className="px-4 pb-20 sm:px-6">
      <div className="pub-cta relative mx-auto max-w-6xl overflow-hidden rounded-3xl px-6 py-14 text-center sm:px-12">
        <h2 className="relative text-[28px] font-semibold tracking-[-0.02em] text-white sm:text-[36px]">Build your carrier list this afternoon</h2>
        <p className="relative mx-auto mt-3 max-w-xl text-[17px] leading-7 text-white/85">Create a free account, run your first lead generator, and start calling with the phone service you already use.</p>
        <div className="relative mt-8 flex flex-wrap justify-center gap-3">
          <Button size="lg" to={user ? '/app' : '/register'} className="!bg-white !text-[#0b3b37] hover:!bg-white/90">{user ? 'Open your desk' : 'Start free'}</Button>
          <Button size="lg" variant="secondary" to="/pricing" className="!border-white/40 !bg-white/10 !text-white hover:!bg-white/20">See pricing</Button>
        </div>
      </div>
    </section>
  );
}

