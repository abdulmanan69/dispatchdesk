import { Check, ArrowRight } from 'lucide-react';
import { Button, cx } from '../ui.jsx';
import CallButton from '../calling/CallButton.jsx';
import { STAGES } from './shared.jsx';

/** The working stages in order (Archived sits outside the flow, in the header menu). */
export const FLOW = ['lead', 'prospecting', 'sequence', 'opportunity', 'trial', 'customer'];
const NAME = Object.fromEntries(STAGES.map((s) => [s.key, s.name]));
const LABEL = { lead: 'Lead', prospecting: 'Prospecting', sequence: 'Sequence', opportunity: 'Opportunity', trial: 'Trial', customer: 'Customer' };

/** Stage path under the carrier header: where the carrier is, the steps behind it, one click to move it. */
export function StageBar({ stage, canWrite, pending, onStage }) {
  const at = FLOW.indexOf(stage);
  return (
    <nav aria-label="Pipeline stage" className="overflow-x-auto">
      <ol className="flex min-w-max rounded-lg border border-line bg-surface p-0.5 text-[13px]">
        {FLOW.map((k, i) => {
          const current = i === at;
          const done = at > i;
          return (
            <li key={k} className="flex-1">
              <button type="button" aria-current={current ? 'step' : undefined} disabled={!canWrite || pending || current}
                title={current ? `Stage: ${NAME[k]}` : `Move to ${NAME[k]}`} onClick={() => onStage(k)}
                className={cx('flex w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 transition-ui disabled:cursor-default',
                  current ? 'bg-brand-600 font-medium text-white' : done ? 'text-fg-2 hover:bg-surface-2' : 'text-muted hover:bg-surface-2 hover:text-fg')}>
                {done && <Check className="size-3.5 text-brand-600 dark:text-brand-300" aria-hidden />}
                {LABEL[k]}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

const BOX = {
  red: 'border-c-red/30 bg-c-red-soft',
  amber: 'border-c-amber/30 bg-c-amber-soft',
  green: 'border-c-green/30 bg-c-green-soft',
  brand: 'border-brand-600/25 bg-brand-50 dark:bg-brand-900/40',
  gray: 'border-line bg-surface-2',
};

/**
 * "Next step" bar: what to do with this carrier now and the button that does it. `step` comes from nextStepFor();
 * `onAction(kind)` runs every action except a call, which dials through CallButton (nothing dials without the click).
 */
export function NextStepBar({ step, carrier: c, canWrite, onAction }) {
  if (!step) return null;
  const a = step.action;
  return (
    <section aria-label="Next step" className={cx('flex flex-col gap-3 rounded-xl border px-4 py-3 sm:flex-row sm:items-center sm:justify-between', BOX[step.tone] || BOX.brand)}>
      <div className="min-w-0">
        <p className="text-xs text-muted">Next step</p>
        <p className="font-medium">{step.title}</p>
        {step.detail && <p className="text-[13px] text-fg-2">{step.detail}</p>}
      </div>
      {a && canWrite && (
        a.kind === 'call'
          ? <CallButton variant="button" phone={c.phone} carrierId={c.id} label={a.label} />
          : <Button className="shrink-0" onClick={() => onAction(a.kind)}>{a.label}<ArrowRight className="size-4" aria-hidden /></Button>
      )}
    </section>
  );
}
