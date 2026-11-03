// Supabase Auth "Send SMS" hook (deploy with verify_jwt = false; Auth → Hooks → Send SMS → this URL).
// Replaces Auth's own SMS sender for OTPs so that the server, not the app, decides:
//   * only Indian mobile numbers (+91 6–9xxxxxxxxx) – Auth itself would text any number in the world;
//   * per number: 5 OTPs per 15 minutes and 10 per day, on top of Auth's own per-IP and resend limits;
//   * sent through MSG91 with the DLT-registered OTP template (MSG91_OTP_TEMPLATE_ID).
// Never logs the number or the code. Rate-limit keys are hashes, so no phone numbers sit in rate_limits.
import { env } from '../_shared/env.ts';
import { serviceClient } from '../_shared/http.ts';
import { hookError, indianMobile, verifyStandardWebhook } from '../_shared/auth-hook.ts';
import { sha256Hex } from '../_shared/payments/crypto.ts';

export default async function smsHook(req: Request): Promise<Response> {
  if (req.method !== 'POST') return hookError(405, 'method_not_allowed');
  const secret = env('SEND_SMS_HOOK_SECRET');
  const body = await req.text();
  if (!secret || !(await verifyStandardWebhook(body, req.headers, secret))) return hookError(401, 'bad_signature');

  let payload: { user?: { phone?: string }; sms?: { otp?: string } };
  try { payload = JSON.parse(body); } catch { return hookError(400, 'invalid_input'); }
  const phone = indianMobile(payload.user?.phone);
  const otp = payload.sms?.otp ?? '';
  if (!phone) return hookError(400, 'Only Indian mobile numbers can sign in.');
  if (!/^\d{6}$/.test(otp)) return hookError(400, 'invalid_input');

  const svc = serviceClient();
  const key = (await sha256Hex(`otp:${phone}`)).slice(0, 32);
  for (const [suffix, max, window] of [['15m', 5, 900], ['1d', 10, 86400]] as const) {
    const { data: ok, error } = await svc.rpc('check_rate_limit', { p_key: `otp:${key}:${suffix}`, p_max: max, p_window_seconds: window });
    if (error) return hookError(500, 'rate_limit_unavailable');
    if (!ok) return hookError(429, 'Too many codes requested for this number. Please try again later.');
  }

  if (env('NOTIFY_PROVIDER') === 'mock') return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  const authKey = env('MSG91_AUTH_KEY');
  const template = env('MSG91_OTP_TEMPLATE_ID');
  if (!authKey || !template) return hookError(500, 'sms_not_configured');
  const res = await fetch('https://control.msg91.com/api/v5/flow', {
    method: 'POST',
    headers: { authkey: authKey, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ template_id: template, short_url: '0', recipients: [{ mobiles: phone, otp }] }),
  }).catch(() => null);
  const out = res ? ((await res.json().catch(() => ({}))) as { type?: string }) : {};
  if (!res?.ok || out.type !== 'success') return hookError(502, 'sms_send_failed');
  return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
}
