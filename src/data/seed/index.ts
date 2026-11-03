/**
 * Builds a complete, consistent database snapshot for the demo, relative to `now` so there is
 * always a live "today". The same snapshot is turned into SQL by scripts/generate-seed-sql.ts.
 */
import type {
  Appointment,
  AppointmentOutcome,
  AppointmentStatus,
  AppointmentSymptoms,
  AppSettings,
  AuditLog,
  CallLog,
  ChatMessage,
  Consent,
  Consultation,
  ConsultMode,
  DataRequest,
  Dependent,
  Doctor,
  DoctorAvailability,
  Drug,
  DrugRule,
  FeeConfig,
  FollowUpPolicy,
  Holiday,
  Hospital,
  Department,
  Icd10,
  MedicalDocument,
  NotificationRow,
  NotificationTemplate,
  Patient,
  Payment,
  Prescription,
  Profile,
  Rating,
  Refund,
  RescheduleRequest,
  Slot,
  SupportTicket,
  UserRole,
} from '@/domain/types';
/** Doctor note templates & favourite medicines (stored in doctor_preferences.prefs). */
export interface DoctorPrefs {
  note_templates: { id: string; name: string; chief_complaint: string; examination: string; advice: string; investigations: string }[];
  favourite_drugs: string[];
}
import { addDaysKey, addMinutes, istDateKey } from '@/domain/time';
import { defaultDrugRules, makeRefCode, makeVerificationCode } from '@/domain/rules';
import { DRUGS } from './drugs';
import { ICD10 } from './icd10';
import {
  DEFAULT_FOLLOW_UP_POLICY,
  DEFAULT_SETTINGS,
  DEMO,
  DEPARTMENTS,
  DEPENDENT_ROWS,
  DOCTOR_ROWS,
  HOSPITALS,
  K,
  PATIENT_ROWS,
  TEMPLATES,
  uid,
} from './org';
import { noteTemplates, type NoteTemplateSeed } from './templates';

export interface DbSnapshot {
  version: number;
  seeded_at: string;
  profiles: Profile[];
  user_roles: UserRole[];
  hospitals: Hospital[];
  departments: Department[];
  doctors: Doctor[];
  doctor_availability: DoctorAvailability[];
  slots: Slot[];
  patients: Patient[];
  dependents: Dependent[];
  consents: Consent[];
  appointments: Appointment[];
  appointment_symptoms: AppointmentSymptoms[];
  documents: MedicalDocument[];
  payments: Payment[];
  refunds: Refund[];
  consultations: Consultation[];
  prescriptions: Prescription[];
  drug_master: Drug[];
  icd10_master: Icd10[];
  note_templates: NoteTemplateSeed[];
  drug_rules: DrugRule[];
  follow_up_policy: FollowUpPolicy;
  fee_config: FeeConfig[];
  reschedule_requests: RescheduleRequest[];
  notifications: NotificationRow[];
  notification_templates: NotificationTemplate[];
  ratings: Rating[];
  support_tickets: SupportTicket[];
  call_logs: CallLog[];
  chat_messages: ChatMessage[];
  audit_logs: AuditLog[];
  app_settings: AppSettings;
  holidays: Holiday[];
  data_requests: DataRequest[];
  doctor_prefs: Record<string, DoctorPrefs>;
  /** Demo-only auth material (hashed in Supabase; plain here because it is a local demo). */
  auth: { doctor_pins: Record<string, string>; admin_passwords: Record<string, string>; mfa_enabled: Record<string, boolean> };
}

export const SEED_VERSION = 3;

