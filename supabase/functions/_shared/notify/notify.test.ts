// @vitest-environment node
import { createHmac } from 'node:crypto';
import { checkMessage, msisdn, smsParts } from './guard.ts';
import { MockAdapter } from './mock.ts';
import { msg91Reports, Msg91Adapter } from './msg91.ts';
import type { OutboundMessage } from './types.ts';
import { b64u, deriveKeys, encryptPayload, pushPayload, vapidAuthorization, WebPushAdapter } from './webpush.ts';
import { whatsappStatuses, WhatsAppCloudAdapter } from './whatsapp.ts';

const LINK = 'https://care.sunrise.example/l/0123456789abcdef0123456789abcdef';
const msg = (o: Partial<OutboundMessage> = {}): OutboundMessage => ({
  id: 'n1', channel: 'sms', template_key: 'booking_confirmed', variables: { name: 'Anjali', doctor: 'Dr. Arun Nair', ref: 'SC-ABC123', link: LINK },
  text: `Hi Anjali, your Sunrise teleconsultation with Dr. Arun Nair is confirmed. Ref SC-ABC123. Details: ${LINK}`, language: 'en', attempts: 1,
  phone: '+919847000001', category: 'transactional', whatsapp_template: 'sunrise_booking_confirmed_v1', sms_dlt_template_id: '1107000000000000001',
  push_title: 'Sunrise Care', link: LINK, subscriptions: null, ...o,
});
const rates = { whatsapp: 13, sms: 25, push: 0 };
const fakeFetch = (status: number, body: unknown, seen: { url?: string; init?: RequestInit }[] = []) =>
  (async (url: string | URL | Request, init?: RequestInit) => { seen.push({ url: String(url), init }); return new Response(JSON.stringify(body), { status }); }) as typeof fetch;

describe('guard: no clinical content, only our secure link', () => {
  it('accepts a whitelisted message', () => expect(checkMessage(msg())).toBeNull());
  it('refuses a non-whitelisted variable', () => expect(checkMessage(msg({ variables: { ref: 'x', diagnosis: 'asthma' } }))).toBe('variable_not_allowed:diagnosis'));
  it('refuses links that are not /l/<token>', () => {
    expect(checkMessage(msg({ link: 'https://care.sunrise.example/p/records/9f1c' }))).toBe('link_not_allowed');
    expect(checkMessage(msg({ text: 'see https://evil.example/x' }))).toBe('url_not_allowed');
  });
  it('SMS parts: GSM 160 / 153, Unicode (Malayalam) 70 / 67', () => {
    expect(smsParts('a'.repeat(160))).toBe(1);
    expect(smsParts('a'.repeat(161))).toBe(2);
    expect(smsParts('ബു'.repeat(35))).toBe(1);
    expect(smsParts('ബു'.repeat(36))).toBe(2);
  });
  it('normalises Indian numbers', () => {
    expect(msisdn('+91 98470 00001')).toBe('919847000001');
    expect(msisdn('9847000001')).toBe('919847000001');
    expect(msisdn('12345')).toBeNull();
  });
});

describe('WhatsApp Cloud API adapter', () => {
  it('sends the approved template with named parameters and the language', async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const a = new WhatsAppCloudAdapter({ token: 't', phoneNumberId: '123', fetch: fakeFetch(200, { messages: [{ id: 'wamid.1' }] }, seen) });
    const r = await a.send(msg({ channel: 'whatsapp', language: 'ml' }), rates);
    expect(r).toMatchObject({ ok: true, providerMessageId: 'wamid.1', costPaise: 13 });
    const body = JSON.parse(String(seen[0]!.init!.body));
    expect(seen[0]!.url).toBe('https://graph.facebook.com/v20.0/123/messages');
    expect(body).toMatchObject({ to: '919847000001', type: 'template', template: { name: 'sunrise_booking_confirmed_v1', language: { code: 'ml' } } });
    expect(body.template.components[0].parameters).toContainEqual({ type: 'text', parameter_name: 'ref', text: 'SC-ABC123' });
  });
  it('"not on WhatsApp" is permanent, 429 / 5xx are retried', async () => {
    expect(await new WhatsAppCloudAdapter({ token: 't', phoneNumberId: '1', fetch: fakeFetch(400, { error: { code: 131026 } }) }).send(msg(), rates)).toMatchObject({ ok: false, permanent: true });
    expect(await new WhatsAppCloudAdapter({ token: 't', phoneNumberId: '1', fetch: fakeFetch(429, {}) }).send(msg(), rates)).toMatchObject({ ok: false, permanent: false });
    expect(await new WhatsAppCloudAdapter({ token: 't', phoneNumberId: '1', fetch: fakeFetch(503, {}) }).send(msg(), rates)).toMatchObject({ ok: false, permanent: false });
  });
  it('reads delivery / read / failed statuses from the webhook', () => {
    const p = { entry: [{ changes: [{ value: { statuses: [{ id: 'w1', status: 'delivered' }, { id: 'w2', status: 'read' }, { id: 'w3', status: 'failed', errors: [{ code: 131026 }] }, { id: 'w4', status: 'sent' }] } }] }] };
    expect(whatsappStatuses(p)).toEqual([{ id: 'w1', status: 'delivered' }, { id: 'w2', status: 'read' }, { id: 'w3', status: 'failed', error: 'wa_131026' }]);
  });
});

