import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Scale } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { dateTime, dollars, money } from '../../lib/format.js';
import { Badge, Button, cx } from '../ui.jsx';
import { checkLoadFit, rulesSummary } from './fit.js';

/** Carrier rules for a carrier (null customer when it is not a customer). Shared cache key for every form. */
export function useCarrierRules(carrierId) {
  return useQuery({
    queryKey: ['customer-rules', carrierId],
    queryFn: () => api.get('/api/customers/rules', { carrierId }),
    enabled: !!carrierId,
    staleTime: 60_000,
  });
}

/** Last-90-day lane figures from the workspace's own loads. */
export function useLaneStats(originState, destState) {
  return useQuery({
    queryKey: ['lane-stats', originState, destState],
    queryFn: () => api.get('/api/loads/lane-stats', { originState, destState }),
    enabled: /^[A-Z]{2}$/.test(originState || '') && /^[A-Z]{2}$/.test(destState || ''),
    staleTime: 5 * 60_000,
  });
}

/**
 * Load check card: the carrier's rules, plain warnings (never blocking), negotiation numbers built only from the
 * carrier's own floors, and lane context from this workspace's own loads with the sample size.
 * `load` uses API units (rateCents, loadedMiles, ...); `stored` is the saved load's fit block (for acknowledging).
 */
export default function FitCard({ load, carrierId, stored, loadId, className }) {
  const rulesQ = useCarrierRules(carrierId);
  const laneQ = useLaneStats(load.originState, load.destState);
  const customer = rulesQ.data?.customer;
  const rules = customer?.rules;
  const result = useMemo(() => (rules ? checkLoadFit(load, rules) : null), [load, rules]);
  const summary = useMemo(() => (rules ? rulesSummary(rules) : []), [rules]);
  const ack = useApiMutation(() => api.post(`/api/loads/${loadId}/fit-ack`), { success: 'Warnings acknowledged', invalidate: [['load', loadId], ['loads']] });
  const n = result?.numbers;
  const lane = laneQ.data?.stats;
  const storedWarnings = stored?.warnings || [];
  const miles = Number(load.loadedMiles) || 0;
  const rpm = load.rateCents != null && miles > 0 ? Math.round(Number(load.rateCents) / miles) / 100 : null;

  return (
    <section className={cx('space-y-3 text-sm', className)} aria-label="Load check">
      <h3 className="flex items-center gap-1.5 text-sm font-medium"><Scale className="size-4 text-c-purple" aria-hidden />Load check</h3>
      {!carrierId ? (
        <p className="text-muted">Pick the carrier to check this load against its rules.</p>
      ) : rulesQ.isLoading ? (
        <p className="text-muted">Loading the carrier’s rules…</p>
      ) : rulesQ.isError ? (
        <p className="text-muted">{rulesQ.error.message}</p>
      ) : !customer ? (
        <p className="text-muted">{rulesQ.data?.carrier?.companyName || 'This carrier'} is not a customer yet, so it has no saved rules.</p>
      ) : (
        <>
          {summary.length ? (
            <div className="flex flex-wrap gap-1">{summary.map((s) => <Badge key={s} color="gray">{s}</Badge>)}</div>
          ) : <p className="text-muted">No rules saved for {rules.carrierName}. Add them on the customer page.</p>}
          {result.warnings.length ? (
            <ul className="space-y-1.5" aria-live="polite">
              {result.warnings.map((w) => (
                <li key={w.code + w.message} className="flex items-start gap-1.5 rounded-md border border-c-amber/30 bg-c-amber-soft px-2.5 py-1.5 text-[13px]">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-c-amber" aria-hidden />{w.message}
                </li>
              ))}
            </ul>
          ) : summary.length ? (
            <p className="flex items-center gap-1.5 text-c-green"><CheckCircle2 className="size-4" aria-hidden />Fits the carrier’s rules</p>
          ) : null}
          {result.warnings.length > 0 && <p className="text-xs text-muted">Warnings never block booking.</p>}
          {n?.walkAwayCents != null && (
            <dl className="space-y-1 rounded-md bg-surface-2/60 px-3 py-2">
              <div className="flex justify-between gap-3"><dt className="text-muted">Walk-away rate</dt><dd className="tabular font-medium">{money(n.walkAwayCents, { digits: 0 })}{n.walkAwayRatePerMile != null && <span className="text-muted"> · {dollars(n.walkAwayRatePerMile)}/mi</span>}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Based on</dt><dd className="text-right">{n.walkAwayBasis === 'cost' ? 'cost per mile incl. deadhead' : 'minimum rate per loaded mile'}</dd></div>
              {n.gapCents != null && (
                <div className="flex justify-between gap-3"><dt className="text-muted">This rate</dt><dd className={cx('tabular font-medium', n.gapCents < 0 ? 'text-c-red' : 'text-c-green')}>{n.gapCents < 0 ? `${money(-n.gapCents, { digits: 0 })} below` : `${money(n.gapCents, { digits: 0 })} above`}</dd></div>
              )}
            </dl>
          )}
        </>
      )}
      <div className="rounded-md border border-line px-3 py-2">
        <p className="text-xs font-medium text-fg-2">Your lane history (90 days)</p>
        {!lane ? (
          <p className="text-xs text-muted">{load.originState && load.destState ? 'Loading…' : 'Set origin and destination states.'}</p>
        ) : lane.sampleSize ? (
          <>
            <p className="text-[13px]"><span className="tabular font-medium">{dollars(lane.avgRatePerMile)}/mi</span> average, {dollars(lane.minRatePerMile)} to {dollars(lane.maxRatePerMile)}, from {lane.sampleSize} load{lane.sampleSize === 1 ? '' : 's'} {lane.originState} → {lane.destState}</p>
            {rpm != null && lane.sampleSize >= 3 && lane.maxRatePerMile && rpm > lane.maxRatePerMile * 1.25 && (
              <p className="mt-1 text-xs text-c-amber">{dollars(rpm)}/mi is well above the highest rate on this lane in your history. Unusually high rates are a common lure in rate-con fraud: verify the broker before dispatching.</p>
            )}
          </>
        ) : (
          <p className="text-xs text-muted">No loads on {lane.originState} → {lane.destState} in the last 90 days.</p>
        )}
        <p className="mt-0.5 text-[11px] text-muted">From your own loads only. Not a market rate.</p>
      </div>
      {loadId && storedWarnings.length > 0 && (
        stored.acknowledgedAt
          ? <p className="text-xs text-muted">Saved warnings acknowledged by {stored.acknowledgedBy || 'a teammate'}, {dateTime(stored.acknowledgedAt)}.</p>
          : <Button size="sm" variant="secondary" loading={ack.isPending} onClick={() => ack.mutate()}>Acknowledge {storedWarnings.length} saved warning{storedWarnings.length === 1 ? '' : 's'}</Button>
      )}
    </section>
  );
}
