import { useQuery } from '@tanstack/react-query';
import type { ConsultMode, ConsultType } from '@/domain/types';
import { callFunction } from '@/lib/functions';
import { getSupabase } from '@/lib/supabase';

/**
 * Admin console data (supabase/migrations/20261101000015_admin_console.sql). Reads are RPCs or RLS-checked
 * selects; every change is an RPC that checks the role, takes a reason where it matters, and is audited.
 */
const sb = () => getSupabase();
async function unwrap<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw error;
  return data as T;
}
const rpc = <T,>(fn: string, args: Record<string, unknown> = {}) => unwrap<T>(sb().rpc(fn, args));

export const cqk = {
  dashboard: (days: number) => ['console', 'dashboard', days] as const,
  doctors: ['console', 'doctors'] as const,
  doctor: (id: string) => ['console', 'doctor', id] as const,
  masters: ['console', 'masters'] as const,
  appts: (f: object) => ['console', 'appts', f] as const,
  content: ['console', 'content'] as const,
  users: (f: object) => ['console', 'users', f] as const,
  tickets: (f: object) => ['console', 'tickets', f] as const,
  ticket: (id: string) => ['console', 'ticket', id] as const,
  audit: (f: object) => ['console', 'audit', f] as const,
  report: (k: string, f: string, t: string) => ['console', 'report', k, f, t] as const,
};

// ---------------------------------------------------------------- dashboard
export interface DashDay { date: string; completed: number; upcoming: number; no_show: number; cancelled: number; revenue: number | null }
export interface Dashboard {
  today: { booked: number; completed: number; in_progress: number; next_hour: number; no_shows: number; new_bookings: number; revenue: number | null };
  attention: number; pending_verifications: number; open_tickets: number; unanswered_tickets: number; failed_notifications: number;
  refunds_pending: { count: number; amount: number } | null; month_revenue: number | null;
  days: DashDay[]; departments: { name: string; name_ml: string; count: number }[]; money: boolean;
}
export const useDashboard = (days: number) => useQuery({ queryKey: cqk.dashboard(days), queryFn: () => rpc<Dashboard>('admin_dashboard', { p_days: days }), refetchInterval: 60_000 });

// ---------------------------------------------------------------- masters
export interface Hospital { id: string; name: string; city: string; address: string | null; phone: string; emergency_phone: string; his_code: string | null; active: boolean }
export interface Department { id: string; name: string; name_ml: string; icon: string; active: boolean }
export interface Holiday { id: string; hospital_id: string | null; date: string; name: string }
export interface Drug {
  id: string; name: string; generic_name: string; form: string; strength: string; category: 'O' | 'A' | 'B' | 'prohibited';
  schedule: 'OTC' | 'G' | 'H' | 'H1' | 'X' | 'narcotic'; interaction_groups: string[]; allergy_class: string | null;
  default_dose: string; default_frequency: string; default_route: string; active: boolean;
}
export interface Icd { code: string; description: string; active: boolean }
export function useMasters() {
  return useQuery({
    queryKey: cqk.masters,
    queryFn: async () => {
      const [hospitals, departments, holidays] = await Promise.all([
        unwrap(sb().from('hospitals').select('*').order('name')),
        unwrap(sb().from('departments').select('*').order('name')),
        unwrap(sb().from('holidays').select('*').order('date')),
      ]);
      return { hospitals: hospitals as Hospital[], departments: departments as Department[], holidays: holidays as Holiday[] };
    },
  });
}
export const searchDrugs = async (q: string) =>
  (await unwrap(sb().from('drug_master').select('*').or(`name.ilike.%${q}%,generic_name.ilike.%${q}%,id.ilike.%${q}%`).order('name').limit(50))) as Drug[];
export const searchIcd = async (q: string) =>
  (await unwrap(sb().from('icd10_master').select('*').or(`code.ilike.${q}%,description.ilike.%${q}%`).order('code').limit(50))) as Icd[];
export const saveHospital = (id: string | null, p: Omit<Hospital, 'id'>, reason: string) => rpc<string>('admin_save_hospital', { p_id: id, p, p_reason: reason });
export const saveDepartment = (id: string | null, p: Omit<Department, 'id'>, reason: string) => rpc<string>('admin_save_department', { p_id: id, p, p_reason: reason });
export const saveHoliday = (hospital: string | null, date: string, name: string, reason: string) =>
  rpc<{ id: string; bookings_that_day: number }>('admin_save_holiday', { p_hospital: hospital, p_date: date, p_name: name, p_reason: reason });
export const deleteHoliday = (id: string, reason: string) => rpc<void>('admin_delete_holiday', { p_id: id, p_reason: reason });
export const saveDrug = (p: Drug, reason: string) => rpc<string>('admin_save_drug', { p, p_reason: reason });
export const saveIcd = (code: string, description: string, active: boolean, reason: string) => rpc<string>('admin_save_icd', { p_code: code, p_description: description, p_active: active, p_reason: reason });

