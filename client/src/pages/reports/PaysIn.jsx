import { Badge } from '../../components/ui.jsx';

/**
 * How fast a broker pays, from the workspace's own invoices (GET /api/brokers, /api/brokers/:id and
 * /api/reports/brokers/payments): green within 30 days on average, amber 31-45, red over 45 or anything past due.
 * Null when there is nothing measured and nothing past due.
 */
export function paysInTone(p) {
  if (!p) return null;
  if (p.pastDueInvoices > 0) return 'red';
  if (p.avgDaysToPay == null) return null;
  if (p.avgDaysToPay <= 30) return 'green';
  if (p.avgDaysToPay <= 45) return 'amber';
  return 'red';
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "32 days" badge (plus "1 past due"); `quiet` renders nothing instead of "No paid invoices yet". */
export function PaysInBadge({ p, quiet = false }) {
  const tone = paysInTone(p);
  if (!tone) return quiet ? null : <span className="whitespace-nowrap text-xs text-muted">No paid invoices yet</span>;
  const days = p.avgDaysToPay != null ? plural(p.avgDaysToPay, 'day') : null;
  const due = p.pastDueInvoices > 0 ? `${p.pastDueInvoices} past due` : null;
  const title = [
    days && `Pays in ${days} on average, from ${plural(p.measuredInvoices || 0, 'paid invoice')} of yours`,
    due && `${plural(p.pastDueInvoices, 'invoice')} past the due date`,
  ].filter(Boolean).join('. ');
  return <Badge color={tone} title={title} className="tabular">{[days, due].filter(Boolean).join(' · ')}</Badge>;
}
