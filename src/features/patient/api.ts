import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDaysKey, fromIst, istDateKey } from '@/domain/time';
import type { Appointment, AppointmentSymptoms, ConsentType, ConsultMode, ConsultType, DocumentTag, Gender, MedicalDocument, Patient, Slot } from '@/domain/types';
import { config } from '@/lib/config';
import { getSupabase } from '@/lib/supabase';
import { callFunction, FunctionError } from '@/lib/functions';
import { documentPath, type AllowedMime } from './documents';

/**
 * Patient data layer. Every call runs as the signed-in user with the anon key, so RLS
 * decides what comes back; business writes go through SECURITY DEFINER RPCs
 * (supabase/migrations/20261101000006_patient_booking.sql).
 */
const sb = () => getSupabase();

async function unwrap<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw error;
  return data as T;
}

export const qk = {
  consents: ['consents'] as const,
  settings: ['app-settings'] as const,
  family: ['family'] as const,
  masters: ['masters'] as const,
  doctors: (f: DoctorFilters) => ['doctors', f] as const,
  doctor: (id: string) => ['doctor', id] as const,
  fees: (id: string) => ['fees', id] as const,
  slots: (id: string) => ['slots', id] as const,
  preview: (d: string, p: string, s: string, m: string) => ['preview', d, p, s, m] as const,
  followUps: ['free-follow-ups'] as const,
  upcoming: ['upcoming'] as const,
  appointment: (id: string) => ['appointment', id] as const,
  hold: (id: string) => ['hold', id] as const,
  looseDocs: (patientId: string) => ['loose-docs', patientId] as const,
};

// ---------------------------------------------------------------- settings & consent
export const REQUIRED_CONSENTS: ConsentType[] = ['terms', 'data_processing', 'teleconsultation'];
export const ALL_CONSENTS: ConsentType[] = [...REQUIRED_CONSENTS, 'whatsapp_opt_in', 'marketing'];

export interface PatientSettings {
  consent_versions: Record<ConsentType, string>;
  consent_texts: Record<ConsentType, { en: string; ml: string }>;
  cancellation_tiers: { min_hours_before: number; percent: number }[];
  slot_hold_minutes: number;
  join_window_minutes: number;
  doctor_no_show_auto_refund_hours: number;
}

export function useSettings() {
  return useQuery({
    queryKey: qk.settings,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const rows = await unwrap(sb().from('app_settings').select('key, value').in('key', ['consent_versions', 'consent_texts', 'cancellation_tiers', 'slot_hold_minutes', 'join_window_minutes', 'doctor_no_show_auto_refund_hours']));
      return Object.fromEntries((rows as { key: string; value: unknown }[]).map((r) => [r.key, r.value])) as unknown as PatientSettings;
    },
  });
}

export interface ConsentRow {
  consent_type: ConsentType;
  version: string;
  granted_at: string;
}

export function useConsents() {
  return useQuery({
    queryKey: qk.consents,
    queryFn: async () =>
      (await unwrap(sb().from('consents').select('consent_type, version, granted_at').eq('granted', true).is('withdrawn_at', null).order('granted_at', { ascending: false }))) as ConsentRow[],
  });
}

/** Required consent types that are missing or were given for an older version of the text. */
export function missingConsents(rows: ConsentRow[] | undefined, versions: Record<string, string> | undefined): ConsentType[] {
  if (!rows || !versions) return [];
  return REQUIRED_CONSENTS.filter((t) => !rows.some((r) => r.consent_type === t && r.version === (versions[t] ?? '1.0')));
}

export function useSetConsents() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ types, granted }: { types: ConsentType[]; granted: boolean }) => unwrap(sb().rpc('set_consents', { p_types: types, p_granted: granted })),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.consents, refetchType: 'all' }),
  });
}

// ---------------------------------------------------------------- family
export type Relation = 'spouse' | 'child' | 'parent' | 'sibling' | 'other';
export type FamilyMember = Patient & { relation: Relation | null };

export function useFamily() {
  return useQuery({
    queryKey: qk.family,
    queryFn: async () => {
      const [patients, deps] = await Promise.all([
        unwrap(sb().from('patients').select('*').order('is_primary', { ascending: false }).order('created_at')),
        unwrap(sb().from('dependents').select('patient_id, relation')),
      ]);
      const rel = new Map((deps as { patient_id: string; relation: Relation }[]).map((d) => [d.patient_id, d.relation]));
      return (patients as Patient[]).map((p) => ({ ...p, relation: rel.get(p.id) ?? null })) as FamilyMember[];
    },
  });
}

