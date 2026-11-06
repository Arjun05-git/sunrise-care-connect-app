import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../_shared/http.ts', async (orig) => ({ ...(await orig<typeof import('../_shared/http.ts')>()), requireUser: vi.fn() }));
import { HttpError, requireUser } from '../_shared/http.ts';
import status from './handler';

const SECRET = 'SECRETVALUE-do-not-leak';
const asUser = (opts: { admin: boolean; environment?: string }) =>
  vi.mocked(requireUser).mockResolvedValue({
    client: { rpc: async (fn: string) => (fn === 'am_staff' ? { data: opts.admin } : { data: { environment: opts.environment ?? 'demo', staff_mfa_required: false } }) },
    user: { id: 'u1' },
  } as never);
const post = () => status(new Request('http://x/functions/v1/system-status', { method: 'POST', headers: { authorization: 'Bearer t' }, body: '{}' }));

beforeEach(() => {
  process.env.RAZORPAY_KEY_ID = 'rzp_live_x';
  process.env.RAZORPAY_KEY_SECRET = SECRET;
  process.env.NOTIFY_PROVIDER = 'mock';
});
afterEach(() => {
  vi.resetAllMocks();
  for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'NOTIFY_PROVIDER']) delete process.env[k];
});

describe('system-status', () => {
  it('requires a signed-in user', async () => {
    vi.mocked(requireUser).mockRejectedValue(new HttpError('unauthorized', 401));
    expect((await post()).status).toBe(401);
  });

  it('is for admins only', async () => {
    asUser({ admin: false });
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('gives an admin the environment from the DATABASE and the provider modes', async () => {
    asUser({ admin: true, environment: 'production' });
    const res = await post();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { environment: string; providers: { id: string; mode: string }[]; warnings: string[] };
    expect(body.environment).toBe('production');
    expect(body.providers.find((p) => p.id === 'payments')?.mode).toBe('live');
    expect(body.providers.find((p) => p.id === 'sms')?.mode).toBe('mock');
    expect(body.warnings).toContain('mock:sms');
  });

  it('treats anything but an explicit demo database as production', async () => {
    asUser({ admin: true, environment: 'something-else' });
    expect(((await (await post()).json()) as { environment: string }).environment).toBe('production');
  });

  it('never echoes a configured secret', async () => {
    asUser({ admin: true });
    expect(JSON.stringify(await (await post()).json())).not.toContain(SECRET);
  });

  it('answers only POST', async () => {
    expect((await status(new Request('http://x/functions/v1/system-status', { method: 'GET' }))).status).toBe(405);
  });
});
