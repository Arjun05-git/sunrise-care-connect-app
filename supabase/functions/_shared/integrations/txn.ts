// ABHA verification transaction, sealed for the browser: ABDM's txn id bound to the account and the patient,
// HMAC-signed and valid for 10 minutes, so a verification can't be confirmed for someone else.
import { env, requireEnv } from '../env.ts';

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(data: string, secret = env('ABHA_TXN_SECRET') ?? requireEnv('SUPABASE_SERVICE_ROLE_KEY')) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}
export async function sealTxn(t: { txn: string; patient: string; user: string; exp: number }) {
  const body = b64u(new TextEncoder().encode(JSON.stringify(t)));
  return `${body}.${await hmac(body)}`;
}
export async function openTxn(sealed: string): Promise<{ txn: string; patient: string; user: string; exp: number } | null> {
  const [body, sig] = sealed.split('.');
  if (!body || !sig || (await hmac(body)) !== sig) return null;
  const t = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as { txn: string; patient: string; user: string; exp: number };
  return t.exp > Date.now() ? t : null;
}

