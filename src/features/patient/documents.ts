/**
 * Medical document upload rules (mirrors the storage bucket + `documents` table checks):
 * PDF / JPG / PNG only, 1 byte – 10 MB, and the file's first bytes must match its type,
 * so a renamed executable or a mislabelled file is rejected before upload.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_CONSULT = 5;
export const ACCEPT = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';

export type AllowedMime = 'application/pdf' | 'image/jpeg' | 'image/png';
export type FileCheck = { ok: true; mime: AllowedMime; ext: 'pdf' | 'jpg' | 'png' } | { ok: false; error: 'type' | 'size' | 'empty' | 'mismatch' };

const BY_EXT: Record<string, AllowedMime> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
const EXT_FOR: Record<AllowedMime, 'pdf' | 'jpg' | 'png'> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

/** Detect the real type from magic bytes. */
export function sniffMime(head: Uint8Array): AllowedMime | null {
  const starts = (...b: number[]) => b.every((x, i) => head[i] === x);
  if (starts(0x25, 0x50, 0x44, 0x46)) return 'application/pdf'; // %PDF
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  return null;
}

export function checkFile(name: string, size: number, declaredType: string, head: Uint8Array): FileCheck {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const byExt = BY_EXT[ext];
  if (!byExt || (declaredType && !Object.values(BY_EXT).includes(declaredType as AllowedMime))) return { ok: false, error: 'type' };
  if (size <= 0) return { ok: false, error: 'empty' };
  if (size > MAX_UPLOAD_BYTES) return { ok: false, error: 'size' };
  const real = sniffMime(head);
  if (!real || real !== byExt) return { ok: false, error: 'mismatch' };
  return { ok: true, mime: real, ext: EXT_FOR[real] };
}

export async function validateFile(file: File): Promise<FileCheck> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  return checkFile(file.name, file.size, file.type, head);
}

/** Storage object path: IDs only – never the file name or any clinical words. */
export const documentPath = (patientId: string, documentId: string, ext: string) => `patients/${patientId}/${documentId}.${ext}`;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
