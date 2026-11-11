import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, ExternalLink, Link2, Mail, MessageSquare, Plus, Ban, Eye } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useToast } from '../Toast.jsx';
import { relative, dateTime } from '../../lib/format.js';
import { Modal, useConfirm } from '../Modal.jsx';
import { Badge, Button, Field, Input, Select, Switch } from '../ui.jsx';
import ComposeModal from '../email/ComposeModal.jsx';

const EXPIRY = [{ value: '', label: '24 hours after delivery' }, { value: '1', label: '1 day' }, { value: '3', label: '3 days' }, { value: '7', label: '7 days' }, { value: '14', label: '14 days' }];
const STATUS = { active: { label: 'Active', color: 'green' }, expired: { label: 'Expired', color: 'gray' }, revoked: { label: 'Turned off', color: 'gray' } };

/**
 * Read-only tracking link for the broker or shipper of one load. They see the load reference, stops and appointments,
 * status, the city the truck is near, the ETA and whether the POD is in; never the driver's name or phone, rates or CRM data.
 * The dispatcher sends it from their own phone or mailbox (nothing is sent automatically).
 */
export default function TrackingLinkModal({ trip, onClose }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [form, setForm] = useState({ label: trip.broker?.companyName || '', days: '', exact: false });
  const [created, setCreated] = useState(null);
  const [compose, setCompose] = useState(false);
  const links = useQuery({ queryKey: ['fleet', 'tracking-links', trip.id], queryFn: () => api.get(`/api/fleet/trips/${trip.id}/tracking-links`) });
  const create = useApiMutation((body) => api.post(`/api/fleet/trips/${trip.id}/tracking-links`, body), {
    invalidate: [['fleet', 'tracking-links', trip.id]], onSuccess: (d) => setCreated(d),
  });
  const revoke = useApiMutation((id) => api.post(`/api/fleet/tracking-links/${id}/revoke`), { success: 'Tracking link turned off', invalidate: [['fleet', 'tracking-links', trip.id]] });
  const copy = async (text, what) => {
    try { await navigator.clipboard.writeText(text); toast.success(`${what} copied`); } catch { toast.error('Copy failed. Select the text and copy it by hand.'); }
  };
  const askRevoke = async (s) => {
    if (await confirm({ title: 'Turn off this tracking link?', message: `${s.label || 'The broker'} will no longer see updates for this load. You can create a new link at any time.`, confirmLabel: 'Turn off', danger: true })) revoke.mutate(s.id);
  };
  const items = links.data?.items || [];
  const body = created ? `Hello,\n\n${created.message.text}\n\nThe page shows the status, the city the truck is near and the ETA. It updates on its own.\n` : '';
  const mergeExtra = useMemo(() => (created ? { track_link: created.link } : undefined), [created]);

  return (
    <Modal open onClose={onClose} size="md" title="Tracking link for the broker"
      footer={created ? <><Button variant="secondary" icon={Plus} onClick={() => setCreated(null)}>New link</Button><Button onClick={onClose}>Done</Button></> : <>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button icon={Link2} loading={create.isPending} onClick={() => create.mutate({ label: form.label || null, days: form.days ? Number(form.days) : null, exact: form.exact })}>Create link</Button>
      </>}>
      {created ? (
        <div className="space-y-4">
          <p className="text-sm text-fg-2">Send this link to {created.share.label || 'the broker'}. It is shown only now; create a new one if it gets lost.</p>
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-2">
            <code className="min-w-0 flex-1 truncate px-1 font-mono text-xs">{created.link}</code>
            <Button size="sm" variant="secondary" icon={Copy} onClick={() => copy(created.link, 'Link')}>Copy</Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button variant="secondary" icon={Mail} onClick={() => setCompose(true)}>Email from my mailbox</Button>
            <Button variant="secondary" icon={MessageSquare} href={created.message.sms}>Text message</Button>
            <Button variant="secondary" icon={ExternalLink} href={created.link} target="_blank" rel="noopener noreferrer">Open the page</Button>
            <Button variant="secondary" icon={Copy} onClick={() => copy(created.message.text, 'Message')}>Copy message</Button>
          </div>
          <p className="text-xs text-muted">Works until {dateTime(created.share.expiresAt)}{created.share.exact ? '. Shows the exact GPS position.' : '. Shows the nearest city, not the exact position.'}</p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-fg-2">{trip.origin.city}, {trip.origin.state} → {trip.dest.city}, {trip.dest.state}{trip.referenceNumber ? ` · ref ${trip.referenceNumber}` : ''}. The broker sees status, appointments, the nearest city and the ETA, so they do not need to call for updates.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Who it is for"><Input value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} maxLength={80} placeholder="Broker name" /></Field>
            <Field label="Link works for">
              <Select value={form.days} onChange={(e) => setForm((f) => ({ ...f, days: e.target.value }))}>{EXPIRY.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</Select>
            </Field>
          </div>
          <div className="rounded-lg border border-line p-3">
            <Switch checked={form.exact} onChange={(v) => setForm((f) => ({ ...f, exact: v }))} label={<span className="text-sm font-medium">Show the exact GPS position</span>} />
            <p className="mt-1.5 text-xs text-fg-2">Off: the broker sees only the city the truck is near. Turn on only if the carrier and the driver agree.</p>
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div className="mt-6 border-t border-line pt-4">
          <h3 className="mb-2 text-sm font-medium">Links for this load</h3>
          <ul className="space-y-2">
            {items.slice(0, 8).map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-[13px]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-medium">{s.label || 'Broker'}</span>
                    <Badge color={STATUS[s.status]?.color || 'gray'}>{STATUS[s.status]?.label || s.status}</Badge>
                    {s.exact && <Badge color="amber">Exact GPS</Badge>}
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted"><Eye className="size-3" aria-hidden />{s.views ? `Opened ${s.views} ${s.views === 1 ? 'time' : 'times'}, last ${relative(s.lastViewedAt)}` : 'Not opened yet'} · created {relative(s.createdAt)}</div>
                </div>
                {s.status === 'active' && <Button size="sm" variant="ghost" icon={Ban} loading={revoke.isPending && revoke.variables === s.id} onClick={() => askRevoke(s)}>Turn off</Button>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {compose && created && (
        // {{track_link}} in a broker template fills in with this link.
        <ComposeModal open onClose={() => setCompose(false)} brokerId={trip.broker?.id} loadId={trip.id} toEmail={created.message.toEmail || ''}
          subject={created.message.subject} body={body} extra={mergeExtra} templateCategory="broker" onSent={() => setCompose(false)} />
      )}
    </Modal>
  );
}
