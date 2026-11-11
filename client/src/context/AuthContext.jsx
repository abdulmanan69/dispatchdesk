import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { applyTheme } from './theme.js';
import { onTabMessage, postTabMessage, clearShared } from './tabSync.js';
import { disablePush } from './push.js';

const AuthCtx = createContext(null);

const RETRY_MAX_MS = 30_000;
/** Only a 401 (or 200 { user: null }) means signed out. Network errors, timeouts, 429 and 5xx are temporary. */
const isTransient = (err) => !err || err.status === 0 || err.status === 429 || err.status >= 500 || err.name === 'AbortError';

export function AuthProvider({ children }) {
  const [user, setUserState] = useState(undefined); // undefined = loading, null = signed out
  // While /api/auth/me cannot be reached: { message, retryAt }. The current user (or loading) is kept meanwhile.
  const [connection, setConnection] = useState(null);
  const qc = useQueryClient();
  const userRef = useRef(user);
  const attempt = useRef(0);
  const timer = useRef(null);

  const setUser = useCallback((u) => {
    userRef.current = u;
    setUserState(u);
  }, []);

  const refresh = useCallback(async () => {
    clearTimeout(timer.current);
    try {
      const { user: u } = await api.get('/api/auth/me', undefined, { timeoutMs: 15_000 });
      attempt.current = 0;
      setConnection(null);
      setUser(u || null);
      if (u) applyTheme(u.theme);
      return u || null;
    } catch (err) {
      if (!isTransient(err)) {
        attempt.current = 0;
        setConnection(null);
        setUser(null);
        return null;
      }
      // Keep whatever we had and try again with backoff (1 s, 2 s, 4 s … 30 s), honoring Retry-After.
      const backoff = Math.min(RETRY_MAX_MS, 1000 * 2 ** attempt.current);
      const delay = Math.max(backoff, Math.min(err?.retryAfterMs || 0, RETRY_MAX_MS * 2));
      attempt.current += 1;
      setConnection({ message: err?.status === 429 ? 'Too many requests from this network.' : "Can't reach DispatchDesk.", retryAt: Date.now() + delay });
      timer.current = setTimeout(() => { refresh(); }, delay);
      return userRef.current ?? null;
    }
  }, [setUser]);

  useEffect(() => {
    refresh();
    return () => clearTimeout(timer.current);
  }, [refresh]);

  // A 401 from any API call: the session is gone for every tab.
  useEffect(() => {
    const onUnauthorized = () => {
      if (userRef.current === null) return;
      setUser(null);
      qc.clear();
      clearShared();
      postTabMessage({ type: 'logout' });
    };
    window.addEventListener('dd:unauthorized', onUnauthorized);
    return () => window.removeEventListener('dd:unauthorized', onUnauthorized);
  }, [qc, setUser]);

  // Sign-out or sign-in in another tab.
  useEffect(() => onTabMessage((msg) => {
    if (msg.type === 'logout') {
      if (userRef.current) { qc.clear(); setUser(null); }
    } else if (msg.type === 'login') {
      if (userRef.current?.id !== msg.userId) { qc.clear(); refresh(); }
    }
  }), [qc, refresh, setUser]);

  const retryNow = useCallback(() => { attempt.current = 0; refresh(); }, [refresh]);

  const value = useMemo(() => ({
    user,
    loading: user === undefined,
    connection,
    retryNow,
    setUser: (u) => { setUser(u); if (u) applyTheme(u.theme); },
    refresh,
    can: (perm) => !!user?.permissions?.includes(perm),
    async login(email, password) {
      const { user: u } = await api.post('/api/auth/login', { email, password });
      qc.clear();
      clearShared();
      setUser(u);
      applyTheme(u.theme);
      postTabMessage({ type: 'login', userId: u.id });
      return u;
    },
    async register(data) {
      const res = await api.post('/api/auth/register', data);
      qc.clear();
      clearShared();
      setUser(res.user);
      if (res.user) postTabMessage({ type: 'login', userId: res.user.id });
      return res;
    },
    async logout() {
      // This browser stops receiving this account's push notifications (bounded so sign-out never hangs).
      await Promise.race([disablePush().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
      await api.post('/api/auth/logout').catch(() => {});
      qc.clear();
      clearShared();
      setUser(null);
      postTabMessage({ type: 'logout' });
    },
  }), [user, connection, retryNow, refresh, qc, setUser]);

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