// ---------------------------------------------------------------- doctors
export type VerificationStatus = 'draft' | 'pending' | 'verified' | 'rejected' | 'suspended';
export interface DoctorRow {
  id: string; profile_id: string | null; full_name: string; phone: string; qualification: string; registration_no: string; registration_council: string;
  verification_status: VerificationStatus; experience_years: number; languages: string[]; hospital_id: string; department_id: string; bio: string;
  modes: ConsultMode[]; slot_minutes: number; his_doctor_code: string | null; active: boolean; created_at: string;
  onboarded_by: string | null; submitted_by: string | null; submitted_at: string | null; verified_by: string | null; verified_at: string | null;
  verification_note: string | null; rejection_reason: string | null; suspended_at: string | null; suspension_reason: string | null;
}
export interface Credential { id: string; kind: 'registration_certificate' | 'degree' | 'id_proof' | 'other'; storage_path: string; file_name: string; mime_type: string; size_bytes: number; uploaded_by: string | null; uploaded_at: string }
export const useDoctors = () => useQuery({ queryKey: cqk.doctors, queryFn: async () => (await unwrap(sb().from('doctors').select('*').order('full_name'))) as DoctorRow[] });
export function useDoctor(id: string | undefined) {
  return useQuery({
    queryKey: cqk.doctor(id ?? 'new'),
    enabled: !!id,
    queryFn: async () => {
      const [doctor, creds] = await Promise.all([
        unwrap(sb().from('doctors').select('*').eq('id', id!).single()),
        unwrap(sb().from('doctor_credentials').select('*').eq('doctor_id', id!).order('uploaded_at', { ascending: false })),
      ]);
      const d = doctor as unknown as DoctorRow;
      const ids = [d.onboarded_by, d.submitted_by, d.verified_by, ...(creds as Credential[]).map((c) => c.uploaded_by)].filter(Boolean) as string[];
      const people = ids.length ? ((await unwrap(sb().from('profiles').select('id, full_name').in('id', [...new Set(ids)]))) as { id: string; full_name: string }[]) : [];
      return { doctor: d, credentials: creds as Credential[], names: Object.fromEntries(people.map((p) => [p.id, p.full_name])) as Record<string, string> };
    },
  });
}
export interface DoctorInput {
  full_name: string; phone: string; qualification: string; registration_no: string; registration_council: string; experience_years: number;
  languages: string[]; hospital_id: string; department_id: string; bio: string; modes: ConsultMode[]; slot_minutes: number; his_doctor_code: string;
}
export const saveDoctor = (id: string | null, p: DoctorInput, reason: string) => rpc<string>('admin_save_doctor', { p_id: id, p, p_reason: reason });
export const submitDoctor = (id: string) => rpc<void>('admin_submit_doctor', { p_doctor: id });
export const verifyDoctor = (id: string, decision: 'verified' | 'rejected', note: string) => rpc<void>('admin_verify_doctor', { p_doctor: id, p_decision: decision, p_note: note });
export const suspendDoctor = (id: string, reason: string) => rpc<{ cancelled: number; holds_released: number }>('admin_suspend_doctor', { p_doctor: id, p_reason: reason });
export const reinstateDoctor = (id: string, reason: string) => rpc<void>('admin_reinstate_doctor', { p_doctor: id, p_reason: reason });
export const createDoctorLogin = (doctorId: string) => callFunction<{ ok: boolean }>('admin-users', { action: 'doctor_login', doctor_id: doctorId });

const EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
/** Credential file: type by magic bytes (not the name), ≤ 10 MB, private bucket, then recorded. */
export async function uploadCredential(doctorId: string, kind: Credential['kind'], file: File) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const mime = sniff(head);
  if (!mime) throw Object.assign(new Error('file_type'), { code: 'file_type' });
  if (file.size > 10 * 1024 * 1024) throw Object.assign(new Error('file_too_large'), { code: 'file_too_large' });
  const path = `${doctorId}/${crypto.randomUUID()}.${EXT[mime]}`;
  const { error } = await sb().storage.from('doctor-credentials').upload(path, file, { contentType: mime, upsert: false });
  if (error) throw error;
  return rpc<string>('admin_add_doctor_credential', { p_doctor: doctorId, p_kind: kind, p_path: path, p_file_name: file.name, p_mime: mime, p_size: file.size });
}
export function sniff(b: Uint8Array): string | null {
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  return null;
}
export async function openCredential(path: string) {
  const { data, error } = await sb().storage.from('doctor-credentials').createSignedUrl(path, 60);
  if (error || !data) throw error ?? new Error('not_found');
  window.open(data.signedUrl, '_blank', 'noopener');
}

