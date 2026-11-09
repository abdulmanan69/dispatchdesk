import { Link } from 'react-router';
import { Check, ShieldCheck, PhoneOff, Database } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import { Button } from '../../components/ui.jsx';
import {
  Chip, SectionHead, HeroPreview, WorkflowStrip, FeatureGrid, SequencePreview, MapShowcase, FleetPreview, ExtensionPreview,
  SourcesStrip, PricingTeaser, FaqList, CtaBand,
} from './sections.jsx';

const PROVIDERS = ['Google Voice', '8x8', 'RingCentral', 'Dialpad', 'Microsoft Teams', 'Zoom Phone', 'Twilio', 'Phone app'];

function Split({ eyebrow, hue, title, text, points, visual, flip, id }) {
  return (
    <section id={id} className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:gap-16 lg:py-20">
      <div className={flip ? 'lg:order-2' : ''}>
        <SectionHead eyebrow={eyebrow} hue={hue} title={title} sub={text} />
        <ul className="mt-6 space-y-3">
          {points.map((p) => (
            <li key={p} className="flex gap-3 text-[15px] leading-6 text-fg-2"><Check className="mt-0.5 size-5 shrink-0 text-c-green" aria-hidden />{p}</li>
          ))}
        </ul>
      </div>
      <div className={flip ? 'lg:order-1' : ''}>{visual}</div>
    </section>
  );
}

export default function Home() {
  const { user } = useAuth();
  return (
    <>
      {/* Hero */}
      <section className="relative isolate overflow-hidden border-b border-line">
        <div aria-hidden className="pub-hero-bg absolute inset-0 -z-10" />
        <div aria-hidden className="pub-dots absolute inset-0 -z-10 [mask-image:linear-gradient(to_bottom,black,transparent_75%)]" />
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-14 sm:px-6 lg:grid-cols-[1fr_1.15fr] lg:pb-24 lg:pt-20">
          <div className="dd-enter min-w-0">
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/80 px-3 py-1 text-[13px] font-medium text-fg-2 backdrop-blur">
              <span className="size-2 rounded-full bg-c-green" />Free plan, no card required
            </span>
            <h1 className="mt-5 text-[40px] font-semibold leading-[1.05] tracking-[-0.035em] text-fg sm:text-[58px]">
              Find carriers, call them, and keep their <span className="text-brand-600 dark:text-brand-300">trucks moving</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-8 text-fg-2">
              DispatchDesk is the sales CRM and dispatch desk for truck dispatchers. Generate leads from the FMCSA census, work a call queue with your own phone service, follow up on time, and plan every truck's next trip on a live map.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button size="lg" to={user ? '/app' : '/register'}>{user ? 'Open your desk' : 'Start free'}</Button>
              <Button size="lg" variant="secondary" to="/pricing">See pricing</Button>
            </div>
            <div className="mt-8">
              <p className="text-xs font-medium text-muted">Calls go through the service you already use</p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {PROVIDERS.map((p) => <li key={p} className="rounded-full border border-line bg-surface/80 px-2.5 py-1 text-xs text-fg-2">{p}</li>)}
              </ul>
            </div>
          </div>
          <div className="dd-enter min-w-0 [animation-delay:80ms]">
            <HeroPreview />
            <p className="mt-3 text-center text-xs text-muted">Example data. Carrier names are fictional.</p>
          </div>
        </div>
      </section>

      {/* Workflow */}
      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
        <SectionHead eyebrow="The daily workflow" hue="blue" title="From a cold list to a signed carrier" sub="Find leads, add them to a sequence, call with Google Voice, log the outcome, and the next step is already scheduled." />
        <div className="mt-10"><WorkflowStrip /></div>
      </section>

      {/* Features */}
      <section className="border-y border-line bg-surface-2/40">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
          <SectionHead eyebrow="Everything in one desk" hue="purple" title="Tools dispatchers use every day" sub="No spreadsheets, sticky notes or ten browser tabs." />
          <div className="mt-10"><FeatureGrid /></div>
        </div>
      </section>

      <Split id="sequences" eyebrow="Sequences and follow-ups" hue="purple"
        title="Every touch scheduled, nothing forgotten"
        text="Build a cadence once. DispatchDesk puts calls in your queue at the carrier's local time, sends emails from your own mailbox, and has texts ready to send from Google Voice."
        points={['Call, email, text and task steps by day', 'Business hours and weekends respected', 'Follow-ups with priority, repeat, reminders and snooze', 'Opt-outs and do-not-call honored automatically']}
        visual={<SequencePreview />} />

      <section className="border-y border-line bg-surface-2/40">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
          <SectionHead eyebrow="Market map" hue="teal" title="Know the market before you call" sub="States colored by time zone, active carriers per state from the FMCSA census, diesel by region from the EIA, and a fuel calculator for any route." />
          <div className="mt-10"><MapShowcase /></div>
        </div>
      </section>

      <Split id="fleet" eyebrow="Fleet map" hue="amber" flip
        title="See every truck and plan its next trip"
        text="Your carriers' trucks on a real street map, colored by status. Set where a truck is and when it is free, then plan the next load with road miles and costs."
        points={['Road route with empty and loaded miles', 'Rate per mile all-in and loaded, fuel cost and profit', 'Weather and alerts at pickup and delivery', 'Find the closest available truck for a load']}
        visual={<FleetPreview />} />

      <Split id="extension" eyebrow="Chrome extension" hue="orange"
        title="Your dialer and Google Voice, side by side"
        text="One shortcut opens the workspace: the power dialer on one side and your phone service on the other. A side panel keeps the next carrier, the script and the outcome keys in reach."
        points={['Calls load into your open Google Voice tab', 'Disposition, notes and follow-up without switching windows', 'Find USDOT, MC and phone numbers on any page', 'Reads a page only when you click the button']}
        visual={<ExtensionPreview />} />

      {/* Trust */}
      <section className="border-y border-line bg-surface-2/40">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
          <SectionHead eyebrow="Real data, clearly sourced" hue="green" title="Public data you can check" sub="Numbers in DispatchDesk come from public sources and link back to them. When a source is not connected, the app says so instead of guessing." />
          <div className="mt-10"><SourcesStrip /></div>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {[
              [PhoneOff, 'red', 'No auto-dialing', 'Every call and text starts with your click.'],
              [ShieldCheck, 'green', 'Private pipelines', 'Each dispatcher sees their own carriers unless a team shares them.'],
              [Database, 'blue', 'Your data stays yours', 'Export your carriers any time. Credentials are stored encrypted.'],
            ].map(([Icon, hue, t, d]) => (
              <div key={t} className="flex gap-3 rounded-2xl border border-line bg-surface p-5">
                <Chip icon={Icon} hue={hue} />
                <div><h3 className="text-[15px] font-semibold text-fg">{t}</h3><p className="mt-1 text-sm leading-6 text-fg-2">{d}</p></div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
          <SectionHead eyebrow="Pricing" hue="teal" title="Start free, upgrade when you grow" />
          <Link to="/pricing" className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">Compare all plans</Link>
        </div>
        <div className="mt-10"><PricingTeaser user={user} /></div>
      </section>

      {/* FAQ */}
      <section className="mx-auto max-w-3xl px-4 pb-20 sm:px-6">
        <SectionHead eyebrow="Questions" hue="pink" title="Common questions" center />
        <div className="mt-10"><FaqList /></div>
      </section>

      <CtaBand user={user} />
    </>
  );
}
