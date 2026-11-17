import { Link } from 'react-router';
import { useAuth } from '../../context/AuthContext.jsx';
import { date } from '../../lib/format.js';
import { cx } from '../ui.jsx';

/**
 * Free trial state for accounts without a plan (user.trial from the server): days left while it runs, and once it
 * ends, that the account is read-only until a plan is chosen. A failed renewal (user.billingAlert) comes first.
 */
export default function TrialBanner() {
  const { user } = useAuth();
  if (user?.billingAlert === 'past_due') {
    return (
      <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-c-red/30 bg-c-red-soft px-4 py-2 text-[13px] text-fg sm:px-6">
        <span className="size-1.5 shrink-0 rounded-full bg-c-red" aria-hidden />
        Your last payment did not go through. Update your card to keep your plan.
        <Link to="/app/billing" className="font-medium text-fg underline-offset-2 hover:underline">Update payment method</Link>
      </div>
    );
  }
  const t = user?.trial;
  if (!t || (!t.active && !t.locked)) return null;
  const locked = t.locked;
  return (
    <div role={locked ? 'status' : undefined} className={cx('flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2 text-[13px] sm:px-6', locked ? 'border-c-amber/30 bg-c-amber-soft text-fg' : 'border-line bg-surface text-fg-2')}>
      <span className={cx('size-1.5 shrink-0 rounded-full', locked ? 'bg-c-amber' : 'bg-brand-600')} aria-hidden />
      {locked
        ? 'Your free trial has ended. Your data is safe and you can still view it; choose a plan to keep adding, calling and sending.'
        : `Free trial: ${t.daysLeft} day${t.daysLeft === 1 ? '' : 's'} left (until ${date(t.endsAt)}).`}
      <Link to="/app/billing" className="font-medium text-fg underline-offset-2 hover:underline">{locked ? 'Choose a plan' : 'See plans'}</Link>
    </div>
  );
}
