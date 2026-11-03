// Integration dispatcher: claims due outbox events, builds each payload with integration_payload() (which
// re-checks consent and flags), sends through the adapter and records the outcome. Runs every minute
// (pg_cron → pg_net on Supabase; the local gateway's timer). The doctor master is pulled nightly.
import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '../env.ts';
import { HttpAbdmAdapter, MockAbdmAdapter } from './abdm.ts';
import { HttpHisAdapter, MockHisAdapter } from './his.ts';
import { HttpLeadSquaredAdapter, MockLeadSquaredAdapter } from './leadsquared.ts';
import { AdapterError, type AbdmAdapter, type HisAdapter, type LeadSquaredAdapter, type SendOutcome } from './types.ts';

export interface Adapters { his?: HisAdapter; leadsquared?: LeadSquaredAdapter; abdm?: AbdmAdapter }

/** INTEGRATIONS_PROVIDER=mock (local stack, tests) uses the mocks; otherwise each system needs its keys. */
export function integrationAdaptersFromEnv(): Adapters {
  if (env('INTEGRATIONS_PROVIDER') === 'mock') {
    return { his: new MockHisAdapter(MOCK_DOCTOR_MASTER), leadsquared: new MockLeadSquaredAdapter(), abdm: new MockAbdmAdapter() };
  }
  const a: Adapters = {};
  if (env('HIS_BASE_URL') && env('HIS_API_KEY')) a.his = new HttpHisAdapter({ baseUrl: env('HIS_BASE_URL')!, apiKey: env('HIS_API_KEY')!, facilityId: env('HIS_FACILITY_ID') ?? '' });
  if (env('LSQ_HOST') && env('LSQ_ACCESS_KEY') && env('LSQ_SECRET_KEY')) {
    a.leadsquared = new HttpLeadSquaredAdapter({ host: env('LSQ_HOST')!, accessKey: env('LSQ_ACCESS_KEY')!, secretKey: env('LSQ_SECRET_KEY')!,
      activityCodes: JSON.parse(env('LSQ_ACTIVITY_CODES') ?? '{}') });
  }
  if (env('ABDM_CLIENT_ID') && env('ABDM_CLIENT_SECRET') && env('ABDM_PUBLIC_KEY_PEM')) {
    a.abdm = new HttpAbdmAdapter({ gatewayUrl: env('ABDM_GATEWAY_URL') ?? 'https://dev.abdm.gov.in/gateway', abhaUrl: env('ABDM_ABHA_URL') ?? 'https://abhasbx.abdm.gov.in/abha/api',
      clientId: env('ABDM_CLIENT_ID')!, clientSecret: env('ABDM_CLIENT_SECRET')!, publicKeyPem: env('ABDM_PUBLIC_KEY_PEM')! });
  }
  return a;
}

/** The local mock HIS knows two seeded doctors' registrations so the nightly match can be seen working. */
const MOCK_DOCTOR_MASTER = [
  { his_doctor_code: 'SUN-DR-0001', registration_no: 'TCMC/40000', name: 'Dr. Arun Nair' },
  { his_doctor_code: 'SUN-DR-9999', registration_no: 'TCMC/UNKNOWN', name: 'Not in Care Connect' },
];

interface EventRow { id: string; system: 'his' | 'leadsquared' | 'abdm'; kind: string; entity_id: string; attempts: number }
export interface IntegrationReport { claimed: number; sent: number; retry: number; failed: number; skipped: number; waiting: number }

export async function send(a: Adapters, ev: EventRow, payload: Record<string, unknown>): Promise<SendOutcome> {
  try {
    if (ev.system === 'leadsquared') {
      if (!a.leadsquared) return { ok: false, error: 'not_configured', permanent: true };
      return await a.leadsquared.captureEvent(payload as never);
    }
    if (ev.system !== 'his') return { ok: false, error: 'unknown_system', permanent: true };
    if (!a.his) return { ok: false, error: 'not_configured', permanent: true };
    switch (ev.kind) {
      case 'patient_upsert': return await a.his.upsertPatient(payload as never);
      case 'consultation_summary': return await a.his.pushConsultationSummary(payload as never);
      case 'prescription': return await a.his.pushPrescription(payload as never);
      case 'billing_payment': return await a.his.postBilling(payload as never);
      case 'billing_refund': return await a.his.postRefund(payload as never);
      default: return { ok: false, error: 'unknown_kind', permanent: true };
    }
  } catch (e) {
    if (e instanceof AdapterError) return { ok: false, error: e.code, permanent: e.permanent };
    return { ok: false, error: `exception:${(e as Error).message}`.slice(0, 120), permanent: false };
  }
}

export async function dispatchIntegrations(svc: SupabaseClient, a = integrationAdaptersFromEnv(), batch = 50): Promise<IntegrationReport> {
  const report: IntegrationReport = { claimed: 0, sent: 0, retry: 0, failed: 0, skipped: 0, waiting: 0 };
  const { data, error } = await svc.rpc('claim_integration_events', { p_limit: batch });
  if (error) throw new Error(`claim: ${error.message}`);
  const events = (data ?? []) as EventRow[];
  report.claimed = events.length;
  // patient masters first, so clinical / billing events in the same batch find the MRN
  events.sort((x, y) => Number(y.kind === 'patient_upsert') - Number(x.kind === 'patient_upsert'));
  for (const ev of events) {
    const { data: payload } = await svc.rpc('integration_payload', { p_id: ev.id });
    const p = (payload ?? { skip: 'no_payload' }) as Record<string, unknown>;
    if (p.skip) {
      await svc.rpc('fail_integration_event', { p_id: ev.id, p_error: String(p.skip), p_mode: 'skip' });
      report.skipped++;
      continue;
    }
    if (p.wait) {
      await svc.rpc('ensure_patient_upsert', { p_patient: p.patient_id });
      await svc.rpc('fail_integration_event', { p_id: ev.id, p_error: String(p.wait), p_mode: 'wait' });
      report.waiting++;
      continue;
    }
    const res = await send(a, ev, p);
    if (res.ok) {
      await svc.rpc('complete_integration_event', { p_id: ev.id, p_external_ref: res.externalRef, p_result: res.result ?? {} });
      report.sent++;
    } else {
      const { data: st } = await svc.rpc('fail_integration_event', { p_id: ev.id, p_error: res.error, p_mode: res.permanent ? 'permanent' : 'temporary' });
      if (st === 'queued') report.retry++;
      else report.failed++;
    }
  }
  return report;
}

/** Nightly: pull the HIS doctor master and match codes (never creates doctors or changes verification). */
export async function syncDoctorMaster(svc: SupabaseClient, a = integrationAdaptersFromEnv()) {
  const { data: on } = await svc.from('app_settings').select('value').eq('key', 'integrations').maybeSingle();
  if (!(on?.value as { his?: boolean } | undefined)?.his) return { skipped: 'integration_off' };
  if (!a.his) return { skipped: 'not_configured' };
  const rows = await a.his.fetchDoctorMaster();
  const { data, error } = await svc.rpc('his_apply_doctor_master', { p_rows: rows });
  if (error) throw new Error(`doctor_master: ${error.message}`);
  return data;
}
