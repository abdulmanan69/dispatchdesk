import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useConfirm } from '../Modal.jsx';
import { Card, Button, Badge } from '../ui.jsx';
import GoogleMark from './GoogleMark.jsx';

/**
 * Settings → Security: the Google account used for Continue with Google. Unlinking needs a password first (accounts
 * created with Google get one through the reset-password email). Hidden when Google sign-in is off and nothing is linked.
 */
export default function GoogleLink() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const status = useQuery({ queryKey: ['google-link'], queryFn: () => api.get('/api/auth/google/status') });
  const unlink = useApiMutation(() => api.post('/api/auth/google/unlink'), { success: 'Google account unlinked', invalidate: [['google-link']] });
  const setPassword = useApiMutation(() => api.post('/api/auth/forgot-password', { email: user.email }), {
    success: `We emailed a link to set your password to ${user?.email}.`,
  });
  const d = status.data;
  if (!d || (!d.linked && !d.available)) return null;

  return (
    <Card title="Google sign-in">
      <div className="space-y-3 text-sm">
        <p className="flex items-center gap-2 font-medium">
          <GoogleMark className="size-4 shrink-0" />
          {d.linked ? 'Google account linked' : 'No Google account linked'}
          {d.linked && <Badge color="green">On</Badge>}
        </p>
        {!d.linked && (
          <p className="text-fg-2">To link one, log out and use Continue with Google with {user?.email}.</p>
        )}
        {d.linked && d.hasPassword && (
          <>
            <p className="text-fg-2">You can log in with Continue with Google or with your password.</p>
            <Button variant="secondary" size="sm" loading={unlink.isPending}
              onClick={async () => { if (await confirm({ title: 'Unlink your Google account?', message: 'You will log in with your email and password only.', confirmLabel: 'Unlink', danger: true })) unlink.mutate(); }}>
              Unlink
            </Button>
          </>
        )}
        {d.linked && !d.hasPassword && (
          <>
            <p className="text-fg-2">Your account has no password yet, so Google is the only way to log in. Set a password before you unlink Google.</p>
            {user?.mailConfigured === false
              ? <p className="text-xs text-muted">Platform email is not set up, so the link cannot be sent. Ask an admin.</p>
              : <Button variant="secondary" size="sm" loading={setPassword.isPending} disabled={setPassword.isSuccess} onClick={() => setPassword.mutate()}>Set a password</Button>}
          </>
        )}
      </div>
    </Card>
  );
}
