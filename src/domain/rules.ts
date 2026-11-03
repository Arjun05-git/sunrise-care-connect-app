/**
 * Pure business rules. No I/O. Used by:
 *  - the demo adapter (browser),
 *  - Supabase edge functions (copied into supabase/functions/_shared by `npm run sync:shared`),
 *  - unit tests (rules.test.ts).
 * The authoritative enforcement for booking / double-booking / consult type lives in Postgres
 * (supabase/migrations/0003_functions.sql) and mirrors these functions.
 */
import type {
  Appointment,
  AppSettings,
  ConsultMode,
  ConsultType,
  Doctor,
  DoctorAvailability,
  Drug,
  DrugRule,
  FeeConfig,
  FollowUpPolicy,
  Holiday,
} from './types';
import { addDaysKey, addMinutes, fromIst, istDateKey, istWeekday, minutesBetween } from './time';

/* ------------------------------------------------------------------ slots */

export interface SlotCandidate {
  start_at: string;
  end_at: string;
}

/**
 * Expand weekly availability into concrete slots for [fromDateKey, fromDateKey + days),
 * skipping dated blocks (leave / blocked time) and holidays.
 */
export function generateSlotCandidates(
  doctor: Pick<Doctor, 'id' | 'slot_minutes' | 'hospital_id'>,
  availability: DoctorAvailability[],
  holidays: Holiday[],
  fromDateKey: string,
  days: number,
): SlotCandidate[] {
  const out: SlotCandidate[] = [];
  const weekly = availability.filter((a) => a.kind === 'weekly');
  const blocks = availability.filter((a) => a.kind === 'block');
  for (let i = 0; i < days; i++) {
    const day = addDaysKey(fromDateKey, i);
    if (holidays.some((h) => h.date === day && (h.hospital_id === null || h.hospital_id === doctor.hospital_id))) continue;
    const weekday = istWeekday(fromIst(day, '12:00'));
    for (const w of weekly.filter((x) => x.weekday === weekday)) {
      let cursor = fromIst(day, w.start_time);
      const end = fromIst(day, w.end_time);
      while (addMinutes(cursor, doctor.slot_minutes) <= end) {
        const slotEnd = addMinutes(cursor, doctor.slot_minutes);
        const blocked = blocks.some((b) => {
          if (!b.block_date_from || !b.block_date_to) return false;
          if (day < b.block_date_from || day > b.block_date_to) return false;
          const bs = fromIst(day, b.start_time);
          const be = fromIst(day, b.end_time);
          return cursor < be && slotEnd > bs;
        });
        if (!blocked) out.push({ start_at: cursor.toISOString(), end_at: slotEnd.toISOString() });
        cursor = slotEnd;
      }
    }
  }
  return out;
}

/** A slot is bookable when open, or held but the hold has lapsed, and it starts in the future. */
export function isSlotBookable(slot: { status: string; held_until: string | null; start_at: string }, now = new Date()): boolean {
  if (new Date(slot.start_at) <= now) return false;
  if (slot.status === 'open') return true;
  if (slot.status === 'held' && slot.held_until && new Date(slot.held_until) <= now) return true;
  return false;
}

/* ---------------------------------------------------------- consult type */

export interface ConsultTypeDecision {
  consult_type: ConsultType;
  is_free: boolean;
  index_appointment_id: string | null;
  free_remaining: number;
  window_ends_at: string | null;
  reason: 'no_prior_consult' | 'window_expired' | 'free_follow_up' | 'follow_up_free_exhausted';
}

/**
 * Decide first consult vs follow-up.
 * A follow-up applies when the same patient had a COMPLETED, PAID consult ("index consult") within
 * `free_window_days` that matches the policy's doctor rule. Up to `free_follow_up_count` follow-ups
 * against that index consult are free; further follow-ups inside the window are charged the
 * follow-up fee. Outside the window the visit is a first consult with the normal fee.
 */
