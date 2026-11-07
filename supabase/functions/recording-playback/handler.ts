// Plays a consultation recording for its treating doctor: open_recording() authorises as the calling user and writes the audit entry,
// then the parts are joined once into joined.webm (cached) and a short-lived signed link is returned. The storage path never reaches the client.
import { handler, HttpError, json, readJson, requireUser, rpcCode, serviceClient } from '../_shared/http.ts';
import { joinParts, orderedParts } from '../_shared/recording.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = 'consult-recordings';
const LINK_SECONDS = 300;

export default handler(async (req) => {
  const { client } = await requireUser(req);
  const { recording_id } = await readJson<{ recording_id?: string }>(req);
  if (!recording_id || !UUID.test(recording_id)) throw new HttpError('invalid_input');

  const { data, error } = await client.rpc('open_recording', { p_rec: recording_id });
  if (error) {
    const code = rpcCode(error);
    if (code === 'not_found') throw new HttpError(code, 404);
    if (code === 'not_ready') throw new HttpError(code, 409);
    throw new HttpError('upstream_error', 502);
  }
  const prefix = (data as { storage_prefix: string }).storage_prefix;

  const store = serviceClient().storage.from(BUCKET);
  const listed = await store.list(prefix.replace(/\/$/, ''), { limit: 10000 });
  if (listed.error) throw new HttpError('upstream_error', 502);
  const names = listed.data.map((o) => o.name);
  if (!names.includes('joined.webm')) {
    let parts: string[];
    try { parts = orderedParts(names); } catch { throw new HttpError('parts_missing', 409); }
    const whole = await joinParts(prefix, parts, async (path) => {
      const r = await store.download(path);
      if (r.error) throw new HttpError('upstream_error', 502);
      return new Uint8Array(await r.data.arrayBuffer());
    });
    const up = await store.upload(prefix + 'joined.webm', whole, { contentType: 'audio/webm', upsert: false });
    if (up.error && !/exists|duplicate/i.test(up.error.message)) throw new HttpError('upstream_error', 502);
  }
  const signed = await store.createSignedUrl(prefix + 'joined.webm', LINK_SECONDS);
  if (signed.error || !signed.data) throw new HttpError('upstream_error', 502);
  return json(req, { url: signed.data.signedUrl, expires_in: LINK_SECONDS, mime_type: 'audio/webm' });
});