// ---------------------------------------------------------------- appointment monitor
export type Attention = 'doctor_not_joined' | 'patient_not_joined' | 'outcome_missing' | 'awaiting_patient_choice' | 'refund_failed' | 'reschedule_pending';
export interface MonitorRow {
  id: string; ref_code: string; start_at: string; end_at: string; mode: ConsultMode; consult_type: ConsultType; status: string; outcome: string | null;
  outcome_reason: string | null; fee_amount: number; is_free: boolean; doctor_id: string; department_id: string; extended_minutes: number;
  doctor_joined_at: string | null; patient_joined_at: string | null; attention: Attention[]; created_at: string;
  doctor_name: string; department: string; hospital: string; patient_name: string; contact_phone: string | null;
  payment_status: string | null; refunded: number; paid: number;
}
export interface MonitorFilters { from: string; to: string; status?: string; doctor_id?: string; department_id?: string; q?: string; attention?: boolean }
export const useMonitor = (f: MonitorFilters) =>
  useQuery({ queryKey: cqk.appts(f), queryFn: () => rpc<{ total: number; attention: number; rows: MonitorRow[] }>('admin_appointments', { p: f }), refetchInterval: 60_000 });
export const cancelByStaff = (id: string, refund: 'full' | 'policy' | 'none', reason: string) =>
  rpc<{ refund_amount: number; refund_id: string | null; paid: number }>('admin_cancel_appointment', { p_appt: id, p_refund: refund, p_reason: reason });
export const refundPreview = (id: string, by: 'patient' | 'admin') => rpc<{ amount: number; percent: number; paid: number; rule: string }>('refund_quote', { p_appt: id, p_cancelled_by: by });
export const moveOptions = (id: string, anyDoctor: boolean) => rpc<{ slot_id: string; start_at: string; doctor_id: string; doctor_name: string }[]>('admin_move_options', { p_appt: id, p_any_doctor: anyDoctor, p_days: 7 });
export const moveByStaff = (id: string, slot: string, reason: string) => rpc<string>('admin_move_appointment', { p_appt: id, p_slot: slot, p_reason: reason });
export const outcomeByStaff = (id: string, outcome: 'completed' | 'patient_no_show' | 'doctor_no_show' | 'technical_failure', reason: string) =>
  rpc<{ status: string }>('admin_record_outcome', { p_appt: id, p_outcome: outcome, p_reason: reason });
export const extendWindow = (id: string, minutes: number, reason: string) => rpc<number>('admin_extend_window', { p_appt: id, p_minutes: minutes, p_reason: reason });

// ---------------------------------------------------------------- content
export type ContentKey = 'teleconsultation' | 'data_processing' | 'whatsapp_opt_in' | 'terms' | 'marketing' | 'terms_of_use' | 'privacy_notice' | 'refund_policy';
export const CONSENT_KEYS: ContentKey[] = ['teleconsultation', 'data_processing', 'terms', 'whatsapp_opt_in', 'marketing'];
export const DOCUMENT_KEYS: ContentKey[] = ['terms_of_use', 'privacy_notice', 'refund_policy'];
export interface ContentVersion { id: string; key: ContentKey; version: string; revision: number; title_en: string; title_ml: string; body_en: string; body_ml: string; published_by: string | null; published_at: string; reason: string | null }
export const useContent = () =>
  useQuery({
    queryKey: cqk.content,
    queryFn: async () => (await unwrap(sb().from('content_versions').select('*').order('published_at', { ascending: false }))) as ContentVersion[],
  });
/** Latest = highest version, then highest revision (the server orders the same way). */
export function latest(rows: ContentVersion[], key: ContentKey): ContentVersion | undefined {
  const num = (v: string) => v.split('.').map(Number) as [number, number];
  return rows.filter((r) => r.key === key).sort((a, b) => {
    const [a1, a2] = num(a.version); const [b1, b2] = num(b.version);
    return b1 - a1 || b2 - a2 || b.revision - a.revision;
  })[0];
}
export const publishContent = (key: ContentKey, v: { title_en: string; title_ml: string; body_en: string; body_ml: string }, newVersion: boolean, reason: string) =>
  rpc<{ version: string; revision: number; reconsent: boolean; affected_users: number }>('admin_publish_content', {
    p_key: key, p_title_en: v.title_en, p_title_ml: v.title_ml, p_body_en: v.body_en, p_body_ml: v.body_ml, p_new_version: newVersion, p_reason: reason,
  });
export const publicContent = (key: string) => rpc<ContentVersion | null>('public_content', { p_key: key });

