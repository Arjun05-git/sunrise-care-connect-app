-- =============================================================================
-- Sunrise Care Connect – core schema
-- Region: create the Supabase project in ap-south-1 (Mumbai) for data residency.
-- Double booking is prevented at three levels (marked ★):
--   1. slots_doctor_start_uq / slots_no_overlap  – one non-overlapping slot per doctor & time
--   2. appointments_one_live_per_slot            – UNIQUE(slot_id) among live appointments
--   3. appointments_no_double_booking            – EXCLUDE overlapping live appointments per doctor
-- All timestamps are timestamptz (UTC); the app renders everything in Asia/Kolkata.
-- =============================================================================

create extension if not exists pgcrypto;
create extension if not exists btree_gist;   -- needed for exclusion constraints (double-booking guard)
create extension if not exists pg_trgm;      -- fuzzy search on drugs / ICD-10 / names

alter database postgres set timezone to 'Asia/Kolkata';

-- ---------------------------------------------------------------- enums
create type app_role as enum ('patient', 'doctor', 'coordinator', 'admin', 'finance');
create type consult_mode as enum ('audio', 'video');
create type consult_type as enum ('first', 'follow_up');
create type appointment_status as enum ('pending_payment', 'confirmed', 'in_progress', 'completed', 'no_show', 'cancelled', 'rescheduled');
create type appointment_outcome as enum ('completed', 'patient_no_show', 'doctor_no_show', 'technical_failure', 'cancelled_by_patient', 'cancelled_by_doctor', 'cancelled_by_admin', 'payment_expired');
create type slot_status as enum ('open', 'held', 'booked', 'blocked');
create type payment_status as enum ('created', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded');
create type refund_status as enum ('initiated', 'processed', 'failed');
create type drug_category as enum ('O', 'A', 'B', 'prohibited');
create type drug_schedule as enum ('OTC', 'G', 'H', 'H1', 'X', 'narcotic');
create type notification_channel as enum ('whatsapp', 'sms', 'push', 'in_app');
create type notification_status as enum ('queued', 'sent', 'delivered', 'read', 'failed');
create type consent_type as enum ('teleconsultation', 'data_processing', 'whatsapp_opt_in', 'terms');
create type follow_up_match as enum ('same_doctor', 'same_department', 'any');

-- ---------------------------------------------------------------- identity
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  phone text unique,
  email text unique,
  preferred_language text not null default 'en' check (preferred_language in ('en', 'ml')),
  created_at timestamptz not null default now()
);

