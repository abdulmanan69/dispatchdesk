import { Badge, cx } from '../ui.jsx';

/**
 * Lead score v2 display (server: services/carriers/leadSignals.js). Score 0–100 = Need + Fit + Reachability + Quality;
 * tiers A (75+), B (55–74), C (under 55). Signals are { key, label, points, group, tone }.
 */
export const TIER_COLORS = Object.freeze({ A: 'green', B: 'amber', C: 'gray' });
export const TIER_LABELS = Object.freeze({ A: 'Tier A · best fit', B: 'Tier B · good fit', C: 'Tier C · weak fit' });
export const GROUP_LABELS = Object.freeze({ need: 'Need', fit: 'Fit', reach: 'Reachability', quality: 'Quality' });

/** "A · 82" in the tier color (A green, B amber, C gray); a dash when the carrier has no score. */
export function TierBadge({ tier, score, className }) {
  if (!tier) return <span className="text-muted">—</span>;
  const title = `${TIER_LABELS[tier] || `Tier ${tier}`}${score != null ? ` · lead score ${score}/100` : ''}`;
  return (
    <Badge color={TIER_COLORS[tier] || 'gray'} title={title} aria-label={title} className={cx('tabular', className)}>
      {tier}{score != null ? ` · ${score}` : ''}
    </Badge>
  );
}

const TONE = {
  bad: 'border-c-red/30 bg-c-red-soft text-c-red',
  warn: 'border-c-amber/30 bg-c-amber-soft text-c-amber',
  good: 'border-line bg-surface text-fg-2',
  info: 'border-line bg-surface-2 text-muted',
};
const TONE_ORDER = { bad: 0, warn: 1, good: 2, info: 3 };
const pts = (n) => `${n > 0 ? '+' : ''}${n}`;

/** Signals in display order: problems first (so they are never cut off), then the strongest reasons. */
export function orderSignals(signals = []) {
  return [...signals].sort((a, b) => (TONE_ORDER[a.tone] ?? 3) - (TONE_ORDER[b.tone] ?? 3) || Math.abs(b.points || 0) - Math.abs(a.points || 0));
}

/** The n strongest positive reasons (carrier header, summaries). */
export function topReasons(signals = [], n = 3) {
  return (Array.isArray(signals) ? signals : []).filter((s) => s?.points > 0).sort((a, b) => b.points - a.points).slice(0, n);
}

// Signals nearly every carrier has, or "could not check" notes: in the score and its hover text, not worth a chip.
const QUIET = new Set(['company_email', 'shared_unchecked', 'safety_not_checked', 'insurer_unchecked', 'not_rated', 'clean_history', 'address_ok']);

/** Signal chips ("New MC · 45 days", "Cell phone", "Shared contact · 7 carriers"); points and group on hover. */
export function SignalChips({ signals = [], max = 6, className }) {
  const list = orderSignals((Array.isArray(signals) ? signals : []).filter((s) => s && s.label && !QUIET.has(s.key)));
  if (!list.length) return null;
  const shown = list.slice(0, max);
  const rest = list.slice(max);
  return (
    <ul className={cx('flex flex-wrap gap-1', className)} aria-label="Lead signals">
      {shown.map((s) => (
        <li key={s.key} title={`${s.label}${s.points ? ` (${pts(s.points)} ${GROUP_LABELS[s.group] || s.group})` : ''}`}
          className={cx('inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] leading-none whitespace-nowrap', TONE[s.tone] || TONE.info)}>
          {s.label}
        </li>
      ))}
      {rest.length > 0 && (
        <li title={rest.map((s) => s.label).join(', ')} className="inline-flex items-center rounded border border-line px-1.5 py-0.5 text-[11px] leading-none text-muted">+{rest.length} more</li>
      )}
    </ul>
  );
}
