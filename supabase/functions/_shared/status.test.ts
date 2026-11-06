import { describe, expect, it } from 'vitest';
import { systemStatus, type Mode } from './status';

const envOf = (vars: Record<string, string>) => (k: string) => vars[k];
const mode = (vars: Record<string, string>, id: string, environment: 'demo' | 'production' = 'demo'): Mode | undefined =>
  systemStatus(envOf(vars), environment).providers.find((p) => p.id === id)?.mode;
const warnings = (vars: Record<string, string>, environment: 'demo' | 'production') => systemStatus(envOf(vars), environment).warnings;

describe('payments', () => {
  it('mock gateway when allowed', () => expect(mode({ PAYMENTS_ALLOW_MOCK: 'true' }, 'payments')).toBe('mock'));
  it('mock gateway that is not allowed means payments cannot be taken (unconfigured)', () => {
    const s = systemStatus(envOf({}), 'demo').providers.find((p) => p.id === 'payments')!;
    expect(s.mode).toBe('unconfigured');
    expect(s.detail).toBe('mock_payments_disabled');
  });
  it('Razorpay test keys are a sandbox: no real money', () => expect(mode({ RAZORPAY_KEY_ID: 'rzp_test_abc', RAZORPAY_KEY_SECRET: 's' }, 'payments')).toBe('sandbox'));
  it('Razorpay live keys are live', () => expect(mode({ RAZORPAY_KEY_ID: 'rzp_live_abc', RAZORPAY_KEY_SECRET: 's' }, 'payments')).toBe('live'));
  it('Razorpay without its secret is not set up', () => expect(mode({ RAZORPAY_KEY_ID: 'rzp_live_abc' }, 'payments')).toBe('unconfigured'));
  it('PAYMENTS_PROVIDER=razorpay wins over the mock switch', () => {
    expect(mode({ PAYMENTS_PROVIDER: 'razorpay', PAYMENTS_ALLOW_MOCK: 'true', RAZORPAY_KEY_ID: 'rzp_live_abc', RAZORPAY_KEY_SECRET: 's' }, 'payments')).toBe('live');
  });
});

