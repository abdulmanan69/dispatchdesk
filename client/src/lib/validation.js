// Form checks shared by the sign-in, sign-up and password pages. They mirror the server's rules
// (server/src/routes/auth.js), so people see the problem next to the field before anything is sent.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Error for an email field, or '' when it looks right. */
export function emailError(value) {
  const v = String(value || '').trim();
  if (!v) return 'Enter your email address';
  if (!EMAIL.test(v)) return 'Enter a valid email address, like name@company.com';
  return '';
}

/** The password rules, in the order the checklist shows them. */
export const PASSWORD_RULES = [
  { key: 'length', label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { key: 'letter', label: 'A letter', test: (p) => /[A-Za-z]/.test(p) },
  { key: 'number', label: 'A number', test: (p) => /\d/.test(p) },
];

/** Error for a new password, or '' when it meets every rule. */
export function newPasswordError(value) {
  const p = String(value || '');
  if (!p) return 'Enter a password';
  if (p.length > 200) return 'Password must be 200 characters or fewer';
  const missing = PASSWORD_RULES.filter((r) => !r.test(p));
  if (!missing.length) return '';
  if (missing[0].key === 'length') return 'Password must be at least 8 characters';
  return 'Password must include at least one letter and one number';
}

/**
 * Field errors from a failed request: the server lists each problem with its field path
 * ({ path: 'email', message }), so a form can show them next to the right input.
 */
export function fieldErrorsFrom(err) {
  const out = {};
  if (err?.status !== 400 || !Array.isArray(err.details)) return out;
  for (const d of err.details) {
    const key = String(d?.path || '').split('.')[0];
    if (key && d.message && !out[key]) out[key] = d.message;
  }
  return out;
}

/** Message for a failed sign-in, sign-up or password request: plain words for the network and rate-limit cases. */
export function authErrorMessage(err) {
  if (err?.network) return "Can't reach DispatchDesk right now. Check your internet connection and try again.";
  if (err?.timeout) return 'DispatchDesk took too long to answer. Try again in a moment.';
  if (err?.status === 429) {
    const mins = err.retryAfterMs ? Math.max(1, Math.ceil(err.retryAfterMs / 60_000)) : null;
    const base = String(err.message || 'Too many attempts.').replace(/\s*Try again.*$/i, '').replace(/\.?$/, '.');
    return mins ? `${base} Try again in ${mins} minute${mins === 1 ? '' : 's'}.` : `${base} Try again later.`;
  }
  if (err?.status >= 500) return 'Something went wrong on our side. Try again in a moment.';
  return err?.message || 'Something went wrong. Try again.';
}