export function determineConsultType(args: {
  patientId: string;
  doctor: Pick<Doctor, 'id' | 'department_id'>;
  startAt: string;
  history: Pick<Appointment, 'id' | 'patient_id' | 'doctor_id' | 'department_id' | 'status' | 'is_free' | 'fee_amount' | 'completed_at' | 'start_at' | 'index_appointment_id' | 'consult_type'>[];
  policy: FollowUpPolicy;
}): ConsultTypeDecision {
  const { patientId, doctor, startAt, history, policy } = args;
  const matches = (a: { doctor_id: string; department_id: string }) =>
    policy.match_rule === 'any' ||
    (policy.match_rule === 'same_doctor' && a.doctor_id === doctor.id) ||
    (policy.match_rule === 'same_department' && a.department_id === doctor.department_id);

  const indexCandidates = history
    .filter((a) => a.patient_id === patientId && a.status === 'completed' && !a.is_free && a.fee_amount > 0 && matches(a))
    .filter((a) => new Date(a.completed_at ?? a.start_at) <= new Date(startAt))
    .sort((a, b) => (b.completed_at ?? b.start_at).localeCompare(a.completed_at ?? a.start_at));

  const index = indexCandidates[0];
  if (!index) return { consult_type: 'first', is_free: false, index_appointment_id: null, free_remaining: 0, window_ends_at: null, reason: 'no_prior_consult' };

  const windowEnds = addMinutes(index.completed_at ?? index.start_at, policy.free_window_days * 24 * 60);
  if (new Date(startAt) > windowEnds) {
    return { consult_type: 'first', is_free: false, index_appointment_id: null, free_remaining: 0, window_ends_at: windowEnds.toISOString(), reason: 'window_expired' };
  }
  const used = history.filter(
    (a) => a.index_appointment_id === index.id && a.is_free && !['cancelled', 'rescheduled'].includes(a.status),
  ).length;
  const remaining = Math.max(0, policy.free_follow_up_count - used);
  return {
    consult_type: 'follow_up',
    is_free: remaining > 0,
    index_appointment_id: index.id,
    free_remaining: remaining,
    window_ends_at: windowEnds.toISOString(),
    reason: remaining > 0 ? 'free_follow_up' : 'follow_up_free_exhausted',
  };
}

/* -------------------------------------------------------------------- fee */

/** Doctor-specific fee wins over department fee. Returns null when nothing is configured. */
export function resolveFee(
  configs: FeeConfig[],
  doctor: Pick<Doctor, 'id' | 'department_id'>,
  mode: ConsultMode,
  consultType: ConsultType,
): number | null {
  const byDoctor = configs.find((c) => c.scope === 'doctor' && c.doctor_id === doctor.id && c.mode === mode && c.consult_type === consultType);
  if (byDoctor) return byDoctor.amount;
  const byDept = configs.find((c) => c.scope === 'department' && c.department_id === doctor.department_id && c.mode === mode && c.consult_type === consultType);
  return byDept ? byDept.amount : null;
}

/** GST is not charged on healthcare services by clinical establishments (exempt), so breakup is fee + convenience 0. */
export function feeBreakup(amount: number) {
  return { consultation: amount, platform: 0, tax: 0, total: amount };
}

/* ----------------------------------------------------------- refunds etc */

export interface RefundDecision {
  percent: number;
  amount: number;
  rule: 'doctor_or_admin_cancel' | 'tier' | 'no_tier' | 'free_consult';
  hoursBefore: number;
}

export function cancellationRefund(args: {
  appointment: Pick<Appointment, 'start_at' | 'fee_amount' | 'is_free'>;
  paidAmount: number;
  cancelledBy: 'patient' | 'doctor' | 'admin' | 'system';
  settings: Pick<AppSettings, 'cancellation_tiers'>;
  now?: Date;
}): RefundDecision {
  const now = args.now ?? new Date();
  const hoursBefore = minutesBetween(now, args.appointment.start_at) / 60;
  if (args.appointment.is_free || args.paidAmount <= 0) return { percent: 0, amount: 0, rule: 'free_consult', hoursBefore };
  if (args.cancelledBy !== 'patient') return { percent: 100, amount: args.paidAmount, rule: 'doctor_or_admin_cancel', hoursBefore };
  const tier = [...args.settings.cancellation_tiers]
    .sort((a, b) => b.min_hours_before - a.min_hours_before)
    .find((t) => hoursBefore >= t.min_hours_before);
  if (!tier) return { percent: 0, amount: 0, rule: 'no_tier', hoursBefore };
  return { percent: tier.percent, amount: Math.round((args.paidAmount * tier.percent) / 100), rule: 'tier', hoursBefore };
}

