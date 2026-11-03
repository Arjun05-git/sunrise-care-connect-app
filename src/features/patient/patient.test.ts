import { checkFile, documentPath, MAX_UPLOAD_BYTES, sniffMime } from './documents';
import { dayStrip, groupByDayPart, isBookable, mmss } from './slots';
import { symptomSchema } from './symptoms';
import { missingConsents } from './api';
import type { Slot } from '@/domain/types';

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0, 0, 0, 0, 0]);

describe('document validation', () => {
  it('accepts real PDF / PNG / JPG files', () => {
    expect(checkFile('report.pdf', 1000, 'application/pdf', PDF)).toEqual({ ok: true, mime: 'application/pdf', ext: 'pdf' });
    expect(checkFile('rash.PNG', 1000, 'image/png', PNG)).toMatchObject({ ok: true, ext: 'png' });
    expect(checkFile('scan.jpeg', 1000, 'image/jpeg', JPG)).toMatchObject({ ok: true, ext: 'jpg' });
  });
  it('rejects other types, empty and oversize files', () => {
    expect(checkFile('virus.exe', 1000, 'application/x-msdownload', EXE)).toEqual({ ok: false, error: 'type' });
    expect(checkFile('notes.docx', 1000, '', PDF)).toEqual({ ok: false, error: 'type' });
    expect(checkFile('empty.pdf', 0, 'application/pdf', PDF)).toEqual({ ok: false, error: 'empty' });
    expect(checkFile('huge.pdf', MAX_UPLOAD_BYTES + 1, 'application/pdf', PDF)).toEqual({ ok: false, error: 'size' });
    expect(checkFile('max.pdf', MAX_UPLOAD_BYTES, 'application/pdf', PDF).ok).toBe(true);
  });
  it('rejects files whose content does not match the extension', () => {
    expect(checkFile('renamed.pdf', 1000, 'application/pdf', EXE)).toEqual({ ok: false, error: 'mismatch' });
    expect(checkFile('photo.png', 1000, 'image/png', JPG)).toEqual({ ok: false, error: 'mismatch' });
    expect(sniffMime(new Uint8Array([1, 2, 3]))).toBeNull();
  });
  it('builds storage paths from ids only (no file names)', () => {
    expect(documentPath('p1', 'd1', 'pdf')).toBe('patients/p1/d1.pdf');
  });
});

describe('slots', () => {
  const now = new Date('2026-10-23T04:30:00Z').getTime(); // 10:00 IST
  const slot = (start: string, status: Slot['status'] = 'open', held_until: string | null = null): Slot =>
    ({ id: start, doctor_id: 'd', start_at: start, end_at: start, status, held_until, appointment_id: null });
  it('applies the same bookable rule as the database', () => {
    expect(isBookable(slot('2026-10-23T05:00:00Z'), now)).toBe(true);
    expect(isBookable(slot('2026-10-23T04:34:00Z'), now)).toBe(false); // < 5 min away
    expect(isBookable(slot('2026-10-23T05:00:00Z', 'booked'), now)).toBe(false);
    expect(isBookable(slot('2026-10-23T05:00:00Z', 'held', '2026-10-23T04:35:00Z'), now)).toBe(false); // active hold
    expect(isBookable(slot('2026-10-23T05:00:00Z', 'held', '2026-10-23T04:20:00Z'), now)).toBe(true); // lapsed hold
  });
  it('groups by IST day and day part, and counts bookable slots per day', () => {
    const slots = [slot('2026-10-23T03:30:00Z'), slot('2026-10-23T09:00:00Z'), slot('2026-10-23T13:00:00Z'), slot('2026-10-24T03:30:00Z', 'booked')];
    const g = groupByDayPart(slots, '2026-10-23');
    expect([g.morning.length, g.afternoon.length, g.evening.length]).toEqual([1, 1, 1]);
    const strip = dayStrip(slots, 3, new Date(now));
    expect(strip.map((d) => d.key)).toEqual(['2026-10-23', '2026-10-24', '2026-10-25']);
    expect(strip.map((d) => d.available)).toEqual([2, 0, 0]); // 09:00 IST already past
  });
  it('formats the countdown', () => {
    expect(mmss(600)).toBe('10:00');
    expect(mmss(61)).toBe('01:01');
    expect(mmss(-5)).toBe('00:00');
  });
});

describe('pre-consult form schema', () => {
  const base = { body_area: 'head', symptoms: ['headache'], duration: '1_3_days', severity: 5, description: 'Headache for two days', vitals: { bp: '', pulse: '', temperature: '', spo2: '', weight: '', sugar: '' }, allergies: '', current_medicines: '', past_history: '' };
  it('accepts a complete form', () => expect(symptomSchema.safeParse(base).success).toBe(true));
  it('requires body area, duration and a description', () => {
    const r = symptomSchema.safeParse({ ...base, body_area: undefined, duration: undefined, description: 'bad' });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.message).sort()).toEqual(['patient.v.bodyArea', 'patient.v.describe', 'patient.v.duration']);
  });
  it('validates vitals format and ranges', () => {
    expect(symptomSchema.safeParse({ ...base, vitals: { ...base.vitals, bp: '12080' } }).success).toBe(false);
    expect(symptomSchema.safeParse({ ...base, vitals: { ...base.vitals, spo2: '140' } }).success).toBe(false);
    expect(symptomSchema.safeParse({ ...base, vitals: { ...base.vitals, bp: '120/80', temperature: '100.4' } }).success).toBe(true);
  });
});

describe('consents', () => {
  const v = { terms: '1.0', data_processing: '1.0', teleconsultation: '2.0', whatsapp_opt_in: '1.0' };
  it('asks again when a required consent is missing or its text has a new version', () => {
    const rows = [
      { consent_type: 'terms' as const, version: '1.0', granted_at: '' },
      { consent_type: 'data_processing' as const, version: '1.0', granted_at: '' },
      { consent_type: 'teleconsultation' as const, version: '1.0', granted_at: '' },
    ];
    expect(missingConsents(rows, v)).toEqual(['teleconsultation']);
    expect(missingConsents([], v)).toEqual(['terms', 'data_processing', 'teleconsultation']);
    expect(missingConsents([...rows, { consent_type: 'teleconsultation', version: '2.0', granted_at: '' }], v)).toEqual([]);
  });
});
