// ABHA verification + linking (optional for patients; only while app_settings.abdm_enabled is true):
//   { action: "start", patient_id, id, method }  → OTP sent by ABDM; returns a signed, 10-minute transaction
//   { action: "confirm", txn, otp }              → ABDM returns the verified profile → linked to that patient
// The transaction is bound to the signed-in account and the patient, so it can't be replayed for another.
import { handler, HttpError, json, readJson, requireUser, rpcCode, serviceClient } from '../_shared/http.ts';
import { normaliseAbha } from '../_shared/integrations/abdm.ts';
import { openTxn, sealTxn } from '../_shared/integrations/txn.ts';
import { integrationAdaptersFromEnv } from '../_shared/integrations/service.ts';
import { AdapterError, type AbhaMethod } from '../_shared/integrations/types.ts';

export default handler(async (req) => {
  const { client, user } = await requireUser(req);
  const svc = serviceClient();
  const { data: flag } = await svc.from('app_settings').select('value').eq('key', 'abdm_enabled').maybeSingle();
  if (flag?.value !== true) throw new HttpError('abdm_disabled', 403);
  const abdm = integrationAdaptersFromEnv().abdm;
  if (!abdm) throw new HttpError('not_configured', 503);
  const body = await readJson<{ action?: string; patient_id?: string; id?: string; method?: AbhaMethod; txn?: string; otp?: string }>(req);

  try {
    if (body.action === 'start') {
      // RLS: only the caller's own (family) patients are visible
      const { data: pt } = await client.from('patients').select('id').eq('id', body.patient_id ?? '').is('archived_at', null).maybeSingle();
      if (!pt) throw new HttpError('not_found', 404);
      if (!normaliseAbha(body.id ?? '')) throw new HttpError('invalid_abha');
      const method: AbhaMethod = body.method === 'aadhaar_otp' ? 'aadhaar_otp' : 'mobile_otp';
      const { txnId } = await abdm.startVerification({ id: body.id!, method });
      return json(req, { txn: await sealTxn({ txn: txnId, patient: pt.id, user: user.id, exp: Date.now() + 10 * 60_000 }) });
    }
    if (body.action === 'confirm') {
      const t = await openTxn(body.txn ?? '');
      if (!t || t.user !== user.id) throw new HttpError('txn_expired');
      if (!/^\d{6}$/.test(body.otp ?? '')) throw new HttpError('invalid_otp');
      const profile = await abdm.confirmVerification({ txnId: t.txn, otp: body.otp! });
      const { error } = await svc.rpc('link_abha', { p_patient: t.patient, p_number: profile.abha_number, p_address: profile.abha_address, p_actor: user.id });
      if (error) throw new HttpError(rpcCode(error), 409);
      return json(req, { ok: true, abha_number: profile.abha_number, abha_address: profile.abha_address, name: profile.name });
    }
  } catch (e) {
    if (e instanceof AdapterError) throw new HttpError(e.code, e.permanent ? 400 : 502);
    throw e;
  }
  throw new HttpError('invalid_input');
});