/** Patients may reschedule a confirmed appointment up to `patient_reschedule_min_hours` before start (configurable). */
export function canPatientReschedule(appointment: Pick<Appointment, 'start_at' | 'status'>, settings: Pick<AppSettings, 'patient_reschedule_min_hours'>, now = new Date()) {
  if (appointment.status !== 'confirmed') return false;
  return minutesBetween(now, appointment.start_at) / 60 >= settings.patient_reschedule_min_hours;
}

export function joinWindow(appointment: Pick<Appointment, 'start_at' | 'end_at' | 'extended_minutes'>, settings: Pick<AppSettings, 'join_window_minutes'>, now = new Date()) {
  const opensAt = addMinutes(appointment.start_at, -settings.join_window_minutes);
  const closesAt = addMinutes(appointment.end_at, 30 + appointment.extended_minutes);
  return { canJoin: now >= opensAt && now <= closesAt, opensAt, closesAt, minutesToOpen: Math.ceil(minutesBetween(now, opensAt)) };
}

export type GraceVerdict = 'ok' | 'doctor_no_show' | 'patient_no_show' | 'both_no_show' | 'waiting';

/**
 * After start + grace: if the doctor never joined → doctor no-show (patient offered free reschedule
 * or full refund). If the doctor joined but the patient did not → patient no-show per policy.
 */
export function graceCheck(
  a: Pick<Appointment, 'start_at' | 'status' | 'doctor_joined_at' | 'patient_joined_at'>,
  settings: Pick<AppSettings, 'auto_doctor_no_show_minutes' | 'auto_patient_no_show_minutes'>,
  now = new Date(),
): GraceVerdict {
  if (a.status !== 'confirmed' && a.status !== 'in_progress') return 'ok';
  const late = minutesBetween(a.start_at, now);
  if (!a.doctor_joined_at && late > settings.auto_doctor_no_show_minutes) return a.patient_joined_at ? 'doctor_no_show' : 'both_no_show';
  if (a.doctor_joined_at && !a.patient_joined_at && late > settings.auto_patient_no_show_minutes) return 'patient_no_show';
  if (late > 0 && (!a.doctor_joined_at || !a.patient_joined_at)) return 'waiting';
  return 'ok';
}

/* ------------------------------------------------------------ drug rules */

export interface DrugCheck {
  blocked: boolean;
  reasons: string[]; // i18n keys with params, rendered by UI
  warnings: string[];
}

/** Pairs of interaction groups that should raise a warning. Deliberately basic. */
export const INTERACTION_RULES: { a: string; b: string; message: string }[] = [
  { a: 'anticoagulant', b: 'nsaid', message: 'Increased bleeding risk (anticoagulant + NSAID).' },
  { a: 'anticoagulant', b: 'antiplatelet', message: 'Increased bleeding risk (anticoagulant + antiplatelet).' },
  { a: 'nsaid', b: 'nsaid', message: 'Two NSAIDs prescribed together.' },
  { a: 'ace_inhibitor', b: 'potassium_sparing', message: 'Risk of hyperkalaemia (ACE inhibitor + potassium-sparing diuretic).' },
  { a: 'ace_inhibitor', b: 'arb', message: 'Dual RAAS blockade (ACE inhibitor + ARB).' },
  { a: 'macrolide', b: 'statin', message: 'Macrolide may raise statin levels (myopathy risk).' },
  { a: 'ssri', b: 'triptan', message: 'Serotonin syndrome risk (SSRI + triptan).' },
  { a: 'ssri', b: 'tramadol', message: 'Serotonin syndrome / seizure risk (SSRI + tramadol).' },
  { a: 'qt_prolonging', b: 'qt_prolonging', message: 'Two QT-prolonging drugs.' },
  { a: 'sulfonylurea', b: 'fluoroquinolone', message: 'Dysglycaemia risk (sulfonylurea + fluoroquinolone).' },
  { a: 'metformin', b: 'contrast', message: 'Hold metformin around iodinated contrast.' },
  { a: 'ppi', b: 'clopidogrel', message: 'Omeprazole/esomeprazole may reduce clopidogrel effect.' },
];

