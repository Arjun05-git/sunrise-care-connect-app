import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { HttpHisAdapter, MockHisAdapter } from './his.ts';
import { HttpLeadSquaredAdapter, leadAttributes, lsqTime } from './leadsquared.ts';
import { MockAbdmAdapter, normaliseAbha } from './abdm.ts';
import { dispatchIntegrations, send } from './service.ts';
import { openTxn, sealTxn } from './txn.ts';
import { CombinedPushAdapter, FcmAdapter, fcmMessage, serviceAccountJwt } from '../notify/fcm.ts';
import type { OutboundMessage } from '../notify/types.ts';
import type { LeadEvent } from './types.ts';

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const patient = { patient_ref: 'p-1', mrn: null, name: 'Devika', date_of_birth: '1991-03-03', gender: 'female', mobile: '+919800000301', email: null, address: 'Kochi', abha_number: null, idempotency_key: 'his:patient:p-1:abc' };

describe('HIS HTTP adapter (stub)', () => {
  it('creates the patient with an Idempotency-Key and returns the MRN', async () => {
    const f = vi.fn(async () => reply(201, { mrn: 'SUN-123' }));
    const r = await new HttpHisAdapter({ baseUrl: 'https://his.test/api/', apiKey: 'k', facilityId: 'KKD', fetch: f as never }).upsertPatient(patient);
    expect(r).toMatchObject({ ok: true, externalRef: 'SUN-123', result: { mrn: 'SUN-123' } });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://his.test/api/patients');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('his:patient:p-1:abc');
    expect((init.headers as Record<string, string>)['X-Facility-Id']).toBe('KKD');
  });
  it('retries 5xx / 429, gives up on other 4xx', async () => {
    const mk = (s: number) => new HttpHisAdapter({ baseUrl: 'https://his.test', apiKey: 'k', facilityId: 'F', fetch: (async () => reply(s, { code: 'x' })) as never });
    expect(await mk(503).upsertPatient(patient)).toMatchObject({ ok: false, permanent: false });
    expect(await mk(429).upsertPatient(patient)).toMatchObject({ ok: false, permanent: false });
    expect(await mk(422).upsertPatient(patient)).toMatchObject({ ok: false, permanent: true, error: 'http_422:x' });
  });
  it('mock gives a stable MRN and can simulate outages', async () => {
    const m = new MockHisAdapter();
    const a = await m.upsertPatient(patient);
    const b = await m.upsertPatient(patient);
    expect(a.ok && b.ok && a.externalRef === b.externalRef).toBe(true);
    expect(await m.upsertPatient({ ...patient, name: 'HISDOWN test' })).toMatchObject({ ok: false, permanent: false });
  });
});

