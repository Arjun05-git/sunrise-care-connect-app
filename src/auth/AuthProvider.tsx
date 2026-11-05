import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthService, Session } from './types';
import { createAuthService } from './createAuthService';
import { disableNativePush } from '@/lib/native';

interface AuthCtx {
  session: Session | null;
  loading: boolean;
  service: AuthService;
  /** Call after a successful sign-in so guards re-evaluate. */
  setSession: (s: Session | null) => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children, service }: { children: ReactNode; service?: AuthService }) {
  const svc = useMemo(() => service ?? createAuthService(), [service]);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void svc
      .getSession()
      .catch(() => null)
      .then((s) => {
        setSession(s);
        setLoading(false);
      });
  }, [svc]);

  const signOut = useCallback(async () => {
    // In the app, stop push to this phone for the account that is leaving (needs the session, so first).
    await disableNativePush().catch(() => undefined);
    await svc.signOut();
    setSession(null);
  }, [svc]);

  return <Ctx.Provider value={{ session, loading, service: svc, setSession, signOut }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('AuthProvider missing');
  return c;
}
