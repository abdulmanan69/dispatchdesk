import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Mail, MessageSquare, Phone, Radio, Square } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useToast } from '../Toast.jsx';
import { dateTime, relative } from '../../lib/format.js';
import { Modal } from '../Modal.jsx';
import { Badge, Button, Field, Input, Select, cx } from '../ui.jsx';
import { SHARE_DURATIONS, SHARE_STATUS } from './fleetApi.js';

/**
 * Create a live-location link for a truck's driver and send it.
 * The driver opens it on their phone and agrees before anything is shared; links expire and can be stopped.
 */
export default function ShareLocation({ truck, tripId, onClose }) {
  const toast = useToast();
  const [form, setForm] = useState({ driverName: '', driverPhone: truck.phone || '', hours: 24, loadId: tripId || truck.currentTrip?.id || truck.nextTrip?.id || '' });
  const [created, setCreated] = useState(null); // { link, message, share }
  const shares = useQuery({ queryKey: ['fleet', 'shares', truck.id], queryFn: () => api.get(`/api/fleet/carriers/${truck.id}/shares`) });
  const create = useApiMutation((body) => api.post(`/api/fleet/carriers/${truck.id}/share`, body), {
    invalidate: [['fleet']],
    onSuccess: (d) => setCreated(d),
  });
  const stop = useApiMutation((id) => api.post(`/api/fleet/shares/${id}/stop`), { success: 'Location link stopped', invalidate: [['fleet']] });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));

  const copy = async (text, what) => {
    try { await navigator.clipboard.writeText(text); toast.success(`${what} copied`); } catch { toast.error('Copy failed. Select the text and copy it by hand.'); }
  };
  // Google Voice has no "prefill message" URL, so copy the text first, then open the conversation.
  const viaVoice = async () => { await copy(created.message.text, 'Message'); window.open(created.message.googleVoice, '_blank', 'noopener'); };

  const trips = truck.trips || [];
  const active = (shares.data?.items || []).filter((s) => ['pending', 'sharing', 'paused'].includes(s.status));

  return (
    <Modal open onClose={onClose} size="md" title={`Live location · ${truck.companyName}`}
      footer={created ? <Button onClick={onClose}>Done</Button> : <>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button icon={Radio} loading={create.isPending} onClick={() => create.mutate({ ...form, hours: Number(form.hours), loadId: form.loadId || null })}>Create link</Button>
      </>}>
      {created ? (
        <div className="space-y-4">
          <p className="text-sm text-fg-2">Send this link to {created.share.driverName || 'the driver'}. When they open it and tap <span className="font-medium text-fg">Start sharing</span>, the truck moves on your map. The link is shown only now.</p>
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-2">
            <code className="min-w-0 flex-1 truncate px-1 font-mono text-xs">{created.link}</code>
            <Button size="sm" variant="secondary" icon={Copy} onClick={() => copy(created.link, 'Link')}>Copy</Button>
          </div>
          <div className="rounded-lg border border-line p-3 text-sm text-fg-2">{created.message.text}</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button variant="secondary" icon={Phone} onClick={viaVoice}>Send with Google Voice</Button>
            <Button variant="secondary" icon={MessageSquare} href={created.message.sms}>Text message</Button>
            <Button variant="secondary" icon={Mail} href={created.message.email}>Email</Button>
            <Button variant="secondary" icon={Copy} onClick={() => copy(created.message.text, 'Message')}>Copy message</Button>
          </div>
          <p className="text-xs text-muted">Expires {dateTime(created.share.expiresAt)}. The driver can stop sharing anytime; you can stop the link below.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-fg-2">The driver gets a link that shares their phone's GPS while the page is open, and lets them check in at pickup and delivery. Nothing is shared until they agree.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Driver name"><Input value={form.driverName} onChange={set('driverName')} placeholder="Marco" maxLength={80} /></Field>
            <Field label="Driver phone"><Input value={form.driverPhone} onChange={set('driverPhone')} placeholder="(214) 555-0111" maxLength={30} /></Field>
            <Field label="Link lasts">
              <Select value={form.hours} onChange={set('hours')}>{SHARE_DURATIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}</Select>
            </Field>
            <Field label="Show the driver this trip">
              <Select value={form.loadId} onChange={set('loadId')}>
                <option value="">No trip</option>
                {trips.map((t) => <option key={t.id} value={t.id}>{t.origin.city} → {t.dest.city}</option>)}
              </Select>
            </Field>
          </div>
          {active.length > 0 && <p className="text-xs text-muted">Creating a new link stops the current one.</p>}
        </div>
      )}

      {(shares.data?.items || []).length > 0 && (
        <div className="mt-6 border-t border-line pt-4">
          <h3 className="mb-2 text-sm font-medium">Links for this truck</h3>
          <ul className="space-y-2">
            {shares.data.items.slice(0, 6).map((s) => {
              const st = SHARE_STATUS[s.status] || SHARE_STATUS.stopped;
              const live = ['pending', 'sharing', 'paused'].includes(s.status);
              return (
                <li key={s.id} className={cx('flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-[13px]', !live && 'opacity-70')}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2"><span className="truncate font-medium">{s.driverName || 'Driver'}</span><Badge color={st.color}>{st.label}</Badge></div>
                    <div className="text-xs text-muted">
                      {s.last ? `Last fix ${relative(s.last.at)}${s.last.speedMph ? ` · ${s.last.speedMph} mph` : ''}${s.last.accuracyM ? ` · ±${Math.round(s.last.accuracyM)} m` : ''}` : `Created ${relative(s.createdAt)}`}
                      {live ? ` · expires ${relative(s.expiresAt)}` : ''}
                    </div>
                  </div>
                  {live && <Button size="sm" variant="ghost" icon={Square} loading={stop.isPending && stop.variables === s.id} onClick={() => stop.mutate(s.id)}>Stop</Button>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Modal>
  );
}
