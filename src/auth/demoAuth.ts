import { AuthError, type AuthService, type AuthUser, type Session } from './types';

/** Demo credentials – shown on the login screen in demo mode. */
export const DEMO = {
  otp: '123456',
  patientPhone: '+919847000001',
  doctorPhone: '+919847100001',
  adminEmail: 'admin@sunrise.demo',
  password: 'Sunrise@123',
} as const;

const DIRECTORY: AuthUser[] = [
  { id: 'u-patient-1', role: 'patient', name: 'Anjali Menon', phone: DEMO.patientPhone, email: null },
  { id: 'u-doctor-1', role: 'doctor', name: 'Dr. Arun Nair', phone: DEMO.doctorPhone, email: null },
  { id: 'u-admin-1', role: 'admin', name: 'Sunrise Admin', phone: null, email: DEMO.adminEmail },
  { id: 'u-coord-1', role: 'coordinator', name: 'Care Coordinator', phone: null, email: 'coordinator@sunrise.demo' },
  { id: 'u-fin-1', role: 'finance', name: 'Finance Desk', phone: null, email: 'finance@sunrise.demo' },
];

const SESSION_KEY = 'scc-session';
export const INDIAN_MOBILE = /^\+91[6-9]\d{9}$/;

/** Fixed-window limiter (server side this lives in Postgres / the Auth hook). */
export function createRateLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return (key: string) => {
    const t = now();
    const recent = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (recent.length >= max) return false;
    recent.push(t);
    hits.set(key, recent);
    return true;
  };
}

/**
 * Demo auth: OTP is always 123456, unknown numbers become new patients, sessions live in localStorage.
 * Never use in production – VITE_APP_MODE=supabase switches to the real implementation.
 */
export class DemoAuthService implements AuthService {
  readonly mode = 'demo' as const;
  private otpLimiter = createRateLimiter(5, 15 * 60_000);
  private verifyLimiter = createRateLimiter(6, 15 * 60_000);

  constructor(private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage) {}

  async requestOtp(phone: string) {
    if (!INDIAN_MOBILE.test(phone)) throw new AuthError('invalid_phone');
    if (!this.otpLimiter(phone)) throw new AuthError('rate_limited');
    return { retryAfterSec: 30 };
  }

  async verifyOtp(phone: string, code: string, intendedRole: 'patient' | 'doctor') {
    if (!this.verifyLimiter(phone)) throw new AuthError('rate_limited');
    if (code !== DEMO.otp) throw new AuthError('invalid_otp');
    const known = DIRECTORY.find((u) => u.phone === phone);
    if (intendedRole === 'doctor' && known?.role !== 'doctor') throw new AuthError('not_a_doctor');
    const user: AuthUser = known ?? { id: `u-${phone.slice(-10)}`, role: 'patient', name: '', phone, email: null };
    if (intendedRole === 'patient' && user.role !== 'patient') throw new AuthError('invalid_credentials');
    return this.persist(user);
  }

  async signInWithPassword(email: string, password: string) {
    if (!this.verifyLimiter(email)) throw new AuthError('rate_limited');
    const user = DIRECTORY.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (!user || password !== DEMO.password) throw new AuthError('invalid_credentials');
    return this.persist(user);
  }

  async getSession() {
    try {
      const raw = this.storage.getItem(SESSION_KEY);
      return raw ? (JSON.parse(raw) as Session) : null;
    } catch {
      return null;
    }
  }

  async signOut() {
    this.storage.removeItem(SESSION_KEY);
  }

  private persist(user: AuthUser): Session {
    const s: Session = { user, stepUpPending: false, issuedAt: new Date().toISOString() };
    this.storage.setItem(SESSION_KEY, JSON.stringify(s));
    return s;
  }
}
