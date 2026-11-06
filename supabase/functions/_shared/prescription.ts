// Prescription PDF on Sunrise letterhead (A4), rendered server-side with pdf-lib.
// Contents follow the Telemedicine Practice Guidelines 2020 prescription format: doctor name,
// qualification and registration, patient name / age / sex, date, diagnosis, medicines, advice,
// follow-up, signature, plus a QR code to verify it. Standard fonts are Latin-1 only (see `latin`).
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import qrcode from 'qrcode-generator';
import { latin } from './receipt.ts';
import { istDate, istDateTime } from './time.ts';

export interface RxItem { drug_name: string; generic_name: string; strength: string; form: string; dose: string; frequency: string; duration: string; route: string; instructions: string }
export interface RxData {
  status: 'draft' | 'final';
  version: number;
  rx_no: string | null;
  verification_code: string | null;
  finalized_at: string | null;
  created_at: string;
  addendum_reason: string | null;
  parent_rx_no: string | null;
  superseded: boolean;
  doctor: { name: string; qualification: string; registration_no: string; council?: string; department?: string };
  patient: { name: string; age: number | null; gender: string; mrn?: string | null };
  hospital: { name: string; city: string; address: string; phone: string };
  consult: { ref: string; mode: 'audio' | 'video'; consult_type: 'first' | 'follow_up'; start_at: string };
  diagnoses: { code: string | null; description: string }[];
  advice: string;
  investigations: string;
  follow_up_date: string | null;
  items: RxItem[];
}

const W = 595.28;
const H = 841.89;
const M = 40;
const TEAL = rgb(15 / 255, 118 / 255, 110 / 255);
const AMBER = rgb(245 / 255, 158 / 255, 11 / 255);
const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.39, 0.45, 0.55);
const LINE = rgb(0.85, 0.88, 0.92);

const GENDER: Record<string, string> = { female: 'Female', male: 'Male', other: 'Other', undisclosed: '-' };

/** Splits text into lines that fit `width` (words longer than a line are broken). */
export function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of latin(text).split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
      if (line) out.push(line);
      let w = word;
      while (font.widthOfTextAtSize(w, size) > width) {
        let n = w.length - 1;
        while (n > 1 && font.widthOfTextAtSize(w.slice(0, n), size) > width) n--;
        out.push(w.slice(0, n));
        w = w.slice(n);
      }
      line = w;
    }
    out.push(line);
  }
  return out;
}

/** QR matrix (error correction M) – drawn as vector squares, so it stays sharp when printed. */
export function qrMatrix(text: string): boolean[][] {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => q.isDark(r, c)));
}

function drawQr(page: PDFPage, m: boolean[][], x: number, y: number, size: number) {
  const cell = size / m.length;
  page.drawRectangle({ x: x - 4, y: y - 4, width: size + 8, height: size + 8, color: rgb(1, 1, 1) });
  m.forEach((row, r) => row.forEach((dark, c) => {
    if (dark) page.drawRectangle({ x: x + c * cell, y: y + size - (r + 1) * cell, width: cell + 0.05, height: cell + 0.05, color: INK });
  }));
}

/** The Sunrise mark: a half sun over a horizon with rays. */
function drawLogo(page: PDFPage, x: number, y: number) {
  page.drawCircle({ x: x + 16, y: y + 6, size: 10, color: AMBER });
  page.drawRectangle({ x, y: y - 6, width: 32, height: 12, color: TEAL });
  for (let i = 0; i < 5; i++) {
    const a = Math.PI * (0.15 + (i * 0.7) / 4);
    page.drawLine({ start: { x: x + 16 + Math.cos(a) * 13, y: y + 6 + Math.sin(a) * 13 }, end: { x: x + 16 + Math.cos(a) * 18, y: y + 6 + Math.sin(a) * 18 }, thickness: 1.6, color: AMBER });
  }
  page.drawLine({ start: { x, y: y - 6 }, end: { x: x + 32, y: y - 6 }, thickness: 1, color: rgb(1, 1, 1) });
}

