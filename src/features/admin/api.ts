import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConsultMode, ConsultType } from '@/domain/types';
import { fromIst } from '@/domain/time';
import { callFunction } from '@/lib/functions';
import { getSupabase } from '@/lib/supabase';

/**
 * Admin / finance data. Reads go through RLS (staff policies); every change is an RPC that checks the
 * role, requires a reason and is audited with it (supabase/migrations/20261101000007_payments.sql).
 */
const sb = () => getSupabase();
async function unwrap<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw error;
  return data as T;
}

export const aqk = {
  fees: ['admin', 'fees'] as const,
  policy: ['admin', 'policy'] as const,
  overrides: ['admin', 'overrides'] as const,
  payments: (f: PaymentFilters) => ['admin', 'payments', f] as const,
};

// ---------------------------------------------------------------- fees
export interface FeeRow { id: string; scope: 'doctor' | 'department'; doctor_id: string | null; department_id: string | null; mode: ConsultMode; consult_type: ConsultType; amount: number }
export interface DoctorLite { id: string; full_name: string; department_id: string; modes: ConsultMode[]; verification_status: string; active: boolean }
export interface DepartmentLite { id: string; name: string; name_ml: string }

export function useFeeData() {
  return useQuery({
    queryKey: aqk.fees,
    queryFn: async () => {
      const [fees, doctors, departments] = await Promise.all([
        unwrap(sb().from('fee_config').select('*')),
        unwrap(sb().from('doctors').select('id, full_name, department_id, modes, verification_status, active').order('full_name')),
        unwrap(sb().from('departments').select('id, name, name_ml').order('name')),
      ]);
      return { fees: fees as FeeRow[], doctors: doctors as DoctorLite[], departments: departments as DepartmentLite[] };
    },
  });
}

/** Effective fee the booking engine will charge (doctor-specific → department; follow-up → first). */
export function effectiveFee(fees: FeeRow[], doctor: DoctorLite, mode: ConsultMode, type: ConsultType): { amount: number | null; source: 'doctor' | 'department' | 'fallback' | null; row?: FeeRow } {
  const find = (t: ConsultType) =>
    fees.find((f) => f.scope === 'doctor' && f.doctor_id === doctor.id && f.mode === mode && f.consult_type === t) ??
    fees.find((f) => f.scope === 'department' && f.department_id === doctor.department_id && f.mode === mode && f.consult_type === t);
  const direct = find(type);
  if (direct) return { amount: direct.amount, source: direct.scope, row: direct };
  if (type === 'follow_up') {
    const first = find('first');
    if (first) return { amount: first.amount, source: 'fallback' };
  }
  return { amount: null, source: null };
}

export function useSaveFee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (f: { scope: 'doctor' | 'department'; doctor_id?: string | null; department_id?: string | null; mode: ConsultMode; consult_type: ConsultType; amount: number; reason: string }) =>
      unwrap(sb().rpc('save_fee', { p_scope: f.scope, p_doctor: f.doctor_id ?? null, p_department: f.department_id ?? null, p_mode: f.mode, p_type: f.consult_type, p_amount: f.amount, p_reason: f.reason })),
    onSuccess: () => qc.invalidateQueries({ queryKey: aqk.fees }),
  });
}
export function useDeleteFee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => unwrap(sb().rpc('delete_fee', { p_id: id, p_reason: reason })),
    onSuccess: () => qc.invalidateQueries({ queryKey: aqk.fees }),
  });
}

// ---------------------------------------------------------------- policies
export type MatchRule = 'same_doctor' | 'same_department' | 'any';
export interface Policy { free_window_days: number; free_follow_up_count: number; match_rule: MatchRule; updated_at: string }
export interface Tier { min_hours_before: number; percent: number }

export function usePolicies() {
  return useQuery({
    queryKey: aqk.policy,
    queryFn: async () => {
      const [policy, tiers] = await Promise.all([
        unwrap(sb().from('follow_up_policy').select('*').eq('id', 1).single()),
        unwrap(sb().from('app_settings').select('value').eq('key', 'cancellation_tiers').single()),
      ]);
      return { policy: policy as unknown as Policy, tiers: (tiers as unknown as { value: Tier[] }).value };
    },
  });
}
export function useSavePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { window: number; count: number; match: MatchRule; reason: string }) =>
      unwrap(sb().rpc('update_follow_up_policy', { p_window_days: p.window, p_count: p.count, p_match: p.match, p_reason: p.reason })),
    onSuccess: () => qc.invalidateQueries({ queryKey: aqk.policy }),
  });
}
export function useSaveTiers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { tiers: Tier[]; reason: string }) => unwrap(sb().rpc('update_cancellation_tiers', { p_tiers: p.tiers, p_reason: p.reason })),
    onSuccess: () => qc.invalidateQueries({ queryKey: aqk.policy }),
  });
}

