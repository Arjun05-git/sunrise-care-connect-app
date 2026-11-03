import { config } from '@/lib/config';
import { DemoAuthService } from './demoAuth';
import type { AuthService } from './types';

/**
 * Auth backend for the configured mode. The Supabase implementation (and supabase-js) is loaded on
 * first use, keeping it out of the main bundle.
 */
export function createAuthService(): AuthService {
  if (config.mode !== 'supabase') return new DemoAuthService();
  let loading: Promise<AuthService> | null = null;
  const svc = () =>
    (loading ??= Promise.all([import('./supabaseAuth'), import('@/lib/supabase')]).then(([a, s]) => new a.SupabaseAuthService(s.getSupabase())));
  return {
    mode: 'supabase',
    requestOtp: (phone) => svc().then((s) => s.requestOtp(phone)),
    verifyOtp: (phone, code, role) => svc().then((s) => s.verifyOtp(phone, code, role)),
    signInWithPassword: (email, password) => svc().then((s) => s.signInWithPassword(email, password)),
    getSession: () => svc().then((s) => s.getSession()),
    signOut: () => svc().then((s) => s.signOut()),
  };
}
