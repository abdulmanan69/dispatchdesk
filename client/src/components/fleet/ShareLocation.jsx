import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, KeyRound, Mail, MessageSquare, Phone, Plus, Radio, RotateCcw, ShieldAlert, ShieldCheck, Smartphone, Square } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useToast } from '../Toast.jsx';
import { dateTime, relative } from '../../lib/format.js';
import { Modal, useConfirm } from '../Modal.jsx';
import { Badge, Button, Field, Input, Select, Switch, cx } from '../ui.jsx';
import { SHARE_DURATIONS, SHARE_STATUS } from './fleetApi.js';
import TextLogModal from '../carriers/TextLogModal.jsx';

const STATUS = { ...SHARE_STATUS, locked: { label: 'Locked: wrong PIN', color: 'red' } };
const CLAIM_WINDOWS = [{ value: 30, label: '30 minutes' }, { value: 120, label: '2 hours' }, { value: 360, label: '6 hours' }];
export const CONFIDENCE = {
  high: { label: 'High confidence', color: 'green', Icon: ShieldCheck },
  medium: { label: 'Check position', color: 'amber', Icon: ShieldAlert },
  low: { label: 'Low confidence', color: 'red', Icon: ShieldAlert },
};
const LIVE = ['pending', 'sharing', 'paused'];

/** Big, copyable PIN shown once (on create and after a device reset). */
function PinCard({ pin, who, onCopy }) {
  return (
    <div className="rounded-lg border border-c-blue bg-c-blue-soft p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-[13px] font-medium"><KeyRound className="size-4" aria-hidden />PIN for {who}</div>
          <div className="mt-1 font-mono text-2xl tracking-[0.3em] tabular">{pin}</div>
        </div>
        <Button size="sm" variant="secondary" icon={Copy} onClick={() => onCopy(pin, 'PIN')}>Copy</Button>
      </div>
      <p className="mt-2 text-xs text-fg-2">Read this PIN to the driver on the phone. Do not send it in the same message as the link. It is shown only now.</p>
    </div>
  );
}

