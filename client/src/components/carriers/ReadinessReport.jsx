import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, AlertTriangle, XCircle, HelpCircle, Copy, Mail, ExternalLink } from 'lucide-react';
import { api } from '../../lib/api.js';
import { date, dateTime } from '../../lib/format.js';
import { Modal } from '../Modal.jsx';
import { Badge, Button, ErrorState, Loading, cx } from '../ui.jsx';
import { useToast } from '../Toast.jsx';
import ComposeModal from '../email/ComposeModal.jsx';
import { copyText } from './CopyField.jsx';
import { carrierResources } from './resources.js';
import { claimText } from './SaveAndCall.jsx';

export const CHECK_STYLE = {
  pass: { icon: CheckCircle2, cls: 'text-c-green', label: 'OK' },
  warn: { icon: AlertTriangle, cls: 'text-c-amber', label: 'Check' },
  fail: { icon: XCircle, cls: 'text-c-red', label: 'Problem' },
  unknown: { icon: HelpCircle, cls: 'text-muted', label: 'Unknown' },
};

/**
 * Carrier readiness report for a USDOT number (new-authority kit), from public FMCSA data only.
 * Insurance and live authority need the free QCMobile webKey; without it they show as unknown.
 * "Copy summary" puts a plain-text version on the clipboard; "Email summary" opens the composer for a carrier
 * that is in the CRM. Nothing is sent automatically.
 */
export default function ReadinessReport({ dot, open, onClose }) {
  const toast = useToast();
  const [compose, setCompose] = useState(false);
  const q = useQuery({
    queryKey: ['authority-kit', 'readiness', dot],
    queryFn: ({ signal }) => api.get(`/api/authority-kit/readiness/${encodeURIComponent(dot)}`, undefined, { signal }),
    enabled: open && !!dot,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const r = q.data;
  const fmcsaLinks = r ? carrierResources({ dotNumber: r.carrier.dotNumber }).filter((l) => ['safer', 'li'].includes(l.key)) : [];
  return (
    <Modal open={open} onClose={onClose} size="lg" title={r ? r.carrier.companyName : 'Readiness report'}
      footer={r && (
        <>
          <Button variant="secondary" icon={Copy} onClick={async () => { if (await copyText(r.text)) toast.success('Summary copied'); }}>Copy summary</Button>
          {r.crm?.carrierId && r.carrier.email && <Button variant="secondary" icon={Mail} onClick={() => setCompose(true)}>Email summary</Button>}
          <span className="flex-1" />
          <Button onClick={onClose}>Done</Button>
        </>
      )}>
      {q.isLoading ? <Loading label="Reading FMCSA records…" /> : q.isError ? <ErrorState error={q.error} onRetry={q.refetch} /> : r && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted tabular">
            {r.carrier.mcNumber && <Badge color="blue">MC {r.carrier.mcNumber}</Badge>}
            <Badge color="gray">USDOT {r.carrier.dotNumber}</Badge>
            <span>{[r.carrier.city, r.carrier.state].filter(Boolean).join(', ')}</span>
            {r.carrier.fleetSize != null && <span>· {r.carrier.fleetSize} truck{r.carrier.fleetSize === 1 ? '' : 's'}</span>}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-line px-3 py-2">
              <p className="text-xs text-muted">Registered (census)</p>
              <p className="text-sm font-medium">{date(r.authority.registeredAt)}</p>
              <p className="text-xs text-muted">{r.authority.ageDays != null ? `${r.authority.ageDays} days ago` : 'Unknown'}</p>
            </div>
            <div className="rounded-lg border border-line px-3 py-2">
              <p className="text-xs text-muted">90 days</p>
              <p className="text-sm font-medium">{date(r.brokerAcceptance.reaches90At)}</p>
            </div>
            <div className="rounded-lg border border-line px-3 py-2">
              <p className="text-xs text-muted">180 days</p>
              <p className="text-sm font-medium">{date(r.brokerAcceptance.reaches180At)}</p>
            </div>
          </div>
          <p className="text-sm text-fg-2">{r.brokerAcceptance.note}</p>

          {(r.crm?.existsInCrm || r.crm?.teamClaims?.length > 0) && (
            <p className={cx('rounded-lg border px-3 py-2 text-[13px]', r.crm.existsInCrm ? 'border-c-green/30 bg-c-green-soft' : 'border-c-amber/30 bg-c-amber-soft')}>
              {r.crm.existsInCrm ? 'This carrier is in your list.' : claimText(r.crm.teamClaims)}
            </p>
          )}

          <ul className="divide-y divide-line rounded-lg border border-line">
            {r.checks.map((c) => {
              const s = CHECK_STYLE[c.status] || CHECK_STYLE.unknown;
              const Icon = s.icon;
              return (
                <li key={c.key} className="flex items-start gap-3 px-3 py-2.5">
                  <Icon className={cx('mt-0.5 size-4 shrink-0', s.cls)} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{c.label}<span className="sr-only">: {s.label}</span></p>
                    <p className="text-[13px] text-fg-2">{c.detail}</p>
                  </div>
                  <span className="shrink-0 text-[11px] text-muted">{c.source}</span>
                </li>
              );
            })}
          </ul>

          <div className="space-y-1 text-xs text-muted">
            {r.sources.map((s) => (
              <p key={s.label}>{s.label}{s.retrievedAt ? `, read ${dateTime(s.retrievedAt)}` : ''}{s.note ? `. ${s.note}` : ''}</p>
            ))}
            {fmcsaLinks.length > 0 && (
              <p className="flex flex-wrap gap-3 pt-1">
                {fmcsaLinks.map((l) => <a key={l.key} href={l.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-fg hover:underline">{l.title}<ExternalLink className="size-3" aria-hidden /></a>)}
              </p>
            )}
          </div>
        </div>
      )}
      {compose && r?.crm?.carrierId && (
        <ComposeModal open carrierId={r.crm.carrierId} toEmail={r.carrier.email} subject={`Authority snapshot for ${r.carrier.companyName}`} body={r.text} onClose={() => setCompose(false)} />
      )}
    </Modal>
  );
}
