// Shared by the prescription edge functions.
import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.ts';
import { renderPrescription, type RxData } from './prescription.ts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CODE = /^[A-HJ-NP-Z2-9]{10}$/;

/** Public verification page for a code (QR target). */
export const verifyUrl = (code: string) => `${(env('PUBLIC_APP_URL') ?? 'http://localhost:5173').replace(/\/$/, '')}/verify/${code}`;

type Payload = RxData & { id: string; doctor_id: string; pdf_path: string | null; consult: RxData['consult'] & { ref: string } };

/**
 * PDF bytes for a prescription (access already checked by the caller). A final, current version is
 * rendered once and stored in the private `prescriptions` bucket (with the signature as it was then);
 * drafts are previews and superseded versions are re-rendered with the "newer version" banner.
 */
export async function prescriptionPdf(svc: SupabaseClient, id: string): Promise<{ bytes: Uint8Array; fileName: string }> {
  const { data, error } = await svc.rpc('rx_pdf_payload', { p_rx: id });
  if (error || !data) throw new Error('payload');
  const p = data as Payload;
  const fileName = `Prescription-${p.rx_no ?? 'draft'}.pdf`;
  const storable = p.status === 'final' && !p.superseded;
  if (storable && p.pdf_path) {
    const { data: blob } = await svc.storage.from('prescriptions').download(p.pdf_path);
    if (blob) return { bytes: new Uint8Array(await blob.arrayBuffer()), fileName };
  }
  const { data: sig } = await svc.storage.from('signatures').download(`${p.doctor_id}.png`);
  const bytes = await renderPrescription(p, {
    verifyUrl: p.verification_code ? verifyUrl(p.verification_code) : null,
    signature: sig && p.status === 'final' ? new Uint8Array(await sig.arrayBuffer()) : null,
  });
  if (storable && !p.pdf_path) {
    const path = `${p.id}-v${p.version}.pdf`;
    const up = await svc.storage.from('prescriptions').upload(path, bytes, { contentType: 'application/pdf', upsert: true });
    if (!up.error) await svc.rpc('set_rx_pdf_path', { p_rx: p.id, p_path: path });
  }
  return { bytes, fileName };
}
