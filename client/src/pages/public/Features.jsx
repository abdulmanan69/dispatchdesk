import { Button } from '../../components/ui.jsx';

const SECTIONS = [
  {
    title: 'Carrier leads',
    points: [
      'Live search of the FMCSA Company Census (public data from data.transportation.gov) by state, city, name, USDOT, MC and power units.',
      'Optional FMCSA QCMobile enrichment when you add an FMCSA web key.',
      'CSV import with column mapping, duplicate detection by USDOT, MC and phone, and CSV export.',
      'Every record shows its source and when it was last verified.',
    ],
  },
  {
    title: 'CRM and pipeline',
    points: [
      'Seven stages: All leads, Prospecting, Sequence, Opportunities, Trials, Customers, Archived.',
      'Board view with drag and drop, and a sortable table with bulk actions.',
      'Carrier profiles with contacts, notes, tags, calls, emails, follow-ups, documents and a full activity timeline.',
    ],
  },
  {
    title: 'Prospecting and sequences',
    points: [
      'Daily call queue built from due sequence steps and follow-ups, ordered by priority and local time.',
      'Time-zone detection from the carrier’s state with calling-window guidance.',
      'Configurable sequences (for example: Day 1 call, Day 2 email, Day 4 call, Day 7 final follow-up) that respect business hours, weekends, opt-outs and daily limits.',
      'Click-to-call links — calls are never placed automatically.',
    ],
  },
  {
    title: 'Email and automation',
    points: [
      'Connect Gmail or Outlook with OAuth, or Hostinger and other SMTP providers. Credentials are encrypted at rest.',
      'Templates with merge fields, signatures, drafts, scheduled sends, retries and unsubscribe links.',
      'Emails are marked sent only after your provider accepts them.',
      'Automations: when a stage changes, a call outcome is logged or a carrier is added — create follow-ups, enroll sequences, add tags or notify you.',
    ],
  },
  {
    title: 'Dispatch tools',
    points: [
      'Broker directory with payment terms, credit notes and load history.',
      'Load tracking from planned to paid, with lane history.',
      'Rate calculator: rate per mile (rate ÷ loaded miles), all-in RPM with deadhead, fuel cost, detention and estimated profit.',
      'Paste load-board text to fill the form automatically. Load boards are never scraped.',
    ],
  },
  {
    title: 'AI dispatcher',
    points: [
      'Works with any OpenAI-compatible API you configure.',
      'Answers grounded in your uploaded training documents, with optional web research that shows sources and dates.',
      'Email drafts, call scripts, objection handling and load analysis. It will not invent live rates or authority data.',
    ],
  },
  {
    title: 'Teams, training and community',
    points: [
      'Team board and leaderboard: dials, leads added, in touch, follow-ups, opportunities, trials, customers.',
      'Roles and permissions with private pipelines per dispatcher.',
      'Training courses with progress tracking and a trainer inbox.',
      'Marketplace for dispatch tools, services and jobs, and a moderated community forum.',
    ],
  },
];

export default function Features() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-14">
      <h1 className="text-3xl font-medium tracking-[-0.01em]">Everything a dispatcher needs to sell and deliver</h1>
      <p className="mt-3 max-w-2xl text-muted">A practical tour of the product. Integrations that need your own credentials (email, AI, payments, FMCSA web key) are clearly labeled inside the app.</p>
      <div className="mt-10 divide-y divide-line rounded-xl border border-line bg-surface">
        {SECTIONS.map((s) => (
          <section key={s.title} className="grid gap-4 p-6 md:grid-cols-[220px_1fr]">
            <h2 className="font-medium">{s.title}</h2>
            <ul className="space-y-2 text-sm text-muted">
              {s.points.map((p) => <li key={p} className="flex gap-2"><span className="mt-2 size-1 shrink-0 rounded-full bg-brand-500" />{p}</li>)}
            </ul>
          </section>
        ))}
      </div>
      <div className="mt-10 flex flex-wrap gap-3">
        <Button size="lg" to="/register">Start free</Button>
        <Button size="lg" variant="secondary" to="/pricing">Compare plans</Button>
      </div>
    </div>
  );
}
