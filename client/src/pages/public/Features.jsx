import { Link } from 'react-router';
import { Check, ArrowRight } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import { Chip, SectionHead, CtaBand, HeroPreview, SequencePreview, FleetPreview, ExtensionPreview, MapShowcase } from './sections.jsx';
import { AREAS } from './featureIcons.js';

const VISUALS = { hero: <HeroPreview />, sequence: <SequencePreview />, fleet: <FleetPreview />, extension: <ExtensionPreview />, map: <MapShowcase /> };

export default function Features() {
  const { user } = useAuth();
  return (
    <>
      <section className="relative isolate overflow-hidden border-b border-line">
        <div aria-hidden className="pub-hero-bg absolute inset-0 -z-10" />
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:py-20">
          <SectionHead as="h1" eyebrow="Product" hue="teal" title="Everything a dispatcher needs, in one desk" sub="From the first lead to the truck's next load. Jump to a section." />
          <nav aria-label="Feature sections" className="mt-8 flex flex-wrap gap-2">
            {AREAS.map((a) => (
              <a key={a.slug} href={`#${a.anchor}`} className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-sm text-fg-2 transition-ui hover:border-line-strong hover:text-fg">
                <a.icon className={`size-4 text-c-${a.hue}`} aria-hidden />{a.label}
              </a>
            ))}
          </nav>
        </div>
      </section>

      <div className="mx-auto max-w-6xl divide-y divide-line px-4 sm:px-6">
        {AREAS.map((a, i) => (
          <section key={a.slug} id={a.anchor} className="scroll-mt-20 py-14 lg:py-16">
            <div className={a.visual ? 'grid items-center gap-10 lg:grid-cols-2 lg:gap-14' : 'grid gap-8 lg:grid-cols-[1fr_1fr]'}>
              <div className={a.visual && i % 2 ? 'lg:order-2' : ''}>
                <Chip icon={a.icon} hue={a.hue} size="lg" />
                <h2 className="mt-5 text-[28px] font-semibold tracking-[-0.02em] text-fg">{a.title}</h2>
                <p className="mt-3 text-[16px] leading-7 text-fg-2">{a.text}</p>
                <Link to={`/features/${a.slug}`} className="mt-4 inline-flex items-center gap-1 text-[14px] font-medium text-brand-700 underline-offset-2 hover:underline dark:text-brand-300">
                  {a.steps.length ? 'How it works' : 'Learn more'}<span className="sr-only">: {a.title}</span><ArrowRight className="size-3.5" aria-hidden />
                </Link>
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
