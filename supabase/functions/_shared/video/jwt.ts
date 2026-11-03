// Minimal HS256 JWT sign/verify on WebCrypto – identical on Deno and Node ≥ 18 (no SDK needed for LiveKit tokens).
import { safeEqual } from '../payments/crypto.ts';

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === 'string' ? enc.encode(bytes) : bytes;
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): string {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  return atob(p + '='.repeat((4 - (p.length % 4)) % 4));
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data))));
}

export async function signHs256(payload: Record<string, unknown>, secret: string): Promise<string> {
  const head = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}`;
  return `${head}.${await hmac(secret, head)}`;
}

/** Returns the claims when the signature, nbf and exp are valid; null otherwise. */
export async function verifyHs256(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(fromB64url(parts[0]!)) as { alg?: string };
    if (header.alg !== 'HS256') return null;
    if (!safeEqual(await hmac(secret, `${parts[0]}.${parts[1]}`), parts[2]!)) return null;
    const claims = JSON.parse(fromB64url(parts[1]!)) as Record<string, unknown>;
    const leeway = 30;
    if (typeof claims.exp === 'number' && claims.exp + leeway < nowSec) return null;
    if (typeof claims.nbf === 'number' && claims.nbf - leeway > nowSec) return null;
    return claims;
  } catch {
    return null;
  }
}

export async function sha256Base64(body: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(body)));
  let s = '';
  for (const x of d) s += String.fromCharCode(x);
  return btoa(s);
}
