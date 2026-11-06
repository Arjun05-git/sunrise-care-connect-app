// Date formatting for server-side output (PDFs, messages): always India time, whatever zone the server runs in.
// One place, so receipts and prescriptions can never disagree about what day or time it is.
export const IST_TZ = 'Asia/Kolkata';

const dateFmt = new Intl.DateTimeFormat('en-IN', { timeZone: IST_TZ, day: 'numeric', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: IST_TZ, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

/** "6 Nov 2026" in IST. */
export const istDate = (iso: string) => dateFmt.format(new Date(iso));
/** "6 Nov 2026, 1:30 am IST". */
export const istDateTime = (iso: string) => `${dateTimeFmt.format(new Date(iso))} IST`;
