import { describe, expect, it } from 'vitest';
import { checkUpload, pdfHasActiveContent, sniffMime } from './filetype';

const bytes = (s: string) => new TextEncoder().encode(s);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const PDF = bytes('%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n%%EOF');

describe('server-side upload checks', () => {
  it('detects the type from bytes, not the name', () => {
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(JPG)).toBe('image/jpeg');
    expect(sniffMime(PDF)).toBe('application/pdf');
    expect(sniffMime(bytes('<html><script>alert(1)</script>'))).toBeNull();
  });
  it('accepts a clean file whose path and Content-Type match its bytes', () => {
    expect(checkUpload(PDF, 'pdf', 'application/pdf')).toEqual({ ok: true, mime: 'application/pdf', ext: 'pdf', size: PDF.length });
    expect(checkUpload(PNG, 'png', 'image/png').ok).toBe(true);
  });
  it('refuses renamed or mislabelled files, empty and oversized files', () => {
    expect(checkUpload(bytes('<svg onload=alert(1)>'), 'png', 'image/png')).toEqual({ ok: false, error: 'type' });
    expect(checkUpload(PNG, 'pdf', 'application/pdf')).toEqual({ ok: false, error: 'mismatch' });
    expect(checkUpload(PNG, 'png', 'text/html')).toEqual({ ok: false, error: 'mismatch' });
    expect(checkUpload(new Uint8Array(), 'pdf', 'application/pdf')).toEqual({ ok: false, error: 'empty' });
    const big = new Uint8Array(10 * 1024 * 1024 + 1); big.set(PNG);
    expect(checkUpload(big, 'png', 'image/png')).toEqual({ ok: false, error: 'size' });
  });
  it('refuses PDFs with scripts, launch actions or embedded files, including hex-escaped names', () => {
    for (const evil of ['/OpenAction << /S /JavaScript /JS (app.alert(1)) >>', '/S /Launch /F (cmd.exe)', '/Type /EmbeddedFile', '/S /J#61vaScript']) {
      const pdf = bytes(`%PDF-1.7\n1 0 obj << ${evil} >> endobj`);
      expect(pdfHasActiveContent(pdf)).toBe(true);
      expect(checkUpload(pdf, 'pdf', 'application/pdf')).toEqual({ ok: false, error: 'active_content' });
    }
    expect(pdfHasActiveContent(PDF)).toBe(false);
  });
});
