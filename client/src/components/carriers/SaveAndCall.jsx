import { useEffect, useState } from 'react';
import { Phone } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { relative } from '../../lib/format.js';
import { Button, cx } from '../ui.jsx';
import { useConfirm } from '../Modal.jsx';
import { useToast } from '../Toast.jsx';
import { errorToast } from '../../lib/hooks.js';
import { useDialer } from '../calling/useDialer.js';
import LogCallModal from './LogCallModal.jsx';
import CallButton from '../calling/CallButton.jsx';
import { saveCensusLeads } from './saveLeads.js';

const pretty = (phone) => {
  const d = String(phone || '').replace(/\D/g, '');
  const n = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return n.length === 10 ? `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` : String(phone || '');
};

/** "Tina has this carrier (contacted 2 days ago)" for the team collision guard. */
export function claimText(claims = []) {
  const c = claims[0];
  if (!c) return '';
  const who = c.assignedToName && c.assignedToName !== c.ownerName ? `${c.ownerName} (assigned to ${c.assignedToName})` : c.ownerName;
  const touched = c.lastContactedAt ? `contacted ${relative(c.lastContactedAt)}` : 'not contacted yet';
  const more = claims.length > 1 ? ` and ${claims.length - 1} more teammate${claims.length > 2 ? 's' : ''}` : '';
  return `${who}${more} already ${claims.length > 1 ? 'have' : 'has'} this carrier (${c.stage?.name ? `${c.stage.name}, ` : ''}${touched}).`;
}

/**
 * Click-to-call for a census lead (Find carriers, New authority).
 * - Already in the CRM: a normal call that logs against the carrier.
 * - Not saved yet: the click saves it first (re-verified with FMCSA on the server, plan limits apply), then dials with the
 *   new carrier id, so the log form opens and the call is recorded on the lead.
 * - A teammate has it: asks first (team collision guard).
 * - Authority not active (FMCSA licensing re-checked on save): asks "Authority is not active. Save anyway?" first;
 *   `allowInactive` skips that question (pending carriers in the new-authority kit).
 * Nothing dials without the click.
 *
 * record: { dotNumber, phone, companyName, existsInCrm, existingId, teamClaims }
 */
export default function SaveAndCall({ record, variant = 'link', label, onSaved, className, allowInactive = false }) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const d = useDialer();
  const [busy, setBusy] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

  useEffect(() => {
    if (d.mode === 'bridge' && d.isFinal && d.attempt && !d.attempt.callId && d.attempt.carrier && d.autoOpenLog && !['failed', 'canceled'].includes(d.attempt.status)) setLogOpen(true);
  }, [d.mode, d.isFinal, d.attempt, d.autoOpenLog]);

  if (!record?.phone) return <span className="text-muted">—</span>;
  if (record.existsInCrm && record.existingId) {
    return <CallButton phone={record.phone} carrierId={record.existingId} variant={variant === 'link' ? 'link' : 'button'} size="sm" label={label || 'Call'} className={cx(variant === 'link' && 'whitespace-nowrap', className)} />;
  }

  const start = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    if (record.teamClaims?.length) {
      const ok = await confirm({ title: 'A teammate has this carrier', message: `${claimText(record.teamClaims)} Call and add it to your list anyway?`, confirmLabel: 'Call anyway' });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const saved = await saveCensusLeads({ dots: [record.dotNumber], confirm, allowInactive });
      const item = saved.items?.find((i) => i.dotNumber === String(record.dotNumber).replace(/^0+/, '')) || saved.items?.[0];
      if (!item?.id) {
        toast.error(item?.status === 'limited' ? 'Your plan’s limit for saved leads is reached, so this lead was not saved. Upgrade, or try again tomorrow.'
          : item?.status === 'inactive_authority' ? 'Not saved: this carrier’s operating authority is not active.'
            : item?.status === 'unverified' ? 'Not saved: operating authority could not be verified with FMCSA right now.'
              : 'This carrier was not found in the FMCSA census, so it was not saved.');
        return;
      }
      if (item.status === 'created') toast.success(`Saved ${record.companyName || 'carrier'} to your list`);
      qc.invalidateQueries({ queryKey: ['discovery'] });
      qc.invalidateQueries({ queryKey: ['carriers'] });
      qc.invalidateQueries({ queryKey: ['authority-kit'] });
      qc.invalidateQueries({ queryKey: ['billing'] }); // the "leads saved today" meter
      onSaved?.(item);
      const res = await d.dial({ carrierId: item.id, phone: record.phone });
      if (res?.mode === 'link' && res.autoOpenLog !== false && res.attempt?.carrier) setLogOpen(true);
    } catch (err) {
      errorToast(toast, err);
    } finally {
      setBusy(false);
    }
  };

  const title = 'Saves this carrier to your list, then calls with your calling app';
  return (
    <>
      {variant === 'link' ? (
        <a href={`tel:+1${String(record.phone).replace(/\D/g, '').slice(-10)}`} onClick={start} title={title}
          className={cx('whitespace-nowrap tabular text-fg hover:underline', (busy || d.dialing) && 'opacity-60', className)} aria-busy={busy || undefined}>
          {pretty(record.phone)}
        </a>
      ) : (
        <Button size="sm" icon={Phone} onClick={start} loading={busy || d.dialing} title={title} className={className}>{label || 'Save and call'}</Button>
      )}
      {logOpen && d.attempt?.carrier && (
        <span onClick={(e) => e.stopPropagation()}>
          <LogCallModal open={logOpen} onClose={() => { setLogOpen(false); d.reset(); }} carrier={d.attempt.carrier} attempt={d.attempt} />
        </span>
      )}
    </>
  );
}
