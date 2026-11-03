// TEST GATEWAY ONLY (PAYMENTS_ALLOW_MOCK=true): plays the part of the Razorpay checkout + servers.
// POST {order_id, method, outcome: 'success'|'failure'} → signed payment result like Razorpay's
// handler, and (MOCK_SEND_WEBHOOKS=true) the matching webhook a moment later.
import { env } from '../_shared/env.ts';
import { handler, HttpError, json, readJson, requireUser } from '../_shared/http.ts';
import { mockProvider } from '../_shared/payments/index.ts';

const METHODS = ['upi', 'card', 'netbanking', 'wallet'];

export default handler(async (req) => {
  if (env('PAYMENTS_ALLOW_MOCK') !== 'true') throw new HttpError('not_found', 404);
  const { client } = await requireUser(req);
  const b = await readJson<{ order_id?: string; method?: string; outcome?: string }>(req);
  if (typeof b.order_id !== 'string' || !METHODS.includes(b.method ?? '') || !['success', 'failure'].includes(b.outcome ?? '')) throw new HttpError('invalid_input');
  const { data: pay } = await client.from('payments').select('amount, provider, status').eq('provider_order_id', b.order_id).maybeSingle();
  if (!pay || pay.provider !== 'mock') throw new HttpError('not_found', 404);

  const gw = mockProvider();
  const url = env('PUBLIC_FUNCTIONS_URL');
  const sendWebhook = (event: string, entity: Record<string, unknown>) => {
    if (env('MOCK_SEND_WEBHOOKS') !== 'true' || !url) return;
    const body = JSON.stringify({ event, created_at: Math.floor(Date.now() / 1000), payload: { payment: { entity } } });
    setTimeout(async () => {
      const sig = await gw.signWebhook(body);
      await fetch(`${url}/payments-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig, 'x-razorpay-event-id': `evt_mock_${crypto.randomUUID()}` }, body }).catch(() => undefined);
    }, 1500);
  };

  if (b.outcome === 'failure') {
    sendWebhook('payment.failed', { id: `pay_mock_failed_${crypto.randomUUID().slice(0, 8)}`, order_id: b.order_id, method: b.method, amount: pay.amount * 100, status: 'failed', error_description: 'Payment declined (test)' });
    throw new HttpError('payment_failed', 402);
  }
  const { paymentId, signature } = await gw.simulatePayment(b.order_id, b.method!, pay.amount);
  sendWebhook('payment.captured', { id: paymentId, order_id: b.order_id, method: b.method, amount: pay.amount * 100, status: 'captured' });
  return json(req, { razorpay_order_id: b.order_id, razorpay_payment_id: paymentId, razorpay_signature: signature });
});
