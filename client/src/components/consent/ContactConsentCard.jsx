import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Ban, FileText, Plus } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { date, dateTime } from '../../lib/format.js';
import { Modal } from '../Modal.jsx';
import { Badge, Button, Card, Checkbox, ErrorState, Field, Input, Loading, Select, Textarea } from '../ui.jsx';

/**
 * Consent to automated calls and texts (TCPA) for one carrier: status, history, record a consent obtained outside the
 * app (with a note on how), revoke, and the printable proof. Nothing here calls or texts anyone.
 */

const CHANNEL_TEXT = { sms: 'SMS', voice: 'voice' };
const SOURCE_TEXT = { onboarding: 'Agreement signing page', manual: 'Recorded by dispatcher', form: 'Web form' };
export const channelsText = (channels = []) => channels.map((c) => CHANNEL_TEXT[c] || c).join(' + ');
export const proofUrl = (id) => `/api/contact-consents/${encodeURIComponent(id)}/proof`;

/** 10 digits for a valid US number, else null (same rule as the server). */
export function usPhone(input) {
  let d = String(input ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? d : null;
}

export const consentsKey = (carrierId) => ['contact-consents', carrierId];
export function useContactConsents(carrierId) {
  return useQuery({ queryKey: consentsKey(carrierId), queryFn: () => api.get('/api/contact-consents', { carrierId }), enabled: !!carrierId });
}

/** One-line status: "Consented · SMS + voice · since Nov 12, 2026" | "Not consented" | "Revoked". */
export function summaryText(s) {
  if (!s || s.status === 'none') return 'Not consented';
  if (s.status === 'revoked') return 'Revoked';
  return `Consented · ${channelsText(s.channels)} · since ${date(s.since)}`;
}

/** Small header badge, shown only while an active consent exists. */
export function ConsentBadge({ carrierId }) {
  const q = useContactConsents(carrierId);
  const s = q.data?.summary;
  if (s?.status !== 'consented') return null;
  return <Badge color="green" title={`Calls and texts: ${summaryText(s)}`}>Consent</Badge>;
}

export default function ContactConsentCard({ carrier, canWrite }) {
  const q = useContactConsents(carrier.id);
  const [recording, setRecording] = useState(false);
  const [revoking, setRevoking] = useState(null);
  const s = q.data?.summary;
  const items = q.data?.items || [];
  return (
    <Card title="Calls and texts consent" actions={canWrite && <Button size="sm" variant="secondary" icon={Plus} onClick={() => setRecording(true)}>Record consent</Button>}>
      {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={q.refetch} /> : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge color={s?.status === 'consented' ? 'green' : s?.status === 'revoked' ? 'red' : 'gray'}>
              {s?.status === 'consented' ? 'Consented' : s?.status === 'revoked' ? 'Revoked' : 'Not consented'}
            </Badge>
            {s?.status === 'consented' && <span className="text-fg-2">{channelsText(s.channels)} · since {date(s.since)}</span>}
          </div>
          {!items.length ? (
            <p className="text-sm text-muted">No consent on file. Automated calls and texts need the carrier&apos;s consent first. Ask for it on the agreement link, or record one the carrier gave you in writing or on a recorded call.</p>
          ) : (
            <ul className="space-y-2">
              {items.map((c) => (
                <li key={c.id} className="space-y-1 rounded-lg border border-line px-3 py-2 text-[13px]">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium tabular">{c.phoneDisplay}</span>
                    <span className="text-fg-2">{channelsText(c.channels)}</span>
                    <Badge color={c.active ? 'green' : 'gray'}>{c.active ? 'Active' : 'Revoked'}</Badge>
                  </div>
                  <p className="text-xs text-muted">
                    {SOURCE_TEXT[c.source] || c.source} · {dateTime(c.grantedAt)}{c.grantedByName ? ` · ${c.grantedByName}` : ''}
                  </p>
                  {c.note && <p className="whitespace-pre-wrap break-words text-xs text-fg-2">{c.note}</p>}
                  {c.revokedAt && <p className="text-xs text-muted">Revoked {dateTime(c.revokedAt)}{c.revokeReason ? `: ${c.revokeReason}` : ''}</p>}
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    <Button size="sm" variant="ghost" icon={FileText} href={proofUrl(c.id)} target="_blank" rel="noopener noreferrer">View proof</Button>
                    {/* Anyone who can see the carrier may record an opt-out. */}
                    {c.active && <Button size="sm" variant="ghost" icon={Ban} onClick={() => setRevoking(c)}>Revoke</Button>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {recording && <RecordConsentModal carrier={carrier} onClose={() => setRecording(false)} />}
      {revoking && <RevokeConsentModal consent={revoking} carrierId={carrier.id} onClose={() => setRevoking(null)} />}
    </Card>
  );
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** A consent the carrier gave outside the app. The note on how it was obtained is required. */
export function RecordConsentModal({ carrier, onClose }) {
  const primary = carrier.contacts?.find((c) => c.isPrimary) || carrier.contacts?.[0];
  const [f, setF] = useState(() => ({
    phone: carrier.phone || primary?.phone || '', sms: true, voice: true, name: primary?.name || '', day: today(), note: '', proofDocumentId: '',
  }));
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const digits = usPhone(f.phone);
  const channels = [f.sms && 'sms', f.voice && 'voice'].filter(Boolean);

  // Debounced preview of the exact wording that will be stored.
  const [previewKey, setPreviewKey] = useState({ phone: digits, channels: channels.join(',') });
  useEffect(() => {
    const t = setTimeout(() => setPreviewKey({ phone: digits, channels: channels.join(',') }), 250);
    return () => clearTimeout(t);
  }, [digits, channels.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const wording = useQuery({
    queryKey: ['contact-consents', 'wording', previewKey.phone, previewKey.channels],
    queryFn: () => api.get('/api/contact-consents/wording', { phone: previewKey.phone || '', channels: previewKey.channels }),
    enabled: !!previewKey.channels,
  });
  const docs = useQuery({ queryKey: ['documents', 'carrier', carrier.id], queryFn: () => api.get('/api/documents', { carrierId: carrier.id }) });

  const save = useApiMutation((body) => api.post('/api/contact-consents', body), {
    success: 'Consent recorded', invalidate: [consentsKey(carrier.id), ['carrier', carrier.id]], onSuccess: onClose,
  });
  const noteOk = f.note.trim().length >= 5;
  const ok = !!digits && channels.length > 0 && noteOk && !!f.day && f.day <= today();
  const submit = (e) => {
    e.preventDefault();
    if (!ok) return;
    save.mutate({
      carrierId: carrier.id, phone: digits, channels, note: f.note.trim(), grantedByName: f.name.trim() || null,
      // Today means now; an earlier day is stored at local noon of that day.
      grantedAt: f.day === today() ? null : new Date(`${f.day}T12:00:00`).toISOString(),
      proofDocumentId: f.proofDocumentId || null,
    });
  };

  return (
    <Modal open onClose={onClose} size="md" title="Record consent to calls and texts"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" form="consent-form" loading={save.isPending} disabled={!ok}>Record consent</Button>
      </>}>
      <form id="consent-form" className="space-y-4" onSubmit={submit} noValidate>
        <p className="flex items-start gap-2 rounded-lg border border-c-amber/30 bg-c-amber-soft px-3 py-2 text-[13px] text-c-amber">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>Record only consent the person gave you to this wording, in writing or on a recorded call, and keep the proof. Consent cannot be a condition of your services.</span>
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Phone number" required error={f.phone && !digits ? 'Enter a 10-digit US phone number' : null}>
            <Input type="tel" inputMode="tel" value={f.phone} onChange={set('phone')} maxLength={20} placeholder="(555) 555-0123" />
          </Field>
          <Field label="Person who agreed"><Input value={f.name} onChange={set('name')} maxLength={120} placeholder="Full name" /></Field>
        </div>
        <fieldset className="space-y-1">
          <legend className="mb-1 text-[13px] font-medium">Covers</legend>
          <div className="flex flex-wrap gap-4">
            <Checkbox label="Texts (SMS)" checked={f.sms} onChange={(e) => setF((x) => ({ ...x, sms: e.target.checked }))} />
            <Checkbox label="Calls (voice)" checked={f.voice} onChange={(e) => setF((x) => ({ ...x, voice: e.target.checked }))} />
          </div>
          {!channels.length && <p className="text-xs text-red-600">Pick texts, calls or both</p>}
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date given" required><Input type="date" value={f.day} max={today()} onChange={set('day')} /></Field>
          <Field label="Proof document" hint="Optional. Upload it under Documents first.">
            <Select value={f.proofDocumentId} onChange={set('proofDocumentId')} disabled={!docs.data?.items?.length}>
              <option value="">None</option>
              {(docs.data?.items || []).map((d) => <option key={d.id} value={d.id}>{d.originalName}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="How consent was obtained" required hint="For example: signed paper form on May 3, or said yes on a recorded call.">
          <Textarea rows={3} value={f.note} onChange={set('note')} maxLength={1000} />
        </Field>
        <div className="space-y-1">
          <p className="text-[13px] font-medium">Wording stored with the record</p>
          <p className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] leading-relaxed text-fg-2">
            {wording.data?.text || (wording.isError ? 'Could not load the wording.' : 'Loading…')}
          </p>
        </div>
      </form>
    </Modal>
  );
}

export function RevokeConsentModal({ consent, carrierId, onClose }) {
  const [reason, setReason] = useState('');
  const revoke = useApiMutation(() => api.post(`/api/contact-consents/${encodeURIComponent(consent.id)}/revoke`, { reason: reason.trim() || null }), {
    success: 'Consent revoked', invalidate: [consentsKey(carrierId), ['carrier', carrierId]], onSuccess: onClose,
  });
  return (
    <Modal open onClose={onClose} size="sm" title="Revoke consent?"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate()}>Revoke</Button>
      </>}>
      <div className="space-y-3">
        <p className="text-sm text-fg-2">No automated calls or texts to {consent.phoneDisplay} after this. The record and its proof are kept.</p>
        <Field label="Reason or how they asked" hint="Optional. For example: asked us to stop texting on a call.">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
      </div>
    </Modal>
  );
}
