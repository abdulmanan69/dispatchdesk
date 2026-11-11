import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Ban, FileSignature, FileText } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { dateTime, relative } from '../../lib/format.js';
import { useConfirm } from '../Modal.jsx';
import { Badge, Button, ErrorState } from '../ui.jsx';
import OnboardingLinkModal from './OnboardingLinkModal.jsx';
import { LINK_STATUS, ONBOARDING_DOC_LABEL, recordUrl } from './onboardingLinks.js';

/** One-line summary of a link's progress for the list. */
export function linkSummary(l) {
  const parts = [];
  if (l.status === 'signed') parts.push(`Signed by ${l.signerName} ${dateTime(l.signedAt)}`);
  else if (l.status === 'revoked') parts.push(`Turned off ${relative(l.revokedAt)}`);
  else if (l.status === 'expired') parts.push(`Expired ${relative(l.expiresAt)}`);
  else parts.push(`${l.viewedAt ? `Opened ${relative(l.viewedAt)}` : 'Not opened yet'} · works until ${dateTime(l.expiresAt)}`);
  if (l.feePercent != null) parts.push(`fee ${l.feePercent}%`);
  if (l.requestedDocs.length) parts.push(`documents ${l.requestedDocs.filter((k) => l.uploadedDocs.includes(k)).length} of ${l.requestedDocs.length}`);
  return parts.join(' · ');
}

/**
 * Dispatch agreement links for one carrier: status (sent, opened, signed, turned off, expired), the signed record and
 * revoke. `showCreate` adds the "Send agreement" button; `hideWhenEmpty` renders nothing until a link exists.
 */
export default function OnboardingPanel({ carrier, feePercent, showCreate = true, hideWhenEmpty = false, title = 'Dispatch agreement' }) {
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: ['onboarding-links', carrier.id], queryFn: () => api.get('/api/onboarding-links', { carrierId: carrier.id }) });
  const revoke = useApiMutation((id) => api.post(`/api/onboarding-links/${id}/revoke`), { success: 'Link turned off', invalidate: [['onboarding-links', carrier.id]] });
  const items = q.data?.items || [];
  if (hideWhenEmpty && !items.length) return null;

  const askRevoke = async (l) => {
    if (await confirm({ title: 'Turn off this link?', message: `${carrier.companyName} will no longer be able to open or sign it. You can send a new link at any time.`, confirmLabel: 'Turn off', danger: true })) revoke.mutate(l.id);
  };

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {showCreate && <Button size="sm" variant="secondary" icon={FileSignature} onClick={() => setCreating(true)}>Send agreement</Button>}
      </div>
      {q.isError ? <ErrorState error={q.error} onRetry={q.refetch} /> : !items.length ? (
        <p className="text-sm text-muted">{q.isLoading ? 'Loading…' : 'No agreement links yet. Send one and the carrier can sign and upload documents from their phone.'}</p>
      ) : (
        <ul className="space-y-2">
          {items.slice(0, 10).map((l) => {
            const st = LINK_STATUS[l.status] || LINK_STATUS.pending;
            const open = l.status === 'pending' || l.status === 'viewed';
            return (
              <li key={l.id} className="flex flex-col gap-2 rounded-lg border border-line px-3 py-2 text-[13px] sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-medium">{l.agreementTitle}</span>
                    <Badge color={st.color}>{st.label}</Badge>
                  </div>
                  <p className="text-xs text-muted">{linkSummary(l)}</p>
                  {l.requestedDocs.length > 0 && l.status !== 'revoked' && (
                    <p className="text-xs text-muted">{l.requestedDocs.map((k) => `${ONBOARDING_DOC_LABEL[k] || k}${l.uploadedDocs.includes(k) ? ' (in)' : ''}`).join(', ')}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {l.status === 'signed' && <Button size="sm" variant="ghost" icon={FileText} href={recordUrl(l.id)} target="_blank" rel="noopener noreferrer">View record</Button>}
                  {open && <Button size="sm" variant="ghost" icon={Ban} loading={revoke.isPending && revoke.variables === l.id} onClick={() => askRevoke(l)}>Turn off</Button>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {showCreate && <OnboardingLinkModal open={creating} onClose={() => setCreating(false)} carrier={carrier} feePercent={feePercent} />}
    </section>
  );
}
