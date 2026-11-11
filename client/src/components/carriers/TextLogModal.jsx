import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, ExternalLink, MessageSquare } from 'lucide-react';
import { api } from '../../lib/api.js';
import { phoneFmt } from '../../lib/format.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useToast } from '../Toast.jsx';
import { Modal } from '../Modal.jsx';
import { Button, Checkbox, Field, Textarea } from '../ui.jsx';
import { copyText, openTextLink, textHref } from '../followups/followUpUtils.js';
import TemplatePicker from '../templates/TemplatePicker.jsx';
import { fieldList } from '../templates/templateApi.js';
import { smsInfo } from '../templates/merge.js';

/**
 * Text a carrier or driver with your own messaging app (Google Voice when that is your provider, otherwise the
 * phone's SMS app), then log it here. DispatchDesk does not send texts itself: one click copies the message,
 * opens your app and logs the text, and you press Send there.
 *
 * Props: carrier { id, companyName, phone, doNotCall? }, onClose, initialBody?, loadId?, extra? (merge values such
 * as { track_link }), category? (template filter), onLogged?({ done }), doneOption? { label, defaultChecked }
 * (shows a checkbox, e.g. "Mark the follow-up done"; its value is passed to onLogged), title?.
 */
export default function TextLogModal({ carrier, onClose, initialBody = '', loadId, extra, category, onLogged, doneOption, title }) {
  const toast = useToast();
  const [body, setBody] = useState(initialBody || '');
  const [missing, setMissing] = useState([]);
  const [done, setDone] = useState(doneOption?.defaultChecked ?? true);
  const settings = useQuery({ queryKey: ['telephony', 'settings'], queryFn: () => api.get('/api/telephony/settings'), staleTime: 300000 });
  // Some lists (follow-ups) do not carry the do-not-call flag: look it up before offering to open the messaging app.
  const dncUnknown = carrier.doNotCall === undefined;
  const detail = useQuery({ queryKey: ['carrier', carrier.id], queryFn: () => api.get(`/api/carriers/${carrier.id}`), enabled: dncUnknown, staleTime: 60000 });
  const checking = dncUnknown && detail.isLoading;
  const provider = settings.data?.settings?.provider;
  const gv = provider === 'google_voice';
  const text = body.trim();
  const href = textHref(carrier.phone, provider, gv ? undefined : text);
  const blocked = !!(carrier.doNotCall ?? detail.data?.carrier?.doNotCall);
  const info = smsInfo(text);
  const unfilled = missing.filter((k) => text.includes(`{{${k}}}`));

  const log = useApiMutation((b) => api.post(`/api/carriers/${carrier.id}/texts`, b), {
    success: 'Text logged',
    invalidate: [['carrier', carrier.id], ['carriers']],
    onSuccess: () => { onLogged?.({ done: doneOption ? done : false, body: text }); onClose(); },
  });

  const copy = async () => {
    if (await copyText(text)) toast.success('Message copied');
    else toast.info('Your browser blocked copying. Select the message and copy it.');
  };
  const open = async () => {
    const copied = text ? await copyText(text) : false;
    if (gv) toast.info(copied ? 'Message copied. Paste it in Google Voice and press Send.' : 'Paste the message in Google Voice and press Send.');
    openTextLink(href);
  };
  /** One click: copy, open the messaging app and log the text. */
  const openAndLog = async () => {
    await open();
    log.mutate({ body: text || undefined });
  };

  return (
    <Modal open onClose={onClose} title={title || `Text ${carrier.companyName}`} size="md"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="secondary" loading={log.isPending && !href} disabled={blocked || checking} onClick={() => log.mutate({ body: text || undefined })}>Log only</Button>
        {href && <Button icon={MessageSquare} loading={log.isPending} disabled={blocked || checking || !text} onClick={openAndLog}>{gv ? 'Copy, open Google Voice and log' : 'Open messaging app and log'}</Button>}
      </>}>
      <div className="space-y-3">
        {blocked && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-900/20 dark:text-red-300">Do-not-call is on for this carrier. Texts are blocked too.</p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-fg-2">{carrier.phone ? <>To <span className="tabular text-fg">{phoneFmt(carrier.phone)}</span></> : 'No phone number on file'}</span>
          {!blocked && (
            <TemplatePicker channel="sms" carrierId={carrier.id} loadId={loadId} extra={extra} category={category} align="right"
              onPick={(r) => { setBody(r.body || ''); setMissing(r.unresolved || []); }} />
          )}
        </div>
        <Field label="Message" hint={`${info.chars} characters${info.segments > 1 ? ` · ${info.segments} texts` : ''}${info.unicode ? ' · contains special characters' : ''}`}>
          <Textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} maxLength={1000} disabled={blocked}
            placeholder="Hi, this is … with … dispatch. Do you have a minute to talk about keeping your truck loaded?" />
        </Field>
        {unfilled.length > 0 && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            Fill in {fieldList(unfilled)} before you send. There was no value for {unfilled.length === 1 ? 'it' : 'them'} here.
          </p>
        )}
        {href ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" icon={Copy} disabled={!text} onClick={copy}>Copy</Button>
            <Button size="sm" variant="ghost" icon={ExternalLink} disabled={blocked || checking} onClick={open}>{gv ? 'Open Google Voice' : 'Open messaging app'}</Button>
          </div>
        ) : !blocked && <p className="text-sm text-muted">Add a phone number to the carrier to open your messaging app from here. You can still log a text.</p>}
        {doneOption && <Checkbox label={doneOption.label} checked={done} onChange={(e) => setDone(e.target.checked)} />}
        <p className="text-xs text-muted">Nothing is sent from DispatchDesk. You press Send in {gv ? 'Google Voice' : 'your messaging app'}.</p>
      </div>
    </Modal>
  );
}
