import { canPatientCancel, refundCase, type CancelQuote, type MyAppointment } from './api';

const NOW = new Date('2026-11-06T10:00:00.000Z').getTime();
const appt = (over: Partial<MyAppointment> = {}) =>
  ({ id: 'a1', status: 'confirmed', start_at: '2026-11-06T12:00:00.000Z', reschedule_requests: [], ...over }) as unknown as MyAppointment;

describe('canPatientCancel – the same rule the server enforces (confirmed, not started), plus a clean UI', () => {
  it('a confirmed appointment in the future can be cancelled', () => {
    expect(canPatientCancel(appt(), NOW)).toBe(true);
  });

  it('not once it has started or passed (the server answers too_late)', () => {
    expect(canPatientCancel(appt({ start_at: '2026-11-06T10:00:00.000Z' }), NOW)).toBe(false);
    expect(canPatientCancel(appt({ start_at: '2026-11-06T09:00:00.000Z' }), NOW)).toBe(false);
  });

  it('only confirmed bookings (not completed, cancelled, in progress or awaiting payment)', () => {
    for (const status of ['completed', 'cancelled', 'in_progress', 'pending_payment', 'no_show', 'rescheduled'])
      expect(canPatientCancel(appt({ status } as Partial<MyAppointment>), NOW), status).toBe(false);
  });

  it('not while the doctor\'s new-time proposal is waiting for an answer (answer it first)', () => {
    const pending = [{ id: 'r1', status: 'pending' }] as unknown as MyAppointment['reschedule_requests'];
    expect(canPatientCancel(appt({ reschedule_requests: pending }), NOW)).toBe(false);
    const done = [{ id: 'r1', status: 'declined' }] as unknown as MyAppointment['reschedule_requests'];
    expect(canPatientCancel(appt({ reschedule_requests: done }), NOW)).toBe(true);
  });
});

describe('refundCase – what the confirmation dialog tells the patient', () => {
  const q = (over: Partial<CancelQuote>): CancelQuote => ({ rule: 'tier', percent: 100, amount: 800, paid: 800, refundable: 800, hours_before: 5, ...over });

  it('a refund when money comes back', () => expect(refundCase(q({}))).toBe('refund'));
  it('no refund when the policy says 0 % this close to the start', () => expect(refundCase(q({ percent: 0, amount: 0 }))).toBe('no_refund'));
  it('nothing to refund for a free follow-up', () => expect(refundCase(q({ rule: 'free_consult', paid: 0, amount: 0, refundable: 0, percent: 0 }))).toBe('nothing_to_refund'));
  it('nothing to refund when nothing was paid', () => expect(refundCase(q({ rule: 'not_paid', paid: 0, amount: 0, refundable: 0, percent: 0 }))).toBe('nothing_to_refund'));
  it('nothing to refund when it was already refunded in full', () => expect(refundCase(q({ amount: 0, refundable: 0 }))).toBe('nothing_to_refund'));
});
