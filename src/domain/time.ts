/**
 * IST helpers. All instants are stored as ISO UTC strings; every *display* and every
 * "calendar day / weekday / HH:mm" computation happens in Asia/Kolkata (UTC+05:30, no DST).
 */
export const IST_TZ = 'Asia/Kolkata';
const IST_OFFSET_MIN = 330;

/** YYYY-MM-DD of the given instant in IST. */
export function istDateKey(d: Date | string = new Date()): string {
  const t = typeof d === 'string' ? new Date(d) : d;
  const ist = new Date(t.getTime() + IST_OFFSET_MIN * 60_000);
  return ist.toISOString().slice(0, 10);
}

/** Weekday (0 = Sunday) in IST. */
export function istWeekday(d: Date | string): number {
  const t = typeof d === 'string' ? new Date(d) : d;
  return new Date(t.getTime() + IST_OFFSET_MIN * 60_000).getUTCDay();
}

/** HH:mm in IST. */
export function istTime(d: Date | string): string {
  const t = typeof d === 'string' ? new Date(d) : d;
  return new Date(t.getTime() + IST_OFFSET_MIN * 60_000).toISOString().slice(11, 16);
}

/** Build a UTC Date from an IST calendar date (YYYY-MM-DD) and IST wall time (HH:mm). */
export function fromIst(dateKey: string, hhmm: string): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - IST_OFFSET_MIN * 60_000);
}

export function addDaysKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function addMinutes(d: Date | string, minutes: number): Date {
  const t = typeof d === 'string' ? new Date(d) : d;
  return new Date(t.getTime() + minutes * 60_000);
}

export function minutesBetween(a: Date | string, b: Date | string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 60_000;
}

export function dayPart(iso: string): 'morning' | 'afternoon' | 'evening' {
  const h = Number(istTime(iso).slice(0, 2));
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(locale: string, opts: Intl.DateTimeFormatOptions) {
  const key = locale + JSON.stringify(opts);
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale === 'ml' ? 'ml-IN' : 'en-IN', { timeZone: IST_TZ, ...opts });
    fmtCache.set(key, f);
  }
  return f;
}

export const formatTime = (iso: string, locale = 'en') => fmt(locale, { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
export const formatDate = (iso: string, locale = 'en') => fmt(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));
export const formatDateLong = (iso: string, locale = 'en') => fmt(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
export const formatDateTime = (iso: string, locale = 'en') => `${formatDate(iso, locale)}, ${formatTime(iso, locale)}`;
export const formatDayNum = (dateKey: string) => Number(dateKey.slice(8, 10));
export const formatWeekdayShort = (dateKey: string, locale = 'en') => fmt(locale, { weekday: 'short' }).format(fromIst(dateKey, '12:00'));
export const formatMonthShort = (dateKey: string, locale = 'en') => fmt(locale, { month: 'short' }).format(fromIst(dateKey, '12:00'));

export function ageFromDob(dob: string, now = new Date()): number {
  const [y, m, d] = dob.split('-').map(Number);
  const today = istDateKey(now).split('-').map(Number);
  let age = today[0] - y;
  if (today[1] < m || (today[1] === m && today[2] < d)) age--;
  return age;
}
