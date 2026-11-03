// POST {order_id, payment_id, signature} from the checkout → signature check (key secret), gateway
// lookup (status + amount), capture if only authorised, then the idempotent DB capture.
import { handler, HttpError, json, readJson, requireUser, serviceClient } from '../_shared/http.ts';
import { providerFor, type ProviderName } from '../_shared/payments/index.ts';
import { processRefund } from '../_shared/refunds.ts';

export default handler(async (req) => {
  const { client } = await requireUser(req);
  const b = await readJson<{ order_id?: string; payment_id?: string; signature?: string }>(req);
  if (![b.order_id, b.payment_id, b.signature].every((x) => typeof x === 'string' && x.length < 200)) throw new HttpError('invalid_input');

  // RLS: only the patient's family (or staff) can see this payment
  const { data: pay } = await client.from('payments').select('id, provider, amount').eq('provider_order_id', b.order_id!).maybeSingle();
  if (!pay) throw new HttpError('not_found', 404);
  const gw = providerFor(pay.provider as ProviderName);
  if (!(await gw.verifyPaymentSignature({ orderId: b.order_id!, paymentId: b.payment_id!, signature: b.signature! }))) {
    console.warn('payment_signature_mismatch');
    throw new HttpError('bad_signature');
  }
  let gp = await gw.getPayment(b.payment_id!);
  if (gp.orderId && gp.orderId !== b.order_id) throw new HttpError('bad_signature');
  if (gp.status === 'authorized') gp = await gw.capture(gp.id, pay.amount);
  if (gp.status !== 'captured') throw new HttpError('payment_not_captured', 402);
  if (Math.round(gp.amountInr * 100) !== pay.amount * 100) throw new HttpError('amount_mismatch');

  const svc = serviceClient();
  const { data, error } = await svc.rpc('capture_payment', { p_order_id: b.order_id, p_payment_id: gp.id, p_method: gp.method, p_amount: pay.amount, p_via: 'checkout' });
  if (error) throw error;
  const res = data as { result: string; refund_id: string | null };
  if (res.result === 'refund_pending' && res.refund_id) await processRefund(svc, res.refund_id);
  return json(req, data);
});
