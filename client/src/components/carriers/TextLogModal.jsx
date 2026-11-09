import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { Modal } from '../Modal.jsx';
import { Button, Field, Textarea } from '../ui.jsx';
import { textHref } from '../followups/followUpUtils.js';

/**
 * Text a carrier with your own messaging app (Google Voice when that is your provider, otherwise the
 * phone's SMS app), then log it here. DispatchDesk does not send texts itself.
 */
export default function TextLogModal({ carrier, onClose }) {
  const [body, setBody] = useState('');
  const settings = useQuery({ queryKey: ['telephony', 'settings'], queryFn: () => api.get('/api/telephony/settings'), staleTime: 300000 });
  const provider = settings.data?.settings?.provider;
  const href = textHref(carrier.phone, provider);
  const log = useApiMutation((b) => api.post(`/api/carriers/${carrier.id}/texts`, b), {
    success: 'Text logged',
    invalidate: [['carrier', carrier.id], ['carriers']],
    onSuccess: onClose,
  });
  const open = async () => {
    if (body.trim()) { try { await navigator.clipboard.writeText(body.trim()); } catch { /* clipboard blocked */ } }
    window.open(href, provider === 'google_voice' ? '_blank' : '_self', 'noopener');
  };
  return (
    <Modal open onClose={onClose} title={`Text ${carrier.companyName}`} size="sm"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={log.isPending} onClick={() => log.mutate({ body: body.trim() || undefined })}>Log text</Button>
      </>}>
      <div className="space-y-3">
        {carrier.doNotCall && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-900/20 dark:text-red-300">Do-not-call is on for this carrier.</p>}
        <Field label="Message" hint="Copied to your clipboard when you open your messaging app">
          <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} maxLength={1000} placeholder="Hi, this is … with … dispatch. Do you have a minute to talk about keeping your truck loaded?" />
        </Field>
        {href ? (
          <Button variant="secondary" icon={ExternalLink} onClick={open} disabled={carrier.doNotCall}>
            {provider === 'google_voice' ? 'Open in Google Voice' : 'Open messaging app'}
          </Button>
        ) : <p className="text-sm text-muted">No phone number on file.</p>}
      </div>
    </Modal>
  );
}
