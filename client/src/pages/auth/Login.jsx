import { useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../../context/AuthContext.jsx';
import { Button, Field, Input, PasswordInput } from '../../components/ui.jsx';
import { authErrorMessage, emailError, fieldErrorsFrom } from '../../lib/validation.js';
import AuthShell, { FormError, GoogleSignIn, googleErrorMessage, safeNext } from './AuthShell.jsx';

const check = { email: emailError, password: (v) => (v ? '' : 'Enter your password') };

export default function Login() {
  const { user, login } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [submitted, setSubmitted] = useState(false);
  // A failed Google sign-in comes back as /login?error=google&reason=<code>.
  const [error, setError] = useState(() => (params.get('error') === 'google' ? googleErrorMessage(params.get('reason')) : ''));
  const [busy, setBusy] = useState(false);
  const refs = { email: useRef(null), password: useRef(null) };
  const next = safeNext(params.get('next'));

  if (user) return <Navigate to={next} replace />;

  // After the first try, each field re-checks as it is typed in, so its error clears as soon as it is fixed.
  const set = (k) => (e) => {
    const v = e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
    if (submitted || errors[k]) setErrors((x) => ({ ...x, [k]: check[k](v) }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setSubmitted(true);
    setError('');
    const found = { email: check.email(form.email), password: check.password(form.password) };
    setErrors(found);
    const first = ['email', 'password'].find((k) => found[k]);
    if (first) return refs[first].current?.focus();
    setBusy(true);
    try {
      await login(form.email.trim(), form.password);
      navigate(next, { replace: true });
    } catch (err) {
      const fields = fieldErrorsFrom(err);
      if (Object.keys(fields).length) setErrors(fields);
      else setError(authErrorMessage(err));
      if (err.status === 401) { refs.password.current?.focus(); refs.password.current?.select(); }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Log in" subtitle="Welcome back. Your pipeline is waiting."
      footer={<>New here? <Link to={`/register${params.get('next') ? `?next=${encodeURIComponent(next)}` : ''}`} className="font-medium text-brand-700 hover:underline dark:text-brand-300">Create a free account</Link></>}>
      {error && (
        <div className="mb-4">
          <FormError error={error}>
            {/incorrect email or password/i.test(error) && (
              <Link to="/forgot-password" className="font-medium underline">Reset your password</Link>
            )}
          </FormError>
        </div>
      )}
      <GoogleSignIn mode="login" next={next} />
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Email" error={errors.email}>
          <Input ref={refs.email} type="email" inputMode="email" autoComplete="username" autoCapitalize="none" spellCheck={false}
            placeholder="name@company.com" value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Password" error={errors.password}
          aside={<Link to="/forgot-password" className="text-[13px] text-brand-700 hover:underline dark:text-brand-300">Forgot password?</Link>}>
          <PasswordInput ref={refs.password} autoComplete="current-password" value={form.password} onChange={set('password')} />
        </Field>
        <Button type="submit" loading={busy} className="w-full">{busy ? 'Logging in…' : 'Log in'}</Button>
      </form>
    </AuthShell>
  );
}
