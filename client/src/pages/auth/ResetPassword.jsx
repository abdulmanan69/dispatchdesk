import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { CircleCheck } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Button, Field, PasswordInput } from '../../components/ui.jsx';
import PasswordChecklist from '../../components/account/PasswordChecklist.jsx';
import { authErrorMessage, fieldErrorsFrom, newPasswordError } from '../../lib/validation.js';
import AuthShell, { FormError } from './AuthShell.jsx';

const confirmError = (password, confirm) => (!confirm ? 'Type the new password again' : confirm !== password ? 'The passwords do not match' : '');

export default function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [form, setForm] = useState({ password: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const refs = { password: useRef(null), confirm: useRef(null) };

  const validate = (f) => ({ password: newPasswordError(f.password), confirm: confirmError(f.password, f.confirm) });
  const set = (k) => (e) => {
    const f = { ...form, [k]: e.target.value };
    setForm(f);
    if (submitted) setErrors(validate(f));
  };

  const submit = async (e) => {
    e.preventDefault();
    setSubmitted(true);
    setError('');
    const found = validate(form);
    setErrors(found);
    const first = ['password', 'confirm'].find((k) => found[k]);
    if (first) return refs[first].current?.focus();
    setBusy(true);
    try {
      await api.post('/api/auth/reset-password', { token, password: form.password });
      setDone(true);
    } catch (err) {
      const fields = fieldErrorsFrom(err);
      if (fields.password) setErrors({ password: fields.password });
      else if (err.status === 400 && /invalid or has expired/i.test(err.message)) setExpired(true);
      else setError(authErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (!token || expired) {
    return (
      <AuthShell title={expired ? 'This link has expired' : 'This link is incomplete'}
        footer={<Link to="/login" className="font-medium text-brand-700 hover:underline dark:text-brand-300">Back to log in</Link>}>
        <div className="space-y-4 text-sm">
          <p className="text-fg-2">
            {expired
              ? 'Password reset links work for one hour and only once. Request a new link and use the newest email.'
              : 'The link is missing part of its address. Open it again from the email, or request a new one.'}
          </p>
          <Button to="/forgot-password" className="w-full">Request a new link</Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password">
      {done ? (
        <div className="space-y-4 text-sm" role="status">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-c-green-soft text-c-green"><CircleCheck className="size-[18px]" aria-hidden /></span>
            <p className="font-medium text-fg">Password changed</p>
          </div>
          <p className="text-fg-2">You were signed out on every device. Log in with your new password.</p>
          <Button to="/login" className="w-full">Log in</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error && <FormError error={error} />}
          <Field label="New password" error={errors.password}>
            <PasswordInput ref={refs.password} autoComplete="new-password" aria-describedby="password-rules" value={form.password} onChange={set('password')} />
          </Field>
          <PasswordChecklist id="password-rules" password={form.password} className="-mt-2" />
          <Field label="Confirm new password" error={errors.confirm}>
            <PasswordInput ref={refs.confirm} autoComplete="new-password" value={form.confirm} onChange={set('confirm')} />
          </Field>
          <Button type="submit" loading={busy} className="w-full">{busy ? 'Saving…' : 'Update password'}</Button>
        </form>
      )}
    </AuthShell>
  );
}
