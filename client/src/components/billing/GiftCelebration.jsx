import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import PlanCelebration from './PlanCelebration.jsx';

/**
 * A plan an administrator gifted with "Notify users" on: celebrated once, the first time the user opens the app after
 * it. Closing marks its notification read so it does not show again.
 */
export default function GiftCelebration() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const key = ['billing', 'celebration', user?.id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get('/api/billing/celebration'), enabled: !!user, staleTime: Infinity, retry: false });
  const c = q.data?.celebration;
  if (!c) return null;
  const close = async () => {
    qc.setQueryData(key, { celebration: null });
    try { await api.post(`/api/notifications/${c.notificationId}/read`); } catch { /* shown again next time */ }
    qc.invalidateQueries({ queryKey: ['notifications'] });
    qc.invalidateQueries({ queryKey: ['billing', 'me'] });
  };
  return <PlanCelebration plan={c.plan} headline={c.headline} note={c.note} message={c.message} onClose={close} />;
}
