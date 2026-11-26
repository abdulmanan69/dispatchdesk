import { Link, useParams } from 'react-router';
import { Check, ArrowRight } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import { Button } from '../../components/ui.jsx';
import { NotFound } from '../../context/routes.jsx';
import { Chip, CtaBand, HeroPreview, SequencePreview, FleetPreview, ExtensionPreview, MapShowcase } from './sections.jsx';
import { areaBySlug } from './featureIcons.js';

const VISUALS = { hero: HeroPreview, sequence: SequencePreview, fleet: FleetPreview, extension: ExtensionPreview, map: MapShowcase };

/** One product area at /features/<slug>: what it does, how it works, and related areas. */
export default function FeaturePage() {
  const { slug } = useParams();
  const { user } = useAuth();
  const f = areaBySlug(slug);
  if (!f) return <NotFound />;
  const Visual = f.visual ? VISUALS[f.visual] : null;
  const related = f.related.map(areaBySlug).filter(Boolean);
  return (
    <>
      <section className="relative isolate overflow-hidden border-b border-line">
        <div aria-hidden className="pub-hero-bg absolute inset-0 -z-10" />
        <div className={Visual ? 'mx-auto grid max-w-6xl items-center gap-10 px-4 py-14 sm:px-6 lg:grid-cols-2 lg:gap-14 lg:py-16' : 'mx-auto max-w-3xl px-4 py-14 sm:px-6 lg:py-16'}>
          <div>
            <Chip icon={f.icon} hue={f.hue} size="lg" />
            <h1 className="mt-5 text-[34px] font-semibold leading-tight tracking-[-0.025em] text-fg sm:text-[44px]">{f.title}</h1>
            <p className="mt-4 text-[17px] leading-7 text-fg-2">{f.text}</p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button size="lg" to={user ? '/app' : '/register'}>{user ? 'Open your desk' : 'Start free trial'}</Button>
              <Button size="lg" variant="secondary" to="/pricing">See pricing</Button>
            </div>
          </div>
          {Visual && <div className="min-w-0"><Visual /></div>}
        </div>
      </section>

      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:py-16">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
          <section aria-labelledby="what-you-get">
            <h2 id="what-you-get" className="text-[24px] font-semibold tracking-[-0.02em] text-fg">What you get</h2>
            <ul className="mt-5 space-y-2.5">
              {f.points.map((p) => <li key={p} className="flex gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-[15px] text-fg-2"><Check className="mt-0.5 size-5 shrink-0 text-c-green" aria-hidden />{p}</li>)}
            </ul>
            {f.details.map((d) => <p key={d} className="mt-5 text-[15px] leading-7 text-fg-2">{d}</p>)}
          </section>
          {f.steps.length > 0 && (
            <section aria-labelledby="how-it-works">
              <h2 id="how-it-works" className="text-[24px] font-semibold tracking-[-0.02em] text-fg">How it works</h2>
              <ol className="mt-5 space-y-4">
                {f.steps.map((s, i) => (
                  <li key={s} className="flex gap-4">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[13px] font-semibold tabular-nums text-fg">{i + 1}</span>
                    <p className="pt-0.5 text-[15px] leading-7 text-fg-2">{s}</p>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>

        <section aria-labelledby="related" className="mt-16">
          <h2 id="related" className="text-[24px] font-semibold tracking-[-0.02em] text-fg">Related features</h2>
          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            {related.map((r) => (
              <Link key={r.slug} to={`/features/${r.slug}`} className="group rounded-2xl border border-line bg-surface p-5 transition-ui hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                <Chip icon={r.icon} hue={r.hue} />
                <h3 className="mt-4 text-[15px] font-semibold text-fg">{r.title}</h3>
                <p className="mt-1.5 text-sm leading-6 text-fg-2">{r.text}</p>
                <span className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-brand-700 dark:text-brand-300">Learn more<ArrowRight className="size-3.5" aria-hidden /></span>
              </Link>
            ))}
          </div>
          <p className="mt-6 text-sm"><Link to="/features" className="font-medium text-brand-700 underline-offset-2 hover:underline dark:text-brand-300">See all features</Link></p>
        </section>
      </div>
      <CtaBand user={user} />
    </>
  );
}
