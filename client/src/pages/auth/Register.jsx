import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../../context/AuthContext.jsx';
import { Button, Checkbox, Field, Input } from '../../components/ui.jsx';
import AuthShell, { FormError, safeNext } from './AuthShell.jsx';

export default function Register() {
  const { user, register } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '', acceptTerms: false });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const next = safeNext(params.get('next'));
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  if (user) return <Navigate to={next} replace />;

  const pwOk = form.password.length >= 8 && /[A-Za-z]/.test(form.password) && /\d/.test(form.password);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.acceptTerms) return setError('Please accept the terms to continue.');
    if (!pwOk) return setError('Password needs at least 8 characters with a letter and a number.');
    setBusy(true);
    try {
      await register({ ...form, phone: form.phone || undefined });
      navigate(next === '/app' ? '/app?welcome=1' : next, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Create your account" subtitle="Free plan includes carrier discovery, CRM and prospecting."
      footer={<>Already have an account? <Link to={`/login${params.get('next') ? `?next=${encodeURIComponent(next)}` : ''}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">Log in</Link></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError error={error} />
        <Field label="Full name" required><Input autoComplete="name" value={form.name} onChange={set('name')} /></Field>
        <Field label="Email" required><Input type="email" autoComplete="email" value={form.email} onChange={set('email')} /></Field>
        <Field label="Phone" hint="Optional"><Input type="tel" autoComplete="tel" value={form.phone} onChange={set('phone')} /></Field>
        <Field label="Password" required hint="At least 8 characters, including a letter and a number.">
          <Input type="password" autoComplete="new-password" value={form.password} onChange={set('password')} />
        </Field>
        <Checkbox checked={form.acceptTerms} onChange={set('acceptTerms')} label={<span className="text-[13px] text-muted">I agree to the <Link to="/terms" className="underline">Terms</Link> and <Link to="/privacy" className="underline">Privacy Policy</Link></span>} />
        <Button type="submit" loading={busy} className="w-full">Create account</Button>
      </form>
    </AuthShell>
  );
}
