import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../../lib/api.js';
import { Button, Field, Input } from '../../components/ui.jsx';
import AuthShell, { FormError } from './AuthShell.jsx';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await api.post('/api/auth/forgot-password', { email });
      setDone(r);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a link to choose a new password."
      footer={<Link to="/login" className="font-medium text-brand-700 hover:underline dark:text-brand-300">Back to log in</Link>}>
      {done ? (
        <div className="space-y-3 text-sm">
          <p>{done.message}</p>
          <p className="text-muted">The link expires in one hour. Check your spam folder if it doesn't arrive.</p>
          {done.devToken && (
            <p className="rounded-md bg-surface-2 p-2 text-xs">Development mode: <Link className="underline" to={`/reset-password?token=${done.devToken}`}>open reset link</Link></p>
          )}
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <FormError error={error} />
          <Field label="Email"><Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button type="submit" loading={busy} className="w-full">Send reset link</Button>
        </form>
      )}
    </AuthShell>
  );
}
