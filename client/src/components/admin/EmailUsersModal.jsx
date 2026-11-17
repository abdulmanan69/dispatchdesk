import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useToast } from '../Toast.jsx';
import { Modal } from '../Modal.jsx';
import { Button, Field, Input, Textarea } from '../ui.jsx';

/**
 * Email the selected users from the platform address (the same sender as sign-in emails). Each user gets their own
 * email that starts with "Hi <name>,". Replies go to the support email set in System settings.
 */
export default function EmailUsersModal({ users, onClose, onDone }) {
  const toast = useToast();
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const send = useApiMutation((body) => api.post('/api/admin/users/email', body), {
    onSuccess: (d) => {
      const failed = d.failed?.length ? ` ${d.failed.length} not sent: ${d.failed[0].reason}` : '';
      if (d.sent) toast.success(`Email sent to ${d.sent} user${d.sent === 1 ? '' : 's'}.${failed}`);
      else toast.error(`No email was sent.${failed}`);
      if (d.sent) { onDone?.(); onClose(); }
    },
  });
  const who = users.length === 1 ? users[0].name : `${users.length} users`;
  const ready = subject.trim() && message.trim() && users.length;

  return (
    <Modal open onClose={onClose} title={`Email ${who}`} size="md"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={!ready} loading={send.isPending}
          onClick={() => send.mutate({ userIds: users.map((u) => u.id), subject: subject.trim(), message: message.trim() })}>Send email</Button></>}>
      <div className="space-y-4">
        <p className="text-sm text-fg-2">Sent from the platform address, one email per person, starting with "Hi" and their name. Replies go to the support email.</p>
        <p className="max-h-20 overflow-y-auto text-xs text-muted">{users.map((u) => u.email).join(', ')}</p>
        <Field label="Subject">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={150} placeholder="Welcome to DispatchDesk" />
        </Field>
        <Field label="Message" hint="Leave a blank line between paragraphs">
          <Textarea rows={7} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={5000} />
        </Field>
      </div>
    </Modal>
  );
}
