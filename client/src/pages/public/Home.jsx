import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Radar, PhoneCall, ListOrdered, Handshake, BadgeCheck, Mail, Bot, Calculator, FileText, Users, GraduationCap, ArrowRight } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import { Button, LocalClock, cx } from '../../components/ui.jsx';
import ShaderBackground from '../../components/ShaderBackground.jsx';

// Illustrative preview rows (fictional carriers) that show how the call queue looks.
const QUEUE = [
  { name: 'Red River Transport LLC', mc: '1184420', city: 'Shreveport, LA', tz: 'America/Chicago', fleet: 4, step: 'Call 2 of 4', stage: 'Sequence', stageColor: '#6b6b6b' },
  { name: 'Blue Ridge Reefer Co', mc: '1093317', city: 'Roanoke, VA', tz: 'America/New_York', fleet: 2, step: 'Follow-up · overdue', stage: 'Prospecting', stageColor: '#8a8a8a', overdue: true },
  { name: 'Sunbelt Flatbed Inc', mc: '1240085', city: 'Mesa, AZ', tz: 'America/Phoenix', fleet: 7, step: 'Rate talk', stage: 'Opportunity', stageColor: '#d97706' },
  { name: 'Lone Pine Hauling', mc: '1312906', city: 'Missoula, MT', tz: 'America/Denver', fleet: 1, step: 'First call', stage: 'Lead', stageColor: '#a3a3a3' },
];

function localHour(tz) {
  try { return Number(new Date().toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false })) % 24; } catch { return 12; }
}

