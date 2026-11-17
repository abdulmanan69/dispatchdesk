import { useQuery } from '@tanstack/react-query';
import { api } from './api.js';

/**
 * Public site info: the support email and the optional parts switched in Admin → System settings
 * ({ marketplace, trainingProgram }). Until it loads, optional parts count as off.
 */
export function useSite() {
  const q = useQuery({ queryKey: ['public', 'site'], queryFn: () => api.get('/api/public/site'), staleTime: 60_000 });
  return { loading: q.isLoading, supportEmail: q.data?.supportEmail || null, features: q.data?.features || { marketplace: false, trainingProgram: false } };
}
