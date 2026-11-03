import { describe, expect, it } from 'vitest';
import {
  cancellationRefund,
  checkDrug,
  defaultDrugRules,
  determineConsultType,
  generateSlotCandidates,
  graceCheck,
  isSlotBookable,
  joinWindow,
  maskPhone,
  resolveFee,
  validateUpload,
} from './rules';
import { fromIst, istDateKey, istTime } from './time';
import { DRUGS } from '@/data/seed/drugs';
import { buildSeed } from '@/data/seed';
import { DEFAULT_SETTINGS } from '@/data/seed/org';
import type { DrugRule } from './types';

const policy = { free_window_days: 14, free_follow_up_count: 1, match_rule: 'same_doctor' as const };
const doctor = { id: 'd1', department_id: 'dep1' };
const base = { patient_id: 'p1', doctor_id: 'd1', department_id: 'dep1', status: 'completed' as const, is_free: false, fee_amount: 500, index_appointment_id: null, consult_type: 'first' as const };

describe('IST time helpers', () => {
  it('converts IST wall time to UTC', () => {
    expect(fromIst('2026-10-23', '09:00').toISOString()).toBe('2026-10-23T03:30:00.000Z');
    expect(istTime('2026-10-23T18:45:00.000Z')).toBe('00:15');
    expect(istDateKey('2026-10-23T18:45:00.000Z')).toBe('2026-10-24');
  });
});

describe('determineConsultType', () => {
  it('is a first consult without history', () => {
    const r = determineConsultType({ patientId: 'p1', doctor, startAt: '2026-10-23T05:00:00Z', history: [], policy });
    expect(r).toMatchObject({ consult_type: 'first', is_free: false, reason: 'no_prior_consult' });
  });
  it('gives a free follow-up within the window with the same doctor', () => {
    const history = [{ ...base, id: 'a1', start_at: '2026-10-15T05:00:00Z', completed_at: '2026-10-15T05:20:00Z' }];
    const r = determineConsultType({ patientId: 'p1', doctor, startAt: '2026-10-23T05:00:00Z', history, policy });
    expect(r).toMatchObject({ consult_type: 'follow_up', is_free: true, index_appointment_id: 'a1', free_remaining: 1 });
  });
  it('charges after the free follow-up is used', () => {
    const history = [
      { ...base, id: 'a1', start_at: '2026-10-15T05:00:00Z', completed_at: '2026-10-15T05:20:00Z' },
      { ...base, id: 'a2', start_at: '2026-10-18T05:00:00Z', completed_at: '2026-10-18T05:20:00Z', is_free: true, fee_amount: 0, index_appointment_id: 'a1', consult_type: 'follow_up' as const },
    ];
    const r = determineConsultType({ patientId: 'p1', doctor, startAt: '2026-10-23T05:00:00Z', history, policy });
    expect(r).toMatchObject({ consult_type: 'follow_up', is_free: false, reason: 'follow_up_free_exhausted' });
  });
  it('cancelled free follow-ups do not consume the allowance', () => {
    const history = [
      { ...base, id: 'a1', start_at: '2026-10-15T05:00:00Z', completed_at: '2026-10-15T05:20:00Z' },
      { ...base, id: 'a2', start_at: '2026-10-18T05:00:00Z', completed_at: null, status: 'cancelled' as const, is_free: true, fee_amount: 0, index_appointment_id: 'a1' },
    ];
    const r = determineConsultType({ patientId: 'p1', doctor, startAt: '2026-10-23T05:00:00Z', history: history as never, policy });
    expect(r.is_free).toBe(true);
  });
  it('is a first consult after the window', () => {
    const history = [{ ...base, id: 'a1', start_at: '2026-09-01T05:00:00Z', completed_at: '2026-09-01T05:20:00Z' }];
    const r = determineConsultType({ patientId: 'p1', doctor, startAt: '2026-10-23T05:00:00Z', history, policy });
    expect(r).toMatchObject({ consult_type: 'first', reason: 'window_expired' });
  });
  it('respects the match rule', () => {
    const history = [{ ...base, id: 'a1', doctor_id: 'd2', start_at: '2026-10-20T05:00:00Z', completed_at: '2026-10-20T05:20:00Z' }];
    expect(determineConsultType({ patientId: 'p1', doctor, startAt: '2026-10-23T05:00:00Z', history, policy }).consult_type).toBe('first');
    expect(determineConsultType({ patientId: 'p1', doctor, startAt: '2026-10-23T05:00:00Z', history, policy: { ...policy, match_rule: 'same_department' } }).consult_type).toBe('follow_up');
  });
  it('ignores free consults and other patients as index', () => {
    const history = [
      { ...base, id: 'a1', is_free: true, fee_amount: 0, start_at: '2026-10-20T05:00:00Z', completed_at: '2026-10-20T05:20:00Z' },
      { ...base, id: 'a2', patient_id: 'p2', start_at: '2026-10-20T05:00:00Z', completed_at: '2026-10-20T05:20:00Z' },
    ];
    expect(determineConsultType({ patientId: 'p1', doctor, startAt: '2026-10-23T05:00:00Z', history, policy }).consult_type).toBe('first');
  });
});

