// Issues video-room credentials for one consultation. The join window, participant check, room creation,
// joined-at timestamps and the 'join' call log all happen in join_consult() as the calling user (RLS applies).
import { handler, HttpError, json, readJson, requireUser, rpcCode } from '../_shared/http.ts';
import { activeVideoProvider, issueCredentials, type JoinResult } from '../_shared/video/index.ts';

const JOIN_ERRORS = ['not_joinable', 'too_early', 'window_closed', 'invalid_input', 'rate_limited'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default handler(async (req) => {
  const { client } = await requireUser(req);
  const { appointment_id } = await readJson<{ appointment_id?: string }>(req);
  if (!appointment_id || !UUID.test(appointment_id)) throw new HttpError('invalid_input');
  const provider = activeVideoProvider();
  const { data, error } = await client.rpc('join_consult', { p_appt: appointment_id, p_provider: provider });
  if (error) {
    const code = rpcCode(error);
    if (code === 'not_found') throw new HttpError(code, 404);
    if (JOIN_ERRORS.includes(code)) throw new HttpError(code, 409);
    throw new HttpError('upstream_error', 502); // transient – the client retries
  }
  return json(req, await issueCredentials(provider, data as JoinResult));
});
