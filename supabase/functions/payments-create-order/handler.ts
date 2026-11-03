// POST {appointment_id} → a gateway order for a pending, paid booking. The amount comes from the
// appointment (frozen at hold time), never from the client. Re-tapping "Pay" reuses the open order.
import { handler, HttpError, json, readJson, requireUser, rpcCode, serviceClient } from '../_shared/http.ts';
import { activeProviderName, providerFor, type ProviderName } from '../_shared/payments/index.ts';

interface Prep { appointment_id: string; ref_code: string; amount: number; existing_order_id: string | null; existing_provider: ProviderName | null; seconds_left: number; prefill: Record<string, string> }

export default handler(async (req) => {
  const { client } = await requireUser(req);
  const { appointment_id } = await readJson<{ appointment_id?: string }>(req);
  if (typeof appointment_id !== 'string') throw new HttpError('invalid_input');

  const { data, error } = await client.rpc('prepare_payment', { p_appt: appointment_id });
  if (error) throw new HttpError(rpcCode(error), error.message === 'not_found' ? 404 : 409);
  const prep = data as Prep;

  let name = prep.existing_provider ?? activeProviderName();
  let orderId = prep.existing_order_id;
  if (!orderId) {
    name = activeProviderName();
    const order = await providerFor(name).createOrder({ amountInr: prep.amount, receipt: prep.ref_code, notes: { ref: prep.ref_code } });
    const { data: row, error: e2 } = await serviceClient().rpc('register_payment_order', { p_appt: prep.appointment_id, p_provider: name, p_order_id: order.orderId, p_amount: prep.amount });
    if (e2) throw e2;
    orderId = (row as { provider_order_id: string }).provider_order_id; // a concurrent request may have won
    name = (row as { provider: ProviderName }).provider;
  }
  return json(req, {
    provider: name, key_id: providerFor(name).publicKey, order_id: orderId, amount: prep.amount, currency: 'INR',
    ref_code: prep.ref_code, seconds_left: prep.seconds_left, prefill: prep.prefill,
  });
});
