// Refunds.
//   {payment_id, amount, reason}       admin / finance: full or partial refund (rules in request_refund)
//   {appointment_id, cancel: true, reason}  patient or admin / coordinator cancels; refund per policy
//   {refund_id}                        (re)process a queued refund the caller can see
//   {sweep: true}                      service key only: retry queued / abandoned refunds (cron)
import { handler, HttpError, isServiceCall, json, readJson, requireUser, rpcCode, serviceClient } from '../_shared/http.ts';
import { processRefund } from '../_shared/refunds.ts';

interface Body { payment_id?: string; amount?: number; reason?: string; refund_id?: string; appointment_id?: string; cancel?: boolean; sweep?: boolean }

export default handler(async (req) => {
  const b = await readJson<Body>(req);
  const svc = serviceClient();

  if (b.sweep) {
    if (!isServiceCall(req)) throw new HttpError('forbidden', 403);
    const { data: ids } = await svc.rpc('pending_refunds');
    const results = [];
    for (const id of (ids as string[] | null) ?? []) results.push({ id, ...(await processRefund(svc, id)) });
    return json(req, { processed: results.length, results });
  }

  const { client } = await requireUser(req);
  if (b.cancel && typeof b.appointment_id === 'string') {
    const { data, error } = await client.rpc('cancel_appointment', { p_appt: b.appointment_id, p_reason: b.reason ?? '' });
    if (error) throw new HttpError(rpcCode(error), 409);
    const q = data as { refund_id: string | null };
    const refund = q.refund_id ? await processRefund(svc, q.refund_id) : null;
    return json(req, { ...q, refund });
  }

  let refundId = b.refund_id;
  if (typeof b.payment_id === 'string') {
    const { data, error } = await client.rpc('request_refund', { p_payment: b.payment_id, p_amount: b.amount, p_reason: b.reason ?? '' });
    if (error) throw new HttpError(rpcCode(error), error.message === 'forbidden' ? 403 : 409);
    refundId = (data as { id: string }).id;
  } else if (typeof refundId === 'string') {
    const { data } = await client.from('refunds').select('id').eq('id', refundId).maybeSingle(); // RLS visibility check
    if (!data) throw new HttpError('not_found', 404);
  } else throw new HttpError('invalid_input');

  const result = await processRefund(svc, refundId!);
  const { data: row } = await client.from('refunds').select('id, amount, status, provider_refund_id, failure_reason').eq('id', refundId!).single();
  return json(req, { refund: row, result });
});
