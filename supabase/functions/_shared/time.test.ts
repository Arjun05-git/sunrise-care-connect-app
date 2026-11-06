import { describe, expect, it } from 'vitest';
import { IST_TZ, istDate, istDateTime } from './time';

// Fixed instants: the output must be the same whatever zone the server runs in (run `npm run test:tz`).
describe('edge-function date formatting is always India time', () => {
  it('uses Asia/Kolkata', () => expect(IST_TZ).toBe('Asia/Kolkata'));

  it('just before IST midnight is still the same IST day', () => {
    expect(istDate('2026-11-05T18:29:59Z')).toBe('5 Nov 2026'); // 23:59:59 IST
  });

  it('IST midnight starts the next day (18:30 UTC)', () => {
    expect(istDate('2026-11-05T18:30:00Z')).toBe('6 Nov 2026'); // 00:00 IST
  });

  it('the date is the IST date even when the UTC date is a day earlier', () => {
    expect(istDate('2026-12-31T20:00:00Z')).toBe('1 Jan 2027'); // 01:30 IST on New Year's Day
  });

  it('date and time carry the IST label', () => {
    expect(istDateTime('2026-11-05T20:00:00Z')).toMatch(/^6 Nov 2026, 1:30\s?(am|AM) IST$/);
    expect(istDateTime('2026-11-06T04:30:00Z')).toMatch(/^6 Nov 2026, 10:00\s?(am|AM) IST$/);
  });

  it('twelve-hour clock around noon and midnight', () => {
    expect(istDateTime('2026-11-06T06:30:00Z')).toMatch(/12:00\s?(pm|PM) IST$/); // 12:00 IST
    expect(istDateTime('2026-11-05T18:30:00Z')).toMatch(/12:00\s?(am|AM) IST$/); // 00:00 IST
  });
});
