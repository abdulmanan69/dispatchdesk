import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Button, Loading } from '../../components/ui.jsx';
import AuthShell from './AuthShell.jsx';

export default function VerifyEmail() {
  const [params] = useSearchParams();
  const { user, refresh } = useAuth();
  const [state, setState] = useState({ status: 'pending' });
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const token = params.get('token');
    if (!token) { setState({ status: 'error', message: 'This verification link is missing its token.' }); return; }
    api.post('/api/auth/verify-email', { token })
      .then(() => { setState({ status: 'ok' }); refresh(); })
      .catch((e) => setState({ status: 'error', message: e.message }));
  }, [params, refresh]);

  return (
    <AuthShell title="Email verification">
      {state.status === 'pending' && <Loading label="Verifying…" />}
      {state.status === 'ok' && (
        <div className="space-y-4 text-sm">
          <p>Your email address is verified.</p>
          <Button to={user ? '/app' : '/login'} className="w-full">{user ? 'Go to dashboard' : 'Log in'}</Button>
        </div>
      )}
      {state.status === 'error' && (
        <div className="space-y-4 text-sm">
          <p className="text-red-600">{state.message}</p>
          <p className="text-muted">Log in and use “Resend verification email” from the banner to get a fresh link.</p>
          <Button variant="secondary" to={user ? '/app' : '/login'} className="w-full">Continue</Button>
        </div>
      )}
    </AuthShell>
  );
}
