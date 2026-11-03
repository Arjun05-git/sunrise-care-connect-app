import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Diagnosis } from '@/domain/types';
import { getSupabase } from '@/lib/supabase';
import { callFunction, downloadFunctionFile, FunctionError } from '@/lib/functions';
import { config } from '@/lib/config';

/**
 * Clinical notes + e-prescriptions (supabase/migrations/20261101000010_prescriptions.sql). Every write is
 * an RPC: diagnoses are resolved against the ICD master and every drug is checked by the same rule
 * engine the server enforces at finalisation.
 */
const sb = () => getSupabase();
async function unwrap<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw error;
  return data as T;
}

export const clk = {
  notes: (appt: string) => ['consult', 'notes', appt] as const,
  rx: (appt: string) => ['clinical', 'rx', appt] as const,
  templates: ['clinical', 'templates'] as const,
  signing: ['clinical', 'signing'] as const,
  myRx: ['clinical', 'my-rx'] as const,
};

// ---------------------------------------------------------------- notes
export interface Notes {
  chief_complaint: string; history: string; examination: string; diagnoses: Diagnosis[];
  advice: string; investigations: string; follow_up_date: string | null;
}
export const EMPTY_NOTES: Notes = { chief_complaint: '', history: '', examination: '', diagnoses: [], advice: '', investigations: '', follow_up_date: null };

export function useNotes(appt: string) {
  return useQuery({
    queryKey: clk.notes(appt),
    staleTime: Infinity, // the editor owns the draft once loaded
    queryFn: async () =>
      (await unwrap(sb().from('consultations').select('chief_complaint, history, examination, diagnoses, advice, investigations, follow_up_date, status, updated_at').eq('appointment_id', appt).maybeSingle())) as
        (Notes & { status: 'draft' | 'final'; updated_at: string }) | null,
  });
}
export const saveNotes = async (appt: string, notes: Notes) => (await unwrap(sb().rpc('save_consult_notes', { p_appt: appt, p_notes: notes }))) as string;

export const searchIcd = async (q: string) => (await unwrap(sb().rpc('search_icd10', { p_q: q }))) as { code: string; description: string }[];

// ---------------------------------------------------------------- templates
export interface NoteTemplate { id: string; doctor_id: string | null; name: string; body: Omit<Notes, 'follow_up_date'> }
export function useTemplates() {
  return useQuery({
    queryKey: clk.templates,
    staleTime: 5 * 60_000,
    queryFn: async () => (await unwrap(sb().from('note_templates').select('id, doctor_id, name, body').order('name'))) as NoteTemplate[],
  });
}
export const saveTemplate = async (name: string, body: Omit<Notes, 'follow_up_date'>, id: string | null = null) =>
  (await unwrap(sb().rpc('save_note_template', { p_id: id, p_name: name, p_body: body }))) as string;
export const deleteTemplate = async (id: string) => unwrap(sb().rpc('delete_note_template', { p_id: id }));

// ---------------------------------------------------------------- prescriptions
export type DrugCategory = 'O' | 'A' | 'B' | 'prohibited';
export interface Reason { code: 'inactive' | 'schedule' | 'prohibited' | 'list'; schedule?: string; category?: DrugCategory; mode?: 'audio' | 'video'; consult_type?: 'first' | 'follow_up'; note?: string }
export interface Warning { code: 'allergy' | 'interaction' | 'duplicate'; allergy?: string; key?: string; with?: string }
export interface Verdict { drug_id: string; name: string; category: DrugCategory; schedule: string; blocked: boolean; reasons: Reason[]; warnings: Warning[] }
export type DrugHit = Verdict & { generic_name: string; form: string; strength: string; default_dose: string; default_frequency: string; default_route: string };

export interface RxItem { drug_id: string; drug_name: string; strength: string; form: string; dose: string; frequency: string; duration: string; route: string; instructions: string }
export interface Rx {
  id: string; appointment_id: string; version: number; status: 'draft' | 'final'; parent_prescription_id: string | null; addendum_reason: string | null;
  rx_no: string | null; verification_code: string | null; finalized_at: string | null; updated_at: string; created_at: string;
  diagnoses: Diagnosis[]; advice: string; investigations: string; follow_up_date: string | null;
  prescription_items: (RxItem & { position: number })[];
}

