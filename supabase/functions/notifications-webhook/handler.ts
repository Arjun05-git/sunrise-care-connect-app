// Delivery receipts (no user JWT – deploy with verify_jwt = false):
//   ?provider=whatsapp  Meta webhook: GET verification (hub.challenge), POST signed with X-Hub-Signature-256
//   ?provider=msg91     MSG91 delivery reports, authenticated with ?token=<MSG91_WEBHOOK_TOKEN>
import { corsHeaders, serviceClient } from '../_shared/http.ts';
import { env } from '../_shared/env.ts';
import { hmacHex, safeEqual } from '../_shared/payments/crypto.ts';
import { msg91Reports } from '../_shared/notify/msg91.ts';
import { whatsappStatuses } from '../_shared/notify/whatsapp.ts';

const text = (req: Request, body: string, status = 200) => new Response(body, { status, headers: corsHeaders(req) });

export default async function webhook(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const provider = url.searchParams.get('provider');
  if (provider === 'whatsapp') {
    if (req.method === 'GET') {
      const want = env('WHATSAPP_VERIFY_TOKEN');
      const ok = url.searchParams.get('hub.mode') === 'subscribe' && !!want && safeEqual(url.searchParams.get('hub.verify_token') ?? '', want);
      return ok ? text(req, url.searchParams.get('hub.challenge') ?? '') : text(req, 'forbidden', 403);
    }
    const raw = await req.text();
    const secret = env('WHATSAPP_APP_SECRET');
    const sig = (req.headers.get('x-hub-signature-256') ?? '').replace(/^sha256=/, '');
    if (!secret || !safeEqual(await hmacHex(secret, raw), sig)) return text(req, 'bad_signature', 401);
    const svc = serviceClient();
    for (const s of whatsappStatuses(JSON.parse(raw))) await svc.rpc('record_delivery_status', { p_provider: 'whatsapp_cloud', p_message_id: s.id, p_status: s.status, p_error: s.error ?? null });
    return text(req, 'ok');
  }
  if (provider === 'msg91' && req.method === 'POST') {
    const token = env('MSG91_WEBHOOK_TOKEN');
    if (!token || !safeEqual(token, url.searchParams.get('token') ?? '')) return text(req, 'forbidden', 403);
    const body = await req.json().catch(() => null);
    const svc = serviceClient();
    for (const s of msg91Reports(body)) await svc.rpc('record_delivery_status', { p_provider: 'msg91', p_message_id: s.id, p_status: s.status, p_error: s.error ?? null });
    return text(req, 'ok');
  }
  return text(req, 'not_found', 404);
}
