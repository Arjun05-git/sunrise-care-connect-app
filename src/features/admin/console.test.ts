import { describe, expect, it } from 'vitest';
import { latest, sniff, type ContentVersion } from './console-api';

describe('credential upload type check (magic bytes, not the file name)', () => {
  it('recognises PDF, JPEG and PNG', () => {
    expect(sniff(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe('application/pdf');
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe('image/png');
  });
  it('rejects anything else (e.g. an executable renamed .pdf)', () => {
    expect(sniff(new Uint8Array([0x4d, 0x5a, 0x90, 0x00]))).toBeNull();
    expect(sniff(new Uint8Array([]))).toBeNull();
  });
});

describe('latest published content', () => {
  const row = (version: string, revision: number, at: string): ContentVersion => ({
    id: `${version}-${revision}`, key: 'terms', version, revision, title_en: '', title_ml: '', body_en: 'x'.repeat(10), body_ml: 'x'.repeat(10), published_by: null, published_at: at, reason: null,
  });
  it('orders by version number, then revision – not by time or string order', () => {
    const rows = [row('1.0', 3, '2026-10-27T10:00:00Z'), row('10.0', 1, '2026-10-01T00:00:00Z'), row('2.0', 1, '2026-10-27T10:00:00Z'), row('2.0', 2, '2026-10-27T10:00:00Z')];
    expect(latest(rows, 'terms')?.id).toBe('10.0-1');
    expect(latest(rows.slice(0, 1).concat(rows.slice(2)), 'terms')?.id).toBe('2.0-2');
    expect(latest(rows, 'privacy_notice')).toBeUndefined();
  });
});
