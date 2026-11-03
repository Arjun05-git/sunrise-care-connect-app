// Server-side upload checks: the real type from magic bytes (never the name or the declared Content-Type),
// size, and PDFs with active content (scripts, launch actions, embedded files) refused before a doctor
// opens them. Name scanning can't see inside compressed object streams, so it is a filter, not a virus scan.
export type UploadMime = 'application/pdf' | 'image/jpeg' | 'image/png';
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const EXT: Record<UploadMime, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };

export function sniffMime(b: Uint8Array): UploadMime | null {
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf'; // %PDF-
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  return null;
}

// PDF name objects that run code or carry other files; #xx hex escapes are decoded first (/J#61vaScript).
const ACTIVE = /\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA|SubmitForm|ImportData)\b/;
export function pdfHasActiveContent(b: Uint8Array): boolean {
  const text = new TextDecoder('latin1').decode(b).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return ACTIVE.test(text);
}

export type UploadVerdict = { ok: true; mime: UploadMime; ext: string; size: number } | { ok: false; error: 'empty' | 'size' | 'type' | 'mismatch' | 'active_content' };

/** `ext` is the extension in the storage path, `declared` the object's stored Content-Type. */
export function checkUpload(bytes: Uint8Array, ext: string, declared: string): UploadVerdict {
  if (bytes.length === 0) return { ok: false, error: 'empty' };
  if (bytes.length > MAX_UPLOAD_BYTES) return { ok: false, error: 'size' };
  const mime = sniffMime(bytes);
  if (!mime) return { ok: false, error: 'type' };
  if (EXT[mime] !== ext || declared.split(';')[0]!.trim().toLowerCase() !== mime) return { ok: false, error: 'mismatch' };
  if (mime === 'application/pdf' && pdfHasActiveContent(bytes)) return { ok: false, error: 'active_content' };
  return { ok: true, mime, ext, size: bytes.length };
}