/** All versions for a consultation (drafts are visible to their doctor only). */
export function useRx(appt: string) {
  return useQuery({
    queryKey: clk.rx(appt),
    queryFn: async () =>
      (await unwrap(sb().from('prescriptions').select('*, prescription_items(*)').eq('appointment_id', appt).order('version'))) as Rx[],
  });
}
export const searchDrugs = async (appt: string, q: string, current: string[]) => (await unwrap(sb().rpc('search_rx_drugs', { p_appt: appt, p_q: q, p_current: current }))) as DrugHit[];
export const checkDrugs = async (appt: string, ids: string[]) => (ids.length ? ((await unwrap(sb().rpc('check_rx_drugs', { p_appt: appt, p_drug_ids: ids }))) as Verdict[]) : []);
export interface RxFields { diagnoses: Diagnosis[]; advice: string; investigations: string; follow_up_date: string | null }
export const saveRxDraft = async (appt: string, items: RxItem[], fields?: RxFields) =>
  (await unwrap(sb().rpc('save_rx_draft', {
    p_appt: appt,
    p_items: items.map(({ drug_id, dose, frequency, duration, route, instructions }) => ({ drug_id, dose, frequency, duration, route, instructions })),
    p_fields: fields ?? null,
  }))) as { id: string; version: number; updated_at: string };
export const startAddendum = async (rx: string, reason: string) => (await unwrap(sb().rpc('start_addendum', { p_rx: rx, p_reason: reason }))) as string;
export const discardDraft = async (rx: string) => unwrap(sb().rpc('discard_rx_draft', { p_rx: rx }));

export type FinalizeResult = { ok: true; id: string; rx_no: string; verification_code: string; version: number } | { ok: false; error: 'pin_wrong' | 'pin_locked' | 'pin_not_set'; attempts_left?: number; locked_until?: string };
export const finalizeRx = async (rx: string, pin: string) => (await unwrap(sb().rpc('finalize_prescription', { p_rx: rx, p_pin: pin }))) as FinalizeResult;

// ---------------------------------------------------------------- signing
export interface SigningStatus { pin_set: boolean; locked_until: string | null; signature_updated_at: string | null }
export function useSigningStatus() {
  return useQuery({ queryKey: clk.signing, queryFn: async () => (await unwrap(sb().rpc('signing_status'))) as SigningStatus | null });
}
export const setSigningPin = async (current: string | null, next: string) =>
  (await unwrap(sb().rpc('set_signing_pin', { p_current: current, p_new: next }))) as { ok: boolean; error?: string; attempts_left?: number; locked_until?: string };
export async function uploadSignature(pngBase64: string, pin: string) {
  try {
    return await callFunction<{ ok: boolean; error?: string; attempts_left?: number }>('doctor-signature', { action: 'upload', png_base64: pngBase64, pin });
  } catch (e) {
    if (e instanceof FunctionError && e.status === 403) return { ok: false, error: e.code };
    throw e;
  }
}
/** Current signature as an object URL (null when none uploaded). */
export async function fetchSignature(): Promise<string | null> {
  const { data } = await sb().auth.getSession();
  const res = await fetch(`${config.supabaseUrl}/functions/v1/doctor-signature`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey, Authorization: `Bearer ${data.session?.access_token ?? ''}` },
    body: JSON.stringify({ action: 'get' }),
  });
  return res.ok ? URL.createObjectURL(await res.blob()) : null;
}

// ---------------------------------------------------------------- PDF
export const downloadRxPdf = (id: string) => downloadFunctionFile('prescription-pdf', { prescription_id: id }, 'prescription.pdf');
/** The PDF as a File (for sharing or opening in a tab). */
export async function rxPdfFile(id: string): Promise<File> {
  const { data } = await sb().auth.getSession();
  const res = await fetch(`${config.supabaseUrl}/functions/v1/prescription-pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey, Authorization: `Bearer ${data.session?.access_token ?? ''}` },
    body: JSON.stringify({ prescription_id: id }),
  });
  if (!res.ok) throw new FunctionError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? 'internal_error', res.status);
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'prescription.pdf';
  return new File([await res.blob()], name, { type: 'application/pdf' });
}

export function useInvalidateRx(appt: string) {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: clk.rx(appt) }), qc.invalidateQueries({ queryKey: clk.notes(appt) })]);
}

// ---------------------------------------------------------------- patient
export type MyRx = Rx & { doctors: { full_name: string; departments: { name: string; name_ml: string } | null } | null; patients: { full_name: string } | null; appointments: { ref_code: string; start_at: string; mode: string } | null };
export function useMyPrescriptions() {
  return useQuery({
    queryKey: clk.myRx,
    queryFn: async () =>
      (await unwrap(sb().from('prescriptions').select('*, prescription_items(*), doctors(full_name, departments(name, name_ml)), patients(full_name), appointments(ref_code, start_at, mode)')
        .eq('status', 'final').order('finalized_at', { ascending: false }).limit(200))) as MyRx[],
  });
}
/** Groups versions of the same prescription; the latest version first. */
export function groupVersions<T extends Pick<Rx, 'id' | 'parent_prescription_id' | 'version'>>(rows: T[]): T[][] {
  const by = new Map<string, T[]>();
  for (const r of rows) {
    const root = r.parent_prescription_id ?? r.id;
    by.set(root, [...(by.get(root) ?? []), r]);
  }
  return [...by.values()].map((v) => v.sort((a, b) => b.version - a.version));
}