create table hospitals (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  city text not null default '',
  address text not null default '',
  phone text not null default '',
  emergency_phone text not null default '',
  his_code text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table user_roles (
  user_id uuid not null references profiles (id) on delete cascade,
  role app_role not null,
  hospital_id uuid references hospitals (id),
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table departments (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  name_ml text not null default '',
  icon text not null default 'Stethoscope',
  active boolean not null default true
);

create table doctors (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references profiles (id) on delete restrict,
  full_name text not null,
  photo_url text not null default '',
  qualification text not null default '',
  registration_no text not null default '',
  registration_council text not null default '',
  verification_status text not null default 'pending' check (verification_status in ('pending', 'verified', 'rejected')),
  experience_years int not null default 0 check (experience_years >= 0),
  languages text[] not null default '{}',
  hospital_id uuid not null references hospitals (id),
  department_id uuid not null references departments (id),
  bio text not null default '',
  modes consult_mode[] not null default '{audio,video}',
  slot_minutes int not null default 15 check (slot_minutes between 5 and 60),
  rating_avg numeric(2,1) not null default 0,
  rating_count int not null default 0,
  signature_url text,
  phone text not null default '',
  his_doctor_code text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index doctors_dept_idx on doctors (department_id) where active;
create index doctors_hospital_idx on doctors (hospital_id) where active;

-- Doctor step-up (PIN / biometric) – PIN stored as bcrypt hash.
create table doctor_secrets (
  profile_id uuid primary key references profiles (id) on delete cascade,
  pin_hash text not null,
  failed_attempts int not null default 0,
  locked_until timestamptz
);
create table auth_step_up (
  user_id uuid primary key references profiles (id) on delete cascade,
  verified_until timestamptz not null
);

create table doctor_preferences (
  doctor_id uuid primary key references doctors (id) on delete cascade,
  prefs jsonb not null default '{"note_templates":[],"favourite_drugs":[]}'
);

create table doctor_availability (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references doctors (id) on delete cascade,
  kind text not null check (kind in ('weekly', 'block')),
  weekday int check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  block_date_from date,
  block_date_to date,
  reason text,
  check (start_time < end_time),
  check ((kind = 'weekly' and weekday is not null) or (kind = 'block' and block_date_from is not null and block_date_to is not null and block_date_from <= block_date_to))
);
create index doctor_availability_doctor_idx on doctor_availability (doctor_id, kind);

create table holidays (
  id uuid primary key default gen_random_uuid(),
  hospital_id uuid references hospitals (id),
  date date not null,
  name text not null,
  unique (hospital_id, date)
);

create table slots (
  id uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references doctors (id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status slot_status not null default 'open',
  held_until timestamptz,
  appointment_id uuid,
  constraint slots_valid_range check (start_at < end_at),
  -- ★ A doctor slot exists once per start time…
  constraint slots_doctor_start_uq unique (doctor_id, start_at),
  -- ★ …and a doctor's slots can never overlap.
  constraint slots_no_overlap exclude using gist (doctor_id with =, tstzrange(start_at, end_at) with &&)
);
create index slots_doctor_time_idx on slots (doctor_id, start_at);
create index slots_open_idx on slots (start_at) where status = 'open';

-- ---------------------------------------------------------------- patients
create table patients (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references profiles (id) on delete set null,
  full_name text not null,
  date_of_birth date not null,
  gender text not null check (gender in ('female', 'male', 'other', 'undisclosed')),
  phone text not null default '',
  email text,
  address text not null default '',
  blood_group text,
  allergies text[] not null default '{}',
  his_mrn text unique,
  abha_number text,
  is_primary boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);
create index patients_owner_idx on patients (owner_user_id);
create unique index patients_one_primary_per_user on patients (owner_user_id) where is_primary;

create table dependents (
  id uuid primary key default gen_random_uuid(),
  owner_patient_id uuid not null references patients (id) on delete cascade,
  patient_id uuid not null unique references patients (id) on delete cascade,
  relation text not null check (relation in ('spouse', 'child', 'parent', 'sibling', 'other'))
);

create table consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  consent_type consent_type not null,
  version text not null,
  granted boolean not null,
  granted_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  user_agent text
);
create index consents_user_idx on consents (user_id, consent_type);

create table data_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  kind text not null check (kind in ('export', 'erasure')),
  status text not null default 'received' check (status in ('received', 'in_review', 'completed', 'rejected')),
  note text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- appointments
create table appointments (
  id uuid primary key default gen_random_uuid(),
  ref_code text not null unique,
  patient_id uuid not null references patients (id),
  booked_by_user_id uuid not null references profiles (id),
  doctor_id uuid not null references doctors (id),
  hospital_id uuid not null references hospitals (id),
  department_id uuid not null references departments (id),
  slot_id uuid not null references slots (id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  mode consult_mode not null,
  consult_type consult_type not null,
  index_appointment_id uuid references appointments (id),
  fee_amount int not null check (fee_amount >= 0),
  is_free boolean not null default false,
  status appointment_status not null,
  outcome appointment_outcome,
  outcome_reason text,
  hold_expires_at timestamptz,
  rescheduled_from_id uuid references appointments (id),
  rescheduled_to_id uuid references appointments (id),
  fee_override_reason text,
  extended_minutes int not null default 0,
  doctor_joined_at timestamptz,
  patient_joined_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  check (start_at < end_at),
  check (status <> 'pending_payment' or hold_expires_at is not null),
  -- ★ No double booking: a doctor cannot have two live appointments overlapping in time.
  constraint appointments_no_double_booking exclude using gist (
    doctor_id with =, tstzrange(start_at, end_at) with &&
  ) where (status in ('pending_payment', 'confirmed', 'in_progress', 'completed', 'no_show'))
);
-- ★ A slot is used by at most one live appointment.
create unique index appointments_one_live_per_slot on appointments (slot_id)
  where status in ('pending_payment', 'confirmed', 'in_progress', 'completed', 'no_show');
create index appointments_patient_idx on appointments (patient_id, start_at desc);
create index appointments_doctor_idx on appointments (doctor_id, start_at);
create index appointments_status_idx on appointments (status, start_at);
create index appointments_hold_idx on appointments (hold_expires_at) where status = 'pending_payment';

alter table slots add constraint slots_appointment_fk foreign key (appointment_id) references appointments (id) on delete set null;
-- ★ A slot points at no more than one appointment.
create unique index slots_one_appointment on slots (appointment_id) where appointment_id is not null;

create table appointment_symptoms (
  appointment_id uuid primary key references appointments (id) on delete cascade,
  body_area text,
  symptoms text[] not null default '{}',
  duration text,
  severity int not null default 0 check (severity between 0 and 10),
  description text not null default '',
  voice_note_path text,
  vitals jsonb not null default '{}',
  allergies text not null default '',
  current_medicines text not null default '',
  past_history text not null default ''
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients (id),
  appointment_id uuid references appointments (id) on delete set null,
  uploaded_by uuid not null references profiles (id),
  tag text not null check (tag in ('lab_report', 'imaging', 'prescription', 'discharge_summary', 'photo', 'other')),
  file_name text not null,
  mime_type text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes int not null check (size_bytes > 0 and size_bytes <= 10485760),
  storage_path text not null unique,
  created_at timestamptz not null default now()
);
create index documents_patient_idx on documents (patient_id);
create index documents_appointment_idx on documents (appointment_id);

-- ---------------------------------------------------------------- payments
create table payments (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments (id),
  provider text not null check (provider in ('razorpay', 'mock')),
  provider_order_id text not null unique,
  provider_payment_id text unique,
  amount int not null check (amount >= 0),
  currency text not null default 'INR',
  method text check (method in ('upi', 'card', 'netbanking', 'wallet')),
  status payment_status not null default 'created',
  settled boolean not null default false,
  settlement_id text,
  created_at timestamptz not null default now(),
  captured_at timestamptz
);
create index payments_appointment_idx on payments (appointment_id);

-- Idempotency for gateway webhooks: each event id processed exactly once.
create table payment_webhook_events (
  event_id text primary key,
  event_type text not null,
  payload_hash text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create table refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments (id),
  appointment_id uuid not null references appointments (id),
  amount int not null check (amount > 0),
  reason text not null,
  status refund_status not null default 'initiated',
  provider_refund_id text unique,
  initiated_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index refunds_payment_idx on refunds (payment_id);

-- ---------------------------------------------------------------- clinical
create table icd10_master (
  code text primary key,
  description text not null
);
create index icd10_desc_trgm on icd10_master using gin (description gin_trgm_ops);

create table drug_master (
  id text primary key,
  name text not null,
  generic_name text not null,
  form text not null,
  strength text not null,
  category drug_category not null,
  schedule drug_schedule not null,
  interaction_groups text[] not null default '{}',
  allergy_class text,
  default_dose text not null default '',
  default_frequency text not null default '',
  default_route text not null default 'Oral',
  active boolean not null default true,
  -- Schedule X / narcotics are always prohibited for teleconsultation.
  check (schedule not in ('X', 'narcotic') or category = 'prohibited')
);
create index drug_name_trgm on drug_master using gin (name gin_trgm_ops);

create table drug_rules (
  id uuid primary key default gen_random_uuid(),
  category drug_category not null,
  mode consult_mode not null,
  consult_type consult_type not null,
  allowed boolean not null,
  note text not null default '',
  unique (category, mode, consult_type),
  check (category <> 'prohibited' or allowed = false)
);

create table consultations (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null unique references appointments (id),
  doctor_id uuid not null references doctors (id),
  patient_id uuid not null references patients (id),
  chief_complaint text not null default '',
  history text not null default '',
  examination text not null default '',
  diagnoses jsonb not null default '[]',
  advice text not null default '',
  investigations text not null default '',
  follow_up_date date,
  status text not null default 'draft' check (status in ('draft', 'final')),
  updated_at timestamptz not null default now()
);

create table prescriptions (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments (id),
  doctor_id uuid not null references doctors (id),
  patient_id uuid not null references patients (id),
  version int not null default 1,
  parent_prescription_id uuid references prescriptions (id),
  addendum_reason text,
  status text not null default 'draft' check (status in ('draft', 'final')),
  verification_code text unique,
  advice text not null default '',
  investigations text not null default '',
  follow_up_date date,
  diagnoses jsonb not null default '[]',
  finalized_at timestamptz,
  pdf_path text,
  created_at timestamptz not null default now(),
  check (parent_prescription_id is null or addendum_reason is not null),
  check (status = 'draft' or (verification_code is not null and finalized_at is not null))
);
create unique index prescriptions_version_uq on prescriptions (coalesce(parent_prescription_id, id), version);
create index prescriptions_appt_idx on prescriptions (appointment_id);

create table prescription_items (
  id uuid primary key default gen_random_uuid(),
  prescription_id uuid not null references prescriptions (id) on delete cascade,
  drug_id text not null references drug_master (id),
  drug_name text not null,
  strength text not null default '',
  form text not null default '',
  dose text not null default '',
  frequency text not null default '',
  duration text not null default '',
  route text not null default '',
  instructions text not null default '',
  position int not null default 0
);
create index prescription_items_rx_idx on prescription_items (prescription_id);

-- ---------------------------------------------------------------- policy / config
create table follow_up_policy (
  id int primary key default 1 check (id = 1),
  free_window_days int not null default 14 check (free_window_days between 0 and 365),
  free_follow_up_count int not null default 1 check (free_follow_up_count between 0 and 10),
  match_rule follow_up_match not null default 'same_doctor',
  updated_at timestamptz not null default now()
);

create table fee_config (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('doctor', 'department')),
  doctor_id uuid references doctors (id) on delete cascade,
  department_id uuid references departments (id) on delete cascade,
  mode consult_mode not null,
  consult_type consult_type not null,
  amount int not null check (amount between 0 and 100000),
  check ((scope = 'doctor' and doctor_id is not null) or (scope = 'department' and department_id is not null))
);
create unique index fee_config_uq on fee_config (scope, coalesce(doctor_id, department_id), mode, consult_type);

create table app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table reschedule_requests (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments (id),
  requested_by text not null check (requested_by in ('doctor', 'patient', 'admin')),
  proposed_slot_id uuid references slots (id),
  proposed_start_at timestamptz,
  reason text not null default '',
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'alternate_booked', 'refund_requested', 'expired')),
  response_note text,
  new_appointment_id uuid references appointments (id),
  created_at timestamptz not null default now(),
  responded_at timestamptz
);
create unique index reschedule_one_pending on reschedule_requests (appointment_id) where status = 'pending';

-- ---------------------------------------------------------------- comms
create table notification_templates (
  key text primary key,
  channel notification_channel not null default 'whatsapp',
  provider_template_name text not null,
  body_en text not null,
  body_ml text not null,
  variables text[] not null default '{}',
  active boolean not null default true,
  -- Guardrail: templates can never carry clinical variables.
  check (not (variables && array['diagnosis','symptom','symptoms','medicine','drug','prescription_text','notes','complaint']))
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  channel notification_channel not null,
  template_key text not null references notification_templates (key),
  variables jsonb not null default '{}',
  rendered_text text not null,
  link text,
  to_masked text,
  status notification_status not null default 'queued',
  provider_message_id text,
  error text,
  attempts int not null default 0,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on notifications (user_id, created_at desc);
create index notifications_queue_idx on notifications (created_at) where status = 'queued';

create table ratings (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null unique references appointments (id),
  doctor_id uuid not null references doctors (id),
  patient_id uuid not null references patients (id),
  stars int not null check (stars between 1 and 5),
  comment text not null default '' check (length(comment) <= 500),
  created_at timestamptz not null default now()
);

create table support_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id),
  appointment_id uuid references appointments (id),
  category text not null check (category in ('payment', 'technical', 'appointment', 'prescription', 'grievance', 'data_request', 'other')),
  subject text not null check (length(subject) <= 140),
  description text not null check (length(description) <= 4000),
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  assigned_to uuid references profiles (id),
  resolution text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table call_logs (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments (id),
  provider text not null,
  room_name text not null,
  event text not null,
  actor_user_id uuid references profiles (id),
  detail text,
  created_at timestamptz not null default now()
);
create index call_logs_appt_idx on call_logs (appointment_id, created_at);

create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references appointments (id),
  sender_user_id uuid not null references profiles (id),
  sender_role text not null check (sender_role in ('patient', 'doctor')),
  body text not null check (length(body) <= 2000),
  document_id uuid references documents (id),
  created_at timestamptz not null default now()
);
create index chat_appt_idx on chat_messages (appointment_id, created_at);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid,
  actor_role text,
  action text not null,
  entity text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  reason text,
  created_at timestamptz not null default now()
);
create index audit_entity_idx on audit_logs (entity, entity_id);
create index audit_created_idx on audit_logs (created_at desc);

create table rate_limits (
  key text primary key,
  window_start timestamptz not null,
  hits int not null
);
