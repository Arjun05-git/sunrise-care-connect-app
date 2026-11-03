// Gateway webhook (no user JWT – deploy with verify_jwt = false). Signature-verified with the webhook
// secret, idempotent per event id (payment_webhook_events primary key). Subscribe to:
// payment.authorized, payment.captured, order.paid, payment.failed, refund.processed, refund.failed, settlement.processed
import { corsHeaders, serviceClient } from '../_shared/http.ts';
import { activeProviderName, providerFor } from '../_shared/payments/index.ts';
import { sha256Hex } from '../_shared/payments/crypto.ts';
import { processRefund } from '../_shared/refunds.ts';

const text = (req: Request, body: string, status = 200) => new Response(body, { status, headers: corsHeaders(req) });

interface Evt {
  event: string;
  created_at?: number;
  payload: {
    payment?: { entity: { id: string; order_id: string; method: string | null; amount: number; status: string; error_description?: string } };
    refund?: { entity: { id: string } };
    settlement?: { entity: { id: string; created_at: number } };
  };
}

export default async function webhook(req: Request): Promise<Response> {
  if (req.method !== 'POST') return text(req, 'method_not_allowed', 405);
  const raw = await req.text();
  const gw = providerFor(activeProviderName());
  if (!(await gw.verifyWebhookSignature(raw, req.headers.get('x-razorpay-signature') ?? ''))) return text(req, 'bad_signature', 400);

  let evt: Evt;
  try {
    evt = JSON.parse(raw) as Evt;
  } catch {
    return text(req, 'bad_payload', 400);
  }
  const hash = await sha256Hex(raw);
  const eventId = req.headers.get('x-razorpay-event-id') ?? `body_${hash}`;
  const svc = serviceClient();
  const { error: dup } = await svc.from('payment_webhook_events').insert({ event_id: eventId, event_type: evt.event, payload_hash: hash });
  if (dup) return text(req, 'duplicate'); // already received → 200 so the gateway stops retrying

  try {
    const p = evt.payload.payment?.entity;
    switch (evt.event) {
      case 'payment.authorized':
        if (p) await gw.capture(p.id, p.amount / 100); // auto-capture off on the account → capture now; payment.captured follows
        break;
      case 'payment.captured':
      case 'order.paid': {
        if (!p) break;
        const { data, error } = await svc.rpc('capture_payment', { p_order_id: p.order_id, p_payment_id: p.id, p_method: p.method, p_amount: p.amount / 100, p_via: 'webhook' });
        if (error && error.message !== 'payment_not_found') throw error; // unknown order = not ours → ignore
        const res = data as { result?: string; refund_id?: string } | null;
        if (res?.result === 'refund_pending' && res.refund_id) await processRefund(svc, res.refund_id);
        break;
      }
      case 'payment.failed':
        if (p) await svc.rpc('fail_payment', { p_order_id: p.order_id, p_reason: p.error_description ?? 'failed' });
        break;
      case 'refund.processed':
      case 'refund.failed': {
        const r = evt.payload.refund?.entity;
        if (r) await svc.rpc('settle_refund_by_provider_id', { p_provider_refund_id: r.id, p_status: evt.event === 'refund.processed' ? 'processed' : 'failed', p_failure: evt.event === 'refund.failed' ? 'gateway_failed' : null });
        break;
      }
      case 'settlement.processed': {
        const s = evt.payload.settlement?.entity;
        if (s) await svc.rpc('mark_settled', { p_settlement_id: s.id, p_until: new Date(s.created_at * 1000).toISOString() });
        break;
      }
    }
    await svc.from('payment_webhook_events').update({ processed_at: new Date().toISOString() }).eq('event_id', eventId);
  } catch (e) {
    console.error('webhook_error', (e as Error).message);
    await svc.from('payment_webhook_events').delete().eq('event_id', eventId); // let the gateway retry
    return text(req, 'error', 500);
  }
  return text(req, 'ok');
}