export async function renderPrescription(d: RxData, opts: { verifyUrl: string | null; signature: Uint8Array | null }): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(d.rx_no ? `Prescription ${d.rx_no}` : 'Prescription (draft)');
  pdf.setAuthor(d.doctor.name);
  pdf.setProducer('Sunrise Care Connect');
  pdf.setCreator('Sunrise Care Connect');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  let sig: PDFImage | null = null;
  if (opts.signature) {
    try { sig = await pdf.embedPng(opts.signature); } catch { sig = null; }
  }
  const draft = d.status === 'draft';
  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;
  const FOOTER = 150; // space kept for signature + QR + legal lines on the last page

  const text = (s: string, x: number, yy: number, o: { size?: number; f?: PDFFont; color?: ReturnType<typeof rgb> } = {}) =>
    page.drawText(latin(s), { x, y: yy, size: o.size ?? 9.5, font: o.f ?? font, color: o.color ?? INK });
  const right = (s: string, xr: number, yy: number, o: { size?: number; f?: PDFFont; color?: ReturnType<typeof rgb> } = {}) =>
    text(s, xr - (o.f ?? font).widthOfTextAtSize(latin(s), o.size ?? 9.5), yy, o);

  const newPage = () => {
    page = pdf.addPage([W, H]);
    pages.push(page);
    // letterhead band
    page.drawRectangle({ x: 0, y: H - 78, width: W, height: 78, color: TEAL });
    page.drawRectangle({ x: 0, y: H - 81, width: W, height: 3, color: AMBER });
    drawLogo(page, M, H - 44);
    text('Sunrise Chain of Hospitals', M + 44, H - 36, { size: 16, f: bold, color: rgb(1, 1, 1) });
    text(`${d.hospital.name}, ${d.hospital.city}`, M + 44, H - 52, { size: 9, color: rgb(0.8, 0.98, 0.95) });
    text(`${d.hospital.address}  |  ${d.hospital.phone}`, M + 44, H - 64, { size: 8, color: rgb(0.8, 0.98, 0.95) });
    right(d.doctor.name, W - M, H - 34, { size: 11, f: bold, color: rgb(1, 1, 1) });
    right(d.doctor.qualification || ' ', W - M, H - 47, { size: 8.5, color: rgb(0.8, 0.98, 0.95) });
    right(`Reg. No. ${d.doctor.registration_no}${d.doctor.council ? ` (${d.doctor.council})` : ''}`, W - M, H - 59, { size: 7.5, color: rgb(0.8, 0.98, 0.95) });
    if (d.doctor.department) right(d.doctor.department, W - M, H - 70, { size: 7.5, color: rgb(0.8, 0.98, 0.95) });
    if (draft) {
      page.drawText('DRAFT - NOT VALID', { x: 110, y: 330, size: 54, font: bold, color: rgb(0.86, 0.15, 0.15), opacity: 0.12, rotate: degrees(35) });
    }
    y = H - 104;
  };
  /** Moves to a new page when `need` points don't fit above the footer area. */
  const ensure = (need: number) => {
    if (y - need < 60) { newPage(); }
  };
  const section = (title: string) => {
    ensure(30);
    text(title.toUpperCase(), M, y, { size: 8, f: bold, color: TEAL });
    y -= 13;
  };
  const para = (s: string, o: { size?: number; f?: PDFFont; color?: ReturnType<typeof rgb>; indent?: number } = {}) => {
    const size = o.size ?? 9.5;
    for (const line of wrap(s, o.f ?? font, size, W - 2 * M - (o.indent ?? 0))) {
      ensure(size + 4);
      text(line, M + (o.indent ?? 0), y, { size, f: o.f, color: o.color });
      y -= size + 3.5;
    }
  };

  newPage();

  // title + numbers
  text(draft ? 'PRESCRIPTION (DRAFT PREVIEW)' : d.version > 1 ? `PRESCRIPTION - ADDENDUM ${d.version - 1}` : 'PRESCRIPTION', M, y, { size: 13, f: bold });
  if (d.rx_no) right(d.rx_no, W - M, y, { size: 11, f: bold, color: TEAL });
  y -= 15;
  text(`Teleconsultation (${d.consult.mode === 'video' ? 'video' : 'audio'}, ${d.consult.consult_type === 'first' ? 'first consultation' : 'follow-up'}) on ${istDate(d.consult.start_at)}  |  Booking ${d.consult.ref}`, M, y, { size: 8.5, color: MUTED });
  if (d.finalized_at) right(`Issued ${istDateTime(d.finalized_at)}`, W - M, y, { size: 8.5, color: MUTED });
  y -= 18;

  if (d.version > 1 && d.parent_rx_no) {
    const lines = wrap(`This addendum (version ${d.version}) replaces ${d.parent_rx_no} and any earlier addenda. Reason: ${d.addendum_reason ?? ''}`, font, 8.5, W - 2 * M - 16);
    const h = lines.length * 12 + 10;
    page.drawRectangle({ x: M, y: y - h + 10, width: W - 2 * M, height: h, color: rgb(1, 0.97, 0.88), borderColor: AMBER, borderWidth: 0.8 });
    lines.forEach((l, i) => text(l, M + 8, y - i * 12, { size: 8.5 }));
    y -= h + 6;
  }
  if (d.superseded) {
    page.drawRectangle({ x: M, y: y - 6, width: W - 2 * M, height: 18, color: rgb(0.99, 0.9, 0.9) });
    text('A newer version of this prescription exists. Use the latest version.', M + 8, y, { size: 8.5, f: bold, color: rgb(0.7, 0.1, 0.1) });
    y -= 24;
  }

  // patient block
  page.drawRectangle({ x: M, y: y - 26, width: W - 2 * M, height: 36, color: rgb(0.96, 0.98, 0.98), borderColor: LINE, borderWidth: 0.6 });
  text('Patient', M + 10, y - 2, { size: 7.5, color: MUTED });
  text(d.patient.name, M + 10, y - 16, { size: 11, f: bold });
  text('Age / Sex', M + 270, y - 2, { size: 7.5, color: MUTED });
  text(`${d.patient.age ?? '-'} y / ${GENDER[d.patient.gender] ?? '-'}`, M + 270, y - 16, { size: 10 });
  text('MRN', M + 380, y - 2, { size: 7.5, color: MUTED });
  text(d.patient.mrn ?? '-', M + 380, y - 16, { size: 10 });
  y -= 46;

  section('Diagnosis');
  if (!d.diagnoses.length) para('-', { color: MUTED });
  for (const dx of d.diagnoses) para(dx.code ? `${dx.code}  ${dx.description}` : `${dx.description} (provisional)`);
  y -= 6;

  // Rx
  ensure(40);
  text('Rx', M, y - 4, { size: 20, f: bold, color: TEAL });
  y -= 26;
  if (!d.items.length) {
    para('No medicines prescribed.', { color: MUTED });
  } else {
    const cols = [M, M + 22, M + 250, M + 330, M + 420];
    const header = () => {
      page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 16, color: rgb(0.94, 0.96, 0.97) });
      ['#', 'Medicine', 'Dose', 'Frequency', 'Duration'].forEach((h, i) => text(h, cols[i]! + 4, y + 1, { size: 8, f: bold, color: MUTED }));
      y -= 18;
    };
    header();
    d.items.forEach((it, i) => {
      // brand names often carry the strength already ("Paracetamol 650")
      const strength = it.strength && !it.drug_name.includes(it.strength.split(' ')[0]!) ? ` ${it.strength}` : '';
      const name = wrap(`${it.drug_name}${strength} (${it.form})`, bold, 9.5, 222);
      const extra = wrap([it.generic_name !== it.drug_name ? it.generic_name : '', it.route, it.instructions].filter(Boolean).join('  |  '), italic, 8, 222);
      const dose = wrap(it.dose || '-', font, 9, 76);
      const freq = wrap(it.frequency || '-', font, 9, 86);
      const dur = wrap(it.duration || '-', font, 9, W - M - cols[4]! - 6);
      const rows = Math.max(name.length + extra.length, dose.length, freq.length, dur.length);
      const h = rows * 12 + 7;
      if (y - h < 60) { newPage(); header(); }
      text(String(i + 1), cols[0]! + 4, y, { size: 9.5, f: bold });
      name.forEach((l, k) => text(l, cols[1]! + 4, y - k * 12, { size: 9.5, f: bold }));
      extra.forEach((l, k) => text(l, cols[1]! + 4, y - (name.length + k) * 12, { size: 8, f: italic, color: MUTED }));
      dose.forEach((l, k) => text(l, cols[2]! + 4, y - k * 12, { size: 9 }));
      freq.forEach((l, k) => text(l, cols[3]! + 4, y - k * 12, { size: 9 }));
      dur.forEach((l, k) => text(l, cols[4]! + 4, y - k * 12, { size: 9 }));
      y -= h;
      page.drawLine({ start: { x: M, y: y + 12 }, end: { x: W - M, y: y + 12 }, thickness: 0.5, color: LINE });
    });
  }
  y -= 8;
  if (d.investigations.trim()) { section('Investigations'); para(d.investigations); y -= 6; }
  if (d.advice.trim()) { section('Advice'); para(d.advice); y -= 6; }
  if (d.follow_up_date) { section('Follow-up'); para(istDate(`${d.follow_up_date}T12:00:00+05:30`)); y -= 6; }

  // footer: signature + QR on the last page
  if (y < FOOTER + 20) newPage();
  const fy = 70;
  if (sig) {
    const s = sig.scale(Math.min(140 / sig.width, 46 / sig.height));
    page.drawImage(sig, { x: M, y: fy + 34, width: s.width, height: s.height });
  }
  page.drawLine({ start: { x: M, y: fy + 30 }, end: { x: M + 200, y: fy + 30 }, thickness: 0.6, color: MUTED });
  text(d.doctor.name, M, fy + 18, { size: 9.5, f: bold });
  text(`Reg. No. ${d.doctor.registration_no}`, M, fy + 6, { size: 8, color: MUTED });
  text(draft ? 'Not signed - draft preview' : `Digitally signed ${d.finalized_at ? istDateTime(d.finalized_at) : ''}`, M, fy - 6, { size: 8, color: draft ? rgb(0.7, 0.1, 0.1) : MUTED });

  if (opts.verifyUrl && d.verification_code && !draft) {
    drawQr(page, qrMatrix(opts.verifyUrl), W - M - 78, fy - 8, 78);
    right('Scan to verify', W - M - 88, fy + 56, { size: 8, f: bold });
    right(`Code ${d.verification_code}`, W - M - 88, fy + 44, { size: 8, color: MUTED });
    const host = opts.verifyUrl.replace(/^https?:\/\//, '').replace(/\/verify\/.*$/, '/verify');
    right(host, W - M - 88, fy + 32, { size: 7, color: MUTED });
  }

  // every page: page numbers + guideline note
  pages.forEach((p, i) => {
    page = p;
    page.drawLine({ start: { x: M, y: 46 }, end: { x: W - M, y: 46 }, thickness: 0.5, color: LINE });
    text('Issued through teleconsultation under the Telemedicine Practice Guidelines 2020. Not for emergencies - call 112.', M, 34, { size: 7, color: MUTED });
    text('Schedule X and narcotic / psychotropic drugs are never prescribed by teleconsultation.', M, 24, { size: 7, color: MUTED });
    right(`Page ${i + 1} of ${pages.length}`, W - M, 24, { size: 7, color: MUTED });
  });
  return pdf.save();
}
