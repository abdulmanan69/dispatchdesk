import { useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { AlertCircle } from 'lucide-react';
import { useAuth } from '../../context/AuthContext.jsx';
import { Button, Checkbox, Field, Input, PasswordInput } from '../../components/ui.jsx';
import PasswordChecklist from '../../components/account/PasswordChecklist.jsx';
import { authErrorMessage, emailError, fieldErrorsFrom, newPasswordError } from '../../lib/validation.js';
import AuthShell, { FormError, GoogleSignIn, safeNext } from './AuthShell.jsx';

const ORDER = ['name', 'email', 'phone', 'password', 'acceptTerms'];
const check = {
  name: (v) => (v.trim() ? (v.trim().length > 120 ? 'Name must be 120 characters or fewer' : '') : 'Enter your full name'),
  email: emailError,
  phone: (v) => (v.trim().length > 40 ? 'Phone number must be 40 characters or fewer' : ''),
  password: newPasswordError,
  acceptTerms: (v) => (v ? '' : 'Accept the Terms and Privacy Policy to continue'),
};

export default function Register() {
  const { user, register } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '', acceptTerms: false });
  const [errors, setErrors] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [taken, setTaken] = useState(false);
  const [busy, setBusy] = useState(false);
  const refs = { name: useRef(null), email: useRef(null), phone: useRef(null), password: useRef(null), acceptTerms: useRef(null) };
  const next = safeNext(params.get('next'));
  const loginHref = `/login${params.get('next') ? `?next=${encodeURIComponent(next)}` : ''}`;

  if (user) return <Navigate to={next} replace />;

  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
    if (k === 'email') setTaken(false);
    if (submitted || errors[k]) setErrors((x) => ({ ...x, [k]: check[k](v) }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setSubmitted(true);
    setError('');
    setTaken(false);
    const found = Object.fromEntries(ORDER.map((k) => [k, check[k](form[k])]));
    setErrors(found);
    const first = ORDER.find((k) => found[k]);
    if (first) return refs[first].current?.focus();
    setBusy(true);
    try {
      await register({ ...form, name: form.name.trim(), email: form.email.trim(), phone: form.phone.trim() || undefined });
      navigate(next === '/app' ? '/app?welcome=1' : next, { replace: true });
    } catch (err) {
      const fields = fieldErrorsFrom(err);
      if (err.status === 409) {
        setTaken(true);
        refs.email.current?.focus();
      } else if (Object.keys(fields).length) {
        setErrors(fields);
        const k = ORDER.find((x) => fields[x]);
        if (k) refs[k].current?.focus();
      } else {
        setError(authErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Create your account" subtitle="Free plan includes carrier discovery, CRM and prospecting."
      footer={<>Already have an account? <Link to={loginHref} className="font-medium text-brand-700 hover:underline dark:text-brand-300">Log in</Link></>}>
      <GoogleSignIn mode="register" next={next} />
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <FormError error={error} />}
        <Field label="Full name" required error={errors.name}>
          <Input ref={refs.name} autoComplete="name" value={form.name} onChange={set('name')} />
        </Field>
        <Field label="Email" required
          error={taken
            ? <>An account with this email already exists. <Link to={loginHref} className="font-medium underline">Log in</Link> or <Link to="/forgot-password" className="font-medium underline">reset your password</Link>.</>
            : errors.email}>
          <Input ref={refs.email} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false}
            placeholder="name@company.com" value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Phone" hint="Optional" error={errors.phone}>
          <Input ref={refs.phone} type="tel" autoComplete="tel" value={form.phone} onChange={set('phone')} />
        </Field>
        <Field label="Password" required error={errors.password}>
          <PasswordInput ref={refs.password} autoComplete="new-password" aria-describedby="password-rules" value={form.password} onChange={set('password')} />
        </Field>
        <PasswordChecklist id="password-rules" password={form.password} className="-mt-2" />
        <div className="space-y-1">
          <Checkbox ref={refs.acceptTerms} checked={form.acceptTerms} onChange={set('acceptTerms')}
            aria-invalid={errors.acceptTerms ? true : undefined} aria-describedby={errors.acceptTerms ? 'terms-error' : undefined}
            label={<span className="text-[13px] text-muted">I agree to the <Link to="/terms" className="underline">Terms</Link> and <Link to="/privacy" className="underline">Privacy Policy</Link></span>} />
          {errors.acceptTerms && (
            <p id="terms-error" className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
              <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden /><span>{errors.acceptTerms}</span>
            </p>
          )}
        </div>
        <Button type="submit" loading={busy} className="w-full">{busy ? 'Creating account…' : 'Create account'}</Button>
      </form>
    </AuthShell>
  );
}
