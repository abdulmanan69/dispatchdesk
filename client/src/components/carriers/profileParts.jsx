import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { date, nf } from '../../lib/format.js';
import { cx } from '../ui.jsx';

/** Building blocks of the FMCSA profile and its inspection / related-carrier sections. */
export const UTC_DAY = { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' };
export const day = (d) => (d ? date(`${d}T00:00:00Z`, UTC_DAY) : '—');
export const usd = (n) => (n == null ? '—' : nf({ style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n));
export const yesNo = (v) => (v === true ? 'Yes' : v === false ? 'No' : '—');
export const addressText = (a) => (a ? [a.street, [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ') : null);

export const TONE = {
  red: 'bg-c-red-soft text-c-red border-c-red/30',
  amber: 'bg-c-amber-soft text-c-amber border-c-amber/30',
  green: 'bg-c-green-soft text-c-green border-c-green/30',
  gray: 'bg-c-gray-soft text-fg-2 border-line',
};
/** A flag that may wrap on small screens (Badge stays on one line). */
export function Chip({ tone = 'gray', children, title, className }) {
  return <span title={title} className={cx('inline-flex items-start rounded border px-1.5 py-0.5 text-[12px] font-medium leading-snug', TONE[tone], className)}>{children}</span>;
}

export function Unavailable({ children = 'Not available right now' }) {
  return <p className="text-sm text-muted">{children}</p>;
}

/** Collapsible on phones (tap the title); always open from the sm breakpoint up. `anchor` = the section-nav target id. */
export function Section({ title, children, defaultOpen = true, className, anchor }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section id={anchor} className={cx('min-w-0 scroll-mt-16 rounded-xl border border-line bg-surface', className)}>
      <h3 className="text-sm font-medium">
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left sm:pointer-events-none">
          {title}
          <ChevronDown className={cx('size-4 shrink-0 text-muted transition-transform sm:hidden', open && 'rotate-180')} aria-hidden />
        </button>
      </h3>
      <div id={id} className={cx('space-y-3 border-t border-line px-4 py-3', open ? 'block' : 'hidden sm:block')}>{children}</div>
    </section>
  );
}

export function Rows({ children }) {
  return <dl className="grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">{children}</dl>;
}
export function Row({ k, children }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="min-w-0 break-words">{children ?? '—'}</dd>
    </>
  );
}
export const Num = ({ children }) => <span className="tabular">{children}</span>;

export function ShowMore({ items, initial, render, noun }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, initial);
  return (
    <>
      {shown.map(render)}
      {items.length > initial && (
        <li>
          <button type="button" className="text-[13px] font-medium text-brand-700 hover:underline dark:text-brand-300" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${items.length} ${noun}`}
          </button>
        </li>
      )}
    </>
  );
}
