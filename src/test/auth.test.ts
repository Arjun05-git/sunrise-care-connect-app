import { DemoAuthService, DEMO, createRateLimiter } from '@/auth/demoAuth';
import { guardDecision, homeFor } from '@/auth/guards';
import { AuthError } from '@/auth/types';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

describe('DemoAuthService', () => {
  it('rejects invalid Indian mobile numbers', async () => {
    await expect(new DemoAuthService(memory()).requestOtp('+911234567890')).rejects.toMatchObject({ code: 'invalid_phone' });
  });
  it('rejects a wrong OTP and accepts 123456', async () => {
    const s = new DemoAuthService(memory());
    await expect(s.verifyOtp(DEMO.patientPhone, '000000', 'patient')).rejects.toBeInstanceOf(AuthError);
    const session = await s.verifyOtp(DEMO.patientPhone, DEMO.otp, 'patient');
    expect(session.user.role).toBe('patient');
    expect(await s.getSession()).toMatchObject({ user: { role: 'patient' } });
  });
  it('creates a new patient for an unknown number', async () => {
    const session = await new DemoAuthService(memory()).verifyOtp('+919999912345', DEMO.otp, 'patient');
    expect(session.user).toMatchObject({ role: 'patient', phone: '+919999912345' });
  });
  it('only lets registered doctors use the doctor tab', async () => {
    const s = new DemoAuthService(memory());
    await expect(s.verifyOtp(DEMO.patientPhone, DEMO.otp, 'doctor')).rejects.toMatchObject({ code: 'not_a_doctor' });
    expect((await s.verifyOtp(DEMO.doctorPhone, DEMO.otp, 'doctor')).user.role).toBe('doctor');
  });
  it('signs staff in with email + password and signs out', async () => {
    const s = new DemoAuthService(memory());
    await expect(s.signInWithPassword(DEMO.adminEmail, 'wrong-pass')).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect((await s.signInWithPassword(DEMO.adminEmail, DEMO.password)).user.role).toBe('admin');
    await s.signOut();
    expect(await s.getSession()).toBeNull();
  });
  it('rate-limits OTP requests (5 per 15 minutes)', async () => {
    const s = new DemoAuthService(memory());
    for (let i = 0; i < 5; i++) await s.requestOtp('+919847000099');
    await expect(s.requestOtp('+919847000099')).rejects.toMatchObject({ code: 'rate_limited' });
  });
  it('rate limiter window resets', () => {
    let now = 0;
    const allow = createRateLimiter(1, 1000, () => now);
    expect(allow('k')).toBe(true);
    expect(allow('k')).toBe(false);
    now = 1001;
    expect(allow('k')).toBe(true);
  });
});

describe('role guards', () => {
  const session = (role: 'patient' | 'doctor' | 'admin' | 'finance') => ({ user: { role }, stepUpPending: false });
  it('sends anonymous users to login', () => expect(guardDecision(null, ['patient'])).toEqual({ kind: 'login' }));
  it('allows the right role', () => expect(guardDecision(session('doctor'), ['doctor'])).toEqual({ kind: 'allow' }));
  it('redirects the wrong role to its own home', () => {
    expect(guardDecision(session('patient'), ['doctor'])).toEqual({ kind: 'redirect', to: '/p' });
    expect(guardDecision(session('finance'), ['patient'])).toEqual({ kind: 'redirect', to: '/a' });
  });
  it('sends staff who still need their TOTP code to /mfa, whatever page they asked for', () => {
    expect(guardDecision({ ...session('admin'), stepUpPending: true }, ['admin'])).toEqual({ kind: 'redirect', to: '/mfa' });
    expect(guardDecision({ ...session('finance'), stepUpPending: true }, ['patient'])).toEqual({ kind: 'redirect', to: '/mfa' });
  });
  it('maps homes', () => expect(['patient', 'doctor', 'admin', 'coordinator', 'finance'].map((r) => homeFor(r as never))).toEqual(['/p', '/d', '/a', '/a', '/a']));
});
