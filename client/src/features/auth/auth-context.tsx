import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError, session } from '@/lib/api';
import type { AuthResponse, User } from '@/lib/types';

type Status = 'loading' | 'authenticated' | 'anonymous';

export const DEMO_USER = {
  email: 'demo@example.com',
  name: 'Demo Shopper',
  password: 'Password123',
};

interface AuthContextValue {
  user: User | null;
  status: Status;
  login: (email: string, password: string) => Promise<void>;
  register: (input: { name: string; email: string; password: string }) => Promise<void>;
  /** Logs in as the shared demo user, creating the account on first use. */
  loginAsDemo: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<Status>(session.token ? 'loading' : 'anonymous');

  useEffect(
    () =>
      session.subscribe((token) => {
        if (token) return;
        setUser(null);
        setStatus('anonymous');
        queryClient.clear();
      }),
    [queryClient],
  );

  // Validate a stored token after a reload.
  useEffect(() => {
    if (!session.token) return;
    const controller = new AbortController();
    api<{ user: User }>('/auth/me', { signal: controller.signal })
      .then((res) => {
        setUser(res.user);
        setStatus('authenticated');
      })
      .catch(() => {
        if (!controller.signal.aborted) session.set(null);
      });
    return () => controller.abort();
  }, []);

  const finish = useCallback((res: AuthResponse) => {
    session.set(res.token);
    setUser(res.user);
    setStatus('authenticated');
  }, []);

  const login = useCallback(
    async (email: string, password: string) =>
      finish(await api<AuthResponse>('/auth/login', { method: 'POST', body: { email, password } })),
    [finish],
  );

  const register = useCallback(
    async (input: { name: string; email: string; password: string }) =>
      finish(await api<AuthResponse>('/auth/register', { method: 'POST', body: input })),
    [finish],
  );

  const loginAsDemo = useCallback(async () => {
    try {
      await login(DEMO_USER.email, DEMO_USER.password);
    } catch (err) {
      // No seed script is needed: the demo account is created the first time it is used.
      if (!(err instanceof ApiError) || err.status !== 401) throw err;
      await register(DEMO_USER);
    }
  }, [login, register]);

  const logout = useCallback(() => session.set(null), []);

  const value = useMemo(
    () => ({ user, status, login, register, loginAsDemo, logout }),
    [user, status, login, register, loginAsDemo, logout],
  );
  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth() {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
