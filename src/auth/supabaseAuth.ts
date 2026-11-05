import type { SupabaseClient, User } from '@supabase/supabase-js';
import { AuthError, STAFF_ROLES, type AuthService, type Role, type Session } from './types';
import { INDIAN_MOBILE } from './phone';

const ROLE_ORDER: Role[] = ['admin', 'finance', 'coordinator', 'doctor', 'patient'];

/**
 * Supabase Auth: phone OTP for patients & doctors, email + password for staff.
 * The role comes from `user_roles` (read under RLS), never from client-editable metadata.
 * OTP rate limits are enforced by Supabase Auth (GoTrue) on the server.
 */
export class SupabaseAuthService implements AuthService {
  readonly mode = 'supabase' as const;
  constructor(private sb: SupabaseClient) {}

  async requestOtp(phone: string) {
    if (!INDIAN_MOBILE.test(phone)) throw new AuthError('invalid_phone');
    const { error } = await this.sb.auth.signInWithOtp({ phone });
    if (error) throw mapError(error);
    return { retryAfterSec: 30 };
  }

  async verifyOtp(phone: string, code: string, intendedRole: 'patient' | 'doctor') {
    const { data, error } = await this.sb.auth.verifyOtp({ phone, token: code, type: 'sms' });
    if (error || !data.user) throw error ? mapError(error) : new AuthError('invalid_otp');
    const s = await this.toSession(data.user);
    const ok = intendedRole === 'doctor' ? s.user.role === 'doctor' : s.user.role === 'patient';
    if (!ok) {
      await this.sb.auth.signOut();
      throw new AuthError(intendedRole === 'doctor' ? 'not_a_doctor' : 'invalid_credentials');
    }
    return s;
  }

  async signInWithPassword(email: string, password: string) {
    const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error || !data.user) throw error ? mapError(error) : new AuthError('invalid_credentials');
    const s = await this.toSession(data.user);
    if (!STAFF_ROLES.includes(s.user.role)) {
      await this.sb.auth.signOut();
      throw new AuthError('invalid_credentials');
    }
    return s;
  }

  async getSession() {
    const { data } = await this.sb.auth.getSession();
    if (!data.session) return null;
    // Opened offline (installed app): the role can't be checked, so wait for the connection (the shell shows
    // the offline banner) rather than sending a signed-in user to the login screen.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) await new Promise((r) => window.addEventListener('online', r, { once: true }));
    return this.toSession(data.session.user).catch(() => null);
  }

  async signOut() {
    await this.sb.auth.signOut();
  }

  /** aal2 still missing: the user has a verified factor, or staff MFA is required (setting missing = required). */
  private async staffNeedsMfa(): Promise<boolean> {
    const { data: aal } = await this.sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel === 'aal2') return false;
    if (aal?.nextLevel === 'aal2') return true;
    const { data } = await this.sb.from('app_settings').select('value').eq('key', 'staff_mfa_required').maybeSingle();
    return data?.value !== false;
  }

  private async toSession(user: User, attempt = 0): Promise<Session> {
    const [roles, profile] = await Promise.all([
      this.sb.from('user_roles').select('role').eq('user_id', user.id),
      this.sb.from('profiles').select('full_name').eq('id', user.id).maybeSingle(),
    ]);
    // Never guess a role: if the lookup fails, retry once, then treat the session as unusable.
    if (roles.error || profile.error) {
      if (attempt === 0) return this.toSession(user, 1);
      throw new AuthError('invalid_credentials');
    }
    const have = new Set((roles.data ?? []).map((r) => r.role as Role));
    const role = ROLE_ORDER.find((r) => have.has(r));
    if (!role) throw new AuthError('invalid_credentials');
    return {
      user: { id: user.id, role, name: profile.data?.full_name ?? '', phone: user.phone ? `+${user.phone.replace(/^\+/, '')}` : null, email: user.email ?? null },
      // Staff need a TOTP code (aal2) before the console opens; the database refuses staff RPCs without it.
      stepUpPending: STAFF_ROLES.includes(role) ? await this.staffNeedsMfa() : false,
      issuedAt: new Date().toISOString(),
    };
  }
}

function mapError(e: { status?: number; message?: string; code?: string }): AuthError {
  if (e.status === 429 || /rate|too many|seconds/i.test(e.message ?? '')) return new AuthError('rate_limited');
  if (/invalid login|credentials/i.test(e.message ?? '')) return new AuthError('invalid_credentials');
  return new AuthError('invalid_otp');
}
