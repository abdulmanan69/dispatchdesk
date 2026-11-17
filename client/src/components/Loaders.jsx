/**
 * Loading and empty-state artwork drawn in SVG and CSS (no animation files, no extra downloads). Motion lives in
 * index.css (dd-road, dd-bob, dd-float) and stops for viewers who prefer reduced motion.
 */

const join = (...c) => c.filter(Boolean).join(' ');

/** A small truck driving along a moving road: the app's loading animation. */
export function TruckLoader({ size = 'md', className }) {
  const w = size === 'lg' ? 112 : size === 'sm' ? 44 : 72;
  return (
    <svg viewBox="0 0 72 36" width={w} height={w / 2} className={join('overflow-visible', className)} aria-hidden>
      {/* road */}
      <line x1="2" y1="33" x2="70" y2="33" stroke="var(--line-strong)" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="2" y1="33" x2="70" y2="33" className="dd-road stroke-brand-500 dark:stroke-brand-300" strokeWidth="1.5" strokeDasharray="6 6" strokeLinecap="round" opacity="0.55" />
      {/* speed lines */}
      <g className="dd-road stroke-muted" strokeWidth="1.2" strokeLinecap="round" strokeDasharray="4 10" opacity="0.6">
        <line x1="4" y1="16" x2="16" y2="16" />
        <line x1="1" y1="22" x2="13" y2="22" />
      </g>
      {/* truck */}
      <g className="dd-bob">
        <rect x="20" y="9" width="27" height="17" rx="2.5" className="fill-surface stroke-brand-600 dark:stroke-brand-300" strokeWidth="1.8" />
        <path d="M47 14h7l5 6v6h-12z" className="fill-brand-600 dark:fill-brand-400" />
        <rect x="50" y="16" width="5" height="3.5" rx="0.8" fill="var(--surface)" opacity="0.85" />
        <line x1="25" y1="15" x2="36" y2="15" className="stroke-brand-500 dark:stroke-brand-300" strokeWidth="1.6" strokeLinecap="round" opacity="0.6" />
      </g>
      <g fill="#f59e0b" stroke="var(--surface)" strokeWidth="1.2">
        <circle cx="27" cy="28" r="3.2" />
        <circle cx="40" cy="28" r="3.2" />
        <circle cx="53" cy="28" r="3.2" />
      </g>
    </svg>
  );
}

/**
 * Artwork above an empty state: the section's icon on a card, resting on a dashed route that ends at a pin.
 * Quiet by design: line work in the theme's neutral and brand colors.
 */
export function EmptyArt({ icon: Icon }) {
  return (
    <div className="relative mb-4 h-[76px] w-[148px]" aria-hidden>
      <svg viewBox="0 0 148 76" className="absolute inset-0 size-full">
        <path d="M6 64 C 34 64, 40 46, 66 50 S 110 66, 128 40" fill="none" stroke="var(--line-strong)" strokeWidth="1.6" strokeDasharray="4 5" strokeLinecap="round" />
        <circle cx="6" cy="64" r="3" fill="var(--surface)" stroke="var(--line-strong)" strokeWidth="1.6" />
        <path d="M128 40c-4.4 0-8-3.4-8-7.7 0-5.7 8-13.3 8-13.3s8 7.6 8 13.3c0 4.3-3.6 7.7-8 7.7z" className="fill-brand-500/80 dark:fill-brand-400/80" transform="translate(0 -6)" />
        <circle cx="128" cy="26" r="2.6" fill="var(--surface)" />
        <circle cx="22" cy="18" r="1.8" fill="var(--line-strong)" />
        <circle cx="110" cy="10" r="1.4" fill="var(--line-strong)" />
        <circle cx="40" cy="8" r="1.2" fill="var(--line-strong)" />
      </svg>
      <div className="dd-float absolute left-1/2 top-2 flex size-12 -translate-x-1/2 items-center justify-center rounded-xl border border-line bg-surface shadow-sm">
        {Icon && <Icon className="size-5 text-brand-600 dark:text-brand-300" strokeWidth={1.6} />}
      </div>
    </div>
  );
}
