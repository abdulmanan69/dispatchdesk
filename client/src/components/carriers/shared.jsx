import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { Badge, cx } from '../ui.jsx';
import { label } from '../../lib/format.js';
import { ExternalLink } from 'lucide-react';
import CallButton from '../calling/CallButton.jsx';
import { carrierResources } from './resources.js';

export const STAGES = [
  { key: 'lead', name: 'All Leads' },
  { key: 'prospecting', name: 'Prospecting' },
  { key: 'sequence', name: 'Sequence' },
  { key: 'opportunity', name: 'Opportunities' },
  { key: 'trial', name: 'Trials' },
  { key: 'customer', name: 'Customers' },
  { key: 'archived', name: 'Archived' },
];

export function StageBadge({ stage }) {
  if (!stage) return null;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-medium"
      style={{ background: `color-mix(in srgb, ${stage.color || '#64748b'} 16%, transparent)`, color: `color-mix(in srgb, ${stage.color || '#64748b'} 78%, var(--fg))` }}>
      <span className="size-1.5 rounded-full" style={{ background: stage.color || '#64748b' }} aria-hidden />
      {stage.name}
    </span>
  );
}

export function TagList({ tags = [], className }) {
  if (!tags.length) return null;
  return (
    <span className={cx('inline-flex flex-wrap gap-1', className)}>
      {tags.map((t) => (
        <span key={t.id} className="inline-flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-[11px] leading-none">
          <span className="size-1.5 rounded-full" style={{ background: t.color }} aria-hidden />{t.name}
        </span>
      ))}
    </span>
  );
}

export function AuthorityBadge({ status }) {
  if (!status) return <span className="text-muted">—</span>;
  const color = { active: 'green', inactive: 'red', pending: 'amber', unknown: 'gray' }[status] || 'gray';
  return <Badge color={color}>{label(status)}</Badge>;
}

export const equipmentLabel = (eq) => (eq ? eq.split(',').map(label).join(', ') : '—');

export const OUTCOME_COLORS = {
  no_answer: 'gray', busy: 'gray', voicemail: 'blue', interested: 'green', not_interested: 'red', call_back: 'amber', follow_up: 'amber', converted: 'brand',
};

export function useTags() {
  return useQuery({ queryKey: ['tags'], queryFn: () => api.get('/api/tags'), staleTime: 60000 });
}
export function useAssignees() {
  return useQuery({ queryKey: ['carriers', 'assignees'], queryFn: () => api.get('/api/carriers/meta/assignees'), staleTime: 300000 });
}
export function useSequences() {
  return useQuery({ queryKey: ['sequences'], queryFn: () => api.get('/api/sequences') });
}
export function useProspectLists() {
  return useQuery({ queryKey: ['prospect-lists'], queryFn: () => api.get('/api/prospecting/lists') });
}

/**
 * Click-to-call phone number. Dials through the user's calling provider (Settings → Calling);
 * the href stays a plain tel: link as a no-JavaScript fallback. Nothing dials without a click.
 */
export function PhoneLink({ phone, carrierId, className }) {
  if (!phone) return <span className="text-muted">—</span>;
  return <CallButton phone={phone} carrierId={carrierId} variant="link" className={className} />;
}

/** Public research links (SAFER, SMS, licensing, Google, Maps). Clicks never open the row underneath. */
export function ResourceLinks({ carrier, compact, className }) {
  const links = carrierResources(carrier);
  if (!links.length) return <span className="text-muted">—</span>;
  return (
    <span className={cx('flex flex-wrap items-center', compact ? 'gap-x-2 gap-y-0.5' : 'gap-1.5', className)}>
      {links.map((l) => (
        <a key={l.key} href={l.href} target="_blank" rel="noopener noreferrer" title={l.title} onClick={(e) => e.stopPropagation()}
          className={compact
            ? 'whitespace-nowrap text-[12px] text-fg-2 underline-offset-2 hover:text-brand-700 hover:underline dark:hover:text-brand-300'
            : 'inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-fg-2 transition-ui hover:border-line-strong hover:bg-surface-2 hover:text-fg'}>
          {l.label}{!compact && <ExternalLink className="size-3 text-muted" aria-hidden />}
        </a>
      ))}
    </span>
  );
}

const NAV_KEY = 'dd:carrier-nav';
/** Remember the list the user opened a carrier from, so the profile can step to the previous/next carrier. */
export function rememberCarrierNav(ids, back) {
  try { sessionStorage.setItem(NAV_KEY, JSON.stringify({ ids, back })); } catch { /* storage unavailable */ }
}
export function readCarrierNav(id) {
  try {
    const nav = JSON.parse(sessionStorage.getItem(NAV_KEY) || 'null');
    const i = nav?.ids?.indexOf(id) ?? -1;
    if (i < 0) return null;
    return { prev: nav.ids[i - 1] || null, next: nav.ids[i + 1] || null, index: i, total: nav.ids.length, back: nav.back || '/app/carriers' };
  } catch { return null; }
}
