// Supabase Auth "Send SMS" hook helpers. Auth signs each call the Standard Webhooks way:
//   webhook-id, webhook-timestamp, webhook-signature: "v1,<base64 HMAC-SHA256 of `${id}.${ts}.${body}`>"
// with the hook secret "v1,whsec_<base64 key>" from the dashboard.
import { safeEqual } from './payments/crypto.ts';

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function verifyStandardWebhook(body: string, headers: Headers, secret: string, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300): Promise<boolean> {
  const id = headers.get('webhook-id');
  const ts = headers.get('webhook-timestamp');
  const sigs = headers.get('webhook-signature');
  if (!id || !ts || !sigs || !/^\d+$/.test(ts) || Math.abs(nowSec - Number(ts)) > toleranceSec) return false;
  const raw = secret.replace(/^v1,/, '').replace(/^whsec_/, '');
  let keyBytes: Uint8Array;
  try { keyBytes = fromB64(raw); } catch { return false; }
  const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = b64(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`))));
  return sigs.split(' ').some((s) => s.startsWith('v1,') && safeEqual(s.slice(3), expected));
}

/** Indian mobile numbers only (as Auth sends them: digits, country code first). Blocks SMS-pumping to premium ranges abroad. */
export const indianMobile = (phone: unknown): string | null => {
  const d = String(phone ?? '').replace(/^\+/, '');
  return /^91[6-9]\d{9}$/.test(d) ? d : null;
};

/** Hook error body Auth understands; the message is shown to nobody but the API caller. */
export const hookError = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { http_code: status, message } }), { status, headers: { 'Content-Type': 'application/json' } });
