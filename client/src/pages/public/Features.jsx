import { Check } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import {
  Crosshair, PhoneOutgoing, ListOrdered, CalendarClock, MapPinned, Map as MapIcon, Puzzle, Mail, Bot, Users, Handshake, Calculator,
} from 'lucide-react';
import { Chip, SectionHead, CtaBand, HeroPreview, SequencePreview, FleetPreview, ExtensionPreview, MapShowcase } from './sections.jsx';

const AREAS = [
  {
    id: 'leads', icon: Crosshair, hue: 'blue', title: 'Lead generator and carrier discovery',
    text: 'Search the public FMCSA Company Census by state, city, fleet size, cargo and authority age, or save the search as a generator that adds new leads for you.',
    points: ['Skips carriers already in your CRM', 'Scores each lead 0–100 with the reasons', 'Adds leads to a prospect list and a sequence', 'Scheduled daily or weekly runs on paid plans', 'CSV import and export'],
  },
  {
    id: 'calling', icon: PhoneOutgoing, hue: 'green', title: 'Prospecting and power dialer', visual: 'hero',
    text: 'A daily call queue ordered by priority and each carrier’s local time. Call with your own phone service and log the outcome with one key.',
    points: ['Google Voice, 8x8, RingCentral, Dialpad, Teams, Zoom Phone, Twilio or your phone app', 'Calling-hours and do-not-call guards', 'Call scripts library', 'Outcome keys 1–8, notes and next follow-up', 'Nothing is ever dialed without your click'],
  },
  {
    id: 'sequences', icon: ListOrdered, hue: 'purple', title: 'Sequences', visual: 'sequence',
    text: 'Cadences of call, email, text and task steps. Emails send from your mailbox on schedule; calls and texts wait in your queue.',
    points: ['Business hours and weekends', 'Daily limits and cooldown per sequence', 'Merge fields for carrier and contact details', 'Start a dialer session for a sequence in one click'],
  },
  {
    id: 'followups', icon: CalendarClock, hue: 'pink', title: 'Follow-ups',
    text: 'Overdue, today and upcoming in one workspace with live counts, a week view and bulk actions.',
    points: ['Priority, repeat and reminder lead time', 'Snooze to later today, tomorrow or next week', 'Call, email or text from the row', 'Complete with an outcome; repeats schedule themselves'],
  },
  {
    id: 'fleet', icon: MapPinned, hue: 'amber', title: 'Fleet map and trip planning', visual: 'fleet',
    text: 'Your carriers’ trucks on a live street map. Plan the next trip with road miles, rate per mile, fuel and weather.',
    points: ['Truck status, location and available time', 'Road routes with deadhead and loaded miles', 'Find the closest available truck for a load', 'Week board of every carrier’s trips'],
  },
  {
    id: 'market', icon: MapIcon, hue: 'teal', title: 'Market map and data', visual: 'map',
    text: 'The US by time zone, active carriers per state, diesel and gasoline by region, weather alerts and freight holidays.',
    points: ['FMCSA carrier counts per state', 'EIA weekly diesel and gasoline', 'National Weather Service alerts', 'Trip fuel calculator with your own spot rates'],
  },
  {
    id: 'extension', icon: Puzzle, hue: 'orange', title: 'Chrome extension', visual: 'extension',
    text: 'A workspace that places the dialer and Google Voice side by side, and a side panel for the call in progress.',
    points: ['Calls load into your open Google Voice tab', 'Disposition, notes, follow-up and template email', 'Look up and add carriers from any page', 'Personal access token; no access to admin or billing'],
  },
  {
    id: 'email', icon: Mail, hue: 'blue', title: 'Email from your own mailbox',
    text: 'Connect Google or Microsoft in one click once your administrator enables it, or any SMTP mailbox with an app password.',
    points: ['Templates, drafts and scheduling', 'Daily limits, cooldown and retries', 'Unsubscribe links and suppression list', 'Passwords and tokens stored encrypted'],
  },
  {
    id: 'deals', icon: Handshake, hue: 'green', title: 'Pipeline, opportunities and customers',
    text: 'A board from new lead to signed customer, with trials, fees, lanes, compliance checklists and documents.',
    points: ['Drag and drop or keyboard board', 'Agreement, W-9, COI and permits with expiry dates', 'Brokers, loads and lane history', 'Rate calculator and load-text parser'],
  },
  {
    id: 'ai', icon: Bot, hue: 'purple', title: 'AI dispatcher',
    text: 'Answers dispatch questions and drafts emails and scripts using your own training documents and optional web search.',
    points: ['Objection replies and broker emails', 'Cites the documents it used', 'Says so when it is not configured', 'Never invents rates'],
  },
  {
    id: 'teams', icon: Users, hue: 'green', title: 'Teams',
    text: 'Private pipelines per dispatcher with a shared team board for owners and managers.',
    points: ['Owner, manager and dispatcher roles', 'Team board, activity and leaderboard', 'Seat-based billing'],
  },
  {
    id: 'tools', icon: Calculator, hue: 'amber', title: 'Dispatch tools',
    text: 'Calculators and lookups that dispatchers reach for between calls.',
    points: ['Rate per mile and profit', 'Factoring fees and detention', 'Time zones and calling hours', 'Command palette with Ctrl+K'],
  },
];

