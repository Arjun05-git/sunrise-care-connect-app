// Sends due notifications. Service-role only: called every minute by the scheduler (pg_cron + pg_net on
// Supabase; the local gateway's timer here).
import { handler, HttpError, isServiceCall, json, serviceClient } from '../_shared/http.ts';
import { dispatch } from '../_shared/notify/service.ts';

export default handler(async (req) => {
  if (!isServiceCall(req)) throw new HttpError('forbidden', 403);
  return json(req, await dispatch(serviceClient()));
});
