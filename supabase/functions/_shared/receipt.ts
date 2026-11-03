import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export interface ReceiptData {
  receipt_no: string; ref_code: string; amount: number; currency: string; method: string | null; provider: string;
  provider_payment_id: string | null; captured_at: string; status: string; patient_name: string; doctor_name: string;
  doctor_reg: string; department: string; hospital: { name: string; city: string; address: string; phone: string };
  mode: 'audio' | 'video'; consult_type: 'first' | 'follow_up'; start_at: string;
  refunds: { amount: number; status: string; at: string }[];
}

const IST = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso)) + ' IST';
const inr = (n: number) => 'Rs. ' + new Intl.NumberFormat('en-IN').format(n);
/** Standard PDF fonts are Latin-1 only: typographic punctuation is mapped to ASCII; anything else (e.g. Malayalam) becomes '?'. */
const PUNCT: Record<string, string> = { '\u2013': '-', '\u2014': '-', '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"', '\u2026': '...', '\u20B9': 'Rs.', '\u00A0': ' ' };
export const latin = (s: string) => s.replace(/[\u2013\u2014\u2018\u2019\u201C\u201D\u2026\u20B9\u00A0]/g, (c) => PUNCT[c]!).replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

/** Payment receipt – booking and money details only, never clinical content. */
export async function renderReceipt(d: ReceiptData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Receipt ${d.receipt_no}`);
  pdf.setProducer('Sunrise Care Connect');
  const page = pdf.addPage([420, 595]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const teal = rgb(15 / 255, 118 / 255, 110 / 255);
  const muted = rgb(0.39, 0.45, 0.55);
  const text = (s: string, x: number, y: number, o: { size?: number; f?: typeof font; color?: ReturnType<typeof rgb> } = {}) =>
    page.drawText(latin(s), { x, y, size: o.size ?? 9.5, font: o.f ?? font, color: o.color ?? rgb(0.06, 0.09, 0.16) });

  page.drawRectangle({ x: 0, y: 545, width: 420, height: 50, color: teal });
  text('Sunrise Chain of Hospitals', 28, 572, { size: 15, f: bold, color: rgb(1, 1, 1) });
  text('Sunrise Care Connect - teleconsultation', 28, 556, { size: 9, color: rgb(0.8, 0.98, 0.95) });
  let y = 520;
  text('PAYMENT RECEIPT', 28, y, { size: 12, f: bold });
  text(d.receipt_no, 392 - bold.widthOfTextAtSize(d.receipt_no, 10), y, { size: 10, f: bold, color: teal });
  y -= 14;
  text(`${d.hospital.name}, ${d.hospital.city}`, 28, y, { size: 8.5, color: muted });
  y -= 26;

  const refunded = d.refunds.filter((r) => r.status === 'processed').reduce((s, r) => s + r.amount, 0);
  const rows: [string, string][] = [
    ['Booking reference', d.ref_code],
    ['Patient', d.patient_name],
    ['Doctor', `${d.doctor_name} (Reg. ${d.doctor_reg})`],
    ['Department', d.department],
    ['Consultation', `${d.mode === 'video' ? 'Video' : 'Audio'} - ${d.consult_type === 'first' ? 'First consultation' : 'Follow-up'}`],
    ['Scheduled for', IST(d.start_at)],
    ['Paid on', IST(d.captured_at)],
    ['Payment method', `${(d.method ?? '-').toUpperCase()} via ${d.provider === 'razorpay' ? 'Razorpay' : 'Test gateway'}`],
    ['Transaction id', d.provider_payment_id ?? '-'],
  ];
  for (const [k, v] of rows) {
    text(k, 28, y, { color: muted });
    text(v, 140, y);
    y -= 17;
  }
  y -= 6;
  page.drawLine({ start: { x: 28, y }, end: { x: 392, y }, thickness: 0.6, color: rgb(0.85, 0.88, 0.92) });
  y -= 18;
  const money: [string, string, boolean?][] = [
    ['Consultation fee', inr(d.amount)],
    ['GST (healthcare services - exempt)', inr(0)],
    ['Amount paid', inr(d.amount), true],
  ];
  if (refunded > 0) money.push(['Refunded', '- ' + inr(refunded)], ['Net amount', inr(d.amount - refunded), true]);
  for (const [k, v, strong] of money) {
    text(k, 28, y, { f: strong ? bold : font });
    const f = strong ? bold : font;
    text(v, 392 - f.widthOfTextAtSize(v, 9.5), y, { f });
    y -= 17;
  }
  const pending = d.refunds.filter((r) => r.status === 'initiated').reduce((s, r) => s + r.amount, 0);
  if (pending > 0) { text(`Refund of ${inr(pending)} in progress.`, 28, y, { size: 8.5, color: muted }); y -= 14; }

  text('This is a computer-generated receipt and does not need a signature.', 28, 60, { size: 8, color: muted });
  text(`${d.hospital.address}  |  ${d.hospital.phone}`, 28, 46, { size: 8, color: muted });
  text('This service is not for emergencies. Call 112.', 28, 32, { size: 8, color: muted });
  return pdf.save();
}
