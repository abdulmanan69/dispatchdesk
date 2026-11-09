import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { applyTheme } from './theme.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = loading, null = signed out
  const qc = useQueryClient();

  const refresh = useCallback(async () => {
    try {
      const { user: u } = await api.get('/api/auth/me');
      setUser(u);
      if (u) applyTheme(u.theme);
      return u;
    } catch {
      setUser(null);
      return null;
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const onUnauthorized = () => { setUser(null); qc.clear(); };
    window.addEventListener('dd:unauthorized', onUnauthorized);
    return () => window.removeEventListener('dd:unauthorized', onUnauthorized);
  }, [qc]);

  const value = useMemo(() => ({
    user,
    loading: user === undefined,
    setUser: (u) => { setUser(u); if (u) applyTheme(u.theme); },
    refresh,
    can: (perm) => !!user?.permissions?.includes(perm),
    async login(email, password) {
      const { user: u } = await api.post('/api/auth/login', { email, password });
      qc.clear();
      setUser(u);
      applyTheme(u.theme);
      return u;
    },
    async register(data) {
      const res = await api.post('/api/auth/register', data);
      qc.clear();
      setUser(res.user);
      return res;
    },
    async logout() {
      await api.post('/api/auth/logout').catch(() => {});
      qc.clear();
      setUser(null);
    },
  }), [user, refresh, qc]);

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