export interface PatientInput {
  id?: string | null;
  full_name: string;
  date_of_birth: string;
  gender: Gender;
  relation?: Relation | null;
  blood_group?: string | null;
  allergies?: string[];
  phone?: string | null;
  email?: string | null;
  address?: string | null;
}

export function useSavePatient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: PatientInput) =>
      (await unwrap(
        sb().rpc('save_patient', {
          p_id: p.id ?? null, p_full_name: p.full_name, p_date_of_birth: p.date_of_birth, p_gender: p.gender, p_relation: p.relation ?? null,
          p_blood_group: p.blood_group || null, p_allergies: p.allergies ?? [], p_phone: p.phone || null, p_email: p.email || null, p_address: p.address || null,
        }),
      )) as string,
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.family, refetchType: 'all' }),
  });
}

export function useArchivePatient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap(sb().rpc('archive_patient', { p_id: id })),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.family, refetchType: 'all' }),
  });
}

// ---------------------------------------------------------------- directory
export interface DepartmentRow { id: string; name: string; name_ml: string; icon: string }
export interface HospitalRow { id: string; name: string; city: string }

export function useMasters() {
  return useQuery({
    queryKey: qk.masters,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const [departments, hospitals] = await Promise.all([
        unwrap(sb().from('departments').select('id, name, name_ml, icon').eq('active', true).order('name')),
        unwrap(sb().from('hospitals').select('id, name, city').eq('active', true).order('name')),
      ]);
      return { departments: departments as DepartmentRow[], hospitals: hospitals as HospitalRow[] };
    },
  });
}

export interface DoctorFilters {
  q?: string;
  department?: string;
  hospital?: string;
  language?: string;
  mode?: ConsultMode;
  today?: boolean;
}

export interface DoctorCard {
  id: string;
  full_name: string;
  photo_url: string | null;
  qualification: string;
  registration_no: string;
  registration_council: string;
  experience_years: number;
  languages: string[];
  modes: ConsultMode[];
  rating_avg: number;
  rating_count: number;
  bio: string;
  hospital_id: string;
  hospital_name: string;
  hospital_city: string;
  department_id: string;
  department_name: string;
  department_name_ml: string;
  next_slot: string | null;
  fee_from: number | null;
}

export const DOCTOR_LANGUAGES = ['Malayalam', 'English', 'Hindi', 'Tamil', 'Kannada', 'Konkani', 'Urdu', 'Arabic'];

export function useDoctors(f: DoctorFilters) {
  return useQuery({
    queryKey: qk.doctors(f),
    placeholderData: (prev) => prev,
    queryFn: async () =>
      (await unwrap(
        sb().rpc('search_doctors', {
          p_q: f.q?.trim() || null, p_hospital: f.hospital || null, p_department: f.department || null,
          p_language: f.language || null, p_mode: f.mode || null, p_available_today: !!f.today,
        }),
      )) as DoctorCard[],
  });
}

export function useDoctor(id: string) {
  return useQuery({
    queryKey: qk.doctor(id),
    queryFn: async () => {
      const rows = (await unwrap(sb().rpc('search_doctors', {}))) as DoctorCard[];
      const d = rows.find((r) => r.id === id);
      if (!d) throw new Error('doctor_unavailable');
      return d;
    },
  });
}

export interface FeeRow { mode: ConsultMode; first_fee: number | null; follow_up_fee: number | null }
export const useDoctorFees = (id: string) =>
  useQuery({ queryKey: qk.fees(id), queryFn: async () => (await unwrap(sb().rpc('doctor_fees', { p_doctor: id }))) as FeeRow[] });

/** The doctor's slots for the next 14 IST days (all statuses, so taken times show as unavailable). */
export function useSlots(doctorId: string) {
  return useQuery({
    queryKey: qk.slots(doctorId),
    enabled: !!doctorId,
    refetchInterval: 30_000,
    queryFn: async () => {
      const from = new Date().toISOString();
      const to = fromIst(addDaysKey(istDateKey(), 14), '00:00').toISOString();
      return (await unwrap(
        sb().from('slots').select('id, doctor_id, start_at, end_at, status, held_until, appointment_id').eq('doctor_id', doctorId).gte('start_at', from).lt('start_at', to).order('start_at'),
      )) as Slot[];
    },
  });
}

export interface BookingPreview {
  consult_type: ConsultType;
  is_free: boolean;
  reason: 'no_prior_consult' | 'window_expired' | 'free_follow_up' | 'follow_up_free_exhausted';
  fee: number;
  free_remaining: number;
  window_ends_at: string | null;
  slot_start: string;
  bookable: boolean;
  hold_minutes: number;
}

