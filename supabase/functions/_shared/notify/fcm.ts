// Native push for the Capacitor apps through Firebase Cloud Messaging (HTTP v1). Android tokens go straight to
// FCM; iOS tokens too, with the APNs auth key uploaded to the Firebase project (FCM relays to APNs).
// Same message as Web Push: title + text without the link, and the /l/<token> URL to open – nothing clinical.
import { pushPayload } from './webpush.ts';
import type { ChannelAdapter, DeviceToken, OutboundMessage, Rates, SendResult } from './types.ts';

export interface FcmConfig { projectId: string; clientEmail: string; privateKeyPem: string; fetch?: typeof fetch; now?: () => number }

const b64u = (b: Uint8Array | string) =>
  btoa(typeof b === 'string' ? b : String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Signed service-account assertion (RS256) exchanged for a 1-hour OAuth token. */
export async function serviceAccountJwt(cfg: FcmConfig, nowSec: number): Promise<string> {
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64u(JSON.stringify({ iss: cfg.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: nowSec, exp: nowSec + 3600 }));
  const der = Uint8Array.from(atob(cfg.privateKeyPem.replace(/-----[^-]+-----|\\n|\s/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${claims}`)));
  return `${head}.${claims}.${b64u(sig)}`;
}

/** FCM v1 message for one device (data carries the URL; Capacitor's tap handler opens it). */
export function fcmMessage(m: OutboundMessage, d: DeviceToken) {
  const p = JSON.parse(new TextDecoder().decode(pushPayload(m))) as { title: string; body: string; url: string | null; tag: string };
  return {
    message: {
      token: d.token,
      notification: { title: p.title, body: p.body },
      data: { url: p.url ?? '/', tag: p.tag },
      android: { priority: m.category === 'reminder' ? 'HIGH' : 'NORMAL', notification: { channel_id: 'sunrise_default', tag: p.tag } },
      apns: { headers: { 'apns-priority': m.category === 'reminder' ? '10' : '5' }, payload: { aps: { sound: 'default', 'thread-id': p.tag } } },
    },
  };
}

export class FcmAdapter {
  readonly provider = 'fcm';
  private cached: { token: string; until: number } | null = null;
  constructor(private cfg: FcmConfig) {}
  private async accessToken(): Promise<string> {
    const now = this.cfg.now?.() ?? Date.now();
    if (this.cached && this.cached.until > now + 60_000) return this.cached.token;
    const res = await (this.cfg.fetch ?? fetch)('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: await serviceAccountJwt(this.cfg, Math.floor(now / 1000)) }),
    });
    if (!res.ok) throw new Error(`fcm_oauth_${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.cached = { token: j.access_token, until: now + j.expires_in * 1000 };
    return j.access_token;
  }
  /** Sends to every device; returns how many were accepted and which tokens are no longer registered. */
  async sendAll(m: OutboundMessage, devices: DeviceToken[]): Promise<{ accepted: number; gone: string[]; lastError: string }> {
    const auth = await this.accessToken();
    let accepted = 0;
    let lastError = '';
    const gone: string[] = [];
    for (const d of devices) {
      const res = await (this.cfg.fetch ?? fetch)(`https://fcm.googleapis.com/v1/projects/${this.cfg.projectId}/messages:send`, {
        method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: JSON.stringify(fcmMessage(m, d)),
      });
      if (res.ok) accepted++;
      else {
        const err = (await res.json().catch(() => ({}))) as { error?: { status?: string; details?: { errorCode?: string }[] } };
        const code = err.error?.details?.[0]?.errorCode ?? err.error?.status ?? `http_${res.status}`;
        if (code === 'UNREGISTERED' || res.status === 404) gone.push(d.token);
        else lastError = `fcm_${code}`.toLowerCase();
      }
    }
    return { accepted, gone, lastError };
  }
}

/** The push channel: Web Push subscriptions and native devices together. */
export class CombinedPushAdapter implements ChannelAdapter {
  readonly channel = 'push' as const;
  readonly provider: string;
  constructor(private web?: ChannelAdapter, private fcm?: FcmAdapter) {
    this.provider = [web && 'webpush', fcm && 'fcm'].filter(Boolean).join('+') || 'none';
  }
  async send(m: OutboundMessage, rates: Rates): Promise<SendResult> {
    const subs = m.subscriptions ?? [];
    const devices = m.devices ?? [];
    let accepted = 0;
    let lastError = '';
    const out: SendResult = { ok: false, provider: this.provider, goneEndpoints: [], goneTokens: [] };
    if (subs.length && this.web) {
      const r = await this.web.send({ ...m, devices: [] }, rates);
      if (r.ok) accepted++;
      else lastError = r.error ?? '';
      out.goneEndpoints = r.goneEndpoints ?? [];
    }
    if (devices.length && this.fcm) {
      const r = await this.fcm.sendAll(m, devices);
      accepted += r.accepted;
      out.goneTokens = r.gone;
      if (r.lastError) lastError = r.lastError;
    }
    if (accepted) return { ...out, ok: true, providerMessageId: `${accepted}`, costPaise: rates.push, delivered: true };
    const allGone = (out.goneEndpoints?.length ?? 0) + (out.goneTokens?.length ?? 0) === subs.length + devices.length;
    return { ...out, error: lastError || (subs.length + devices.length ? 'push_gone' : 'no_subscription'), permanent: allGone };
  }
}
