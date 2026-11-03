import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Appointment, AppointmentSymptoms, ConsultMode, MedicalDocument, Patient, Slot } from '@/domain/types';
import { addDaysKey, fromIst } from '@/domain/time';
import { getSupabase } from '@/lib/supabase';
import { useAuth } from '@/auth/AuthProvider';

/**
 * Doctor data. RLS limits every read to the doctor's own appointments and the patients they treat
 * (supabase/migrations/20261101000002_rls.sql); every change is an RPC with its own checks
 * (supabase/migrations/20261101000008_doctor.sql).
 */
const sb = () => getSupabase();
async function unwrap<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw error;
  return data as T;
}

export const dqk = {
  me: ['doctor', 'me'] as const,
  range: (from: string, to: string) => ['doctor', 'appts', from, to] as const,
  appts: ['doctor', 'appts'] as const,
  appointment: (id: string) => ['doctor', 'appointment', id] as const,
  availability: ['doctor', 'availability'] as const,
  daySlots: (day: string) => ['doctor', 'day-slots', day] as const,
  patients: ['doctor', 'patients'] as const,
  timeline: (id: string) => ['doctor', 'timeline', id] as const,
};

export interface MyDoctor { id: string; full_name: string; slot_minutes: number; modes: ConsultMode[]; photo_url: string; hospitals: { name: string; city: string } | null; departments: { name: string; name_ml: string } | null }

export function useMyDoctor() {
  const { session } = useAuth();
  return useQuery({
    queryKey: dqk.me,
    enabled: !!session,
    staleTime: 10 * 60_000,
    queryFn: async () =>
      (await unwrap(sb().from('doctors').select('id, full_name, slot_minutes, modes, photo_url, hospitals(name, city), departments(name, name_ml)').eq('profile_id', session!.user.id).single())) as unknown as MyDoctor,
  });
}

export interface RescheduleRow {
  id: string; appointment_id: string; requested_by: string; proposed_slot_id: string | null; proposed_start_at: string | null; reason: string;
  status: 'pending' | 'accepted' | 'declined' | 'alternate_booked' | 'refund_requested' | 'expired'; response_note: string | null;
  new_appointment_id: string | null; created_at: string; responded_at: string | null; respond_by: string | null;
}
export type DoctorAppt = Appointment & {
  patients: Pick<Patient, 'id' | 'full_name' | 'date_of_birth' | 'gender' | 'allergies'> | null;
  reschedule_requests: RescheduleRow[];
};

const LIST_SELECT = '*, patients(id, full_name, date_of_birth, gender, allergies), reschedule_requests!reschedule_requests_appointment_id_fkey(*)';

/** The doctor's bookings between two IST dates (inclusive). Unpaid holds are not shown. */
export function useDoctorAppointments(fromKey: string, toKey: string, doctorId: string | undefined) {
  return useQuery({
    queryKey: dqk.range(fromKey, toKey),
    enabled: !!doctorId,
    queryFn: async () =>
      (await unwrap(
        sb().from('appointments').select(LIST_SELECT).eq('doctor_id', doctorId!).neq('status', 'pending_payment')
          .gte('start_at', fromIst(fromKey, '00:00').toISOString()).lt('start_at', fromIst(addDaysKey(toKey, 1), '00:00').toISOString())
          .order('start_at'),
      )) as DoctorAppt[],
  });
}

export type DoctorApptDetail = DoctorAppt & {
  patients: Patient | null;
  appointment_symptoms: AppointmentSymptoms | null;
  documents: MedicalDocument[];
};
export function useDoctorAppointment(id: string) {
  return useQuery({
    queryKey: dqk.appointment(id),
    queryFn: async () =>
      (await unwrap(sb().from('appointments').select('*, patients(*), appointment_symptoms(*), documents(*), reschedule_requests!reschedule_requests_appointment_id_fkey(*)').eq('id', id).maybeSingle())) as DoctorApptDetail | null,
  });
}

/** Open slots on one IST day (for a same-day reschedule proposal). */
export function useDaySlots(doctorId: string | undefined, dayKey: string) {
  return useQuery({
    queryKey: dqk.daySlots(dayKey),
    enabled: !!doctorId,
    staleTime: 0, // always fresh when the proposal dialog opens
    refetchOnMount: 'always',
    queryFn: async () =>
      (await unwrap(
        sb().from('slots').select('id, doctor_id, start_at, end_at, status, held_until, appointment_id').eq('doctor_id', doctorId!)
          .gte('start_at', fromIst(dayKey, '00:00').toISOString()).lt('start_at', fromIst(addDaysKey(dayKey, 1), '00:00').toISOString()).order('start_at'),
      )) as Slot[],
  });
}

// ---------------------------------------------------------------- actions
function useAction<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ['doctor'] }) });
}
export const useRecordOutcome = () =>
  useAction((v: { id: string; outcome: 'completed' | 'patient_no_show' | 'technical_failure'; note?: string }) => unwrap(sb().rpc('record_outcome', { p_appt: v.id, p_outcome: v.outcome, p_note: v.note ?? null })));
export const useProposeReschedule = () =>
  useAction((v: { id: string; slotId: string; reason: string }) => unwrap(sb().rpc('propose_reschedule', { p_appt: v.id, p_slot: v.slotId, p_reason: v.reason })));
