import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Monitor, KeyRound } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { relative, dateTime } from '../../lib/format.js';
import { Card, Field, Input, Button, Badge, QueryState, IconButton } from '../ui.jsx';
import { X } from 'lucide-react';

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
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [error, setError] = useState('');
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api.get('/api/auth/sessions') });
  const change = useApiMutation((body) => api.post('/api/auth/change-password', body), {
    success: 'Password changed. Other sessions were signed out.', invalidate: [['sessions']],
    onSuccess: () => setPw({ currentPassword: '', newPassword: '', confirm: '' }),
  });
  const revoke = useApiMutation((id) => api.del(`/api/auth/sessions/${id}`), { success: 'Session signed out', invalidate: [['sessions']] });
  const revokeOthers = useApiMutation(() => api.post('/api/auth/sessions/revoke-others'), { success: (d) => `Signed out ${d.revoked} other session(s)`, invalidate: [['sessions']] });

  const submit = (e) => {
    e.preventDefault();
    setError('');
    if (pw.newPassword !== pw.confirm) return setError('New passwords do not match');
    change.mutate({ currentPassword: pw.currentPassword, newPassword: pw.newPassword });
  };

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="Change password">
        <form className="space-y-3" onSubmit={submit}>
          <Field label="Current password" required><Input type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} required /></Field>
          <Field label="New password" hint="At least 8 characters with a letter and a number" required><Input type="password" autoComplete="new-password" minLength={8} value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} required /></Field>
          <Field label="Confirm new password" error={error} required><Input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required /></Field>
          <Button type="submit" icon={KeyRound} loading={change.isPending}>Update password</Button>
        </form>
      </Card>
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
