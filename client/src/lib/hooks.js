import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../components/Toast.jsx';
import { api } from './api.js';

/** Toast for a failed request; plan-limit errors (402) get a "See plans" link to billing. */
export function errorToast(toast, err) {
  const code = err?.details?.code || err?.code;
  if (err?.status === 403 && code === 'EMAIL_UNVERIFIED') {
    // Writes wait for a verified address: offer the link again right from the error.
    const resend = () => api.post('/api/auth/resend-verification')
      .then((r) => (r?.alreadyVerified ? toast.success('Your email is already verified. Reload the page.')
        : r?.emailSent ? toast.success('Verification email sent. Open the link in it, then try again.')
          : toast.error(`Could not send the email: ${r?.reason || 'email is not configured'}`)))
      .catch((e) => toast.error(e));
    toast.error(err, { action: { label: 'Resend link', onClick: resend } });
  } else if (err?.status === 402) toast.error(err, { action: { label: code === 'STORAGE_FULL' ? 'Upgrade or free up space' : 'See plans', href: '/app/billing' } });
  else toast.error(err);
}

/**
 * useMutation + toast + cache invalidation.
 * const save = useApiMutation((body) => api.post('/api/x', body), { success: 'Saved', invalidate: [['x']] });
 */
export function useApiMutation(fn, { success, invalidate = [], onSuccess, onError } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (data, vars) => {
      await Promise.all(invalidate.map((key) => qc.invalidateQueries({ queryKey: key })));
      if (success) toast.success(typeof success === 'function' ? success(data, vars) : success);
      onSuccess?.(data, vars);
    },
    onError: (err, vars) => {
      if (onError) onError(err, vars);
      else errorToast(toast, err);
    },
  });
}

/** Read a form element into a plain object (checkboxes → booleans). */
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else if (el.type !== 'file' && el.type !== 'submit' && el.type !== 'button') out[el.name] = el.value;
  }
  return out;
}
