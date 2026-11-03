// Sends due HIS / LeadSquared events ({}) or pulls the HIS doctor master ({"job":"doctor_master"}, nightly).
// Service-role only: called by the scheduler (pg_cron + pg_net on Supabase; the local gateway's timer).
import { handler, HttpError, isServiceCall, json, readJson, serviceClient } from '../_shared/http.ts';
import { dispatchIntegrations, syncDoctorMaster } from '../_shared/integrations/service.ts';

export default handler(async (req) => {
  if (!isServiceCall(req)) throw new HttpError('forbidden', 403);
  const body = await readJson<{ job?: string }>(req).catch(() => ({}) as { job?: string });
  const svc = serviceClient();
  if (body.job === 'doctor_master') return json(req, await syncDoctorMaster(svc));
  return json(req, await dispatchIntegrations(svc));
});
