import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { MailCheck } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Button, Field, Input } from '../../components/ui.jsx';
import { authErrorMessage, emailError, fieldErrorsFrom } from '../../lib/validation.js';
import AuthShell, { FormError } from './AuthShell.jsx';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(null);
  const [fieldError, setFieldError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  const submit = async (e) => {
    e.preventDefault();
    setSubmitted(true);
    setError('');
    const problem = emailError(email);
    setFieldError(problem);
    if (problem) return ref.current?.focus();
    setBusy(true);
    try {
      const r = await api.post('/api/auth/forgot-password', { email: email.trim() });
      setDone({ ...r, email: email.trim() });
    } catch (err) {
      const fields = fieldErrorsFrom(err);
      if (fields.email) setFieldError(fields.email);
      else setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a link to choose a new password."
      footer={<Link to="/login" className="font-medium text-brand-700 hover:underline dark:text-brand-300">Back to log in</Link>}>
      {done ? (
        <div className="space-y-3 text-sm" role="status">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-c-green-soft text-c-green"><MailCheck className="size-[18px]" aria-hidden /></span>
            <p className="font-medium text-fg">Check your email</p>
          </div>
          <p className="text-fg-2">If an account exists for <span className="font-medium text-fg">{done.email}</span>, we sent a link to reset its password.</p>
          <p className="text-muted">The link works for one hour. Check your spam folder if it doesn't arrive in a few minutes.</p>
          <Button variant="link" onClick={() => { setDone(null); setSubmitted(false); }}>Use a different email</Button>
          {done.devToken && (
            <p className="rounded-md bg-surface-2 p-2 text-xs">Development mode: <Link className="underline" to={`/reset-password?token=${done.devToken}`}>open reset link</Link></p>
          )}
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error && <FormError error={error} />}
          <Field label="Email" error={fieldError}>
            <Input ref={ref} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false}
              placeholder="name@company.com" value={email}
              onChange={(e) => { setEmail(e.target.value); if (submitted || fieldError) setFieldError(emailError(e.target.value)); }} />
          </Field>
          <Button type="submit" loading={busy} className="w-full">{busy ? 'Sending…' : 'Send reset link'}</Button>
        </form>
      )}
    </AuthShell>
  );
}
