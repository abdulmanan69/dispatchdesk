import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../../context/AuthContext.jsx';
import { Button, Field, Input } from '../../components/ui.jsx';
import AuthShell, { FormError, safeNext } from './AuthShell.jsx';

export default function Login() {
  const { user, login } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const next = safeNext(params.get('next'));

  if (user) return <Navigate to={next} replace />;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email, password);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Log in" subtitle="Welcome back. Your pipeline is waiting."
      footer={<>New here? <Link to={`/register${params.get('next') ? `?next=${encodeURIComponent(next)}` : ''}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">Create a free account</Link></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError error={error} />
        <Field label="Email"><Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <div className="flex justify-end">
          <Link to="/forgot-password" className="text-[13px] text-brand-700 hover:underline dark:text-brand-300">Forgot password?</Link>
        </div>
        <Button type="submit" loading={busy} className="w-full">Log in</Button>
      </form>
    </AuthShell>
  );
}