// ---------------------------------------------------------------- users & roles
export type StaffRole = 'admin' | 'coordinator' | 'finance';
export interface UserRow { id: string; full_name: string; phone: string | null; email: string | null; created_at: string; last_sign_in_at: string | null; roles: string[] }
export const useUsers = (f: { q: string; kind: string; page: number }) =>
  useQuery({ queryKey: cqk.users(f), queryFn: () => rpc<{ total: number; rows: UserRow[] }>('admin_users', { p_q: f.q || null, p_kind: f.kind, p_limit: 50, p_offset: f.page * 50 }) });
export const setStaffRoles = (user: string, roles: StaffRole[], reason: string) => rpc<void>('admin_set_staff_roles', { p_user: user, p_roles: roles, p_reason: reason });
export const inviteStaff = (email: string, fullName: string, roles: StaffRole[], reason: string) =>
  callFunction<{ ok: boolean; user_id: string; invite_link: string | null }>('admin-users', { action: 'invite_staff', email, full_name: fullName, roles, reason });

// ---------------------------------------------------------------- support tickets
export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export const TICKET_VARIANT: Record<TicketStatus, 'warning' | 'default' | 'success' | 'neutral'> = { open: 'warning', in_progress: 'default', resolved: 'success', closed: 'neutral' };
export const TICKET_CATEGORIES = ['appointment', 'payment', 'technical', 'prescription', 'grievance', 'data_request', 'other'] as const;
export interface TicketRow {
  id: string; ref_code: string; category: string; subject: string; status: TicketStatus; created_at: string; updated_at: string; first_response_at: string | null;
  resolved_at: string | null; assigned_to: string | null; user_name: string | null; user_phone: string | null; assignee_name: string | null; appointment_ref: string | null; messages: number;
}
export interface TicketMessage { id: string; ticket_id: string; author_user_id: string | null; author_kind: 'user' | 'staff'; body: string; internal: boolean; created_at: string }
export interface TicketDetail { id: string; ref_code: string; user_id: string; appointment_id: string | null; category: string; subject: string; description: string; status: TicketStatus; assigned_to: string | null; resolution: string | null; created_at: string; first_response_at: string | null; resolved_at: string | null }
export const useTickets = (f: { status?: string; category?: string; assignee?: string; q?: string }) =>
  useQuery({ queryKey: cqk.tickets(f), queryFn: () => rpc<{ total: number; counts: Record<string, number> | null; rows: TicketRow[] }>('admin_tickets', { p: f }) });
export function useTicket(id: string | undefined) {
  return useQuery({
    queryKey: cqk.ticket(id ?? ''),
    enabled: !!id,
    queryFn: async () => {
      const [ticket, messages] = await Promise.all([
        unwrap(sb().from('support_tickets').select('*').eq('id', id!).single()),
        unwrap(sb().from('ticket_messages').select('*').eq('ticket_id', id!).order('created_at')),
      ]);
      return { ticket: ticket as unknown as TicketDetail, messages: messages as TicketMessage[] };
    },
  });
}
export const staffList = async () => (await rpc<{ rows: UserRow[] }>('admin_users', { p_kind: 'staff', p_limit: 200 }).catch(() => ({ rows: [] as UserRow[] }))).rows;
export const postTicketMessage = (id: string, body: string, internal = false) => rpc<string>('post_ticket_message', { p_ticket: id, p_body: body, p_internal: internal });
export const updateTicket = (id: string, status: TicketStatus, assignee: string | null, resolution: string) =>
  rpc<void>('admin_update_ticket', { p_ticket: id, p_status: status, p_assignee: assignee, p_resolution: resolution });
export const createTicket = (category: string, subject: string, description: string, appointment: string | null) =>
  rpc<string>('create_ticket', { p_category: category, p_subject: subject, p_description: description, p_appt: appointment });

// ---------------------------------------------------------------- audit
export interface AuditRow { id: string; created_at: string; action: string; entity: string; entity_id: string | null; actor_user_id: string | null; actor_role: string | null; actor_name: string | null; reason: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null }
export interface AuditFilters { from: string; to: string; entity?: string; action?: string; actor_role?: string; entity_id?: string; q?: string; limit?: number; offset?: number }
export const useAudit = (f: AuditFilters) => useQuery({ queryKey: cqk.audit(f), queryFn: () => rpc<{ total: number; rows: AuditRow[] }>('admin_audit', { p: f }) });
export const auditPage = (f: AuditFilters) => rpc<{ total: number; rows: AuditRow[] }>('admin_audit', { p: f });

// ---------------------------------------------------------------- reports
export type ReportKind = 'appointments' | 'revenue' | 'no_shows' | 'utilisation' | 'follow_ups' | 'notifications';
export const useReport = (kind: ReportKind, from: string, to: string, enabled: boolean) =>
  useQuery({ queryKey: cqk.report(kind, from, to), enabled, queryFn: () => rpc<Record<string, unknown>[]>('admin_report', { p_kind: kind, p_from: from, p_to: to }) });
