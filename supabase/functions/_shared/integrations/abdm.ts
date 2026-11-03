// ABDM (ABHA) adapters – used only when app_settings.abdm_enabled is true.
// HttpAbdmAdapter is a STUB for the ABHA v3 login-by-OTP flow (sandbox: https://abhasbx.abdm.gov.in):
//   session token from the gateway → POST /v3/profile/login/request/otp (loginId RSA-encrypted with ABDM's
//   public key) → POST /v3/profile/login/verify (OTP encrypted) → profile. Not yet run against the sandbox;
//   Sunrise needs NHA client credentials and the facility registration first.
import { AdapterError, type AbdmAdapter, type AbhaMethod, type AbhaProfile } from './types.ts';

export const ABHA_NUMBER = /^\d{2}-\d{4}-\d{4}-\d{4}$/;
export const ABHA_ADDRESS = /^[a-z0-9._]{3,32}@(abdm|sbx)$/;
/** 14 digits typed with or without dashes → 91-1234-5678-9012; an ABHA address is lower-cased. */
export function normaliseAbha(input: string): { kind: 'number' | 'address'; value: string } | null {
  const s = input.trim().toLowerCase();
  const digits = s.replace(/[\s-]/g, '');
  if (/^\d{14}$/.test(digits)) return { kind: 'number', value: `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 10)}-${digits.slice(10)}` };
  if (ABHA_ADDRESS.test(s)) return { kind: 'address', value: s };
  return null;
}

export interface AbdmConfig { gatewayUrl: string; abhaUrl: string; clientId: string; clientSecret: string; publicKeyPem: string; fetch?: typeof fetch }

async function rsaEncrypt(pem: string, text: string): Promise<string> {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('spki', der, { name: 'RSA-OAEP', hash: 'SHA-1' }, false, ['encrypt']);
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...out));
}

export class HttpAbdmAdapter implements AbdmAdapter {
  readonly name = 'abdm_http';
  constructor(private cfg: AbdmConfig) {}
  private async token(): Promise<string> {
    const res = await (this.cfg.fetch ?? fetch)(`${this.cfg.gatewayUrl}/v0.5/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret }),
    });
    if (!res.ok) throw new AdapterError(`abdm_session_${res.status}`);
    return ((await res.json()) as { accessToken: string }).accessToken;
  }
  private async post(path: string, body: unknown, token: string, extra: Record<string, string> = {}) {
    const res = await (this.cfg.fetch ?? fetch)(`${this.cfg.abhaUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'REQUEST-ID': crypto.randomUUID(), TIMESTAMP: new Date().toISOString(), ...extra },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new AdapterError(res.status === 400 || res.status === 422 ? 'abdm_rejected' : `abdm_${res.status}`, res.status < 500);
    return json;
  }
  async startVerification({ id, method }: { id: string; method: AbhaMethod }) {
    const n = normaliseAbha(id);
    if (!n) throw new AdapterError('invalid_abha', true);
    const token = await this.token();
    const res = await this.post('/v3/profile/login/request/otp', {
      scope: ['abha-login', method === 'aadhaar_otp' ? 'aadhaar-verify' : 'mobile-verify'],
      loginHint: n.kind === 'number' ? 'abha-number' : 'abha-address',
      loginId: await rsaEncrypt(this.cfg.publicKeyPem, n.value.replace(/-/g, '')),
      otpSystem: method === 'aadhaar_otp' ? 'aadhaar' : 'abdm',
    }, token);
    return { txnId: String(res.txnId ?? '') };
  }
  async confirmVerification({ txnId, otp }: { txnId: string; otp: string }): Promise<AbhaProfile> {
    const token = await this.token();
    const res = await this.post('/v3/profile/login/verify', {
      scope: ['abha-login', 'mobile-verify'], authData: { authMethods: ['otp'], otp: { txnId, otpValue: await rsaEncrypt(this.cfg.publicKeyPem, otp) } },
    }, token);
    const acc = ((res.accounts as Record<string, unknown>[] | undefined) ?? [])[0] ?? {};
    const raw = String(acc.ABHANumber ?? '');
    const number = normaliseAbha(raw)?.value;
    if (!number) throw new AdapterError('abdm_no_account', true);
    return { abha_number: number, abha_address: (acc.preferredAbhaAddress as string) ?? null, name: String(acc.name ?? ''), gender: (acc.gender as string) ?? null,
             year_of_birth: acc.yearOfBirth ? Number(acc.yearOfBirth) : null };
  }
}

/** Local / test ABDM: OTP 123456 verifies; the profile mirrors the number typed in. */
export class MockAbdmAdapter implements AbdmAdapter {
  readonly name = 'abdm_mock';
  async startVerification({ id }: { id: string; method: AbhaMethod }) {
    const n = normaliseAbha(id);
    if (!n) throw new AdapterError('invalid_abha', true);
    return { txnId: `mock-${btoa(n.value)}` };
  }
  async confirmVerification({ txnId, otp }: { txnId: string; otp: string }): Promise<AbhaProfile> {
    if (otp !== '123456') throw new AdapterError('invalid_otp', true);
    const value = atob(txnId.replace(/^mock-/, ''));
    const number = value.includes('@') ? '91-0000-0000-0001' : value;
    return { abha_number: number, abha_address: value.includes('@') ? value : null, name: 'ABHA Sandbox User', gender: null, year_of_birth: null };
  }
}