describe('fees and refunds', () => {
  const configs = [
    { id: '1', scope: 'department' as const, department_id: 'dep1', doctor_id: null, mode: 'video' as const, consult_type: 'first' as const, amount: 500 },
    { id: '2', scope: 'doctor' as const, department_id: null, doctor_id: 'd1', mode: 'video' as const, consult_type: 'first' as const, amount: 800 },
  ];
  it('doctor fee overrides department fee', () => {
    expect(resolveFee(configs, doctor, 'video', 'first')).toBe(800);
    expect(resolveFee(configs, { id: 'd9', department_id: 'dep1' }, 'video', 'first')).toBe(500);
    expect(resolveFee(configs, doctor, 'audio', 'first')).toBeNull();
  });
  const appt = { start_at: '2026-10-23T10:00:00Z', fee_amount: 500, is_free: false };
  it('full refund more than 2h before', () => {
    expect(cancellationRefund({ appointment: appt, paidAmount: 500, cancelledBy: 'patient', settings: DEFAULT_SETTINGS, now: new Date('2026-10-23T07:00:00Z') }).amount).toBe(500);
  });
  it('no refund inside 2h', () => {
    expect(cancellationRefund({ appointment: appt, paidAmount: 500, cancelledBy: 'patient', settings: DEFAULT_SETTINGS, now: new Date('2026-10-23T09:00:00Z') }).amount).toBe(0);
  });
  it('doctor cancel is always full refund', () => {
    expect(cancellationRefund({ appointment: appt, paidAmount: 500, cancelledBy: 'doctor', settings: DEFAULT_SETTINGS, now: new Date('2026-10-23T09:59:00Z') }).percent).toBe(100);
  });
});

describe('grace period & join window', () => {
  const s = DEFAULT_SETTINGS;
  const a = { start_at: '2026-10-23T10:00:00Z', end_at: '2026-10-23T10:15:00Z', extended_minutes: 0, status: 'confirmed' as const, doctor_joined_at: null, patient_joined_at: null };
  it('join opens 10 minutes before', () => {
    expect(joinWindow(a, s, new Date('2026-10-23T09:49:00Z')).canJoin).toBe(false);
    expect(joinWindow(a, s, new Date('2026-10-23T09:50:00Z')).canJoin).toBe(true);
  });
  it('automatic no-shows wait 30 minutes', () => {
    expect(graceCheck(a, s, new Date('2026-10-23T10:11:00Z'))).toBe('waiting');
    expect(graceCheck({ ...a, doctor_joined_at: '2026-10-23T10:00:00Z' }, s, new Date('2026-10-23T10:29:00Z'))).toBe('waiting');
  });
  it('doctor no-show after 30 minutes when the patient was there', () => {
    expect(graceCheck({ ...a, patient_joined_at: '2026-10-23T10:00:00Z' }, s, new Date('2026-10-23T10:31:00Z'))).toBe('doctor_no_show');
  });
  it('nobody joined → both no-show', () => {
    expect(graceCheck(a, s, new Date('2026-10-23T10:31:00Z'))).toBe('both_no_show');
  });
  it('patient no-show after 30 minutes when the doctor joined', () => {
    expect(graceCheck({ ...a, doctor_joined_at: '2026-10-23T10:00:00Z' }, s, new Date('2026-10-23T10:31:00Z'))).toBe('patient_no_show');
  });
});

