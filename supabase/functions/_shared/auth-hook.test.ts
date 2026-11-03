import { describe, expect, it } from 'vitest';
import { indianMobile, verifyStandardWebhook } from './auth-hook';

const KEY = btoa('a-32-byte-hook-secret-for-tests!');
const SECRET = `v1,whsec_${KEY}`;
async function sign(id: string, ts: number, body: string) {
  const k = await crypto.subtle.importKey('raw', Uint8Array.from(atob(KEY), (c) => c.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  return `v1,${btoa(String.fromCharCode(...mac))}`;
}
const headers = (id: string, ts: number, sig: string) => new Headers({ 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': sig });

describe('Send SMS hook', () => {
  const now = 1_800_000_000;
  const body = '{"user":{"phone":"919847000001"},"sms":{"otp":"123456"}}';
  it('accepts a correctly signed, fresh call', async () => {
    expect(await verifyStandardWebhook(body, headers('msg_1', now, await sign('msg_1', now, body)), SECRET, now)).toBe(true);
  });
  it('refuses a changed body, a wrong secret, a stale timestamp or missing headers', async () => {
    const sig = await sign('msg_1', now, body);
    expect(await verifyStandardWebhook(body.replace('919847000001', '447700900123'), headers('msg_1', now, sig), SECRET, now)).toBe(false);
    expect(await verifyStandardWebhook(body, headers('msg_1', now, sig), `v1,whsec_${btoa('another-secret-another-secret-!!')}`, now)).toBe(false);
    expect(await verifyStandardWebhook(body, headers('msg_1', now, sig), SECRET, now + 301)).toBe(false);
    expect(await verifyStandardWebhook(body, new Headers(), SECRET, now)).toBe(false);
  });
  it('only texts Indian mobile numbers', () => {
    expect(indianMobile('919847000001')).toBe('919847000001');
    expect(indianMobile('+919847000001')).toBe('919847000001');
    for (const bad of ['447700900123', '9198470000', '915847000001', '12345', '', null]) expect(indianMobile(bad)).toBeNull();
  });
});
