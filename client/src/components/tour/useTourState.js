import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';

const LOCAL_KEY = 'dd.tours';
const readLocal = () => { try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}'); } catch { return {}; } };
const writeLocal = (s) => { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ } };

/** Tour state from the server, with a localStorage fallback when the request fails. Kept apart from driver.js. */
export function useTourState() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['tours'],
    queryFn: async ({ signal }) => {
      try { return (await api.get('/api/tours', undefined, { signal })).state || {}; } catch { return readLocal(); }
    },
    staleTime: Infinity,
  });
  const record = useCallback(async (id, status) => {
    const next = { ...(qc.getQueryData(['tours']) || {}), [id]: { [status]: true, at: new Date().toISOString() } };
    qc.setQueryData(['tours'], next);
    writeLocal(next);
    try { await api.post(`/api/tours/${id}`, { status }); } catch { /* kept locally */ }
  }, [qc]);
  return { state: query.data, loaded: query.isSuccess, record };
}
