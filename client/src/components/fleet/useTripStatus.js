import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useConfirm } from '../Modal.jsx';
import { useToast } from '../Toast.jsx';
import { TRIP_STATUS } from './fleetApi.js';

/** Toast after a trip status change: the paperwork the new status needs (rate con once booked, POD once delivered). */
export function statusToast(d) {
  const now = TRIP_STATUS[d.trip.status]?.label.toLowerCase() || String(d.trip.status).replace(/_/g, ' ');
  const missing = d.paperwork?.missing || [];
  const href = `/app/loads?load=${d.trip.id}&tab=documents`;
  if (missing.includes('pod')) return { type: 'info', message: `Trip is now ${now}. No POD on file yet.`, action: { label: 'Upload POD', href } };
  if (missing.includes('rate_confirmation')) return { type: 'info', message: `Trip is now ${now}. No rate con on file yet.`, action: { label: 'Upload rate con', href } };
  return { type: 'success', message: `Trip is now ${now}` };
}

/**
 * Move a fleet trip to another status (POST /api/fleet/trips/:id/status) with the same rules as the Loads page: moving
 * back, reopening or canceling a delivered trip asks first (409 CONFIRM_STATUS, then force), and paperwork the new status
 * needs is pointed out with a link to the load's documents. mutate({ id, status }).
 */
export function useTripStatus() {
  const confirm = useConfirm();
  const toast = useToast();
  return useApiMutation(async ({ id, status }) => {
    try {
      return await api.post(`/api/fleet/trips/${id}/status`, { status });
    } catch (err) {
      if (err.status === 409 && err.details?.code === 'CONFIRM_STATUS') {
        const ok = await confirm({ title: 'Change trip status?', message: err.message, confirmLabel: 'Change status' });
        return ok ? api.post(`/api/fleet/trips/${id}/status`, { status, force: true }) : { canceled: true };
      }
      throw err;
    }
  }, {
    invalidate: [['fleet'], ['loads'], ['today']],
    onSuccess: (d) => {
      if (!d?.trip) return;
      const t = statusToast(d);
      toast[t.type](t.message, t.action ? { action: t.action } : undefined);
    },
  });
}
