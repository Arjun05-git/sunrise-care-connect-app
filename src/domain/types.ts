/**
 * Domain types shared by the UI, the demo adapter, the Supabase adapter and the edge functions.
 * Column names mirror the Postgres schema in supabase/migrations (snake_case kept on purpose so
 * rows from Supabase map 1:1 without a translation layer).
 */

export type Role = 'patient' | 'doctor' | 'coordinator' | 'admin' | 'finance';
export type ConsultMode = 'audio' | 'video';
export type ConsultType = 'first' | 'follow_up';
export type Gender = 'female' | 'male' | 'other' | 'undisclosed';

export type AppointmentStatus =
  | 'pending_payment'
  | 'confirmed'
  | 'in_progress'
  | 'completed'
  | 'no_show'
  | 'cancelled'
  | 'rescheduled';

/** Extra detail for completed/no_show/cancelled appointments. */
export type AppointmentOutcome =
  | 'completed'
  | 'patient_no_show'
  | 'doctor_no_show'
  /** neither the doctor nor the patient joined: free reschedule offered, refund only on request */
  | 'both_no_show'
  | 'technical_failure'
  | 'cancelled_by_patient'
  | 'cancelled_by_doctor'
  | 'cancelled_by_admin'
  | 'payment_expired';

export interface Profile {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  preferred_language: 'en' | 'ml';
  created_at: string;
}

export interface UserRole {
  user_id: string;
  role: Role;
  hospital_id: string | null;
}

export interface Hospital {
  id: string;
  name: string;
  city: string;
  address: string;
  phone: string;
  emergency_phone: string;
  active: boolean;
}

export interface Department {
  id: string;
  name: string;
  name_ml: string;
  icon: string; // lucide icon name
  active: boolean;
}

export interface Doctor {
  id: string;
  profile_id: string;
  full_name: string;
  photo_url: string;
  qualification: string;
  registration_no: string;
  registration_council: string;
  /** Registration verification workflow, set by admin. */
  verification_status: 'pending' | 'verified' | 'rejected';
  experience_years: number;
  languages: string[];
  hospital_id: string;
  department_id: string;
  bio: string;
  modes: ConsultMode[];
  slot_minutes: number;
  rating_avg: number;
  rating_count: number;
  signature_url: string | null;
  phone: string;
  active: boolean;
}

/** Weekly working window, or a dated block (leave / blocked time). */
export interface DoctorAvailability {
  id: string;
  doctor_id: string;
  kind: 'weekly' | 'block';
  weekday: number | null; // 0 = Sunday (weekly only)
  start_time: string; // HH:mm IST
  end_time: string; // HH:mm IST
  block_date_from: string | null; // YYYY-MM-DD (block only)
  block_date_to: string | null;
  reason: string | null;
}

export type SlotStatus = 'open' | 'held' | 'booked' | 'blocked';

export interface Slot {
  id: string;
  doctor_id: string;
  start_at: string; // ISO UTC
  end_at: string;
  status: SlotStatus;
  held_until: string | null;
  appointment_id: string | null;
}

export interface Patient {
  id: string;
  /** Auth user who owns / manages this record (self or guardian). */
  owner_user_id: string;
  full_name: string;
  date_of_birth: string; // YYYY-MM-DD
  gender: Gender;
  phone: string;
  email: string | null;
  address: string;
  blood_group: string | null;
  allergies: string[];
  his_mrn: string | null; // hospital MRN from HIS sync
  abha_number: string | null;
  is_primary: boolean;
  created_at: string;
}

export interface Dependent {
  id: string;
  owner_patient_id: string;
  patient_id: string;
  relation: 'spouse' | 'child' | 'parent' | 'sibling' | 'other';
}

export type ConsentType = 'teleconsultation' | 'data_processing' | 'whatsapp_opt_in' | 'terms' | 'marketing';

export interface Consent {
  id: string;
  user_id: string;
  consent_type: ConsentType;
  version: string;
  granted: boolean;
  granted_at: string;
  withdrawn_at: string | null;
  user_agent: string | null;
}