export function useBookingPreview(doctorId: string, patientId: string | undefined, slotId: string | undefined, mode: ConsultMode | undefined) {
  return useQuery({
    queryKey: qk.preview(doctorId, patientId ?? '', slotId ?? '', mode ?? ''),
    enabled: !!(patientId && slotId && mode),
    queryFn: async () => (await unwrap(sb().rpc('booking_preview', { p_doctor: doctorId, p_patient: patientId, p_slot: slotId, p_mode: mode }))) as BookingPreview,
  });
}

export interface FreeFollowUp { patient_id: string; patient_name: string; doctor_id: string; doctor_name: string; window_ends_at: string }
export const useFreeFollowUps = () =>
  useQuery({ queryKey: qk.followUps, queryFn: async () => (await unwrap(sb().rpc('my_free_follow_ups'))) as FreeFollowUp[] });

// ---------------------------------------------------------------- appointments
export type AppointmentWithJoins = Appointment & {
  doctors: { full_name: string; photo_url: string | null; qualification: string; registration_no: string } | null;
  patients: { full_name: string } | null;
  departments: { name: string; name_ml: string } | null;
  hospitals: { name: string; city: string } | null;
};

const APPT_SELECT = '*, doctors(full_name, photo_url, qualification, registration_no), patients(full_name), departments(name, name_ml), hospitals(name, city)';

export function useUpcoming() {
  return useQuery({
    queryKey: qk.upcoming,
    queryFn: async () =>
      (await unwrap(
        sb().from('appointments').select(APPT_SELECT).in('status', ['confirmed', 'in_progress']).gte('end_at', new Date().toISOString()).order('start_at').limit(3),
      )) as AppointmentWithJoins[],
  });
}

export interface PaymentSummary { id: string; status: string; amount: number; receipt_no: string | null; method: string | null }
export type AppointmentDetail = AppointmentWithJoins & { appointment_symptoms: AppointmentSymptoms | null; documents: MedicalDocument[]; payments: PaymentSummary[] };

export function useAppointment(id: string) {
  return useQuery({
    queryKey: qk.appointment(id),
    queryFn: async () =>
      (await unwrap(sb().from('appointments').select(`${APPT_SELECT}, appointment_symptoms(*), documents(*), payments(id, status, amount, receipt_no, method)`).eq('id', id).maybeSingle())) as AppointmentDetail | null,
  });
}

// ---------------------------------------------------------------- hold lifecycle
export interface SymptomPayload {
  body_area: string | null;
  symptoms: string[];
  duration: string | null;
  severity: number;
  description: string;
  vitals: Record<string, string>;
  allergies: string;
  current_medicines: string;
  past_history: string;
}

export interface HoldInput {
  doctorId: string;
  patientId: string;
  slotId: string;
  mode: ConsultMode;
  symptoms: SymptomPayload;
  documentIds: string[];
}

export async function holdSlot(h: HoldInput): Promise<Appointment> {
  return (await unwrap(
    sb().rpc('hold_slot', { p_doctor: h.doctorId, p_patient: h.patientId, p_slot: h.slotId, p_mode: h.mode, p_symptoms: h.symptoms, p_document_ids: h.documentIds }),
  )) as Appointment;
}

export const releaseHold = async (appointmentId: string) => unwrap(sb().rpc('release_hold', { p_appt: appointmentId }));
export const confirmFreeBooking = async (appointmentId: string) => (await unwrap(sb().rpc('confirm_free_booking', { p_appt: appointmentId }))) as Appointment;

export interface HoldStatus { status: Appointment['status']; hold_expires_at: string | null; seconds_left: number }
export const getHold = async (appointmentId: string) => (await unwrap(sb().rpc('get_hold', { p_appt: appointmentId }))) as HoldStatus | null;

// ---------------------------------------------------------------- documents
/** Documents of a patient not yet attached to a consult (uploaded earlier, or released with a lapsed hold). */
export function useLooseDocuments(patientId: string | undefined) {
  return useQuery({
    queryKey: qk.looseDocs(patientId ?? ''),
    enabled: !!patientId,
    queryFn: async () =>
      (await unwrap(sb().from('documents').select('*').eq('patient_id', patientId!).is('appointment_id', null).order('created_at', { ascending: false }))) as MedicalDocument[],
  });
}

/**
 * Upload to the private `medical-documents` bucket with progress (XHR – fetch has no upload progress),
 * then register it through `documents-register`. Storage RLS re-checks that the path's patient belongs to the caller.
 */