export function checkDrug(args: {
  drug: Drug;
  mode: ConsultMode;
  consultType: ConsultType;
  rules: DrugRule[];
  patientAllergies: string[];
  otherDrugs: Drug[];
}): DrugCheck {
  const { drug, mode, consultType, rules, patientAllergies, otherDrugs } = args;
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (drug.schedule === 'X' || drug.schedule === 'narcotic') {
    reasons.push(`${drug.name} is a ${drug.schedule === 'X' ? 'Schedule X' : 'narcotic / psychotropic'} substance and cannot be prescribed by teleconsultation.`);
  }
  if (drug.category === 'prohibited') {
    reasons.push(`${drug.name} is on the Prohibited list for teleconsultation.`);
  } else {
    const rule = rules.find((r) => r.category === drug.category && r.mode === mode && r.consult_type === consultType);
    if (rule && !rule.allowed) {
      reasons.push(
        `List ${drug.category} drugs are not allowed in a ${mode} ${consultType === 'first' ? 'first consult' : 'follow-up'}.${rule.note ? ' ' + rule.note : ''}`,
      );
    }
  }

  const allergies = patientAllergies.map((a) => a.toLowerCase().trim()).filter(Boolean);
  if (drug.allergy_class && allergies.some((a) => a.includes(drug.allergy_class!) || drug.allergy_class!.includes(a))) {
    warnings.push(`Patient has a recorded ${drug.allergy_class} allergy.`);
  } else if (allergies.some((a) => drug.generic_name.toLowerCase().includes(a) || drug.name.toLowerCase().includes(a))) {
    warnings.push(`Patient has a recorded allergy matching ${drug.generic_name}.`);
  }

  for (const other of otherDrugs) {
    if (other.id === drug.id) {
      warnings.push(`${drug.name} is already on this prescription.`);
      continue;
    }
    for (const r of INTERACTION_RULES) {
      const hit =
        (drug.interaction_groups.includes(r.a) && other.interaction_groups.includes(r.b)) ||
        (drug.interaction_groups.includes(r.b) && other.interaction_groups.includes(r.a));
      if (hit) warnings.push(`${r.message} (with ${other.name})`);
    }
  }
  return { blocked: reasons.length > 0, reasons, warnings: [...new Set(warnings)] };
}

/** Telemedicine Practice Guidelines 2020 defaults. Admin can change them in Drug Rules. */
export function defaultDrugRules(): Omit<DrugRule, 'id'>[] {
  const out: Omit<DrugRule, 'id'>[] = [];
  for (const mode of ['audio', 'video'] as ConsultMode[]) {
    for (const consult_type of ['first', 'follow_up'] as ConsultType[]) {
      out.push({ category: 'O', mode, consult_type, allowed: true, note: 'List O: safe OTC / commonly used drugs.' });
      out.push({
        category: 'A',
        mode,
        consult_type,
        allowed: mode === 'video' || consult_type === 'follow_up',
        note: 'List A: first prescription needs a video consult; refills allowed in follow-up.',
      });
      out.push({ category: 'B', mode, consult_type, allowed: consult_type === 'follow_up', note: 'List B: only as add-on in a follow-up for an existing condition.' });
      out.push({ category: 'prohibited', mode, consult_type, allowed: false, note: 'Prohibited for teleconsultation.' });
    }
  }
  return out;
}

/* --------------------------------------------------------------- uploads */

export function validateUpload(file: { name: string; size: number; type: string }, settings: Pick<AppSettings, 'max_upload_mb' | 'allowed_upload_types'>): string | null {
  if (!settings.allowed_upload_types.includes(file.type)) return 'upload.errType';
  if (file.size > settings.max_upload_mb * 1024 * 1024) return 'upload.errSize';
  if (/[\\/]|\.\./.test(file.name)) return 'upload.errName';
  return null;
}

/* -------------------------------------------------------------- helpers */

/** Mask a mobile number for display: +91 98•••••210 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  const local = digits.slice(-10);
  return `+91 ${local.slice(0, 2)}•••••${local.slice(-3)}`;
}

/** Short reference code, no PHI. Uses an unambiguous alphabet. */
export function makeRefCode(rand: () => number = Math.random): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = 'SC-';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}

export function makeVerificationCode(rand: () => number = Math.random): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}

/** Render a notification template. Variables are plain strings; never pass clinical content. */
export function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
}

/** Guard used by NotificationService: refuses variable names that suggest clinical content. */
export const FORBIDDEN_NOTIFICATION_VARS = ['diagnosis', 'symptom', 'symptoms', 'medicine', 'drug', 'prescription_text', 'notes', 'complaint'];

export { istDateKey };
