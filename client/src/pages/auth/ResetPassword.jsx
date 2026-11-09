import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../../lib/api.js';
import { Button, Field, Input } from '../../components/ui.jsx';
import AuthShell, { FormError } from './AuthShell.jsx';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (password !== confirm) return setError('Passwords do not match.');
    setBusy(true);
    try {
      await api.post('/api/auth/reset-password', { token, password });
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return <AuthShell title="Invalid link"><p className="text-sm text-muted">This reset link is missing its token. <Link to="/forgot-password" className="underline">Request a new one</Link>.</p></AuthShell>;
  }

  return (
    <AuthShell title="Choose a new password">
      {done ? (
        <div className="space-y-4 text-sm">
          <p>Your password was changed. All other sessions were signed out.</p>
          <Button to="/login" className="w-full">Log in</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <FormError error={error} />
          <Field label="New password" hint="At least 8 characters, including a letter and a number."><Input type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Field label="Confirm password"><Input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
          <Button type="submit" loading={busy} className="w-full">Update password</Button>
        </form>
      )}
    </AuthShell>
  );
}
