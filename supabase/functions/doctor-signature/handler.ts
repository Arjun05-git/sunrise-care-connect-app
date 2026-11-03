// Doctor's signature image: upload (PNG, PIN required) or fetch the current one for the profile page.
// Stored privately as signatures/<doctor id>.png and only ever placed on PDFs server-side.
import { corsHeaders, handler, HttpError, json, readJson, requireUser, serviceClient } from '../_shared/http.ts';

const MAX = 200 * 1024;

/** PNG magic + IHDR size check (no decoding). */
export function pngSize(b: Uint8Array): { w: number; h: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 33 || sig.some((v, i) => b[i] !== v)) return null;
  if (String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) !== 'IHDR') return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { w: dv.getUint32(16), h: dv.getUint32(20) };
}

export default handler(async (req) => {
  const { client, user } = await requireUser(req);
  const body = await readJson<{ action?: 'get' | 'upload'; png_base64?: string; pin?: string }>(req);
  const { data: doc } = await client.from('doctors').select('id').eq('profile_id', user.id).maybeSingle();
  if (!doc) throw new HttpError('forbidden', 403);
  const svc = serviceClient();

  if (body.action === 'get') {
    const { data } = await svc.storage.from('signatures').download(`${doc.id}.png`);
    if (!data) throw new HttpError('not_found', 404);
    return new Response(await data.arrayBuffer(), { headers: { ...corsHeaders(req), 'Content-Type': 'image/png' } });
  }

  const b64 = (body.png_base64 ?? '').replace(/^data:image\/png;base64,/, '');
  if (!b64 || b64.length > (MAX * 4) / 3 + 4) throw new HttpError('signature_invalid');
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    throw new HttpError('signature_invalid');
  }
  const size = pngSize(bytes);
  if (!size || size.w < 100 || size.h < 30 || size.w > 1600 || size.h > 800) throw new HttpError('signature_invalid');

  const { data: pin, error } = await client.rpc('verify_signing_pin', { p_pin: body.pin ?? '' });
  if (error) throw new HttpError('forbidden', 403);
  const chk = pin as { ok: boolean; error?: string; attempts_left?: number };
  if (!chk.ok) return json(req, chk, 403);

  const up = await svc.storage.from('signatures').upload(`${doc.id}.png`, bytes, { contentType: 'image/png', upsert: true });
  if (up.error) throw new Error('signature_store');
  await svc.rpc('record_signature', { p_doctor: doc.id });
  return json(req, { ok: true });
});
