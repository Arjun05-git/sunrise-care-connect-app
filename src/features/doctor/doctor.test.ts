import { rangeErrors } from './pages/AvailabilityPage';

describe('weekly hours validation', () => {
  it('accepts separate ranges in any order', () => {
    expect(rangeErrors([{ start: '14:00', end: '17:00' }, { start: '09:00', end: '13:00' }])).toEqual([]);
  });
  it('allows back-to-back ranges', () => expect(rangeErrors([{ start: '09:00', end: '13:00' }, { start: '13:00', end: '17:00' }])).toEqual([]));
  it('flags overlaps and inverted / empty ranges', () => {
    expect(rangeErrors([{ start: '09:00', end: '13:00' }, { start: '12:00', end: '14:00' }])).toEqual(['overlap']);
    expect(rangeErrors([{ start: '13:00', end: '09:00' }])).toEqual(['order']);
    expect(rangeErrors([{ start: '', end: '10:00' }])).toEqual(['order']);
  });
});
