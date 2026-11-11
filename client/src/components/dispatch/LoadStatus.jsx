import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { label } from '../../lib/format.js';
import { Select, cx } from '../ui.jsx';
import { useConfirm } from '../Modal.jsx';
import { useToast } from '../Toast.jsx';
import { LOAD_STATUSES } from './calc.js';

/**
 * Status change with the same side effects as the fleet board (POST /api/loads/:id/status): the truck moves, the
 * timeline records it, and missing paperwork (rate con once booked, POD once delivered) is pointed out.
 * Moving a load backwards asks first.
 */
export function useLoadStatus(load) {
  const confirm = useConfirm();
  const toast = useToast();
  return useApiMutation(async (status) => {
    try {
      return await api.post(`/api/loads/${load.id}/status`, { status });
    } catch (err) {
      if (err.status === 409 && err.details?.code === 'CONFIRM_STATUS') {
        if (await confirm({ title: 'Change status?', message: err.message, confirmLabel: 'Change status' })) return api.post(`/api/loads/${load.id}/status`, { status, force: true });
        return { canceled: true };
      }
      throw err;
    }
  }, {
    invalidate: [['loads'], ['broker'], ['customer'], ['load', load.id], ['fleet']],
    onSuccess: (d) => {
      if (!d || d.canceled) return;
      const missing = d.paperwork?.missing || [];
      const docsHref = `/app/loads?load=${load.id}&tab=documents`;
      if (missing.includes('pod')) toast.info(`Load marked ${label(d.load.status)}. No POD on file yet.`, { action: { label: 'Upload POD', href: docsHref } });
      else if (missing.includes('rate_confirmation')) toast.info(`Load marked ${label(d.load.status)}. No rate con on file yet.`, { action: { label: 'Upload rate con', href: docsHref } });
      else toast.success(`Load marked ${label(d.load.status)}`);
    },
  });
}

export function LoadStatusSelect({ load, className }) {
  const update = useLoadStatus(load);
  return (
    <Select aria-label="Load status" value={load.status} disabled={update.isPending} onClick={(e) => e.stopPropagation()} onChange={(e) => update.mutate(e.target.value)}
      className={cx('h-7 w-32 text-xs', className)}>
      {LOAD_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
    </Select>
  );
}