describe('notifications', () => {
  it('NOTIFY_PROVIDER=mock simulates every channel', () => {
    for (const id of ['whatsapp', 'sms', 'push']) expect(mode({ NOTIFY_PROVIDER: 'mock' }, id), id).toBe('mock');
  });
  it('each channel is live only with its own keys', () => {
    const vars = { WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1' };
    expect(mode(vars, 'whatsapp')).toBe('live');
    expect(mode(vars, 'sms')).toBe('unconfigured');
    expect(mode({ MSG91_AUTH_KEY: 'k' }, 'sms')).toBe('live');
    expect(mode({ WHATSAPP_TOKEN: 't' }, 'whatsapp')).toBe('unconfigured');
  });
  it('push is live with web-push keys or an FCM service account', () => {
    expect(mode({ VAPID_PUBLIC_KEY: 'a', VAPID_PRIVATE_KEY: 'b' }, 'push')).toBe('live');
    expect(mode({ FCM_SERVICE_ACCOUNT: '{}' }, 'push')).toBe('live');
    expect(mode({ VAPID_PUBLIC_KEY: 'a' }, 'push')).toBe('unconfigured');
  });
});

describe('video', () => {
  const lk = { VIDEO_PROVIDER: 'livekit', LIVEKIT_URL: 'wss://x.example.livekit.cloud', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' };
  it('LiveKit with all three settings is live', () => expect(mode(lk, 'video')).toBe('live'));
  it('LiveKit with a missing setting falls back to the public Jitsi sandbox, like the app does', () => {
    expect(mode({ ...lk, LIVEKIT_API_SECRET: '' }, 'video')).toBe('sandbox');
  });
  it('default public Jitsi is a sandbox (a public server)', () => expect(mode({}, 'video')).toBe('sandbox'));
  it('your own Jitsi domain is live', () => expect(mode({ JITSI_DOMAIN: 'meet.hospital.example' }, 'video')).toBe('live'));
});

describe('integrations', () => {
  it('INTEGRATIONS_PROVIDER=mock simulates all three', () => {
    for (const id of ['his', 'leadsquared', 'abdm']) expect(mode({ INTEGRATIONS_PROVIDER: 'mock' }, id), id).toBe('mock');
  });
  it('a configured system is live but flagged as not yet verified against the real system', () => {
    const his = systemStatus(envOf({ HIS_BASE_URL: 'https://his.example', HIS_API_KEY: 'k' }), 'production').providers.find((p) => p.id === 'his')!;
    expect(his.mode).toBe('live');
    expect(his.note).toBe('unverified_adapter');
  });
  it('systems without their keys are not set up', () => {
    for (const id of ['his', 'leadsquared', 'abdm']) expect(mode({}, id), id).toBe('unconfigured');
  });
});

describe('warnings – only a production environment should be fully live', () => {
  const allMock = { PAYMENTS_ALLOW_MOCK: 'true', NOTIFY_PROVIDER: 'mock', INTEGRATIONS_PROVIDER: 'mock' };
  it('a demo environment has no warnings, however much is simulated', () => expect(warnings(allMock, 'demo')).toEqual([]));
  it('production with mocks and the public Jitsi warns about each', () => {
    expect(warnings(allMock, 'production')).toEqual(expect.arrayContaining(['mock:payments', 'mock:whatsapp', 'mock:sms', 'mock:push', 'mock:his', 'sandbox:video']));
  });
  it('production with a test payment gateway warns', () => {
    expect(warnings({ RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 's' }, 'production')).toContain('sandbox:payments');
  });
  it('production without a payment gateway warns that it is not set up', () => {
    expect(warnings({}, 'production')).toContain('unconfigured:payments');
  });
  it('warns about open CORS in production, not when origins are listed', () => {
    expect(warnings({}, 'production')).toContain('open_cors');
    expect(warnings({ ALLOWED_ORIGINS: '*' }, 'production')).toContain('open_cors');
    expect(warnings({ ALLOWED_ORIGINS: 'https://care.example' }, 'production')).not.toContain('open_cors');
  });
  it('a fully live production setup has no warnings', () => {
    const live = {
      RAZORPAY_KEY_ID: 'rzp_live_x', RAZORPAY_KEY_SECRET: 's', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1', MSG91_AUTH_KEY: 'k',
      VAPID_PUBLIC_KEY: 'a', VAPID_PRIVATE_KEY: 'b', VIDEO_PROVIDER: 'livekit', LIVEKIT_URL: 'wss://x', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's',
      ALLOWED_ORIGINS: 'https://care.example',
    };
    expect(warnings(live, 'production')).toEqual([]);
  });
});

describe('what the status may reveal', () => {
  it('contains modes and names only, never a configured value', () => {
    const secrets = ['SECRETVALUE-razorpay', 'SECRETVALUE-livekit', 'SECRETVALUE-msg91', 'SECRETVALUE-whatsapp', 'SECRETVALUE-fcm', 'SECRETVALUE-his'];
    const vars = {
      RAZORPAY_KEY_ID: 'rzp_live_' + secrets[0], RAZORPAY_KEY_SECRET: secrets[0], LIVEKIT_API_SECRET: secrets[1], LIVEKIT_API_KEY: secrets[1], LIVEKIT_URL: 'wss://x.livekit.cloud',
      VIDEO_PROVIDER: 'livekit', MSG91_AUTH_KEY: secrets[2], WHATSAPP_TOKEN: secrets[3], WHATSAPP_PHONE_NUMBER_ID: '1', FCM_SERVICE_ACCOUNT: secrets[4],
      HIS_BASE_URL: 'https://his.example', HIS_API_KEY: secrets[5],
    };
    const json = JSON.stringify(systemStatus(envOf(vars), 'production'));
    for (const s of secrets) expect(json).not.toContain(s);
  });
});
