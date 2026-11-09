import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../components/Toast.jsx';

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
      else toast.error(err);
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
