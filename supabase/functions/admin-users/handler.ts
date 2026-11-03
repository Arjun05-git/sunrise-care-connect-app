// Account provisioning from the admin console (needs the service role, so it runs here, never in the browser):
//   doctor_login  { doctor_id }                          admin / coordinator: phone login for a doctor record
//   invite_staff  { email, full_name, roles, reason }    admin: email login + invite to set a password
// Roles are then set AS THE CALLER through the audited RPCs, so the guards (two-person rule, own roles,
// last admin) and the audit trail apply exactly as in the console.
import { env } from '../_shared/env.ts';
import { handler, HttpError, json, readJson, requireUser, rpcCode, serviceClient } from '../_shared/http.ts';

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
const STAFF = ['admin', 'coordinator', 'finance'];

interface Body { action?: string; doctor_id?: string; email?: string; full_name?: string; roles?: string[]; reason?: string }

export default handler(async (req) => {
  const { client, user } = await requireUser(req);
  const body = await readJson<Body>(req);
  const svc = serviceClient();
  const allowed = async (roles: string[]) => (await client.rpc('am_staff', { p_roles: roles })).data === true;

  if (body.action === 'doctor_login') {
    if (!(await allowed(['admin', 'coordinator']))) throw new HttpError('forbidden', 403);
    const { data: doc } = await client.from('doctors').select('id, phone, full_name, profile_id').eq('id', body.doctor_id ?? '').maybeSingle();
    if (!doc) throw new HttpError('not_found', 404);
    if (doc.profile_id) throw new HttpError('login_exists', 409);
    if (!/^\+91[6-9]\d{9}$/.test(doc.phone ?? '')) throw new HttpError('invalid_phone');
    // an account that already exists for this number is reused only if it is unused (link_doctor_login checks)
    const { data: existing } = await svc.from('profiles').select('id').eq('phone', doc.phone).maybeSingle();
    let uid = existing?.id as string | undefined;
    if (!uid) {
      const { data, error } = await svc.auth.admin.createUser({ phone: doc.phone.slice(1), phone_confirm: true, user_metadata: { full_name: doc.full_name } });
      if (error || !data.user) throw new HttpError(/already|exists|registered/i.test(error?.message ?? '') ? 'phone_in_use' : 'auth_error', 409);
      uid = data.user.id;
    }
    const { error } = await svc.rpc('link_doctor_login', { p_doctor: doc.id, p_user: uid, p_actor: user.id });
    if (error) throw new HttpError(rpcCode(error), 409);
    return json(req, { ok: true });
  }

  if (body.action === 'invite_staff') {
    if (!(await allowed(['admin']))) throw new HttpError('forbidden', 403);
    const email = (body.email ?? '').trim().toLowerCase();
    const name = (body.full_name ?? '').trim();
    const roles = [...new Set(body.roles ?? [])];
    if (!EMAIL.test(email) || name.length < 3 || name.length > 120) throw new HttpError('invalid_input');
    if (!roles.length || roles.some((r) => !STAFF.includes(r))) throw new HttpError('invalid_input');
    if ((body.reason ?? '').trim().length < 5) throw new HttpError('reason_required');
    const { data: taken } = await svc.from('profiles').select('id').ilike('email', email).maybeSingle();
    if (taken) throw new HttpError('email_in_use', 409);

    const redirectTo = `${env('PUBLIC_APP_URL') ?? ''}/set-password`;
    let uid: string;
    let link: string | null = null;
    if (env('STAFF_INVITE_MODE') === 'link') {
      // local stack: no mail server – the link is shown to the admin once
      const { data, error } = await svc.auth.admin.generateLink({ type: 'invite', email, options: { data: { full_name: name }, redirectTo } });
      if (error || !data.user) throw new HttpError('auth_error', 409);
      uid = data.user.id;
      // built from the token hash: GoTrue's own action_link drops the /auth/v1 prefix behind a proxy
      const hashed = data.properties?.hashed_token;
      link = hashed ? `${env('SUPABASE_URL')}/auth/v1/verify?token=${hashed}&type=invite&redirect_to=${encodeURIComponent(redirectTo)}` : null;
    } else {
      const { data, error } = await svc.auth.admin.inviteUserByEmail(email, { data: { full_name: name }, redirectTo });
      if (error || !data.user) throw new HttpError('auth_error', 409);
      uid = data.user.id;
    }
    const { error } = await client.rpc('admin_set_staff_roles', { p_user: uid, p_roles: roles, p_reason: body.reason });
    if (error) {
      await svc.auth.admin.deleteUser(uid);
      throw new HttpError(rpcCode(error));
    }
    return json(req, { ok: true, user_id: uid, invite_link: link });
  }

  throw new HttpError('invalid_input');
});