describe('drug rule engine', () => {
  const rules = defaultDrugRules().map((r, i) => ({ ...r, id: String(i) })) as DrugRule[];
  const d = (name: string) => DRUGS.find((x) => x.name === name)!;
  const ctx = { rules, patientAllergies: [] as string[], otherDrugs: [] as typeof DRUGS };
  it('blocks prohibited / narcotic', () => {
    const r = checkDrug({ ...ctx, drug: d('Alprazolam'), mode: 'video', consultType: 'follow_up' });
    expect(r.blocked).toBe(true);
    expect(r.reasons.join(' ')).toMatch(/narcotic/);
  });
  it('List A needs video for first consult', () => {
    expect(checkDrug({ ...ctx, drug: d('Amoxicillin'), mode: 'audio', consultType: 'first' }).blocked).toBe(true);
    expect(checkDrug({ ...ctx, drug: d('Amoxicillin'), mode: 'video', consultType: 'first' }).blocked).toBe(false);
    expect(checkDrug({ ...ctx, drug: d('Amoxicillin'), mode: 'audio', consultType: 'follow_up' }).blocked).toBe(false);
  });
  it('List B only in follow-up', () => {
    expect(checkDrug({ ...ctx, drug: d('Prednisolone'), mode: 'video', consultType: 'first' }).blocked).toBe(true);
    expect(checkDrug({ ...ctx, drug: d('Prednisolone'), mode: 'video', consultType: 'follow_up' }).blocked).toBe(false);
  });
  it('warns on allergy and interactions', () => {
    expect(checkDrug({ ...ctx, drug: d('Amoxicillin'), mode: 'video', consultType: 'first', patientAllergies: ['Penicillin'] }).warnings[0]).toMatch(/penicillin/);
    expect(checkDrug({ ...ctx, drug: d('Ibuprofen'), mode: 'video', consultType: 'follow_up', otherDrugs: [d('Warfarin')] }).warnings[0]).toMatch(/bleeding/);
  });
});

describe('slots and misc', () => {
  it('generates slots from weekly availability, skipping blocks and holidays', () => {
    const avail = [
      { id: 'w', doctor_id: 'd1', kind: 'weekly' as const, weekday: 5, start_time: '09:00', end_time: '10:00', block_date_from: null, block_date_to: null, reason: null },
      { id: 'b', doctor_id: 'd1', kind: 'block' as const, weekday: null, start_time: '09:15', end_time: '09:30', block_date_from: '2026-10-23', block_date_to: '2026-10-23', reason: 'x' },
    ];
    const slots = generateSlotCandidates({ id: 'd1', slot_minutes: 15, hospital_id: 'h' }, avail, [], '2026-10-23', 1);
    expect(slots.map((s) => istTime(s.start_at))).toEqual(['09:00', '09:30', '09:45']);
    expect(generateSlotCandidates({ id: 'd1', slot_minutes: 15, hospital_id: 'h' }, avail, [{ id: 'h', hospital_id: null, date: '2026-10-23', name: 'x' }], '2026-10-23', 1)).toHaveLength(0);
  });
  it('held slots become bookable after the hold lapses', () => {
    const now = new Date('2026-10-23T05:00:00Z');
    expect(isSlotBookable({ status: 'held', held_until: '2026-10-23T05:05:00Z', start_at: '2026-10-23T06:00:00Z' }, now)).toBe(false);
    expect(isSlotBookable({ status: 'held', held_until: '2026-10-23T04:59:00Z', start_at: '2026-10-23T06:00:00Z' }, now)).toBe(true);
  });
  it('validates uploads', () => {
    expect(validateUpload({ name: 'a.pdf', size: 1000, type: 'application/pdf' }, DEFAULT_SETTINGS)).toBeNull();
    expect(validateUpload({ name: 'a.exe', size: 1000, type: 'application/x-msdownload' }, DEFAULT_SETTINGS)).toBe('upload.errType');
    expect(validateUpload({ name: 'a.pdf', size: 11 * 1024 * 1024, type: 'application/pdf' }, DEFAULT_SETTINGS)).toBe('upload.errSize');
  });
  it('masks phones', () => {
    expect(maskPhone('+919847000001')).toBe('+91 98•••••001');
  });
});

describe('seed', () => {
  const s = buildSeed(new Date('2026-10-23T06:00:00Z'));
  it('has the required volumes', () => {
    expect(s.hospitals).toHaveLength(3);
    expect(s.departments).toHaveLength(8);
    expect(s.doctors).toHaveLength(10);
    expect(s.patients).toHaveLength(20);
    expect(s.appointments).toHaveLength(40);
    expect(s.drug_master.length).toBeGreaterThanOrEqual(100);
    expect(s.icd10_master.length).toBeGreaterThanOrEqual(200);
    expect(new Set(s.icd10_master.map((x) => x.code)).size).toBe(s.icd10_master.length);
  });
  it('has no double-booked doctor time among active appointments', () => {
    const active = s.appointments.filter((a) => ['confirmed', 'in_progress', 'completed', 'pending_payment'].includes(a.status));
    const keys = active.map((a) => a.doctor_id + a.start_at);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
