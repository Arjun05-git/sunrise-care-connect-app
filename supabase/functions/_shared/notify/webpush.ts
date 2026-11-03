// Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291), on WebCrypto
// only – the same code runs on Deno (Supabase Edge) and Node. Payload: { title, body, url, tag }.
import type { ChannelAdapter, OutboundMessage, PushSubscription, Rates, SendResult } from './types.ts';

const enc = new TextEncoder();
export const b64u = {
  encode(b: Uint8Array): string { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  decode(s: string): Uint8Array { const p = s.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(p + '='.repeat((4 - (p.length % 4)) % 4)), (c) => c.charCodeAt(0)); },
};
const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data as BufferSource));
}
/** HKDF-Expand for ≤ 32 bytes (one block). */
const expand = async (prk: Uint8Array, info: Uint8Array, len: number) => (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, len);

/** Derives the content key + nonce (RFC 8291 §3.4) – shared by encrypt and the test's decrypt. */
export async function deriveKeys(authSecret: Uint8Array, shared: Uint8Array, uaPublic: Uint8Array, asPublic: Uint8Array, salt: Uint8Array) {
  const prkKey = await hmac(authSecret, shared);
  const ikm = await expand(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const prk = await hmac(salt, ikm);
  return { cek: await expand(prk, enc.encode('Content-Encoding: aes128gcm\0'), 16), nonce: await expand(prk, enc.encode('Content-Encoding: nonce\0'), 12) };
}

export async function encryptPayload(payload: Uint8Array, sub: Pick<PushSubscription, 'p256dh' | 'auth'>): Promise<Uint8Array> {
  const uaPublic = b64u.decode(sub.p256dh);
  const authSecret = b64u.decode(sub.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const ua = await crypto.subtle.importKey('raw', uaPublic as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ua }, as.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const { cek, nonce } = await deriveKeys(authSecret, shared, uaPublic, asPublic, salt);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

/** VAPID JWT (ES256) for the push service's origin. */
export async function vapidAuthorization(endpoint: string, keys: { publicKey: string; privateKey: string; subject: string }, now = Date.now()): Promise<string> {
  const pub = b64u.decode(keys.publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u.encode(pub.slice(1, 33)), y: b64u.encode(pub.slice(33, 65)), d: keys.privateKey, ext: true };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = `${b64u.encode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))}.${b64u.encode(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: keys.subject,
  })))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head)));
  return `vapid t=${head}.${b64u.encode(sig)}, k=${keys.publicKey}`;
}

/** Push text: the message without the URL (the notification click opens the secure link). */
export const pushPayload = (m: OutboundMessage) =>
  enc.encode(JSON.stringify({ title: m.push_title, body: m.text.replace(/\s*https?:\/\/\S+/g, '').replace(/[:\s]+$/, ''), url: m.link, tag: m.template_key }));

export class WebPushAdapter implements ChannelAdapter {
  readonly channel = 'push' as const;
  readonly provider = 'webpush';
  constructor(private cfg: { publicKey: string; privateKey: string; subject: string; fetch?: typeof fetch }) {}

  async send(m: OutboundMessage, rates: Rates): Promise<SendResult> {
    const subs = m.subscriptions ?? [];
    if (!subs.length) return { ok: false, provider: this.provider, error: 'no_subscription', permanent: true };
    const gone: string[] = [];
    let accepted = 0;
    let lastError = '';
    for (const s of subs) {
      const res = await (this.cfg.fetch ?? fetch)(s.endpoint, {
        method: 'POST',
        headers: {
          Authorization: await vapidAuthorization(s.endpoint, this.cfg), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
          TTL: String(m.category === 'reminder' ? 3600 : 86400), Urgency: m.category === 'reminder' ? 'high' : 'normal',
        },
        body: (await encryptPayload(pushPayload(m), s)) as BodyInit,
      });
      if (res.status === 404 || res.status === 410) gone.push(s.endpoint);
      else if (res.ok) accepted++;
      else lastError = `push_${res.status}`;
    }
    if (accepted) return { ok: true, provider: this.provider, providerMessageId: `${accepted}/${subs.length}`, costPaise: rates.push, delivered: true, goneEndpoints: gone };
    return { ok: false, provider: this.provider, error: lastError || 'push_gone', permanent: gone.length === subs.length, goneEndpoints: gone };
  }
}
