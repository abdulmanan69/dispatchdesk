import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Mail, Route, Building2, Info } from 'lucide-react';
import { api } from '../../lib/api.js';
import { date, dollars, money, num } from '../../lib/format.js';
import { Badge, Button, Card, EmptyState, Loading, ErrorState, cx } from '../ui.jsx';
import CallButton from '../calling/CallButton.jsx';
import ComposeModal from '../email/ComposeModal.jsx';

const rpm = (n) => (n == null ? null : `${dollars(n)}/mi`);

/** Request params for the reload-ideas endpoint (exported for the fleet panel and tests). */
export function reloadParams({ state, city, equipment }) {
  const st = String(state || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(st) ? { state: st, city: city || undefined, equipment: equipment || undefined } : null;
}

/**
 * Reload ideas for a delivery market (shared contract: the fleet truck panel and load pages can import it).
 *
 * <ReloadIdeas state="GA" city="Atlanta" equipment="dry_van" extra?={truck merge values for emails} compact? title? />
 *
 * Everything comes from the workspace's own data: brokers that gave loads out of the state in the last 365 days (last
 * rate and RPM, average RPM, days to pay, usual destinations), your lanes from there and your customers' preferred
 * lanes, plus FMCSA public counts for context. Calls open the user's calling app on a click; emails open the composer
 * with a broker template. Empty sections say so; nothing is estimated.
 */
export default function ReloadIdeas({ state, city, equipment, extra, compact = false, title, className }) {
  const params = reloadParams({ state, city, equipment });
  const [emailTo, setEmailTo] = useState(null);
  const q = useQuery({
    queryKey: ['reload-ideas', params],
    queryFn: ({ signal }) => api.get('/api/truck-posts/reload-ideas', params, { signal }),
    enabled: !!params,
    staleTime: 5 * 60_000,
  });
  const where = params ? [city, params.state].filter(Boolean).join(', ') : '';
  const limit = compact ? 5 : 15;
  return (
    <Card className={className} title={<h2 className="text-sm font-medium">{title || (where ? `Reload ideas out of ${where}` : 'Reload ideas')}</h2>} bodyClass="p-0">
      {!params ? (
        <EmptyState icon={Route} title="No location yet">Set where the truck is empty to see brokers and lanes from your past loads there.</EmptyState>
      ) : q.isLoading ? <Loading label="Looking through your loads…" /> : q.isError ? <ErrorState error={q.error} onRetry={q.refetch} /> : (
        <div className="divide-y divide-line">
          <section className="px-4 py-3">
            <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-fg-2"><Building2 className="size-3.5 text-c-blue" aria-hidden />Brokers that gave you loads out of {q.data.state}</h3>
            {!q.data.brokers.length ? (
              <p className="text-sm text-muted">No loads out of {q.data.state} with a broker in the last {q.data.days} days. This list fills in as you book loads.</p>
            ) : (
              <ul className="space-y-3">
                {q.data.brokers.slice(0, limit).map((b) => (
                  <li key={b.broker.id} className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        <span className="truncate">{b.broker.companyName}</span>
                        {b.cityLoads > 0 && city && <Badge color="green">{b.cityLoads} from {city}</Badge>}
                      </p>
                      <p className="mt-0.5 text-xs text-muted tabular">
                        {b.loads} load{b.loads === 1 ? '' : 's'} · last {date(b.lastLoadAt)}{b.lastRateCents ? ` at ${money(b.lastRateCents, { digits: 0 })}` : ''}{b.lastRpm != null ? ` (${rpm(b.lastRpm)})` : ''}
                        {b.avgRpm != null ? ` · average ${rpm(b.avgRpm)}` : ''}
                      </p>
                      <p className="text-xs text-muted">
                        {[b.broker.contactName, b.topDestinations?.length ? `usually to ${b.topDestinations.join(', ')}` : null, b.broker.daysToPay != null ? `pays in about ${b.broker.daysToPay} days` : b.broker.paymentTerms].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      {b.broker.phone && <CallButton phone={b.broker.phone} variant="link" className="text-[13px]" />}
                      {b.broker.email && <Button size="sm" variant="secondary" icon={Mail} onClick={() => setEmailTo(b.broker)}>Email</Button>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="px-4 py-3">
            <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-fg-2"><Route className="size-3.5 text-c-teal" aria-hidden />Your lanes out of {q.data.state}</h3>
            {!q.data.lanes.length ? <p className="text-sm text-muted">No loads out of {q.data.state} in the last {q.data.days} days.</p> : (
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {q.data.lanes.slice(0, limit).map((l) => (
                  <li key={l.destState} className="rounded-lg border border-line px-3 py-2 text-sm">
                    <span className="font-medium">{q.data.state} to {l.destState}</span>
                    <span className="ml-2 text-xs text-muted tabular">{l.loads} load{l.loads === 1 ? '' : 's'}{l.avgRpm != null ? ` · ${rpm(l.avgRpm)}` : ''} · last {date(l.lastLoadAt)}</span>
                    {l.topCities?.length > 0 && <span className="block truncate text-xs text-muted">{l.topCities.join(', ')}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {(!compact || q.data.customerLanes.length > 0) && (
            <section className="px-4 py-3">
              <h3 className="mb-2 text-[13px] font-medium text-fg-2">Customers' preferred lanes from here</h3>
              {!q.data.customerLanes.length ? <p className="text-sm text-muted">None of your customers list a lane out of {q.data.state}.</p> : (
                <ul className="space-y-1 text-sm">
                  {q.data.customerLanes.slice(0, limit).map((l, i) => (
                    <li key={`${l.origin}-${l.destination}-${i}`} className="flex flex-wrap gap-x-2">
                      <span>{l.origin} to {l.destination}</span>
                      {l.carrier && <span className="text-xs text-muted">{l.carrier.companyName}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section className={cx('flex items-start gap-2 px-4 py-3 text-xs text-muted')}>
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              {q.data.fmcsa?.state
                ? <>FMCSA census, active registrations based in {q.data.state}: {num(q.data.fmcsa.state.carriers)} carriers and {num(q.data.fmcsa.state.brokers)} listing brokerage{q.data.fmcsa.city ? `; in ${q.data.fmcsa.city.city}: ${num(q.data.fmcsa.city.carriers)} carriers and ${num(q.data.fmcsa.city.brokers)} listing brokerage` : ''}.</>
                : 'FMCSA census counts are not available right now.'}
              {' '}Rates and lanes above come only from loads in your workspace ({q.data.loadsConsidered} considered).
            </span>
          </section>
        </div>
      )}
      {emailTo && (
        <ComposeModal open brokerId={emailTo.id} toEmail={emailTo.email} templateCategory="broker" extra={extra} onClose={() => setEmailTo(null)} />
      )}
    </Card>
  );
}