function ShareRow({ s, onStop, stopping, onReset, resetting }) {
  const st = STATUS[s.status] || STATUS.stopped;
  const live = LIVE.includes(s.status);
  const tr = s.trust || {};
  const conf = tr.confidence ? CONFIDENCE[tr.confidence] : null;
  const canReset = (live || s.status === 'locked') && (s.deviceBoundAt || s.status === 'locked' || tr.recentFlags?.length);
  return (
    <li className={cx('rounded-lg border border-line px-3 py-2 text-[13px]', !live && s.status !== 'locked' && 'opacity-70')}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-medium">{s.driverName || 'Driver'}</span>
            <Badge color={st.color}>{st.label}</Badge>
            {conf && live && <Badge color={conf.color}><conf.Icon className="size-3" aria-hidden />{conf.label}</Badge>}
          </div>
          <div className="text-xs text-muted">
            {s.last ? `Last fix ${relative(s.last.at)}${s.last.speedMph ? ` · ${s.last.speedMph} mph` : ''}${s.last.accuracyM ? ` · ±${Math.round(s.last.accuracyM)} m` : ''}` : `Created ${relative(s.createdAt)}`}
            {live ? (s.claimBy ? ` · must be opened ${relative(s.claimBy)}` : ` · expires ${relative(s.expiresAt)}`) : ''}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          {canReset && <Button size="sm" variant="ghost" icon={RotateCcw} loading={resetting} onClick={() => onReset(s)}>Reset device</Button>}
          {live && <Button size="sm" variant="ghost" icon={Square} loading={stopping} onClick={() => onStop(s.id)}>Stop</Button>}
        </div>
      </div>
      {(s.deviceBoundAt || tr.pinEnabled) && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-fg-2">
          {s.deviceBoundAt
            ? <span className="flex items-center gap-1"><Smartphone className="size-3.5" aria-hidden />{tr.deviceLabel || 'Phone'} · since {relative(s.deviceBoundAt)}</span>
            : <span className="flex items-center gap-1 text-muted"><Smartphone className="size-3.5" aria-hidden />No phone yet</span>}
          {tr.pinEnabled && <span className="flex items-center gap-1"><KeyRound className="size-3.5" aria-hidden />{tr.pinVerified ? 'PIN checked' : `PIN not entered${s.pinAttemptsLeft != null && s.pinAttemptsLeft < 5 ? ` · ${s.pinAttemptsLeft} tries left` : ''}`}</span>}
        </div>
      )}
      {tr.recentFlags?.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-xs">
          {tr.recentFlags.slice(0, 4).map((f, i) => (
            <li key={`${f.type}-${f.at}-${i}`} className="flex gap-1.5 text-amber-800 dark:text-amber-300">
              <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>{f.text}{f.detail ? ` · ${f.detail}` : ''} <span className="text-muted">{relative(f.at)}</span></span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Create a live-location link for a truck's driver and send it.
 * The driver opens it on their phone and agrees before anything is shared. The link locks to that phone,
 * an optional PIN (read to the driver separately) must be entered first, and links expire and can be stopped.
 */
export default function ShareLocation({ truck, tripId, onClose }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [form, setForm] = useState({ driverName: '', driverPhone: truck.phone || '', hours: 24, claimMinutes: 120, pin: true, loadId: tripId || truck.currentTrip?.id || truck.nextTrip?.id || '' });
  const [created, setCreated] = useState(null); // { link, message, share, pin }
  const [texting, setTexting] = useState(false);
  const [resetPin, setResetPin] = useState(null); // { pin, who }
  const shares = useQuery({ queryKey: ['fleet', 'shares', truck.id], queryFn: () => api.get(`/api/fleet/carriers/${truck.id}/shares`) });
  // The same driver usually drives the truck: start from the name and phone on the last link (until the dispatcher types).
  const touched = useRef(false);
  useEffect(() => {
    const last = shares.data?.items?.find((x) => x.driverName || x.driverPhone);
    if (!last || touched.current) return;
    setForm((f) => ({ ...f, driverName: f.driverName || last.driverName || '', driverPhone: last.driverPhone || f.driverPhone }));
  }, [shares.data]);
  const create = useApiMutation((body) => api.post(`/api/fleet/carriers/${truck.id}/share`, body), {
    invalidate: [['fleet']],
    onSuccess: (d) => { setCreated(d); setResetPin(null); },
  });
  const stop = useApiMutation((id) => api.post(`/api/fleet/shares/${id}/stop`), { success: 'Location link stopped', invalidate: [['fleet']] });
  const reset = useApiMutation((s) => api.post(`/api/fleet/shares/${s.id}/reset-device`), {
    invalidate: [['fleet']],
    success: 'The driver can now open the link on a new phone',
    onSuccess: (d, s) => setResetPin(d.pin ? { pin: d.pin, who: s.driverName || 'the driver' } : null),
  });
  const set = (k) => (e) => { touched.current = true; setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e })); };

  const copy = async (text, what) => {
    try { await navigator.clipboard.writeText(text); toast.success(`${what} copied`); } catch { toast.error('Copy failed. Select the text and copy it by hand.'); }
  };
  // Google Voice has no "prefill message" URL, so copy the text first, then open the conversation.
  const viaVoice = async () => { await copy(created.message.text, 'Message'); window.open(created.message.googleVoice, '_blank', 'noopener'); };
  const askReset = async (s) => {
    const ok = await confirm({
      title: 'Reset the phone for this link?',
      message: `${s.driverName || 'The driver'} will open the same link again on the phone they have now.${s.trust?.pinEnabled ? ' A new PIN is created and shown once.' : ''} The phone that had it loses access.`,
      confirmLabel: 'Reset device',
    });
    if (ok) reset.mutate(s);
  };

  const trips = truck.trips || [];
  const items = shares.data?.items || [];
  const active = items.filter((s) => LIVE.includes(s.status));

  return (
    <Modal open onClose={onClose} size="md" title={`Live location · ${truck.companyName}`}
      footer={created ? <><Button variant="secondary" icon={Plus} onClick={() => setCreated(null)}>New link</Button><Button onClick={onClose}>Done</Button></> : <>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button icon={Radio} loading={create.isPending} onClick={() => create.mutate({ ...form, hours: Number(form.hours), claimMinutes: Number(form.claimMinutes), loadId: form.loadId || null })}>Create link</Button>
      </>}>
      {created ? (
        <div className="space-y-4">
          <p className="text-sm text-fg-2">Send this link to {created.share.driverName || 'the driver'}. When they open it and tap <span className="font-medium text-fg">Start sharing</span>, the truck moves on your map. The link locks to the first phone that opens it and is shown only now.</p>
          {created.pin && <PinCard pin={created.pin} who={created.share.driverName || 'the driver'} onCopy={copy} />}
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
          <Button size="sm" variant="ghost" icon={MessageSquare} onClick={() => setTexting(true)}>Write it from a driver template</Button>
          {texting && (
            // {{track_link}} in a driver template fills in with this link; the text is logged on the carrier.
            <TextLogModal carrier={{ id: truck.id, companyName: truck.companyName, phone: created.share.driverPhone || truck.phone, state: truck.state, timezone: truck.timezone }}
              loadId={created.share.loadId || undefined} category="driver" extra={{ track_link: created.link }} initialBody={created.message.text}
              title={`Text ${created.share.driverName || 'the driver'}`} onClose={() => setTexting(false)} />
          )}
          <p className="text-xs text-muted">Must be opened by {dateTime(created.share.claimBy || created.share.expiresAt)}; then it lasts {SHARE_DURATIONS.find((d) => d.value === created.share.durationHours)?.label || `${created.share.durationHours} hours`}. The driver can stop sharing anytime; you can stop the link below.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-fg-2">The driver gets a link that shares their phone's GPS while the page is open, lets them check in at pickup and delivery, and send photos of the BOL, POD and receipts. Nothing is shared until they agree, and the link works on one phone only.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Driver name"><Input value={form.driverName} onChange={set('driverName')} placeholder="Marco" maxLength={80} /></Field>
            <Field label="Driver phone"><Input value={form.driverPhone} onChange={set('driverPhone')} placeholder="(214) 555-0111" maxLength={30} /></Field>
            <Field label="Link lasts" hint="Counted from when the driver opens it">
              <Select value={form.hours} onChange={set('hours')}>{SHARE_DURATIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}</Select>
            </Field>
            <Field label="Must be opened within" hint="Unopened links expire">
              <Select value={form.claimMinutes} onChange={set('claimMinutes')}>{CLAIM_WINDOWS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}</Select>
            </Field>
            <Field label="Show the driver this trip" className="sm:col-span-2">
              <Select value={form.loadId} onChange={set('loadId')}>
                <option value="">No trip</option>
                {trips.map((t) => <option key={t.id} value={t.id}>{t.origin.city} → {t.dest.city}</option>)}
              </Select>
            </Field>
          </div>
          <div className="rounded-lg border border-line p-3">
            <Switch checked={form.pin} onChange={(v) => setForm((f) => ({ ...f, pin: v }))} label={<span className="text-sm font-medium">Require a PIN</span>} />
            <p className="mt-1.5 text-xs text-fg-2">You read a 6-digit PIN to the driver on the phone. If the link is forwarded, it cannot be opened without the PIN. Recommended.</p>
          </div>
          {active.length > 0 && <p className="text-xs text-muted">Creating a new link stops the current one.</p>}
        </div>
      )}

      {resetPin && <div className="mt-4"><PinCard pin={resetPin.pin} who={resetPin.who} onCopy={copy} /></div>}

      {items.length > 0 && (
        <div className="mt-6 border-t border-line pt-4">
          <h3 className="mb-2 text-sm font-medium">Links for this truck</h3>
          <ul className="space-y-2">
            {items.slice(0, 6).map((s) => (
              <ShareRow key={s.id} s={s} onStop={(id) => stop.mutate(id)} stopping={stop.isPending && stop.variables === s.id}
                onReset={askReset} resetting={reset.isPending && reset.variables?.id === s.id} />
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}
