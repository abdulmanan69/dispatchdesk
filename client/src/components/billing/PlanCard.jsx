import { Check } from 'lucide-react';
import { money } from '../../lib/format.js';
import { cx } from '../ui.jsx';

export function priceLabel(plan) {
  if (plan.priceCents === 0) return { amount: '$0', unit: 'forever' };
  const unit = `${plan.perSeat ? 'per user / ' : '/ '}${plan.interval === 'year' ? 'year' : 'month'}`;
  return { amount: money(plan.priceCents), unit };
}

export function monthlyEquivalent(plan) {
  if (plan.interval !== 'year' || !plan.priceCents) return null;
  return money(Math.round(plan.priceCents / 12));
}

/** `highlight` marks the plan we suggest; no unverified popularity claim is shown. */
export default function PlanCard({ plan, highlight, current, action }) {
  const p = priceLabel(plan);
  const eq = monthlyEquivalent(plan);
  return (
    <div className={cx('flex flex-col rounded-xl border bg-surface p-6', highlight ? 'border-fg/25 shadow-[var(--shadow-float)]' : 'border-line')}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-medium">{plan.name}</h3>
        {current ? <span className="text-xs text-brand-700 dark:text-brand-300">Current plan</span> : plan.trialDays ? <span className="font-mono text-xs text-muted">{plan.trialDays}-day trial</span> : null}
      </div>
      <p className="mt-2 min-h-10 text-sm text-fg-2">{plan.description}</p>
      <div className="mt-6 flex items-baseline gap-1.5">
        <span className="text-[32px] font-medium leading-none tabular tracking-[-0.02em]">{p.amount}</span>
        <span className="text-sm text-muted">{p.unit}</span>
      </div>
      <p className="mt-2 min-h-4 text-xs text-muted">{eq ? `${eq} a month, billed yearly` : plan.perSeat ? `Minimum ${plan.minSeats} users` : ''}</p>
      <ul className="mt-6 flex-1 space-y-2.5 border-t border-line pt-6 text-sm text-fg-2">
        {plan.features.map((f) => (
          <li key={f} className="flex gap-2.5"><Check className="mt-0.5 size-4 shrink-0 text-muted" strokeWidth={1.75} aria-hidden />{f}</li>
        ))}
      </ul>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
