import { toCsv } from './csv';
import { effectiveFee, refundableAmount, type DoctorLite, type FeeRow } from './api';

describe('reconciliation CSV', () => {
  it('adds a BOM, quotes commas / quotes / newlines and uses CRLF', () => {
    const csv = toCsv(['a', 'b'], [['x,y', 'say "hi"'], ['line\nbreak', null]]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1)).toBe('a,b\r\n"x,y","say ""hi"""\r\n"line\nbreak",\r\n');
  });
  it('neutralises spreadsheet formulas in text cells but keeps negative numbers', () => {
    expect(toCsv(['n'], [['=HYPERLINK("x")'], [-500]]).slice(1)).toBe('n\r\n"\'=HYPERLINK(""x"")"\r\n-500\r\n');
  });
});

describe('effective fee (mirrors resolve_consult_fee)', () => {
  const doc: DoctorLite = { id: 'd1', full_name: 'Dr A', department_id: 'dep', modes: ['video', 'audio'], verification_status: 'verified', active: true };
  const fees: FeeRow[] = [
    { id: '1', scope: 'department', doctor_id: null, department_id: 'dep', mode: 'video', consult_type: 'first', amount: 800 },
    { id: '2', scope: 'department', doctor_id: null, department_id: 'dep', mode: 'audio', consult_type: 'first', amount: 700 },
    { id: '3', scope: 'department', doctor_id: null, department_id: 'dep', mode: 'audio', consult_type: 'follow_up', amount: 400 },
    { id: '4', scope: 'doctor', doctor_id: 'd1', department_id: null, mode: 'video', consult_type: 'first', amount: 999 },
  ];
  it('doctor fee beats department fee', () => expect(effectiveFee(fees, doc, 'video', 'first')).toMatchObject({ amount: 999, source: 'doctor' }));
  it('department fee when the doctor has none', () => expect(effectiveFee(fees, doc, 'audio', 'follow_up')).toMatchObject({ amount: 400, source: 'department' }));
  it('follow-up without a fee falls back to the first-consult fee', () => expect(effectiveFee(fees, doc, 'video', 'follow_up')).toMatchObject({ amount: 999, source: 'fallback' }));
  it('nothing configured → null', () => expect(effectiveFee([], doc, 'video', 'first').amount).toBeNull());
});

describe('refundable amount', () => {
  const r = (amount: number, status: 'initiated' | 'processed' | 'failed') => ({ id: '', amount, reason: '', status, provider_refund_id: null, failure_reason: null, created_at: '', processed_at: null });
  it('subtracts processed and in-flight refunds, ignores failed ones', () => {
    expect(refundableAmount({ amount: 800, status: 'partially_refunded', refunds: [r(200, 'processed'), r(100, 'initiated'), r(500, 'failed')] })).toBe(500);
  });
  it('nothing for unpaid or fully refunded payments', () => {
    expect(refundableAmount({ amount: 800, status: 'created', refunds: [] })).toBe(0);
    expect(refundableAmount({ amount: 800, status: 'refunded', refunds: [r(800, 'processed')] })).toBe(0);
  });
});