export interface OverrideRow {
  id: string; patient_id: string; doctor_id: string | null; free_count: number; valid_until: string; reason: string; created_at: string; revoked_at: string | null;
  patients: { full_name: string } | null; doctors: { full_name: string } | null;
}
export function useOverrides() {
  return useQuery({
    queryKey: aqk.overrides,
    queryFn: async () =>
      (await unwrap(sb().from('follow_up_overrides').select('*, patients(full_name), doctors(full_name)').is('revoked_at', null).gte('valid_until', new Date().toISOString()).order('created_at', { ascending: false }))) as OverrideRow[],
  });
}
export interface PatientHit { id: string; full_name: string; phone: string; his_mrn: string | null; date_of_birth: string }
export async function searchPatients(q: string): Promise<PatientHit[]> {
  const term = q.trim().replace(/[%,()*]/g, '');
  if (term.length < 2) return [];
  return (await unwrap(
    sb().from('patients').select('id, full_name, phone, his_mrn, date_of_birth').is('archived_at', null)
      .or(`full_name.ilike.%${term}%,phone.ilike.%${term}%,his_mrn.ilike.%${term}%`).order('full_name').limit(8),
  )) as PatientHit[];
}
export function useGrantOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (o: { patient_id: string; doctor_id: string | null; count: number; valid_until: string; reason: string }) =>
      unwrap(sb().rpc('grant_follow_up_override', { p_patient: o.patient_id, p_doctor: o.doctor_id, p_count: o.count, p_valid_until: o.valid_until, p_reason: o.reason })),
    onSuccess: () => qc.invalidateQueries({ queryKey: aqk.overrides }),
  });
}
export function useRevokeOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (o: { id: string; reason: string }) => unwrap(sb().rpc('revoke_follow_up_override', { p_id: o.id, p_reason: o.reason })),
    onSuccess: () => qc.invalidateQueries({ queryKey: aqk.overrides }),
  });
}

// ---------------------------------------------------------------- payments
export interface PaymentFilters { from: string; to: string; status?: string; q?: string }
export interface RefundRow { id: string; amount: number; reason: string; status: 'initiated' | 'processed' | 'failed'; provider_refund_id: string | null; failure_reason: string | null; created_at: string; processed_at: string | null }
export interface PaymentRow {
  id: string; appointment_id: string; provider: string; provider_order_id: string; provider_payment_id: string | null; amount: number; method: string | null;
  status: 'created' | 'authorized' | 'captured' | 'failed' | 'refunded' | 'partially_refunded'; settled: boolean; settlement_id: string | null; receipt_no: string | null;
  created_at: string; captured_at: string | null; failure_reason: string | null; verified_via: string | null;
  appointments: { ref_code: string; start_at: string; status: string; mode: ConsultMode; consult_type: ConsultType; patients: { full_name: string } | null; doctors: { full_name: string } | null } | null;
  refunds: RefundRow[];
}

/** IST day bounds → UTC ISO strings. */
const dayStart = (d: string) => fromIst(d, '00:00').toISOString();
const dayEnd = (d: string) => new Date(fromIst(d, '00:00').getTime() + 86_400_000).toISOString();

export function usePayments(f: PaymentFilters) {
  return useQuery({
    queryKey: aqk.payments(f),
    placeholderData: (p) => p,
    queryFn: async () => {
      let q = sb()
        .from('payments')
        .select('*, appointments!inner(ref_code, start_at, status, mode, consult_type, patients(full_name), doctors(full_name)), refunds(*)')
        .gte('created_at', dayStart(f.from)).lt('created_at', dayEnd(f.to))
        .order('created_at', { ascending: false }).limit(500);
      if (f.status) q = q.eq('status', f.status);
      const term = f.q?.trim().replace(/[%,()*]/g, '');
      // booking refs live on the appointment; ids / receipt numbers on the payment
      if (term && /^sc-/i.test(term)) q = q.ilike('appointments.ref_code', `%${term}%`);
      else if (term) q = q.or(`provider_order_id.ilike.%${term}%,provider_payment_id.ilike.%${term}%,receipt_no.ilike.%${term}%`);
      return (await unwrap(q)) as PaymentRow[];
    },
  });
}

export const refundedAmount = (p: Pick<PaymentRow, 'refunds'>) => p.refunds.filter((r) => r.status === 'processed').reduce((s, r) => s + r.amount, 0);
export const refundableAmount = (p: Pick<PaymentRow, 'refunds' | 'amount' | 'status'>) =>
  ['captured', 'partially_refunded'].includes(p.status) ? p.amount - p.refunds.filter((r) => r.status !== 'failed').reduce((s, r) => s + r.amount, 0) : 0;

export interface RefundQuote { rule: string; percent: number; amount: number; paid: number; refundable: number; hours_before: number }
export const refundQuote = async (appointmentId: string, by: 'patient' | 'admin') =>
  (await unwrap(sb().rpc('refund_quote', { p_appt: appointmentId, p_cancelled_by: by }))) as RefundQuote;

export interface RefundResponse { refund: RefundRow; result: { status: string } }
export const issueRefund = (paymentId: string, amount: number, reason: string) => callFunction<RefundResponse>('payments-refund', { payment_id: paymentId, amount, reason });
export const reprocessRefund = (refundId: string) => callFunction<RefundResponse>('payments-refund', { refund_id: refundId });
export const retryFailedRefund = async (refundId: string) => {
  await unwrap(sb().rpc('retry_refund', { p_refund: refundId }));
  return reprocessRefund(refundId);
};
export const cancelBooking = (appointmentId: string, reason: string) =>
  callFunction<{ amount: number; percent: number; refund: { status: string } | null }>('payments-refund', { appointment_id: appointmentId, cancel: true, reason });

export interface ReconRow {
  kind: 'payment' | 'refund'; at_ist: string; ref_code: string; receipt_no: string | null; provider: string; order_id: string; payment_id: string | null; refund_id: string | null;
  method: string | null; amount: number; payment_status: string; refund_status: string | null; settled: boolean; settlement_id: string | null; note: string | null;
}
export const reconciliation = async (from: string, to: string) => (await unwrap(sb().rpc('reconciliation_report', { p_from: from, p_to: to }))) as ReconRow[];
