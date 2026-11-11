import { useQueryClient } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { money } from '../../lib/format.js';
import { Badge, Input, cx } from '../ui.jsx';
import { useToast } from '../Toast.jsx';

export const STATUS = {
  draft: ['gray', 'Draft'],
  active: ['blue', 'Waiting for the broker'],
  needs_review: ['amber', 'Needs your review'],
  agreed: ['green', 'Agreed'],
  walked_away: ['gray', 'Walked away'],
  canceled: ['gray', 'Canceled'],
};
export const OPEN = ['draft', 'active', 'needs_review'];

export const MODE_OPTIONS = [
  { value: 'approve', label: 'Ask me before every email' },
  { value: 'auto', label: 'Send counters automatically within my limits' },
];

export const NEVER_ALONE = 'The AI never accepts a rate or books a load on its own.';

/** Whole dollars for rates ("$2,150"); cents only when there are some. */
export const usd = (cents) => (cents == null ? '—' : money(cents, { digits: cents % 100 ? 2 : 0 }));

export function StatusBadge({ status }) {
  const [color, text] = STATUS[status] || ['gray', status];
  return <Badge color={color}>{text}</Badge>;
}

export function AiBadge({ className }) {
  return <Badge color="purple" className={className} title="Written by AI"><Bot className="size-3" aria-hidden />AI</Badge>;
}

export function laneText(lane = {}) {
  const from = [lane.originCity, lane.originState].filter(Boolean).join(', ');
  const to = [lane.destCity, lane.destState].filter(Boolean).join(', ');
  return from && to ? `${from} → ${to}` : from || to || 'Lane';
}

/** Dollars typed by the user -> cents (null when blank or not a number). */
export function toCents(v) {
  const s = String(v ?? '').replace(/[$,\s]/g, '');
  if (!s) return null;
  const x = Number(s);
  return Number.isFinite(x) && x >= 0 ? Math.round(x * 100) : null;
}
export const fromCents = (c) => (c == null ? '' : String(c / 100));

/** Text input for a dollar amount with a "$" prefix. Value and onChange use the typed text. */
export function MoneyInput({ value, onChange, className, ...props }) {
  return (
    <div className={cx('relative', className)}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted" aria-hidden>$</span>
      <Input inputMode="decimal" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} className="pl-6 tabular" {...props} />
    </div>
  );
}

/**
 * Mutation on one negotiation: puts the returned detail in the cache, refreshes lists, and reports AI problems
 * (the negotiation stays usable by hand) and emails that could not be sent.
 */
export function useNegotiationAction(id, fn, { success, invalidate = [], onSuccess } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  return useApiMutation(fn, {
    success,
    invalidate: [['negotiations'], ...invalidate],
    onSuccess: (data, vars) => {
      const nid = data?.negotiation?.id || id;
      if (nid && data?.negotiation) qc.setQueryData(['negotiation', nid], { negotiation: data.negotiation, emails: data.emails || [] });
      if (data?.aiError) toast.error(`AI unavailable: ${data.aiError.message}. You can carry on by hand.`);
      if (data?.emailError) toast.error(`The email was not sent: ${data.emailError}`);
      onSuccess?.(data, vars);
    },
  });
}

/** Single-choice switch (radio group); options wrap on narrow screens. */
export function Choice({ options, value, onChange, label, disabled }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full flex-wrap rounded-lg border border-line bg-surface-2 p-0.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} disabled={disabled} onClick={() => !on && onChange(o.value)}
            className={cx('min-h-8 rounded-md px-2.5 py-1 text-left text-[13px] transition-ui disabled:opacity-60', on ? 'bg-surface font-medium text-fg shadow-sm ring-1 ring-line' : 'text-fg-2 hover:text-fg')}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export const negotiationApi = {
  get: (id) => api.get(`/api/negotiations/${id}`),
  act: (id, action, body) => api.post(`/api/negotiations/${id}/${action}`, body || {}),
  patch: (id, body) => api.patch(`/api/negotiations/${id}`, body),
};