export async function uploadDocument(
  file: File,
  meta: { patientId: string; userId: string; tag: DocumentTag; mime: AllowedMime; ext: string },
  onProgress: (pct: number) => void,
  signal?: AbortSignal,
): Promise<MedicalDocument> {
  const id = crypto.randomUUID();
  const path = documentPath(meta.patientId, id, meta.ext);
  const { data } = await sb().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('unauthenticated');

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${config.supabaseUrl}/storage/v1/object/medical-documents/${path}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('apikey', config.supabaseAnonKey);
    xhr.setRequestHeader('Content-Type', meta.mime);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(xhr.status === 413 ? 'size' : 'upload_failed')));
    xhr.onerror = () => reject(new Error('network'));
    xhr.onabort = () => reject(new Error('aborted'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });

  // The server reads the file back, checks its real type (and PDFs for scripts) and registers it.
  try {
    return await callFunction<MedicalDocument>('documents-register', { document_id: id, patient_id: meta.patientId, ext: meta.ext, tag: meta.tag, file_name: file.name.slice(0, 120) });
  } catch (e) {
    await sb().storage.from('medical-documents').remove([path]).catch(() => undefined); // don't leave an orphaned object
    const code = e instanceof FunctionError ? e.code : '';
    throw new Error(['type', 'size', 'active_content'].includes(code) ? code : 'upload_failed');
  }
}

export async function deleteDocument(doc: Pick<MedicalDocument, 'id' | 'storage_path'>) {
  await unwrap(sb().from('documents').delete().eq('id', doc.id));
  await sb().storage.from('medical-documents').remove([doc.storage_path]);
}

/** Short-lived (60 s) signed URL – documents are never public. */
export async function signedDocumentUrl(path: string): Promise<string> {
  const { data, error } = await sb().storage.from('medical-documents').createSignedUrl(path, 60);
  if (error || !data) throw error ?? new Error('sign_failed');
  return data.signedUrl;
}

// ---------------------------------------------------------------- my appointments, reschedule responses
export interface RescheduleProposal {
  id: string; status: 'pending' | 'accepted' | 'declined' | 'alternate_booked' | 'refund_requested' | 'expired';
  proposed_slot_id: string | null; proposed_start_at: string | null; reason: string; respond_by: string | null; created_at: string;
}
export type MyAppointment = AppointmentWithJoins & {
  reschedule_requests: RescheduleProposal[];
  payments: { id: string; status: string; amount: number; receipt_no: string | null }[];
  refunds: { amount: number; status: 'initiated' | 'processed' | 'failed' }[];
};
export const myApptsKey = ['my-appointments'] as const;

export function useMyAppointments() {
  return useQuery({
    queryKey: myApptsKey,
    queryFn: async () =>
      (await unwrap(
        sb().from('appointments')
          .select(`${APPT_SELECT}, reschedule_requests!reschedule_requests_appointment_id_fkey(id, status, proposed_slot_id, proposed_start_at, reason, respond_by, created_at), payments(id, status, amount, receipt_no), refunds(amount, status)`)
          .not('status', 'in', '(pending_payment,rescheduled)').order('start_at', { ascending: false }).limit(100),
      )) as MyAppointment[],
  });
}

const DOCTOR_SIDE = ['cancelled_by_doctor', 'technical_failure', 'doctor_no_show', 'both_no_show'];
/** Cancelled by the doctor / failed, not yet rescheduled or refunded → the patient must choose. */
export const needsFallbackChoice = (a: MyAppointment) =>
  a.status === 'cancelled' && DOCTOR_SIDE.includes(a.outcome ?? '') && !a.rescheduled_to_id && !a.refunds.some((r) => r.status !== 'failed');
export const pendingProposal = (a: MyAppointment) => (a.status === 'confirmed' ? a.reschedule_requests.find((r) => r.status === 'pending') : undefined);

async function processRefundIfAny(res: { refund_id?: string | null }) {
  // the refund is queued in the DB; ask the server to send it to the gateway now (the sweep retries otherwise)
  if (res.refund_id) await callFunction('payments-refund', { refund_id: res.refund_id }).catch(() => undefined);
  return res;
}

export async function respondReschedule(reqId: string, choice: 'accept' | 'reschedule' | 'refund', slotId?: string) {
  const res = (await unwrap(sb().rpc('respond_reschedule', { p_req: reqId, p_choice: choice, p_slot: slotId ?? null }))) as { status: string; appointment_id: string; refund_id: string | null };
  return processRefundIfAny(res);
}

export async function resolveDoctorCancellation(apptId: string, choice: 'reschedule' | 'refund', slotId?: string) {
  const res = (await unwrap(sb().rpc('resolve_doctor_cancellation', { p_appt: apptId, p_choice: choice, p_slot: slotId ?? null }))) as { appointment_id?: string; refund_id?: string | null };
  return processRefundIfAny(res);
}
