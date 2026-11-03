// @vitest-environment node
import { createHash, createHmac } from 'node:crypto';
import { b64url, signHs256, verifyHs256 } from './jwt.ts';
import { livekitToken, verifyLivekitWebhook } from './livekit.ts';
import { issueCredentials, JITSI_CONFIG, tokenTtl, type JoinResult } from './index.ts';

const SECRET = 'test-secret-that-is-at-least-32-chars-long';
const decode = (t: string) => JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()) as Record<string, any>;

describe('HS256', () => {
  it('signature matches Node crypto', async () => {
    const t = await signHs256({ a: 1 }, SECRET);
    const [h, p, s] = t.split('.');
    expect(s).toBe(createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url'));
    expect(b64url('hi?>')).toBe(Buffer.from('hi?>').toString('base64url'));
  });
  it('rejects tampering, wrong secret, expiry and alg none', async () => {
    const now = Math.floor(Date.now() / 1000);
    const t = await signHs256({ sub: 'x', exp: now + 60 }, SECRET);
    expect(await verifyHs256(t, SECRET)).toMatchObject({ sub: 'x' });
    expect(await verifyHs256(t, SECRET + 'x')).toBeNull();
    const [h, , s] = t.split('.');
    expect(await verifyHs256(`${h}.${b64url(JSON.stringify({ sub: 'y', exp: now + 60 }))}.${s}`, SECRET)).toBeNull();
    expect(await verifyHs256(await signHs256({ exp: now - 120 }, SECRET), SECRET)).toBeNull();
    expect(await verifyHs256(`${b64url('{"alg":"none"}')}.${b64url('{}')}.`, SECRET)).toBeNull();
  });
});

describe('LiveKit token', () => {
  it('grants join to one room only, never recording or admin', async () => {
    const t = await livekitToken({ apiKey: 'APIkey', apiSecret: SECRET, room: 'scc-room', identity: 'patient-abc', name: 'Meenakshi', role: 'patient', ttlSeconds: 600 });
    const c = decode(t);
    expect(c).toMatchObject({ iss: 'APIkey', sub: 'patient-abc', name: 'Meenakshi' });
    expect(c.video).toMatchObject({ room: 'scc-room', roomJoin: true, canPublish: true, canSubscribe: true, roomRecord: false, roomAdmin: false, roomCreate: false });
    expect(c.exp - c.nbf).toBe(610);
    expect(JSON.parse(c.metadata)).toEqual({ role: 'patient' });
  });
  it('token lifetime follows the join window (5–120 min)', () => {
    const now = Date.parse('2026-10-24T10:00:00Z');
    expect(tokenTtl('2026-10-24T10:30:00Z', now)).toBe(2100);
    expect(tokenTtl('2026-10-24T09:00:00Z', now)).toBe(300);
    expect(tokenTtl('2026-10-25T10:00:00Z', now)).toBe(7200);
  });
});

describe('LiveKit webhook verification', () => {
  const body = JSON.stringify({ event: 'participant_joined', room: { name: 'scc-room' } });
  const sha = createHash('sha256').update(body).digest('base64');
  const now = Math.floor(Date.now() / 1000);
  it('accepts a correctly signed body', async () => {
    const auth = await signHs256({ iss: 'APIkey', sha256: sha, nbf: now, exp: now + 300 }, SECRET);
    expect(await verifyLivekitWebhook(body, auth, 'APIkey', SECRET)).toBe(true);
    expect(await verifyLivekitWebhook(body, `Bearer ${auth}`, 'APIkey', SECRET)).toBe(true);
  });
  it('rejects a changed body, other key, other secret, missing header', async () => {
    const auth = await signHs256({ iss: 'APIkey', sha256: sha, nbf: now, exp: now + 300 }, SECRET);
    expect(await verifyLivekitWebhook(body + ' ', auth, 'APIkey', SECRET)).toBe(false);
    expect(await verifyLivekitWebhook(body, auth, 'Other', SECRET)).toBe(false);
    expect(await verifyLivekitWebhook(body, auth, 'APIkey', SECRET + '!')).toBe(false);
    expect(await verifyLivekitWebhook(body, '', 'APIkey', SECRET)).toBe(false);
  });
});

describe('credentials', () => {
  const j: JoinResult = { room: 'scc-r', identity: 'doctor-1', display_name: 'Dr. Anil', role: 'doctor', mode: 'video', closes_at: new Date(Date.now() + 1800e3).toISOString() };
  it('Jitsi fallback disables recording and streaming', async () => {
    const c = await issueCredentials('jitsi', j);
    expect(c).toMatchObject({ provider: 'jitsi', room: 'scc-r', recording: false });
    expect(JITSI_CONFIG).toMatchObject({ fileRecordingsEnabled: false, liveStreamingEnabled: false, recordingService: { enabled: false } });
  });
  it('LiveKit credentials report recording off', async () => {
    process.env.LIVEKIT_URL = 'ws://lk';
    process.env.LIVEKIT_API_KEY = 'k';
    process.env.LIVEKIT_API_SECRET = SECRET;
    const c = await issueCredentials('livekit', j);
    expect(c).toMatchObject({ provider: 'livekit', url: 'ws://lk', recording: false });
    if (c.provider === 'livekit') expect(decode(c.token).video.roomRecord).toBe(false);
  });
});
