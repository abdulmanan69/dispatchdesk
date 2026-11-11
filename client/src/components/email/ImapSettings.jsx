import { useEffect, useState } from 'react';
import { CheckCircle2, Info, XCircle } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { Modal } from '../Modal.jsx';
import { Button, Field, Input, Select, Switch, cx } from '../ui.jsx';
import { relative } from '../../lib/format.js';

const SECURITY = [['ssl', 'SSL/TLS (port 993)'], ['starttls', 'STARTTLS (port 143)']];

/** One line about reply detection for a mailbox card. */
export function imapSummary(a) {
  if (!a.imapSupported) return 'Reply detection needs an app-password connection';
  if (!a.imapEnabled) return 'Reply and bounce detection is off';
  if (a.imapError) return 'Reply detection needs attention';
  return a.imapCheckedAt ? `Inbox checked ${relative(a.imapCheckedAt)}` : 'Inbox not checked yet';
}

function Result({ check }) {
  if (!check) return null;
  return (
    <p role="status" className={cx('flex items-start gap-2 rounded-lg px-3 py-2 text-[13px]', check.ok ? 'bg-c-green-soft text-c-green' : 'bg-c-red-soft text-c-red')}>
      {check.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}
      <span className="min-w-0 break-words">{check.message}</span>
    </p>
  );
}

/**
 * Reply and bounce detection for one mailbox (IMAP, opt-in). The inbox is read without marking anything read;
 * nothing is ever sent from it. Sign-in (OAuth) mailboxes cannot use IMAP, which the dialog says plainly.
 */
export function ImapSettingsModal({ account, onClose }) {
  const [f, setF] = useState(null);
  const [check, setCheck] = useState(null);
  useEffect(() => {
    if (!account) return;
    setCheck(null);
    setF({
      enabled: !!account.imapEnabled,
      host: account.imapHost || '',
      security: account.imapSecure === false ? 'starttls' : 'ssl',
    });
  }, [account]);
  const settings = () => ({ imapHost: f.host.trim(), imapPort: f.security === 'ssl' ? 993 : 143, imapSecure: f.security === 'ssl' });
  const inv = [['email', 'accounts']];
  const test = useApiMutation(() => api.post(`/api/email/accounts/${account.id}/imap/test`, settings()), {
    onSuccess: (d) => setCheck({ ok: true, message: d.message }),
    onError: (e) => setCheck({ ok: false, message: e.message }),
  });
  const save = useApiMutation(() => api.patch(`/api/email/accounts/${account.id}`, { imapEnabled: f.enabled, ...(f.host.trim() ? settings() : {}) }), {
    invalidate: inv,
    success: () => (f.enabled ? 'Reply detection is on' : 'Reply detection is off'),
    onSuccess: onClose,
    onError: (e) => setCheck({ ok: false, message: e.message }),
  });
  const set = (k) => (e) => { setCheck(null); setF((x) => ({ ...x, [k]: e.target.value })); };
  if (!account) return null;
  const supported = account.imapSupported;

  return (
    <Modal open={!!account} onClose={onClose} title="Replies and bounces" size="md"
      footer={supported && f && (<>
        <Button variant="secondary" disabled={!f.host.trim()} loading={test.isPending} onClick={() => test.mutate()}>Test connection</Button>
        <Button loading={save.isPending} disabled={f.enabled && !f.host.trim()} onClick={() => save.mutate()}>Save</Button>
      </>)}>
      {!f ? null : !supported ? (
        <div className="flex items-start gap-3 rounded-xl border border-line bg-surface-2 p-4 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-muted" />
          <p className="text-fg-2">{account.imapNote}</p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-fg-2">
            Every few minutes the app reads new messages in this inbox. A reply from a carrier stops its sequence and shows up as a follow-up.
            A bounced email adds the address to your do-not-email list. Google Voice missed-call, voicemail and text notices are logged on the matching carrier.
            Nothing is marked as read and nothing is sent from the inbox.
          </p>
          <Switch checked={f.enabled} onChange={(v) => { setCheck(null); setF((x) => ({ ...x, enabled: v })); }}
            label={<span className="text-[13px] font-medium">Detect replies and bounces</span>} />
          <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
            <Field label="IMAP server" required={f.enabled}><Input value={f.host} onChange={set('host')} placeholder="imap.example.com" autoComplete="off" /></Field>
            <Field label="Security"><Select value={f.security} onChange={set('security')}>{SECURITY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          </div>
          <p className="text-xs text-muted">Uses the same address and password as sending.</p>
          {account.imapNote && <p className="flex items-start gap-2 text-xs text-muted"><Info className="mt-0.5 size-3.5 shrink-0" />{account.imapNote}</p>}
          {account.imapEnabled && (
            <dl className="grid grid-cols-2 gap-2 rounded-lg border border-line p-3 text-xs">
              <div><dt className="text-muted">Last checked</dt><dd className="mt-0.5 text-sm">{account.imapCheckedAt ? relative(account.imapCheckedAt) : 'Not yet'}</dd></div>
              <div><dt className="text-muted">Status</dt><dd className={cx('mt-0.5 text-sm', account.imapError ? 'text-c-red' : account.imapCheckedAt ? 'text-c-green' : 'text-muted')}>{account.imapError ? 'Error' : account.imapCheckedAt ? 'Working' : 'Waiting for the first check'}</dd></div>
              {account.imapError && <p className="col-span-2 break-words text-c-red">{account.imapError}</p>}
            </dl>
          )}
          <Result check={check} />
        </div>
      )}
    </Modal>
  );
}
