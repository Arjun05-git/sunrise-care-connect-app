// POST {payment_id} → receipt PDF, rendered on the server. receipt_data() decides who may see it.
import { corsHeaders, handler, HttpError, readJson, requireUser } from '../_shared/http.ts';
import { renderReceipt, type ReceiptData } from '../_shared/receipt.ts';

export default handler(async (req) => {
  const { client } = await requireUser(req);
  const { payment_id } = await readJson<{ payment_id?: string }>(req);
  if (typeof payment_id !== 'string') throw new HttpError('invalid_input');
  const { data, error } = await client.rpc('receipt_data', { p_payment: payment_id });
  if (error || !data) throw new HttpError('not_found', 404);
  const d = data as ReceiptData;
  const pdf = await renderReceipt(d);
  return new Response(pdf as BodyInit, {
    headers: { ...corsHeaders(req), 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${d.receipt_no}.pdf"` },
  });
});
