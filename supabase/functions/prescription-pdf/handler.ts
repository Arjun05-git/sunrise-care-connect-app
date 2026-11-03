// Prescription PDF for the signed-in user. Access is decided by RLS on `prescriptions` read AS THE USER:
// patients get their family's final prescriptions, doctors their own (incl. draft previews) and final
// prescriptions of patients they treat. The file itself is read / written with the service role.
import { corsHeaders, handler, HttpError, readJson, requireUser, serviceClient } from '../_shared/http.ts';
import { prescriptionPdf, UUID } from '../_shared/rx.ts';

export default handler(async (req) => {
  const { client } = await requireUser(req);
  const { prescription_id } = await readJson<{ prescription_id?: string }>(req);
  if (!prescription_id || !UUID.test(prescription_id)) throw new HttpError('invalid_input');
  const { data: row } = await client.from('prescriptions').select('id').eq('id', prescription_id).maybeSingle();
  if (!row) throw new HttpError('not_found', 404);
  const { bytes, fileName } = await prescriptionPdf(serviceClient(), prescription_id);
  return new Response(bytes as BodyInit, {
    headers: { ...corsHeaders(req), 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${fileName}"` },
  });
});
