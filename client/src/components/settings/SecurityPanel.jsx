import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Monitor, KeyRound } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation, errorToast } from '../../lib/hooks.js';
import { useToast } from '../Toast.jsx';
import { fieldErrorsFrom, newPasswordError } from '../../lib/validation.js';
import PasswordChecklist from '../account/PasswordChecklist.jsx';
import { relative, dateTime } from '../../lib/format.js';
import { Card, Field, Button, Badge, QueryState, IconButton, PasswordInput } from '../ui.jsx';
import { X } from 'lucide-react';
import GoogleLink from '../account/GoogleLink.jsx';

function browserName(ua = '') {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua)) return 'Safari';
  return ua ? ua.slice(0, 40) : 'Unknown client';
}
function osName(ua = '') {
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad/.test(ua)) return 'iOS';
  if (/Linux/.test(ua)) return 'Linux';
  return '';
}

export default function SecurityPanel() {
  const toast = useToast();
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api.get('/api/auth/sessions') });
  const change = useApiMutation((body) => api.post('/api/auth/change-password', body), {
    success: 'Password changed. Other sessions were signed out.', invalidate: [['sessions']],
    onSuccess: () => { setPw({ currentPassword: '', newPassword: '', confirm: '' }); setErrors({}); setSubmitted(false); },
    // A wrong current password or a weak new one is shown next to its field; anything else as a toast.
    onError: (err) => {
      const fields = fieldErrorsFrom(err);
      if (/current password is incorrect/i.test(err?.message || '')) setErrors({ currentPassword: 'That is not your current password' });
      else if (Object.keys(fields).length) setErrors(fields);
      else errorToast(toast, err);
    },
  });
  const revoke = useApiMutation((id) => api.del(`/api/auth/sessions/${id}`), { success: 'Session signed out', invalidate: [['sessions']] });
  const revokeOthers = useApiMutation(() => api.post('/api/auth/sessions/revoke-others'), { success: (d) => `Signed out ${d.revoked} other session(s)`, invalidate: [['sessions']] });

  const validate = (v) => ({
    currentPassword: v.currentPassword ? '' : 'Enter your current password',
    newPassword: newPasswordError(v.newPassword),
    confirm: !v.confirm ? 'Type the new password again' : v.confirm !== v.newPassword ? 'The passwords do not match' : '',
  });
  const setField = (k) => (e) => {
    const v = { ...pw, [k]: e.target.value };
    setPw(v);
    if (submitted) setErrors(validate(v));
  };
  const submit = (e) => {
    e.preventDefault();
    setSubmitted(true);
    const found = validate(pw);
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    change.mutate({ currentPassword: pw.currentPassword, newPassword: pw.newPassword });
  };

  // Google-only accounts have no current password to type: show a short note instead of the change form.
  const googleStatus = useQuery({ queryKey: ['google-link'], queryFn: () => api.get('/api/auth/google/status'), retry: false });

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {googleStatus.data?.hasPassword === false ? (
        <Card title="Password">
          <p className="text-sm text-muted">You sign in with Google and have no password yet. Use Set a password in the Google card to add one.</p>
        </Card>
      ) : (
      <Card title="Change password">
        <form className="space-y-3" onSubmit={submit} noValidate>
          <Field label="Current password" required error={errors.currentPassword}><PasswordInput autoComplete="current-password" value={pw.currentPassword} onChange={setField('currentPassword')} /></Field>
          <Field label="New password" required error={errors.newPassword}><PasswordInput autoComplete="new-password" aria-describedby="password-rules" value={pw.newPassword} onChange={setField('newPassword')} /></Field>
          <PasswordChecklist id="password-rules" password={pw.newPassword} className="-mt-1" />
          <Field label="Confirm new password" required error={errors.confirm}><PasswordInput autoComplete="new-password" value={pw.confirm} onChange={setField('confirm')} /></Field>
          <Button type="submit" icon={KeyRound} loading={change.isPending}>Update password</Button>
        </form>
      </Card>
      )}
      <GoogleLink />
      <Card title="Active sessions" actions={<Button variant="secondary" size="sm" loading={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>Sign out other sessions</Button>} bodyClass="p-0">
        <QueryState query={sessions}>
          {(d) => (
            <ul className="divide-y divide-line">
              {d.items.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                  <Monitor className="size-4 shrink-0 text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{browserName(s.userAgent)} {osName(s.userAgent) && <span className="font-normal text-muted">on {osName(s.userAgent)}</span>} {s.current && <Badge color="green" className="ml-1">This device</Badge>}</p>
                    <p className="text-xs text-muted">{s.ip || 'unknown IP'} · signed in {dateTime(s.createdAt)} · active {relative(s.lastSeenAt)}</p>
                  </div>
                  {!s.current && <IconButton icon={X} label="Sign out this session" onClick={() => revoke.mutate(s.id)} />}
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </Card>
    </div>
  );
}
