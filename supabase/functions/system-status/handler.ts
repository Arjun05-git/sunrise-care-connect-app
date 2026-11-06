// Admin-only: which providers are simulated (mock), test (sandbox) or real (live), and which environment the DATABASE
// says this is (app.environment, migration 019). Reports modes and short codes only - never a configured value.
// In production it also lists what is not live, so a mock left switched on is visible instead of silent.
import { env } from '../_shared/env.ts';
import { handler, HttpError, json, requireUser } from '../_shared/http.ts';
import { systemStatus } from '../_shared/status.ts';

export default handler(async (req) => {
  const { client } = await requireUser(req);
  if ((await client.rpc('am_staff', { p_roles: ['admin'] })).data !== true) throw new HttpError('forbidden', 403);
  const { data: policy } = await client.rpc('auth_policy');
  // only an explicit demo database is demo; anything unclear is production (same rule as the database)
  const environment = (policy as { environment?: string } | null)?.environment === 'demo' ? 'demo' : 'production';
  return json(req, systemStatus(env, environment));
});