const VISUALS = { hero: <HeroPreview />, sequence: <SequencePreview />, fleet: <FleetPreview />, extension: <ExtensionPreview />, map: <MapShowcase /> };

export default function Features() {
  const { user } = useAuth();
  return (
    <>
      <section className="relative isolate overflow-hidden border-b border-line">
        <div aria-hidden className="pub-hero-bg absolute inset-0 -z-10" />
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
          <SectionHead eyebrow="Product" hue="teal" title="Everything a dispatcher needs, in one desk" sub="From the first lead to the truck's next load. Jump to a section." />
          <nav aria-label="Feature sections" className="mt-8 flex flex-wrap gap-2">
            {AREAS.map((a) => (
              <a key={a.id} href={`#${a.id}`} className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-sm text-fg-2 transition-ui hover:border-line-strong hover:text-fg">
                <a.icon className={`size-4 text-c-${a.hue}`} aria-hidden />{a.title.split(' and ')[0]}
              </a>
            ))}
          </nav>
        </div>
      </section>

      <div className="mx-auto max-w-6xl divide-y divide-line px-4 sm:px-6">
        {AREAS.map((a, i) => (
          <section key={a.id} id={a.id} className="scroll-mt-20 py-14 lg:py-16">
            <div className={a.visual ? 'grid items-center gap-10 lg:grid-cols-2 lg:gap-14' : 'grid gap-8 lg:grid-cols-[1fr_1fr]'}>
              <div className={a.visual && i % 2 ? 'lg:order-2' : ''}>
                <Chip icon={a.icon} hue={a.hue} size="lg" />
                <h2 className="mt-5 text-[28px] font-semibold tracking-[-0.02em] text-fg">{a.title}</h2>
                <p className="mt-3 text-[16px] leading-7 text-fg-2">{a.text}</p>
                {a.visual && (
                  <ul className="mt-6 space-y-2.5">
                    {a.points.map((p) => <li key={p} className="flex gap-3 text-[15px] text-fg-2"><Check className="mt-0.5 size-5 shrink-0 text-c-green" aria-hidden />{p}</li>)}
                  </ul>
                )}
              </div>
              {a.visual ? (
                <div className={i % 2 ? 'min-w-0 lg:order-1' : 'min-w-0'}>{VISUALS[a.visual]}</div>
              ) : (
                <ul className="grid content-start gap-2.5 sm:grid-cols-2 lg:pt-16">
                  {a.points.map((p) => <li key={p} className="flex gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-fg-2"><Check className="mt-0.5 size-4 shrink-0 text-c-green" aria-hidden />{p}</li>)}
                </ul>
              )}
            </div>
          </section>
        ))}
      </div>
      <div className="pt-6"><CtaBand user={user} /></div>
    </>
  );
}