const lead: LeadEvent = { event: 'booked', occurred_at: '2026-10-27T05:30:00Z', idempotency_key: 'lsq:booked:a1', lead: { name: 'Devika', mobile: '+919800000301', city: 'Kochi', source: 'Sunrise Care Connect' } };
describe('LeadSquared (stub)', () => {
  it('sends only name, mobile, city and source', () => {
    expect(leadAttributes(lead).map((a) => a.Attribute)).toEqual(['FirstName', 'Phone', 'mx_City', 'Source', 'SearchBy']);
    expect(JSON.stringify(leadAttributes(lead))).not.toMatch(/doctor|department|symptom|diagnos/i);
  });
  it('captures the lead, then posts the activity for the event', async () => {
    const f = vi.fn(async (url: string) => (url.includes('Lead.Capture') ? reply(200, { Status: 'Success', Message: { Id: 'LEAD-9' } }) : reply(200, { Message: { Id: 'ACT-1' } })));
    const r = await new HttpLeadSquaredAdapter({ host: 'api-in21.leadsquared.com', accessKey: 'a', secretKey: 's', activityCodes: { booked: 202 }, fetch: f as never }).captureEvent(lead);
    expect(r).toMatchObject({ ok: true, externalRef: 'ACT-1' });
    const act = JSON.parse((f.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(act).toEqual({ RelatedProspectId: 'LEAD-9', ActivityEvent: 202, ActivityNote: 'ref:lsq:booked:a1', ActivityDateTime: '2026-10-27 05:30:00' });
  });
  it('an event without a configured activity code fails permanently', async () => {
    const r = await new HttpLeadSquaredAdapter({ host: 'h', accessKey: 'a', secretKey: 's', activityCodes: {}, fetch: (async () => reply(200, {})) as never }).captureEvent(lead);
    expect(r).toMatchObject({ ok: false, permanent: true });
    expect(lsqTime('2026-01-02T03:04:05.678Z')).toBe('2026-01-02 03:04:05');
  });
});

describe('ABHA', () => {
  it('normalises numbers and addresses', () => {
    expect(normaliseAbha('91 1234 5678 9012')).toEqual({ kind: 'number', value: '91-1234-5678-9012' });
    expect(normaliseAbha('Devika.I@sbx')).toEqual({ kind: 'address', value: 'devika.i@sbx' });
    expect(normaliseAbha('12345')).toBeNull();
  });
  it('mock verifies with OTP 123456 only', async () => {
    const m = new MockAbdmAdapter();
    const { txnId } = await m.startVerification({ id: '91-1234-5678-9012', method: 'mobile_otp' });
    await expect(m.confirmVerification({ txnId, otp: '000000' })).rejects.toMatchObject({ code: 'invalid_otp' });
    expect((await m.confirmVerification({ txnId, otp: '123456' })).abha_number).toBe('91-1234-5678-9012');
  });
  it('the sealed transaction is bound and expires', async () => {
    process.env.ABHA_TXN_SECRET = 'test-secret';
    const sealed = await sealTxn({ txn: 't1', patient: 'p', user: 'u', exp: Date.now() + 60_000 });
    expect(await openTxn(sealed)).toMatchObject({ txn: 't1', user: 'u' });
    expect(await openTxn(sealed.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).toBeNull();
    expect(await openTxn(await sealTxn({ txn: 't1', patient: 'p', user: 'u', exp: Date.now() - 1 }))).toBeNull();
  });
});

const msg: OutboundMessage = {
  id: 'n1', channel: 'push', template_key: 'reminder_1h', variables: {}, text: 'Your consultation SC-1 starts at 10:00 AM IST: https://care.example/l/abc', language: 'en', attempts: 1,
  phone: null, category: 'reminder', whatsapp_template: 't', sms_dlt_template_id: null, push_title: 'Reminder', link: '/l/abc', subscriptions: [], devices: [{ platform: 'android', token: 'tok-1' }],
};
describe('native push (FCM v1)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  it('signs a valid RS256 service-account assertion', async () => {
    const jwt = await serviceAccountJwt({ projectId: 'p', clientEmail: 'fcm@p.iam.gserviceaccount.com', privateKeyPem: pem }, 1_800_000_000);
    const [h, c, s] = jwt.split('.');
    const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s!, 'base64url'));
    expect(ok).toBe(true);
    expect(JSON.parse(Buffer.from(c!, 'base64url').toString())).toMatchObject({ iss: 'fcm@p.iam.gserviceaccount.com', aud: 'https://oauth2.googleapis.com/token', exp: 1_800_003_600 });
  });
  it('message: title, text without the link, URL in data, high priority for reminders', () => {
    const m = fcmMessage(msg, { platform: 'android', token: 'tok-1' }).message;
    expect(m.notification.body).toBe('Your consultation SC-1 starts at 10:00 AM IST');
    expect(m.data).toEqual({ url: '/l/abc', tag: 'reminder_1h' });
    expect(m.android.priority).toBe('HIGH');
  });
  it('combined adapter: device accepted; unregistered tokens are reported for removal', async () => {
    const f = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('oauth2')) return reply(200, { access_token: 'at', expires_in: 3600 });
      const token = JSON.parse(init.body as string).message.token;
      return token === 'tok-1' ? reply(200, { name: 'm/1' }) : reply(404, { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } });
    });
    const push = new CombinedPushAdapter(undefined, new FcmAdapter({ projectId: 'p', clientEmail: 'e', privateKeyPem: pem, fetch: f as never }));
    const r = await push.send({ ...msg, devices: [{ platform: 'android', token: 'tok-1' }, { platform: 'ios', token: 'tok-2' }] }, { whatsapp: 13, sms: 25, push: 0 });
    expect(r).toMatchObject({ ok: true, provider: 'fcm', goneTokens: ['tok-2'] });
  });
});

describe('integration dispatcher', () => {
  it('sends patient masters first, skips / waits as told, records outcomes', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    const events = [
      { id: 'e-rx', system: 'his', kind: 'prescription', entity_id: 'rx', attempts: 1 },
      { id: 'e-pt', system: 'his', kind: 'patient_upsert', entity_id: 'pt', attempts: 1 },
      { id: 'e-lead', system: 'leadsquared', kind: 'lead_event', entity_id: 'a', attempts: 1 },
    ];
    const payloads: Record<string, unknown> = { 'e-pt': patient, 'e-rx': { wait: 'waiting_for_mrn', patient_id: 'pt' }, 'e-lead': { skip: 'no_consent' } };
    const svc = { rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push([fn, args]);
      if (fn === 'claim_integration_events') return { data: events, error: null };
      if (fn === 'integration_payload') return { data: payloads[args.p_id as string], error: null };
      return { data: null, error: null };
    } };
    const r = await dispatchIntegrations(svc as never, { his: new MockHisAdapter() });
    expect(r).toMatchObject({ claimed: 3, sent: 1, waiting: 1, skipped: 1 });
    const order = calls.filter(([f]) => f === 'integration_payload').map(([, a]) => a.p_id);
    expect(order[0]).toBe('e-pt');
    expect(calls.find(([f]) => f === 'complete_integration_event')?.[1]).toMatchObject({ p_id: 'e-pt', p_result: { mrn: expect.stringMatching(/^SUN-/) } });
    expect(calls.some(([f, a]) => f === 'ensure_patient_upsert' && a.p_patient === 'pt')).toBe(true);
  });
  it('a system without an adapter fails permanently (visible in the admin page)', async () => {
    expect(await send({}, { id: 'x', system: 'his', kind: 'billing_payment', entity_id: 'p', attempts: 1 }, {})).toEqual({ ok: false, error: 'not_configured', permanent: true });
  });
});
