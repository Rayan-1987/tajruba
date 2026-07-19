import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import type { SessionUser } from './types';

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<{ mfaRequired: boolean; challengeToken?: string }>;
  verifyMfa: (challengeToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ user: SessionUser }>('/auth/me')
      .then((res) => setUser(res.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ ok: true; mfaRequired: boolean; challengeToken?: string }>('/auth/login', { email, password });
    if (res.mfaRequired) {
      return { mfaRequired: true, challengeToken: res.challengeToken };
    }
    const me = await api.get<{ user: SessionUser }>('/auth/me');
    setUser(me.user);
    return { mfaRequired: false };
  }, []);

  const verifyMfa = useCallback(async (challengeToken: string, code: string) => {
    await api.post('/auth/mfa/verify-login', { challengeToken, code });
    const res = await api.get<{ user: SessionUser }>('/auth/me');
    setUser(res.user);
  }, []);

  const logout = useCallback(async () => {
    await api.post('/auth/logout');
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, loading, login, verifyMfa, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export { ApiError };