/** Small deterministic PRNG so the demo looks the same on every reset. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (d: Date) => d.toISOString();

export function buildSeed(nowInput = new Date()): DbSnapshot {
  const rand = mulberry32(20261023);
  // Round "now" down to 5 minutes so seeded slots line up neatly.
  const now = new Date(Math.floor(nowInput.getTime() / 300_000) * 300_000);
  const created = iso(addMinutes(now, -90 * 24 * 60));

  /* ---------------- users & roles */
  const profiles: Profile[] = [];
  const user_roles: UserRole[] = [];
  const addUser = (n: number, full_name: string, phone: string | null, email: string | null, role: UserRole['role'], hospital_id: string | null = null) => {
    const id = uid(K.user, n);
    profiles.push({ id, full_name, phone, email, preferred_language: 'en', created_at: created });
    user_roles.push({ user_id: id, role, hospital_id });
    return id;
  };
  const adminId = addUser(1, 'Sunrise Admin', null, DEMO.adminEmail, 'admin');
  addUser(2, 'Finance Desk', null, DEMO.financeEmail, 'finance');
  addUser(3, 'Care Coordinator', null, DEMO.coordinatorEmail, 'coordinator', HOSPITALS[0].id);

  /* ---------------- doctors */
  const doctors: Doctor[] = DOCTOR_ROWS.map((r, i) => {
    const profileId = addUser(100 + i, r[0], r[8], null, 'doctor', HOSPITALS[r[2] - 1].id);
    return {
      id: uid(K.doctor, i + 1),
      profile_id: profileId,
      full_name: r[0],
      photo_url: `/avatars/doctor-${i + 1}.svg`,
      qualification: r[3],
      registration_no: `TCMC/${String(40000 + i * 1373).padStart(5, '0')}`,
      registration_council: 'Travancore-Cochin Medical Council',
      verification_status: i === 9 ? 'pending' : 'verified',
      experience_years: r[4],
      languages: r[5],
      hospital_id: HOSPITALS[r[2] - 1].id,
      department_id: DEPARTMENTS[r[1] - 1].id,
      bio: `${r[0].replace('Dr. ', 'Dr ')} is a consultant in ${DEPARTMENTS[r[1] - 1].name} at ${HOSPITALS[r[2] - 1].name} with ${r[4]} years of experience.`,
      modes: r[6],
      slot_minutes: 15,
      rating_avg: 0,
      rating_count: 0,
      signature_url: `/signatures/doctor-${i + 1}.svg`,
      phone: r[8],
      active: true,
    };
  });

  /* ---------------- availability: Mon–Sat mornings & evenings; demo cardiologist also Sundays and late evening */
  const doctor_availability: DoctorAvailability[] = [];
  let avN = 1;
  doctors.forEach((d, i) => {
    const days = i === 0 ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6];
    for (const weekday of days) {
      const windows = i === 0 ? [['08:00', '13:00'], ['15:00', '22:00']] : i % 2 ? [['09:00', '12:30'], ['17:00', '19:30']] : [['10:00', '13:00'], ['14:00', '17:00']];
      for (const [s, e] of windows) {
        doctor_availability.push({ id: uid(K.availability, avN++), doctor_id: d.id, kind: 'weekly', weekday, start_time: s, end_time: e, block_date_from: null, block_date_to: null, reason: null });
      }
    }
  });
  // A leave block for one doctor, 10 days out
  const leaveDay = addDaysKey(istDateKey(now), 10);
  doctor_availability.push({ id: uid(K.availability, avN++), doctor_id: doctors[4].id, kind: 'block', weekday: null, start_time: '00:00', end_time: '23:59', block_date_from: leaveDay, block_date_to: addDaysKey(leaveDay, 2), reason: 'Conference leave' });

  /* ---------------- fees */
  const fee_config: FeeConfig[] = [];
  let feeN = 1;
  const round50 = (x: number) => Math.round(x / 50) * 50;
  DEPARTMENTS.forEach((dep, i) => {
    const base = [500, 800, 500, 700, 600, 650, 550, 750][i];
    for (const mode of ['video', 'audio'] as ConsultMode[]) {
      fee_config.push({ id: uid(K.fee, feeN++), scope: 'department', department_id: dep.id, doctor_id: null, mode, consult_type: 'first', amount: mode === 'video' ? base : base - 100 });
      fee_config.push({ id: uid(K.fee, feeN++), scope: 'department', department_id: dep.id, doctor_id: null, mode, consult_type: 'follow_up', amount: round50((mode === 'video' ? base : base - 100) * 0.6) });
    }
  });
  doctors.forEach((d, i) => {
    const fee = DOCTOR_ROWS[i][7];
    if (i % 3 === 0) {
      fee_config.push({ id: uid(K.fee, feeN++), scope: 'doctor', doctor_id: d.id, department_id: null, mode: 'video', consult_type: 'first', amount: fee });
      fee_config.push({ id: uid(K.fee, feeN++), scope: 'doctor', doctor_id: d.id, department_id: null, mode: 'audio', consult_type: 'first', amount: fee - 100 });
    }
  });
  const feeFor = (d: Doctor, mode: ConsultMode, type: 'first' | 'follow_up') =>
    fee_config.find((f) => f.scope === 'doctor' && f.doctor_id === d.id && f.mode === mode && f.consult_type === type)?.amount ??
    fee_config.find((f) => f.scope === 'department' && f.department_id === d.department_id && f.mode === mode && f.consult_type === type)!.amount;

  /* ---------------- patients */
  const patients: Patient[] = [];
  const consents: Consent[] = [];
  let consentN = 1;
  PATIENT_ROWS.forEach((r, i) => {
    const owner = addUser(200 + i, r[0], r[3], null, 'patient');
    patients.push({
      id: uid(K.patient, i + 1),
      owner_user_id: owner,
      full_name: r[0],
      date_of_birth: r[1],
      gender: r[2],
      phone: r[3],
      email: null,
      address: r[4] + ', Kerala',
      blood_group: ['O+', 'B+', 'A+', 'AB+', 'O-'][i % 5],
      allergies: r[5],
      his_mrn: `SUN${String(100230 + i * 17)}`,
      abha_number: null,
      is_primary: true,
      created_at: created,
    });
    for (const t of ['teleconsultation', 'data_processing', 'whatsapp_opt_in', 'terms'] as const) {
      consents.push({ id: uid(K.consent, consentN++), user_id: owner, consent_type: t, version: '1.0', granted: true, granted_at: created, withdrawn_at: null, user_agent: 'seed' });
    }
  });
  const dependents: Dependent[] = DEPENDENT_ROWS.map((r, i) => {
    const pid = uid(K.patient, PATIENT_ROWS.length + i + 1);
    patients.push({
      id: pid,
      owner_user_id: patients[0].owner_user_id,
      full_name: r[0],
      date_of_birth: r[1],
      gender: r[2],
      phone: patients[0].phone,
      email: null,
      address: patients[0].address,
      blood_group: 'B+',
      allergies: [],
      his_mrn: `SUN${String(100900 + i)}`,
      abha_number: null,
      is_primary: false,
      created_at: created,
    });
    return { id: uid(K.dependent, i + 1), owner_patient_id: patients[0].id, patient_id: pid, relation: r[3] };
  });

  /* ---------------- appointments */
  type Spec = {
    p: number;
    d: number;
    off: number; // minutes from now
    mode: ConsultMode;
    status: AppointmentStatus;
    outcome?: AppointmentOutcome;
    follow?: number; // index (1-based spec #) of index appointment => free follow-up
    rx?: boolean;
    refund?: boolean;
    reason?: string;
  };
  const day = 24 * 60;
  const specs: Spec[] = [
    /* 1 */ { p: 0, d: 1, off: -5 * day, mode: 'video', status: 'completed', outcome: 'completed', rx: true },
    /* 2 */ { p: 0, d: 0, off: 8, mode: 'video', status: 'confirmed' },
    /* 3 */ { p: 18, d: 0, off: 180, mode: 'audio', status: 'confirmed' },
    /* 4 */ { p: 19, d: 2, off: -40 * day, mode: 'video', status: 'completed', outcome: 'completed', rx: true },
    /* 5 */ { p: 19, d: 2, off: -30 * day, mode: 'video', status: 'completed', outcome: 'completed', follow: 4, rx: true },
    /* 6 */ { p: 0, d: 4, off: -20 * day, mode: 'video', status: 'cancelled', outcome: 'cancelled_by_patient', refund: true, reason: 'Travelling' },
    /* 7 */ { p: 0, d: 6, off: -60 * day, mode: 'audio', status: 'no_show', outcome: 'patient_no_show', reason: 'Patient did not join within grace period' },
    /* 8 */ { p: 0, d: 4, off: 3 * day + 120, mode: 'video', status: 'confirmed' },
    /* 9 */ { p: 1, d: 0, off: -150, mode: 'video', status: 'completed', outcome: 'completed', rx: true },
    /* 10 */ { p: 3, d: 0, off: -90, mode: 'video', status: 'no_show', outcome: 'patient_no_show', reason: 'Patient did not join' },
    /* 11 */ { p: 5, d: 0, off: -45, mode: 'audio', status: 'completed', outcome: 'completed', rx: true },
    /* 12 */ { p: 7, d: 0, off: 60, mode: 'video', status: 'confirmed' },
    /* 13 */ { p: 9, d: 0, off: 120, mode: 'audio', status: 'confirmed', follow: 14 },
    /* 14 */ { p: 9, d: 0, off: -10 * day, mode: 'video', status: 'completed', outcome: 'completed', rx: true },
    /* 15 */ { p: 11, d: 0, off: 1 * day, mode: 'video', status: 'confirmed' },
    /* 16 */ { p: 13, d: 0, off: 2 * day + 60, mode: 'video', status: 'confirmed' },
    /* 17 */ { p: 2, d: 0, off: -3 * day, mode: 'video', status: 'completed', outcome: 'completed', rx: true },
    /* 18 */ { p: 2, d: 3, off: -7 * day, mode: 'video', status: 'completed', outcome: 'completed', rx: true },
    /* 19 */ { p: 4, d: 4, off: -2 * day, mode: 'video', status: 'completed', outcome: 'completed', rx: true },
    /* 20 */ { p: 6, d: 5, off: -12 * day, mode: 'audio', status: 'completed', outcome: 'completed', rx: true },
    /* 21 */ { p: 8, d: 6, off: -1 * day, mode: 'video', status: 'completed', outcome: 'completed', rx: true },
    /* 22 */ { p: 10, d: 7, off: -15 * day, mode: 'video', status: 'completed', outcome: 'completed', rx: true },
    /* 23 */ { p: 12, d: 8, off: -4 * day, mode: 'audio', status: 'completed', outcome: 'completed' },
    /* 24 */ { p: 14, d: 9, off: -6 * day, mode: 'video', status: 'completed', outcome: 'completed', rx: true },
    /* 25 */ { p: 15, d: 1, off: -8 * day, mode: 'video', status: 'cancelled', outcome: 'cancelled_by_doctor', refund: true, reason: 'Doctor on emergency duty' },
    /* 26 */ { p: 16, d: 7, off: -9 * day, mode: 'video', status: 'cancelled', outcome: 'technical_failure', refund: true, reason: 'Video could not connect for either party' },
    /* 27 */ { p: 17, d: 5, off: 1 * day + 90, mode: 'audio', status: 'confirmed' },
    /* 28 */ { p: 3, d: 7, off: 2 * day + 30, mode: 'audio', status: 'confirmed' },
    /* 29 */ { p: 5, d: 1, off: 240, mode: 'video', status: 'confirmed' },
    /* 30 */ { p: 6, d: 3, off: 1 * day + 180, mode: 'video', status: 'confirmed' },
    /* 31 */ { p: 8, d: 9, off: 5 * day, mode: 'video', status: 'confirmed' },
    /* 32 */ { p: 10, d: 1, off: -25 * day, mode: 'video', status: 'completed', outcome: 'completed', rx: true },
    /* 33 */ { p: 12, d: 4, off: -1 * day - 60, mode: 'video', status: 'no_show', outcome: 'patient_no_show', reason: 'Patient did not join' },
    /* 34 */ { p: 14, d: 6, off: 360, mode: 'video', status: 'confirmed' },
    /* 35 */ { p: 16, d: 8, off: 2 * day + 240, mode: 'audio', status: 'confirmed' },
    /* 36 */ { p: 1, d: 9, off: -30 * day, mode: 'video', status: 'completed', outcome: 'completed', rx: true },
    /* 37 */ { p: 4, d: 5, off: 2 * day + 15, mode: 'video', status: 'cancelled', outcome: 'payment_expired', reason: 'Payment not completed within hold time' },
    /* 38 */ { p: 7, d: 1, off: -14 * day, mode: 'video', status: 'rescheduled', reason: 'Patient requested new time' },
    /* 39 */ { p: 7, d: 1, off: -13 * day, mode: 'video', status: 'completed', outcome: 'completed', rx: true },
    /* 40 */ { p: 15, d: 6, off: -1 * day - 120, mode: 'video', status: 'cancelled', outcome: 'doctor_no_show', refund: true, reason: 'Doctor did not join within 10 minutes' },
  ];

  const slots: Slot[] = [];
  const appointments: Appointment[] = [];
  const payments: Payment[] = [];
  const refunds: Refund[] = [];
  const consultations: Consultation[] = [];
  const prescriptions: Prescription[] = [];
  const symptoms: AppointmentSymptoms[] = [];
  const documents: MedicalDocument[] = [];
  const ratings: Rating[] = [];
  const call_logs: CallLog[] = [];
  let itemN = 1;
  let logN = 1;

  const RX_BY_DEPT: Record<number, { dx: string[]; drugs: string[]; cc: string; adv: string }> = {
    0: { dx: ['J06.9'], drugs: ['Paracetamol 650', 'Cetirizine', 'Saline Nasal Drops'], cc: 'Fever and sore throat for 2 days', adv: 'Warm saline gargles, plenty of fluids, rest.' },
    1: { dx: ['I10', 'E78.5'], drugs: ['Amlodipine', 'Atorvastatin'], cc: 'Follow-up of high blood pressure', adv: 'Low salt diet, 30 min brisk walk daily, home BP log.' },
    2: { dx: ['J00'], drugs: ['Paracetamol Syrup', 'Saline Nasal Drops'], cc: 'Runny nose and mild fever', adv: 'Steam inhalation, fluids. Review if fever > 3 days.' },
    3: { dx: ['N94.6'], drugs: ['Paracetamol 650', 'Folic Acid'], cc: 'Painful periods', adv: 'Warm compress, track cycle in diary.' },
    4: { dx: ['L70.0'], drugs: ['Clotrimazole Cream', 'Cetirizine'], cc: 'Itchy rash on forearms', adv: 'Keep area dry, cotton clothing.' },
    5: { dx: ['M54.5'], drugs: ['Paracetamol 650', 'Calcium + Vit D3'], cc: 'Lower back pain after lifting', adv: 'Avoid heavy lifting, back extension exercises.' },
    6: { dx: ['J01.9'], drugs: ['Xylometazoline', 'Cetirizine'], cc: 'Blocked nose and facial pain', adv: 'Steam inhalation twice daily.' },
    7: { dx: ['E11.9'], drugs: ['Metformin', 'Vitamin D3 60K'], cc: 'Review of blood sugar', adv: 'Diabetic diet, monitor fasting sugar thrice weekly.' },
  };

  specs.forEach((s, i) => {
    const n = i + 1;
    const doctor = doctors[s.d];
    const patient = patients[s.p];
    const start = addMinutes(now, s.off);
    const end = addMinutes(start, doctor.slot_minutes);
    const apptId = uid(K.appointment, n);
    const slotId = uid(K.slot, n);
    const active = ['confirmed', 'in_progress', 'completed', 'no_show', 'pending_payment'].includes(s.status);
    slots.push({ id: slotId, doctor_id: doctor.id, start_at: iso(start), end_at: iso(end), status: active ? 'booked' : 'open', held_until: null, appointment_id: active ? apptId : null });

    const isFree = !!s.follow;
    const ctype = s.follow ? 'follow_up' : 'first';
    const fee = isFree ? 0 : feeFor(doctor, s.mode, ctype);
    const bookedAt = addMinutes(start, -2 * day - Math.floor(rand() * day));
    const appt: Appointment = {
      id: apptId,
      ref_code: makeRefCode(rand),
      patient_id: patient.id,
      booked_by_user_id: patient.owner_user_id,
      doctor_id: doctor.id,
      hospital_id: doctor.hospital_id,
      department_id: doctor.department_id,
      slot_id: slotId,
      start_at: iso(start),
      end_at: iso(end),
      mode: s.mode,
      consult_type: ctype,
      index_appointment_id: s.follow ? uid(K.appointment, s.follow) : null,
      fee_amount: fee,
      is_free: isFree,
      status: s.status,
      outcome: s.outcome ?? null,
      outcome_reason: s.reason ?? null,
      hold_expires_at: null,
      rescheduled_from_id: null,
      rescheduled_to_id: null,
      fee_override_reason: null,
      extended_minutes: 0,
      doctor_joined_at: s.status === 'completed' || s.outcome === 'patient_no_show' ? iso(addMinutes(start, 1)) : null,
      patient_joined_at: s.status === 'completed' ? iso(addMinutes(start, 2)) : null,
      completed_at: s.status === 'completed' ? iso(addMinutes(end, 2)) : null,
      cancelled_at: s.status === 'cancelled' ? iso(addMinutes(start, s.outcome === 'cancelled_by_patient' ? -day : 15)) : null,
      created_at: iso(bookedAt),
    };
    appointments.push(appt);

    if (fee > 0 && s.outcome !== 'payment_expired') {
      const payId = uid(K.payment, n);
      const methods = ['upi', 'card', 'upi', 'netbanking', 'wallet', 'upi'] as const;
      payments.push({
        id: payId,
        appointment_id: apptId,
        provider: 'mock',
        provider_order_id: `order_demo${String(n).padStart(6, '0')}`,
        provider_payment_id: `pay_demo${String(n).padStart(6, '0')}`,
        amount: fee,
        currency: 'INR',
        method: methods[n % methods.length],
        status: s.refund ? 'refunded' : 'captured',
        settled: s.off < -2 * day,
        settlement_id: s.off < -2 * day ? `setl_demo${Math.abs(Math.floor(s.off / day))}` : null,
        created_at: iso(bookedAt),
        captured_at: iso(addMinutes(bookedAt, 2)),
      });
      if (s.refund) {
        refunds.push({
          id: uid(K.refund, n),
          payment_id: payId,
          appointment_id: apptId,
          amount: fee,
          reason: s.reason ?? 'Refund',
          status: 'processed',
          provider_refund_id: `rfnd_demo${n}`,
          initiated_by: s.outcome === 'cancelled_by_patient' ? patient.owner_user_id : adminId,
          created_at: appt.cancelled_at!,
          processed_at: iso(addMinutes(appt.cancelled_at!, 60)),
        });
      }
    } else if (s.outcome === 'payment_expired') {
      payments.push({
        id: uid(K.payment, n),
        appointment_id: apptId,
        provider: 'mock',
        provider_order_id: `order_demo${String(n).padStart(6, '0')}`,
        provider_payment_id: null,
        amount: feeFor(doctor, s.mode, 'first'),
        currency: 'INR',
        method: null,
        status: 'failed',
        settled: false,
        settlement_id: null,
        created_at: iso(bookedAt),
        captured_at: null,
      });
    }

    const deptIdx = DEPARTMENTS.findIndex((d) => d.id === doctor.department_id);
    const rx = RX_BY_DEPT[deptIdx];
    symptoms.push({
      appointment_id: apptId,
      body_area: ['General', 'Chest', 'Head & neck', 'Abdomen', 'Skin', 'Back', 'Head & neck', 'General'][deptIdx],
      symptoms: rx.cc.toLowerCase().includes('fever') ? ['Fever', 'Sore throat'] : [rx.cc.split(' ').slice(0, 2).join(' ')],
      duration: ['1-3 days', '1 week', '2-4 weeks', 'More than a month'][n % 4],
      severity: 3 + (n % 5),
      description: rx.cc,
      voice_note_path: null,
      vitals: s.d === 0 || deptIdx === 1 ? { bp: '146/92', pulse: '84', spo2: '98' } : {},
      allergies: patient.allergies.join(', '),
      current_medicines: deptIdx === 1 ? 'Amlodipine 5 mg' : '',
      past_history: deptIdx === 7 ? 'Type 2 diabetes for 6 years' : '',
    });

    if (s.status === 'completed') {
      const diagnoses = rx.dx.map((code) => ICD10.find((x) => x.code === code)!).filter(Boolean);
      consultations.push({
        id: uid(K.consultation, n),
        appointment_id: apptId,
        doctor_id: doctor.id,
        patient_id: patient.id,
        chief_complaint: rx.cc,
        history: 'Symptoms as described in pre-consult form. No red-flag symptoms reported.',
        examination: s.mode === 'video' ? 'Alert, comfortable on video. No visible distress.' : 'Audio consult; history-based assessment.',
        diagnoses,
        advice: rx.adv,
        investigations: deptIdx === 1 ? 'Lipid profile, ECG' : deptIdx === 7 ? 'HbA1c, FBS, PPBS' : '',
        follow_up_date: istDateKey(addMinutes(start, 14 * day)),
        status: 'final',
        updated_at: appt.completed_at!,
      });
      if (s.rx) {
        const pid = uid(K.prescription, n);
        prescriptions.push({
          id: pid,
          appointment_id: apptId,
          doctor_id: doctor.id,
          patient_id: patient.id,
          version: 1,
          parent_prescription_id: null,
          addendum_reason: null,
          status: 'final',
          verification_code: makeVerificationCode(rand),
          advice: rx.adv,
          investigations: deptIdx === 1 ? 'Lipid profile, ECG' : deptIdx === 7 ? 'HbA1c, FBS, PPBS' : '',
          follow_up_date: istDateKey(addMinutes(start, 14 * day)),
          diagnoses,
          finalized_at: appt.completed_at,
          pdf_path: null,
          created_at: appt.completed_at!,
          items: rx.drugs.map((name) => {
            const drug = DRUGS.find((x) => x.name === name)!;
            return {
              id: uid(K.item, itemN++),
              prescription_id: pid,
              drug_id: drug.id,
              drug_name: drug.name,
              strength: drug.strength,
              form: drug.form,
              dose: drug.default_dose,
              frequency: drug.default_frequency,
              duration: '5 days',
              route: drug.default_route,
              instructions: 'After food',
            };
          }),
        });
      }
      if (n % 3 !== 0) {
        ratings.push({ id: uid(K.rating, n), appointment_id: apptId, doctor_id: doctor.id, patient_id: patient.id, stars: n % 4 === 0 ? 4 : 5, comment: n % 2 ? 'Very patient and clear explanation.' : '', created_at: appt.completed_at! });
      }
      for (const [event, actor_role, off] of [['join', 'doctor', 1], ['join', 'patient', 2], ['end', 'doctor', 16]] as const) {
        call_logs.push({ id: uid(K.calllog, logN++), appointment_id: apptId, provider: 'livekit', room_name: `scc-seed-${apptId.slice(-12)}`, event, actor_user_id: null, actor_role, source: 'client', detail: null, created_at: iso(addMinutes(start, off)) });
      }
    }
  });

  // Reschedule chain #38 -> #39
  appointments[37].rescheduled_to_id = appointments[38].id;
  appointments[38].rescheduled_from_id = appointments[37].id;
  // payment of #38 moves to #39 (paid once)
  const p38 = payments.find((p) => p.appointment_id === appointments[37].id);
  if (p38) p38.appointment_id = appointments[38].id;
  payments.splice(payments.findIndex((p) => p.appointment_id === appointments[38].id && p !== p38), 1);

  // Pending doctor-initiated same-day reschedule on #3 (Anjali's mother)
  const propStart = addMinutes(now, 300);
  const propSlotId = uid(K.slot, 100);
  slots.push({ id: propSlotId, doctor_id: doctors[0].id, start_at: iso(propStart), end_at: iso(addMinutes(propStart, 15)), status: 'held', held_until: iso(addMinutes(now, 120)), appointment_id: null });
  const reschedule_requests: RescheduleRequest[] = [
    { id: uid(K.reschedule, 1), appointment_id: appointments[2].id, requested_by: 'doctor', proposed_slot_id: propSlotId, proposed_start_at: iso(propStart), reason: 'Emergency procedure in the cath lab', status: 'pending', response_note: null, new_appointment_id: null, created_at: iso(addMinutes(now, -20)), responded_at: null },
  ];

  /* ---------------- documents for upcoming consult #2 and history */
  const docRows: [number, number, MedicalDocument['tag'], string, string, number][] = [
    [2, 0, 'lab_report', 'Lipid profile – Sep 2026.pdf', 'application/pdf', 182_000],
    [2, 0, 'imaging', 'ECG strip.png', 'image/png', 96_000],
    [1, 0, 'prescription', 'Previous prescription.pdf', 'application/pdf', 120_000],
    [4, 19, 'photo', 'Rash photo.png', 'image/png', 210_000],
    [13, 9, 'lab_report', 'HbA1c report.pdf', 'application/pdf', 140_000],
  ];
  docRows.forEach(([apptN, p, tag, name, mime, size], i) => {
    const ext = mime === 'application/pdf' ? 'pdf' : 'png';
    documents.push({
      id: uid(K.document, i + 1),
      patient_id: patients[p].id,
      appointment_id: uid(K.appointment, apptN),
      uploaded_by: patients[p].owner_user_id,
      tag,
      file_name: name,
      mime_type: mime,
      size_bytes: size,
      storage_path: `seed/${i + 1}/sample-${tag}.${ext}`,
      created_at: iso(addMinutes(now, -day)),
    });
  });

  /* ---------------- ratings → doctor aggregates */
  for (const d of doctors) {
    const rs = ratings.filter((r) => r.doctor_id === d.id);
    const base = 40 + (DOCTOR_ROWS.findIndex((x) => x[0] === d.full_name) * 7) % 60; // historical ratings
    d.rating_count = base + rs.length;
    d.rating_avg = Math.round(((4.6 * base + rs.reduce((s, r) => s + r.stars, 0)) / d.rating_count) * 10) / 10;
  }

  /* ---------------- notifications (outbox) */
  const notifications: NotificationRow[] = [
    { template_key: 'booking_confirmed', user: patients[0].owner_user_id, appt: 1, mins: -2 * day },
    { template_key: 'payment_received', user: patients[0].owner_user_id, appt: 1, mins: -2 * day },
    { template_key: 'reminder_1h', user: patients[0].owner_user_id, appt: 1, mins: -50 },
    { template_key: 'reschedule_proposed', user: patients[0].owner_user_id, appt: 2, mins: -20 },
    { template_key: 'prescription_ready', user: patients[0].owner_user_id, appt: 0, mins: -5 * day + 30 },
    { template_key: 'doctor_new_booking', user: doctors[0].profile_id, appt: 1, mins: -2 * day },
  ].map((n, i) => {
    const a = appointments[n.appt];
    const tpl = TEMPLATES.find((t) => t.key === n.template_key)!;
    const vars: Record<string, string> = { name: 'Anjali', doctor: doctors[0].full_name, date: istDateKey(a.start_at), time: a.start_at.slice(11, 16), ref: a.ref_code, link: `/a/${a.ref_code}`, amount: String(a.fee_amount) };
    return {
      id: uid(K.notification, i + 1),
      user_id: n.user,
      channel: 'whatsapp' as const,
      template_key: n.template_key,
      variables: Object.fromEntries(tpl.variables.map((v) => [v, vars[v] ?? ''])),
      rendered_text: tpl.body_en.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? ''),
      link: `/a/${a.ref_code}`,
      to_masked: '+91 98•••••001',
      status: i === 3 ? ('sent' as const) : ('read' as const),
      provider_message_id: `wamid.demo${i}`,
      error: null,
      read_at: i === 3 ? null : iso(addMinutes(now, n.mins + 5)),
      created_at: iso(addMinutes(now, n.mins)),
    };
  });

  const support_tickets: SupportTicket[] = [
    { id: uid(K.ticket, 1), user_id: patients[2].owner_user_id, appointment_id: null, category: 'payment', subject: 'UPI debited twice', description: 'My UPI app shows two debits for one booking.', status: 'in_progress', assigned_to: null, resolution: null, created_at: iso(addMinutes(now, -2 * day)), updated_at: iso(addMinutes(now, -day)) },
    { id: uid(K.ticket, 2), user_id: patients[5].owner_user_id, appointment_id: null, category: 'technical', subject: 'Camera not detected', description: 'The app says camera blocked on my phone.', status: 'open', assigned_to: null, resolution: null, created_at: iso(addMinutes(now, -300)), updated_at: iso(addMinutes(now, -300)) },
    { id: uid(K.ticket, 3), user_id: patients[0].owner_user_id, appointment_id: null, category: 'prescription', subject: 'Need prescription in Malayalam', description: 'Can I get advice section in Malayalam?', status: 'resolved', assigned_to: null, resolution: 'Doctor added Malayalam advice in addendum.', created_at: iso(addMinutes(now, -10 * day)), updated_at: iso(addMinutes(now, -9 * day)) },
  ];

  const audit_logs: AuditLog[] = [
    { id: uid(K.audit, 1), actor_user_id: adminId, actor_role: 'admin', action: 'doctor.verify', entity: 'doctors', entity_id: doctors[0].id, before: { verification_status: 'pending' }, after: { verification_status: 'verified' }, reason: 'TCMC registration checked online', created_at: iso(addMinutes(now, -80 * day)) },
    { id: uid(K.audit, 2), actor_user_id: adminId, actor_role: 'admin', action: 'policy.update', entity: 'follow_up_policy', entity_id: null, before: { free_window_days: 7 }, after: { free_window_days: 14 }, reason: 'Board decision Oct 2026', created_at: iso(addMinutes(now, -30 * day)) },
    { id: uid(K.audit, 3), actor_user_id: adminId, actor_role: 'admin', action: 'refund.create', entity: 'refunds', entity_id: uid(K.refund, 25), before: null, after: { amount: appointments[24].fee_amount }, reason: 'Doctor cancelled', created_at: appointments[24].cancelled_at! },
  ];

  const holidays: Holiday[] = [
    { id: uid(K.holiday, 1), hospital_id: null, date: '2026-11-01', name: 'Kerala Piravi' },
    { id: uid(K.holiday, 2), hospital_id: null, date: '2026-12-25', name: 'Christmas' },
    { id: uid(K.holiday, 3), hospital_id: null, date: '2027-01-26', name: 'Republic Day' },
  ];

  return {
    version: SEED_VERSION,
    seeded_at: iso(nowInput),
    profiles,
    user_roles,
    hospitals: HOSPITALS,
    departments: DEPARTMENTS,
    doctors,
    doctor_availability,
    slots,
    patients,
    dependents,
    consents,
    appointments,
    appointment_symptoms: symptoms,
    documents,
    payments,
    refunds,
    consultations,
    prescriptions,
    drug_master: DRUGS,
    icd10_master: ICD10,
    note_templates: noteTemplates(doctors[0].id),
    drug_rules: defaultDrugRules().map((r, i) => ({ ...r, id: uid(K.rule, i + 1) })),
    follow_up_policy: DEFAULT_FOLLOW_UP_POLICY,
    fee_config,
    reschedule_requests,
    notifications,
    notification_templates: TEMPLATES,
    ratings,
    support_tickets,
    call_logs,
    chat_messages: [],
    audit_logs,
    app_settings: DEFAULT_SETTINGS,
    holidays,
    data_requests: [],
    doctor_prefs: {
      [doctors[0].id]: {
        favourite_drugs: ['drug-002', 'drug-058', 'drug-064', 'drug-045'],
        note_templates: [
          { id: 't1', name: 'Hypertension review', chief_complaint: 'Review of blood pressure', examination: 'Home BP readings reviewed. No pedal oedema reported.', advice: 'Low salt diet, daily walk 30 min, continue home BP log.', investigations: 'Lipid profile, Serum creatinine, ECG' },
          { id: 't2', name: 'Chest pain triage', chief_complaint: 'Chest discomfort', examination: 'Patient comfortable on video, speaking full sentences.', advice: 'If pain is severe, crushing or with sweating, call 112 immediately.', investigations: 'ECG, Troponin I, Echo' },
        ],
      },
    },
    auth: {
      doctor_pins: Object.fromEntries(doctors.map((d) => [d.profile_id, DEMO.doctorPin])),
      admin_passwords: { [DEMO.adminEmail]: DEMO.adminPassword, [DEMO.financeEmail]: DEMO.adminPassword, [DEMO.coordinatorEmail]: DEMO.adminPassword },
      mfa_enabled: {},
    },
  };
}