describe('MSG91 SMS adapter', () => {
  it('sends the DLT template with variables; cost per part', async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const r = await new Msg91Adapter({ authKey: 'k', fetch: fakeFetch(200, { type: 'success', message: 'req-1' }, seen) }).send(msg(), rates);
    expect(r).toMatchObject({ ok: true, providerMessageId: 'req-1', costPaise: 50 }); // 177 characters = 2 parts
    const body = JSON.parse(String(seen[0]!.init!.body));
    expect(body).toMatchObject({ template_id: '1107000000000000001', recipients: [{ mobiles: '919847000001', ref: 'SC-ABC123' }] });
  });
  it('no DLT id → permanent failure', async () => {
    expect(await new Msg91Adapter({ authKey: 'k', fetch: fakeFetch(200, {}) }).send(msg({ sms_dlt_template_id: null }), rates)).toMatchObject({ ok: false, permanent: true, error: 'no_dlt_template' });
  });
  it('delivery reports', () => {
    expect(msg91Reports([{ requestId: 'r1', report: [{ status: 1 }] }, { request_id: 'r2', status: 'Rejected' }])).toEqual([{ id: 'r1', status: 'delivered' }, { id: 'r2', status: 'failed', error: 'msg91_dlr_rejected' }]);
  });
});

describe('Web Push (VAPID + aes128gcm)', () => {
  it('encrypts so the browser can decrypt (RFC 8291 round trip)', async () => {
    const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const plain = new TextEncoder().encode('{"title":"Sunrise Care","body":"Reminder"}');
    const body = await encryptPayload(plain, { p256dh: b64u.encode(uaPublic), auth: b64u.encode(auth) });
    // browser side
    const salt = body.slice(0, 16);
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
    const idlen = body[20]!;
    const asPublic = body.slice(21, 21 + idlen);
    const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
    const { cek, nonce } = await deriveKeys(auth, shared, uaPublic, asPublic, salt);
    const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
    const out = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(21 + idlen)));
    expect(out[out.length - 1]).toBe(2); // last-record padding delimiter
    expect(new TextDecoder().decode(out.slice(0, -1))).toBe(new TextDecoder().decode(plain));
  });
  it('VAPID token is a valid ES256 JWT for the push service origin', async () => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const h = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', { publicKey: b64u.encode(pub), privateKey: jwk.d!, subject: 'mailto:care@sunrise.example' });
    const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h)!;
    expect(k).toBe(b64u.encode(pub));
    const [hd, pl, sig] = t!.split('.');
    expect(JSON.parse(new TextDecoder().decode(b64u.decode(pl!)))).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'mailto:care@sunrise.example' });
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, b64u.decode(sig!), new TextEncoder().encode(`${hd}.${pl}`))).toBe(true);
  });
  it('push text has no URL (the click opens the secure link); gone endpoints are reported', async () => {
    const payload = JSON.parse(new TextDecoder().decode(pushPayload(msg({ channel: 'push' }))));
    expect(payload).toEqual({ title: 'Sunrise Care', body: 'Hi Anjali, your Sunrise teleconsultation with Dr. Arun Nair is confirmed. Ref SC-ABC123. Details', url: LINK, tag: 'booking_confirmed' });
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const sub = { endpoint: 'https://push.example/x', p256dh: b64u.encode(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))), auth: b64u.encode(new Uint8Array(16)) };
    const a = new WebPushAdapter({ publicKey: b64u.encode(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))), privateKey: (await crypto.subtle.exportKey('jwk', kp.privateKey)).d!, subject: 'mailto:x@y.z', fetch: fakeFetch(410, {}) });
    expect(await a.send(msg({ channel: 'push', subscriptions: [sub] }), rates)).toMatchObject({ ok: false, permanent: true, goneEndpoints: ['https://push.example/x'] });
  });
});

describe('mock adapters (local stack)', () => {
  it('success, permanent and temporary failures by number', async () => {
    const a = new MockAdapter('sms');
    expect(await a.send(msg(), rates)).toMatchObject({ ok: true, delivered: true, costPaise: 50 });
    expect(await a.send(msg({ phone: '+919800000099' }), rates)).toMatchObject({ ok: false, permanent: true });
    expect(await a.send(msg({ phone: '+919800000098' }), rates)).toMatchObject({ ok: false, permanent: false });
  });
});

describe('WhatsApp webhook signature', () => {
  it('matches Meta’s sha256 HMAC of the raw body', async () => {
    const { hmacHex } = await import('../payments/crypto.ts');
    expect(await hmacHex('app-secret', '{"a":1}')).toBe(createHmac('sha256', 'app-secret').update('{"a":1}').digest('hex'));
  });
});