function QueuePreview() {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(id); }, []);
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-[var(--shadow-float)]" aria-label="Preview of the daily call queue">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <div className="flex items-center gap-2 text-sm font-medium"><PhoneCall className="size-4 text-muted" strokeWidth={1.75} />Today's call queue</div>
        <span className="font-mono text-xs text-muted">4 due · 1 overdue</span>
      </div>
      <ul className="divide-y divide-line">
        {QUEUE.map((c, i) => {
          const h = localHour(c.tz);
          const callable = h >= 8 && h < 19;
          return (
            <li key={c.mc} className={cx('grid grid-cols-[1fr_auto] items-center gap-4 px-5 py-3', i === 0 && 'bg-surface-2/60')}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{c.name}</span>
                  <span className="hidden items-center gap-1.5 text-xs text-muted sm:flex"><span className="size-1.5 rounded-full" style={{ background: c.stageColor }} />{c.stage}</span>
                </div>
                <div className="mt-0.5 truncate font-mono text-xs text-muted">MC {c.mc} · {c.city} · {c.fleet} {c.fleet === 1 ? 'truck' : 'trucks'}</div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <LocalClock timezone={c.tz} />
                <span className={cx('text-xs', c.overdue ? 'text-red-600 dark:text-red-400' : callable ? 'text-fg-2' : 'text-muted')}>{callable ? c.step : 'Outside calling hours'}</span>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="grid grid-cols-[1fr_auto] items-end gap-4 border-t border-line bg-bg px-5 py-4">
        <div>
          <div className="text-xs text-muted">Rate check · Dallas, TX to Atlanta, GA · dry van</div>
          <div className="mt-1 font-mono text-sm text-fg-2 tabular">$2,200 ÷ 781 loaded mi</div>
        </div>
        <div className="text-right">
          <div className="text-[28px] font-medium leading-none text-brand-700 tabular dark:text-brand-300">$2.82</div>
          <div className="mt-1 font-mono text-xs text-muted">per mile · $2.68 all-in</div>
        </div>
      </div>
    </div>
  );
}

const FLOW = [
  { icon: Radar, title: 'Find', text: 'Search the public FMCSA census by state, fleet size and authority age, or import your own list.' },
  { icon: PhoneCall, title: 'Call', text: 'A daily queue ordered by priority and each carrier’s local time. Log the outcome in two clicks.' },
  { icon: ListOrdered, title: 'Sequence', text: 'Day-by-day cadences of calls, emails and tasks that schedule the next touch for you.' },
  { icon: Handshake, title: 'Negotiate', text: 'Track fee, value, probability and the next follow-up while you talk terms.' },
  { icon: BadgeCheck, title: 'Sign', text: 'Keep the agreement, W-9, COI, authority letter, lanes and load history together.' },
];

const FEATURES = [
  { icon: Mail, title: 'Email from your own mailbox', text: 'Gmail, Outlook, Hostinger or any SMTP account. Templates, scheduling, daily limits and opt-outs.' },
  { icon: Calculator, title: 'Rate calculator', text: 'Paste a load-board posting and get rate per mile, deadhead, fuel and profit.' },
  { icon: FileText, title: 'Carrier paperwork', text: 'Agreements, W-9s, insurance certificates and permits with expiry tracking.' },
  { icon: Bot, title: 'AI dispatcher', text: 'Drafts broker emails and call scripts from your own training documents. It never invents rates.' },
  { icon: Users, title: 'Teams', text: 'Every dispatcher keeps a private pipeline. Owners see the team board and leaderboard.' },
  { icon: GraduationCap, title: 'Training center', text: 'Lessons on prospecting, onboarding, negotiation and running a dispatch business.' },
];

const STEPS = ['Learn the basics', 'Find one carrier', 'Open a load board account', 'Negotiate the load', 'Complete the carrier packet', 'Receive the rate confirmation', 'Pickup', 'Delivery', 'Invoice and get paid'];

function AskBox() {
  const [q, setQ] = useState('');
  const { user } = useAuth();
  const navigate = useNavigate();
  const go = (e) => {
    e.preventDefault();
    const target = `/app/ai${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`;
    navigate(user ? target : `/register?next=${encodeURIComponent(target)}`);
  };
  return (
    <form onSubmit={go} className="flex flex-col gap-2 sm:flex-row">
      <label htmlFor="ask" className="sr-only">Ask a dispatch question</label>
      <input id="ask" value={q} onChange={(e) => setQ(e.target.value)} placeholder="A carrier says they already have a dispatcher. What do I say?"
        className="h-12 flex-1 rounded-lg border border-line-strong bg-surface px-4 text-sm placeholder:text-muted transition-ui focus:border-brand-500 focus:outline-none" />
      <Button type="submit" size="lg" variant="secondary">Ask</Button>
    </form>
  );
}

export default function Home() {
  const { user } = useAuth();
  return (
    <>
      <section className="relative isolate overflow-hidden border-b border-line">
        <ShaderBackground className="-z-20" />
        {/* Neutral fades keep the headline on calm ground and blend the shader into the page. */}
        <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-r from-bg via-bg/80 to-bg/10 lg:via-bg/60" />
        <div aria-hidden className="absolute inset-x-0 bottom-0 -z-10 h-24 bg-gradient-to-t from-bg to-transparent" />
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1fr_1.05fr] lg:py-28">
          <div className="dd-enter">
            <h1 className="text-[40px] font-medium leading-[1.06] tracking-[-0.03em] sm:text-[56px]">Find, call and sign trucking carriers from one desk</h1>
            <p className="mt-6 max-w-xl text-lg leading-8 text-fg-2">Carrier leads from the FMCSA census, a daily call queue set to each carrier’s local time, sequences, pipeline and paperwork. Built for truck dispatchers.</p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button size="lg" to={user ? '/app' : '/register'}>{user ? 'Open your desk' : 'Start free'}</Button>
              <Button size="lg" variant="secondary" to="/features">See how it works</Button>
            </div>
            <p className="mt-4 text-sm text-muted">Free plan, no card required</p>
          </div>
          <div className="dd-enter [animation-delay:80ms]"><QueuePreview /></div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <div className="max-w-2xl">
          <h2 className="text-[28px] font-medium tracking-[-0.01em]">From cold list to signed carrier</h2>
          <p className="mt-2 text-fg-2">The workflow dispatchers already follow, without spreadsheets and sticky notes</p>
        </div>
        <ol className="mt-10 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-5">
          {FLOW.map((f, i) => (
            <li key={f.title} className="bg-surface p-5">
              <div className="flex items-center gap-2 text-sm font-medium">
                <f.icon className="size-4 text-muted" strokeWidth={1.75} aria-hidden />
                {f.title}
                <span className="ml-auto font-mono text-xs text-muted">{i + 1}/5</span>
              </div>
              <p className="mt-3 text-sm leading-6 text-fg-2">{f.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="border-y border-line">
        <div className="mx-auto grid max-w-6xl gap-x-12 gap-y-10 px-4 py-20 sm:grid-cols-2 sm:px-6 lg:grid-cols-3 lg:py-24">
          {FEATURES.map((f) => (
            <div key={f.title} className="flex gap-3">
              <f.icon className="mt-0.5 size-4 shrink-0 text-muted" strokeWidth={1.75} aria-hidden />
              <div>
                <h3 className="text-sm font-medium">{f.title}</h3>
                <p className="mt-1 text-sm leading-6 text-fg-2">{f.text}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <div className="grid gap-12 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <h2 className="text-[28px] font-medium tracking-[-0.01em]">New to dispatching? Start here</h2>
            <p className="mt-2 text-fg-2">Nine steps from zero to your first paid load. Each one is covered in the training center.</p>
            <Button variant="secondary" className="mt-6" to="/training">Explore training</Button>
          </div>
          <ol className="divide-y divide-line rounded-xl border border-line bg-surface">
            {STEPS.map((s, i) => (
              <li key={s} className="flex items-center gap-4 px-5 py-3 text-sm">
                <span className="w-6 font-mono text-xs text-muted">{String(i + 1).padStart(2, '0')}</span>{s}
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="border-t border-line">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[1fr_1.2fr] lg:items-center">
          <div>
            <h2 className="text-[28px] font-medium tracking-[-0.01em]">Ask a dispatch question</h2>
            <p className="mt-2 text-fg-2">Cold calls, carrier onboarding, broker emails, rate per mile</p>
          </div>
          <AskBox />
        </div>
      </section>

      <section className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-4 py-14 sm:flex-row sm:items-center sm:px-6">
          <div>
            <h2 className="text-lg font-medium">Ready to build your carrier list?</h2>
            <p className="mt-1 text-sm text-fg-2">Browse the <Link to="/marketplace" className="text-fg underline underline-offset-2">marketplace</Link> or join the <Link to="/community" className="text-fg underline underline-offset-2">community</Link> while you set up</p>
          </div>
          <Button size="lg" to={user ? '/app/discover' : '/register'}>{user ? 'Find carriers' : 'Create free account'}<ArrowRight className="size-4" /></Button>
        </div>
      </section>
    </>
  );
}