export const useWithdrawReschedule = () => useAction((reqId: string) => unwrap(sb().rpc('withdraw_reschedule', { p_req: reqId })));
export const useDoctorCancel = () => useAction((v: { id: string; reason: string }) => unwrap(sb().rpc('doctor_cancel', { p_appt: v.id, p_reason: v.reason })));

// ---------------------------------------------------------------- availability
export interface AvailabilityRow { id: string; kind: 'weekly' | 'block'; weekday: number | null; start_time: string; end_time: string; block_date_from: string | null; block_date_to: string | null; reason: string | null }
export interface Clash { appointment_id: string; ref_code: string; start_at: string; patient_name: string }

export function useAvailability(doctorId: string | undefined) {
  return useQuery({
    queryKey: dqk.availability,
    enabled: !!doctorId,
    queryFn: async () => {
      const [rows, clashes] = await Promise.all([
        unwrap(sb().from('doctor_availability').select('*').eq('doctor_id', doctorId!).order('weekday').order('start_time')),
        unwrap(sb().rpc('availability_clashes')),
      ]);
      return { rows: rows as AvailabilityRow[], clashes: clashes as Clash[] };
    },
  });
}
export const useSaveWeeklyHours = () =>
  useAction((rows: { weekday: number; start: string; end: string }[]) => unwrap(sb().rpc('save_weekly_hours', { p_rows: rows })) as Promise<number>);
export const useAddLeave = () =>
  useAction((v: { from: string; to: string; start: string | null; end: string | null; reason: string }) =>
    unwrap(sb().rpc('add_leave', { p_from: v.from, p_to: v.to, p_start: v.start, p_end: v.end, p_reason: v.reason })) as Promise<number>);
export const useRemoveLeave = () => useAction((id: string) => unwrap(sb().rpc('remove_leave', { p_id: id })));

// ---------------------------------------------------------------- patients
export interface PatientSummary { patient: Pick<Patient, 'id' | 'full_name' | 'date_of_birth' | 'gender' | 'his_mrn'>; visits: number; last: string; next: string | null }

/** Patients the doctor has consulted or will consult (derived from their own appointments). */
export function useMyPatients(doctorId: string | undefined) {
  return useQuery({
    queryKey: dqk.patients,
    enabled: !!doctorId,
    queryFn: async () => {
      const rows = (await unwrap(
        sb().from('appointments').select('start_at, status, patients(id, full_name, date_of_birth, gender, his_mrn)').eq('doctor_id', doctorId!)
          .in('status', ['confirmed', 'in_progress', 'completed', 'no_show']).order('start_at', { ascending: false }).limit(1000),
      )) as unknown as { start_at: string; status: string; patients: PatientSummary['patient'] }[];
      const now = new Date().toISOString();
      const map = new Map<string, PatientSummary>();
      for (const r of rows) {
        if (!r.patients) continue;
        const cur = map.get(r.patients.id) ?? { patient: r.patients, visits: 0, last: '', next: null };
        if (r.start_at <= now) { cur.visits += r.status === 'completed' ? 1 : 0; if (!cur.last || r.start_at > cur.last) cur.last = r.start_at; }
        else if (!cur.next || r.start_at < cur.next) cur.next = r.start_at;
        map.set(r.patients.id, cur);
      }
      return [...map.values()].sort((a, b) => (b.next ?? b.last).localeCompare(a.next ?? a.last));
    },
  });
}

export interface RxRow { id: string; appointment_id: string; doctor_id: string; version: number; diagnoses: { code?: string; label?: string; name?: string }[]; advice: string; finalized_at: string | null; status: string; doctors: { full_name: string } | null; prescription_items: { drug_name: string; strength: string; dose: string; frequency: string; duration: string }[] }
export interface ConsultNote { id: string; appointment_id: string; chief_complaint: string; diagnoses: { code?: string; label?: string; name?: string }[]; advice: string; status: string; updated_at: string }
export interface Timeline {
  patient: Patient;
  appointments: (Appointment & { appointment_symptoms: Pick<AppointmentSymptoms, 'description' | 'symptoms' | 'severity'> | null; doctors: { full_name: string } | null })[];
  prescriptions: RxRow[];
  notes: ConsultNote[];
  documents: MedicalDocument[];
}

/** Everything this doctor may see about a patient, newest first. Opening it is audited. */
export function usePatientTimeline(patientId: string) {
  return useQuery({
    queryKey: dqk.timeline(patientId),
    queryFn: async () => {
      await unwrap(sb().rpc('audit_patient_view', { p_patient: patientId }));
      const [patient, appointments, prescriptions, notes, documents] = await Promise.all([
        unwrap(sb().from('patients').select('*').eq('id', patientId).single()),
        unwrap(sb().from('appointments').select('*, appointment_symptoms(description, symptoms, severity), doctors(full_name)').eq('patient_id', patientId).neq('status', 'pending_payment').order('start_at', { ascending: false })),
        unwrap(sb().from('prescriptions').select('id, appointment_id, doctor_id, version, diagnoses, advice, finalized_at, status, doctors(full_name), prescription_items(drug_name, strength, dose, frequency, duration)').eq('patient_id', patientId).eq('status', 'final').order('finalized_at', { ascending: false })),
        unwrap(sb().from('consultations').select('id, appointment_id, chief_complaint, diagnoses, advice, status, updated_at').eq('patient_id', patientId)),
        unwrap(sb().from('documents').select('*').eq('patient_id', patientId).order('created_at', { ascending: false })),
      ]);
      return { patient, appointments, prescriptions, notes, documents } as unknown as Timeline;
    },
  });
}