export interface Appointment {
  id: string;
  ref_code: string; // short human-friendly reference, safe for notifications
  patient_id: string;
  booked_by_user_id: string;
  doctor_id: string;
  hospital_id: string;
  department_id: string;
  slot_id: string;
  start_at: string;
  end_at: string;
  mode: ConsultMode;
  consult_type: ConsultType;
  /** For follow-ups: the paid "index" consult this follow-up hangs off. */
  index_appointment_id: string | null;
  fee_amount: number; // INR paise-free whole rupees
  is_free: boolean;
  status: AppointmentStatus;
  outcome: AppointmentOutcome | null;
  outcome_reason: string | null;
  hold_expires_at: string | null;
  rescheduled_from_id: string | null;
  rescheduled_to_id: string | null;
  fee_override_reason: string | null;
  extended_minutes: number;
  doctor_joined_at: string | null;
  patient_joined_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

export interface AppointmentSymptoms {
  appointment_id: string;
  body_area: string | null;
  symptoms: string[];
  duration: string | null;
  severity: number; // 0-10
  description: string;
  voice_note_path: string | null;
  vitals: { bp?: string; pulse?: string; temperature?: string; spo2?: string; weight?: string; sugar?: string };
  allergies: string;
  current_medicines: string;
  past_history: string;
}

export type DocumentTag = 'lab_report' | 'imaging' | 'prescription' | 'discharge_summary' | 'photo' | 'other';

export interface MedicalDocument {
  id: string;
  patient_id: string;
  appointment_id: string | null;
  uploaded_by: string;
  tag: DocumentTag;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  created_at: string;
}

export type PaymentStatus = 'created' | 'authorized' | 'captured' | 'failed' | 'refunded' | 'partially_refunded';

export interface Payment {
  id: string;
  appointment_id: string;
  provider: 'razorpay' | 'mock';
  provider_order_id: string;
  provider_payment_id: string | null;
  amount: number;
  currency: 'INR';
  method: 'upi' | 'card' | 'netbanking' | 'wallet' | null;
  status: PaymentStatus;
  settled: boolean;
  settlement_id: string | null;
  created_at: string;
  captured_at: string | null;
}

export interface Refund {
  id: string;
  payment_id: string;
  appointment_id: string;
  amount: number;
  reason: string;
  status: 'initiated' | 'processed' | 'failed';
  provider_refund_id: string | null;
  initiated_by: string;
  created_at: string;
  processed_at: string | null;
}

export interface Diagnosis {
  /** ICD-10 code, or null for a free-text provisional diagnosis */
  code: string | null;
  description: string;
}

export interface Consultation {
  id: string;
  appointment_id: string;
  doctor_id: string;
  patient_id: string;
  chief_complaint: string;
  history: string;
  examination: string;
  diagnoses: Diagnosis[];
  advice: string;
  investigations: string;
  follow_up_date: string | null;
  status: 'draft' | 'final';
  updated_at: string;
}

export interface PrescriptionItem {
  id: string;
  prescription_id: string;
  drug_id: string;
  drug_name: string;
  strength: string;
  form: string;
  dose: string;
  frequency: string;
  duration: string;
  route: string;
  instructions: string;
}

export interface Prescription {
  id: string;
  appointment_id: string;
  doctor_id: string;
  patient_id: string;
  version: number;
  /** Addenda point at the original finalised prescription. */
  parent_prescription_id: string | null;
  addendum_reason: string | null;
  status: 'draft' | 'final';
  verification_code: string;
  advice: string;
  investigations: string;
  follow_up_date: string | null;
  diagnoses: Diagnosis[];
  finalized_at: string | null;
  pdf_path: string | null;
  created_at: string;
  items: PrescriptionItem[];
}

/** Telemedicine Practice Guidelines 2020 drug lists. */
export type DrugCategory = 'O' | 'A' | 'B' | 'prohibited';
export type DrugSchedule = 'OTC' | 'G' | 'H' | 'H1' | 'X' | 'narcotic';

export interface Drug {
  id: string;
  name: string;
  generic_name: string;
  form: string;
  strength: string;
  category: DrugCategory;
  schedule: DrugSchedule;
  /** Simple interaction groups used by the basic rule engine. */
  interaction_groups: string[];
  /** Allergy class used to match against patient allergies (e.g. "penicillin", "sulfa", "nsaid"). */
  allergy_class: string | null;
  default_dose: string;
  default_frequency: string;
  default_route: string;
}

export interface Icd10 {
  code: string;
  description: string;
}

export interface DrugRule {
  id: string;
  category: DrugCategory;
  mode: ConsultMode;
  consult_type: ConsultType;
  allowed: boolean;
  note: string;
}

export type FollowUpMatchRule = 'same_doctor' | 'same_department' | 'any';

export interface FollowUpPolicy {
  free_window_days: number;
  free_follow_up_count: number;
  match_rule: FollowUpMatchRule;
}

export interface FeeConfig {
  id: string;
  scope: 'doctor' | 'department';
  doctor_id: string | null;
  department_id: string | null;
  mode: ConsultMode;
  consult_type: ConsultType;
  amount: number;
}

export interface RescheduleRequest {
  id: string;
  appointment_id: string;
  requested_by: 'doctor' | 'patient' | 'admin';
  proposed_slot_id: string | null;
  proposed_start_at: string | null;
  reason: string;
  status: 'pending' | 'accepted' | 'declined' | 'alternate_booked' | 'refund_requested' | 'expired';
  response_note: string | null;
  new_appointment_id: string | null;
  created_at: string;
  responded_at: string | null;
}

export type NotificationChannel = 'whatsapp' | 'sms' | 'push' | 'in_app';

export interface NotificationRow {
  id: string;
  user_id: string;
  channel: NotificationChannel;
  template_key: string;
  /** Only non-clinical variables (name, date, time, ref code, link). */
  variables: Record<string, string>;
  rendered_text: string;
  link: string | null;
  to_masked: string | null;
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
  provider_message_id: string | null;
  error: string | null;
  read_at: string | null;
  created_at: string;
}

export interface NotificationTemplate {
  key: string;
  channel: NotificationChannel;
  /** WhatsApp approved template name. */
  provider_template_name: string;
  body_en: string;
  body_ml: string;
  variables: string[];
  active: boolean;
  category: 'transactional' | 'reminder' | 'service' | 'auth';
  audience: 'patient' | 'doctor' | 'staff';
  channels: NotificationChannel[];
  /** Hold during quiet hours (21:00–08:00 IST) – non-urgent messages only. */
  quiet_hours: boolean;
  /** DLT-registered SMS template id (India); SMS text defaults to the WhatsApp body. */
  sms_dlt_template_id: string | null;
  description: string;
}

export interface Rating {
  id: string;
  appointment_id: string;
  doctor_id: string;
  patient_id: string;
  stars: number;
  comment: string;
  created_at: string;
}

export interface SupportTicket {
  id: string;
  user_id: string;
  appointment_id: string | null;
  category: 'payment' | 'technical' | 'appointment' | 'prescription' | 'grievance' | 'data_request' | 'other';
  subject: string;
  description: string;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  assigned_to: string | null;
  resolution: string | null;
  created_at: string;
  updated_at: string;
}

export interface CallLog {
  id: string;
  appointment_id: string;
  provider: 'livekit' | 'jitsi' | 'system';
  room_name: string;
  /** client: join, leave, reconnecting, reconnected, disconnected, quality, failure, device_error, audio_only, video_on, end ·
   *  server (LiveKit webhook / sweep): participant_joined, participant_left, room_started, room_finished, doctor_no_show, patient_no_show */
  event: string;
  actor_user_id: string | null;
  actor_role: 'patient' | 'doctor' | 'system' | null;
  source: 'client' | 'server';
  /** JSON text with whitelisted, non-clinical keys only (reason, quality counts, seconds, …) */
  detail: string | null;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  appointment_id: string;
  sender_user_id: string;
  sender_role: 'patient' | 'doctor';
  body: string;
  document_id: string | null;
  created_at: string;
}

export interface AuditLog {
  id: string;
  actor_user_id: string | null;
  actor_role: Role | 'system' | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  created_at: string;
}

export interface Holiday {
  id: string;
  hospital_id: string | null; // null = all hospitals
  date: string;
  name: string;
}

export interface DataRequest {
  id: string;
  user_id: string;
  kind: 'export' | 'erasure';
  status: 'received' | 'in_review' | 'completed' | 'rejected';
  note: string | null;
  created_at: string;
}

/** Key/value app settings. Values are typed in AppSettings below. */
export interface AppSettings {
  consult_minutes: number;
  slot_hold_minutes: number;
  join_window_minutes: number; // join button active N min before start
  /** the doctor may mark "patient didn't join" by hand after this many minutes */
  doctor_grace_minutes: number;
  patient_grace_minutes: number;
  /** automatic doctor no-show (or both no-show) this many minutes after the start */
  auto_doctor_no_show_minutes: number;
  /** automatic patient no-show (doctor joined, patient didn't) this many minutes after the start */
  auto_patient_no_show_minutes: number;
  /** Ordered tiers: refund `percent` if cancelled at least `min_hours_before` hours before start. */
  cancellation_tiers: { min_hours_before: number; percent: number }[];
  patient_no_show_refund_percent: number;
  patient_reschedule_min_hours: number;
  /** If the patient does not choose after a doctor no-show / doctor cancel, refund automatically after N hours. */
  doctor_no_show_auto_refund_hours: number;
  /** Max number of times a patient may reschedule one booking. */
  patient_reschedule_limit: number;
  max_upload_mb: number;
  allowed_upload_types: string[];
  /** Video room stays joinable until end + N minutes (+ any extension). */
  join_close_minutes: number;
  /** Call recording. OFF by default; turning it on also needs explicit recording consent (not built). */
  recording_enabled: boolean;
  consent_versions: Record<ConsentType, string>;
  consent_texts: Record<ConsentType, { en: string; ml: string }>;
  abdm_enabled: boolean;
  integrations: { his: boolean; leadsquared: boolean };
  support_phone: string;
  grievance_officer: { name: string; email: string; phone: string };
}
