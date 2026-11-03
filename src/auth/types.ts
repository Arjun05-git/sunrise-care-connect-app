export type Role = 'patient' | 'doctor' | 'coordinator' | 'admin' | 'finance';
export const STAFF_ROLES: Role[] = ['admin', 'coordinator', 'finance'];

export interface AuthUser {
  id: string;
  role: Role;
  name: string;
  phone: string | null;
  email: string | null;
}

export interface Session {
  user: AuthUser;
  /** Staff: TOTP (aal2) still needed before the console opens (/mfa). Always false in demo mode. */
  stepUpPending: boolean;
  issuedAt: string;
}

/**
 * Auth backend contract. Demo implementation now; a Supabase implementation
 * (phone OTP, email + password + TOTP) plugs in later without UI changes.
 */
export interface AuthService {
  readonly mode: 'demo' | 'supabase';
  requestOtp(phone: string): Promise<{ retryAfterSec: number }>;
  verifyOtp(phone: string, code: string, intendedRole: 'patient' | 'doctor'): Promise<Session>;
  signInWithPassword(email: string, password: string): Promise<Session>;
  getSession(): Promise<Session | null>;
  signOut(): Promise<void>;
}

export class AuthError extends Error {
  constructor(public code: 'invalid_phone' | 'invalid_otp' | 'rate_limited' | 'not_a_doctor' | 'invalid_credentials') {
    super(code);
  }
}
