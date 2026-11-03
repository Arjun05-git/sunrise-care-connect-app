// @vitest-environment node
import jsQR from 'jsqr';
import { PDFDocument } from 'pdf-lib';
import { qrMatrix, renderPrescription, wrap, type RxData } from './prescription.ts';
import { CODE, verifyUrl } from './rx.ts';
import { pngSize } from '../doctor-signature/handler.ts';

const base: RxData = {
  status: 'final', version: 1, rx_no: 'SCRX-2610-000042', verification_code: 'ABCDEFGH23', finalized_at: '2026-10-24T06:30:00Z', created_at: '2026-10-24T06:00:00Z',
  addendum_reason: null, parent_rx_no: null, superseded: false,
  doctor: { name: 'Dr. Arun Nair', qualification: 'MBBS, MD (General Medicine)', registration_no: 'TCMC-12345', council: 'TCMC', department: 'General Medicine' },
  patient: { name: 'Anjali Menon', age: 38, gender: 'female', mrn: 'SUN100230' },
  hospital: { name: 'Sunrise Hospital Kakkanad', city: 'Kochi', address: 'Seaport–Airport Road, Kakkanad, Kochi 682030', phone: '+914842000100' },
  consult: { ref: 'SC-ABC123', mode: 'video', consult_type: 'first', start_at: '2026-10-24T06:00:00Z' },
  diagnoses: [{ code: 'J06.9', description: 'Acute upper respiratory infection, unspecified' }, { code: null, description: 'Viral fever' }],
  advice: 'Warm saline gargles, fluids, rest.', investigations: 'CBC', follow_up_date: '2026-11-02',
  items: [{ drug_name: 'Paracetamol 650', generic_name: 'Paracetamol', strength: '650 mg', form: 'Tablet', dose: '1 tablet', frequency: 'TDS', duration: '5 days', route: 'Oral', instructions: 'After food' }],
};

/** Renders a QR matrix into RGBA pixels (4 px per module + quiet zone) for jsQR. */
function decode(m: boolean[][]): string | null {
  const scale = 4, quiet = 4, n = (m.length + quiet * 2) * scale;
  const px = new Uint8ClampedArray(n * n * 4).fill(255);
  m.forEach((row, r) => row.forEach((dark, c) => {
    if (!dark) return;
    for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
      const i = (((r + quiet) * scale + y) * n + (c + quiet) * scale + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
  }));
  return jsQR(px, n, n)?.data ?? null;
}

describe('prescription PDF', () => {
  it('QR encodes the public verification URL (decoded back)', () => {
    process.env.PUBLIC_APP_URL = 'https://care.sunrise.example/';
    const url = verifyUrl('ABCDEFGH23');
    expect(url).toBe('https://care.sunrise.example/verify/ABCDEFGH23');
    expect(decode(qrMatrix(url))).toBe(url);
  });
  it('verification codes use the unambiguous alphabet only', () => {
    expect(CODE.test('ABCDEFGH23')).toBe(true);
    expect(CODE.test('ABCDEFGHI0')).toBe(false); // I and 0 are excluded
    expect(CODE.test('abcdefgh23')).toBe(false);
  });
  it('renders a one-page A4 prescription with its number as the title', async () => {
    const bytes = await renderPrescription(base, { verifyUrl: verifyUrl('ABCDEFGH23'), signature: null });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe('Prescription SCRX-2610-000042');
    const [w, h] = [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()];
    expect([Math.round(w), Math.round(h)]).toEqual([595, 842]);
  });
  it('long prescriptions flow onto more pages; drafts are titled as drafts', async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ ...base.items[0]!, drug_name: `Medicine ${i + 1}`, instructions: 'Take after food with plenty of water and avoid driving if drowsy' }));
    const doc = await PDFDocument.load(await renderPrescription({ ...base, items, status: 'draft', rx_no: null, verification_code: null }, { verifyUrl: null, signature: null }));
    expect(doc.getPageCount()).toBeGreaterThan(1);
    expect(doc.getTitle()).toBe('Prescription (draft)');
  });
  it('wraps long text and survives non-Latin input', async () => {
    const { StandardFonts } = await import('pdf-lib');
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const lines = wrap('word '.repeat(60) + 'averyveryveryverylongwordwithoutanyspacesatallthatmustbebroken', font, 10, 120);
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.every((l) => font.widthOfTextAtSize(l, 10) <= 120)).toBe(true);
    await expect(renderPrescription({ ...base, advice: 'വെള്ളം ധാരാളം കുടിക്കുക' }, { verifyUrl: null, signature: null })).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe('signature PNG check', () => {
  it('reads PNG dimensions and rejects non-PNG', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAMgAAABQCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    expect(pngSize(new Uint8Array(png))).toEqual({ w: 200, h: 80 });
    expect(pngSize(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'.padEnd(40)))).toBeNull();
  });
});
