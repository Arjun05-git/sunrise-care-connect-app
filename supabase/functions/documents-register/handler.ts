// POST {document_id, patient_id, ext, tag, file_name} after the browser uploaded the file to
// medical-documents/patients/<patient>/<document>.<ext> (storage RLS: own family or a treating doctor).
// The file is read back here and checked by its bytes; a bad file is deleted, a good one registered with the
// server's type and size. Clients can no longer insert document rows themselves.
import { handler, HttpError, json, readJson, requireUser, rpcCode, serviceClient } from '../_shared/http.ts';
import { checkUpload } from '../_shared/filetype.ts';
import { UUID } from '../_shared/rx.ts';

const TAGS = ['lab_report', 'imaging', 'prescription', 'discharge_summary', 'photo', 'other'];

export default handler(async (req) => {
  const { client, user } = await requireUser(req);
  const b = await readJson<{ document_id?: string; patient_id?: string; ext?: string; tag?: string; file_name?: string }>(req);
  if (!UUID.test(b.document_id ?? '') || !UUID.test(b.patient_id ?? '') || !['pdf', 'jpg', 'png'].includes(b.ext ?? '') || !TAGS.includes(b.tag ?? '')) {
    throw new HttpError('invalid_input');
  }
  const path = `patients/${b.patient_id}/${b.document_id}.${b.ext}`;
  // ownership first (RLS as the caller): the service role below may delete the file, so never act on a
  // path the caller couldn't see
  const { data: pt } = await client.from('patients').select('id').eq('id', b.patient_id!).maybeSingle();
  if (!pt) throw new HttpError('not_found', 404);
  const svc = serviceClient();
  const store = svc.storage.from('medical-documents');
  const { data: blob, error } = await store.download(path);
  if (error || !blob) throw new HttpError('file_missing', 404);
  const verdict = checkUpload(new Uint8Array(await blob.arrayBuffer()), b.ext!, blob.type);
  if (!verdict.ok) {
    await store.remove([path]);
    throw new HttpError(verdict.error === 'size' ? 'size' : verdict.error === 'active_content' ? 'active_content' : 'type');
  }
  const { data, error: e2 } = await svc.rpc('register_document', {
    p_id: b.document_id, p_patient: b.patient_id, p_user: user.id, p_tag: b.tag, p_file_name: String(b.file_name ?? '').slice(0, 120),
    p_mime: verdict.mime, p_size: verdict.size, p_path: path,
  });
  if (e2) {
    const code = rpcCode(e2);
    throw new HttpError(code, code === 'forbidden' ? 403 : 400);
  }
  return json(req, data);
});
