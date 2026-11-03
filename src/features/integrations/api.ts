import { useQuery } from '@tanstack/react-query';
import { callFunction } from '@/lib/functions';
import { getSupabase } from '@/lib/supabase';

const sb = () => getSupabase();
async function unwrap<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw error;
  return data as T;
}

// ---------------------------------------------------------------- ABHA (patient side, behind abdm_enabled)
export const useAbdmEnabled = () =>
  useQuery({ queryKey: ['abdm', 'flag'], staleTime: 5 * 60_000, queryFn: async () => (await unwrap(sb().from('app_settings').select('value').eq('key', 'abdm_enabled').maybeSingle()) as { value: boolean } | null)?.value === true });
export interface AbhaLink { abha_number: string | null; abha_address: string | null; abha_verified_at: string | null }
export const useAbha = (patientId: string) =>
  useQuery({ queryKey: ['abdm', 'patient', patientId], queryFn: async () => (await unwrap(sb().from('patients').select('abha_number, abha_address, abha_verified_at').eq('id', patientId).single())) as AbhaLink });
export const startAbha = (patientId: string, id: string, method: 'aadhaar_otp' | 'mobile_otp') => callFunction<{ txn: string }>('abha', { action: 'start', patient_id: patientId, id, method });
export const confirmAbha = (txn: string, otp: string) => callFunction<{ ok: boolean; abha_number: string; abha_address: string | null; name: string }>('abha', { action: 'confirm', txn, otp });
export const unlinkAbha = (patientId: string) => unwrap(sb().rpc('unlink_abha', { p_patient: patientId }));

// ---------------------------------------------------------------- admin
export type IntegrationSystem = 'his' | 'leadsquared' | 'abdm';
export interface IntegrationStats {
  flags: Record<IntegrationSystem, boolean>;
  by_system: Partial<Record<IntegrationSystem, { queued: number; sent: number; failed: number; skipped: number; last_sent_at: string | null }>>;
  doctor_sync: { at: string; rows: number; matched: number; linked: number; unmatched: string[]; conflicts: { his_doctor_code: string; issue: string }[] } | null;
}
export interface IntegrationEvent {
  id: string; system: IntegrationSystem; kind: string; entity_id: string; event: string | null; idempotency_key: string; status: string;
  attempts: number; next_attempt_at: string; last_error: string | null; external_ref: string | null; created_at: string; sent_at: string | null;
}
export const useIntegrationStats = () => useQuery({ queryKey: ['integrations', 'stats'], queryFn: () => unwrap<IntegrationStats>(sb().rpc('admin_integration_stats')), refetchInterval: 30_000 });
export const useIntegrationEvents = (f: { system?: string; status?: string; page: number }) =>
  useQuery({ queryKey: ['integrations', 'events', f], queryFn: () => unwrap<{ total: number; rows: IntegrationEvent[] }>(sb().rpc('admin_integration_events', { p: { system: f.system, status: f.status, limit: 50, offset: f.page * 50 } })) });
export const retryIntegration = (id: string) => unwrap(sb().rpc('admin_retry_integration', { p_id: id }));
export const setIntegrations = (his: boolean, leadsquared: boolean, abdm: boolean, reason: string) =>
  unwrap(sb().rpc('admin_set_integrations', { p_his: his, p_leadsquared: leadsquared, p_abdm: abdm, p_reason: reason }));
