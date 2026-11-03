import { addDaysKey, dayPart, istDateKey } from '@/domain/time';
import type { Slot } from '@/domain/types';

/** Same rule as the database's slot_bookable(): open (or lapsed hold) and ≥ 5 minutes away. */
export function isBookable(s: Pick<Slot, 'status' | 'held_until' | 'start_at'>, now = Date.now()): boolean {
  if (new Date(s.start_at).getTime() <= now + 5 * 60_000) return false;
  return s.status === 'open' || (s.status === 'held' && !!s.held_until && new Date(s.held_until).getTime() < now);
}

export interface DayBucket {
  key: string; // YYYY-MM-DD (IST)
  available: number;
}

/** The next `days` IST dates with the number of bookable slots on each. */
export function dayStrip(slots: Slot[], days = 14, now = new Date()): DayBucket[] {
  const today = istDateKey(now);
  const counts = new Map<string, number>();
  for (const s of slots) if (isBookable(s, now.getTime())) counts.set(istDateKey(s.start_at), (counts.get(istDateKey(s.start_at)) ?? 0) + 1);
  return Array.from({ length: days }, (_, i) => {
    const key = addDaysKey(today, i);
    return { key, available: counts.get(key) ?? 0 };
  });
}

export type DayPart = 'morning' | 'afternoon' | 'evening';

/** Slots of one IST day grouped into morning / afternoon / evening, in time order. */
export function groupByDayPart(slots: Slot[], dateKey: string): Record<DayPart, Slot[]> {
  const out: Record<DayPart, Slot[]> = { morning: [], afternoon: [], evening: [] };
  slots
    .filter((s) => istDateKey(s.start_at) === dateKey)
    .sort((a, b) => a.start_at.localeCompare(b.start_at))
    .forEach((s) => out[dayPart(s.start_at)].push(s));
  return out;
}

/** mm:ss for the hold countdown. */
export const mmss = (sec: number) => `${String(Math.floor(Math.max(0, sec) / 60)).padStart(2, '0')}:${String(Math.max(0, sec) % 60).padStart(2, '0')}`;
