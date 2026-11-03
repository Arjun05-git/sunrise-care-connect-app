import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChatMessage, MedicalDocument } from '@/domain/types';
import { getSupabase } from '@/lib/supabase';

/**
 * Consultation room data. Every write is an RPC (supabase/migrations/20261101000009_video.sql) that
 * derives the caller's role server-side; chat and call logs are readable by the two participants only.
 */
const sb = () => getSupabase();
async function unwrap<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw error;
  return data as T;
}

export const cqk = {
  access: (id: string) => ['consult', 'access', id] as const,
  chat: (id: string) => ['consult', 'chat', id] as const,
  summary: (id: string) => ['consult', 'summary', id] as const,
};

export interface ConsultAccess {
  role: 'doctor' | 'patient';
  status: string;
  outcome: string | null;
  start_at: string;
  end_at: string;
  mode: 'video' | 'audio';
  opens_at: string;
  closes_at: string;
  now: string;
  can_join: boolean;
  doctor_joined_at: string | null;
  patient_joined_at: string | null;
  doctor_grace_minutes: number;
  patient_grace_minutes: number;
  auto_doctor_no_show_minutes: number;
  auto_patient_no_show_minutes: number;
  recording: false;
}

export function useConsultAccess(id: string) {
  return useQuery({
    queryKey: cqk.access(id),
    refetchInterval: 30_000,
    queryFn: async () => (await unwrap(sb().rpc('consult_access', { p_appt: id }))) as ConsultAccess,
  });
}

/** Server-clock offset so countdowns don't depend on the device clock. */
export const clockSkew = (a: ConsultAccess | undefined) => (a ? new Date(a.now).getTime() - Date.now() : 0);

export type ChatRow = ChatMessage & { documents: Pick<MedicalDocument, 'id' | 'file_name' | 'mime_type' | 'size_bytes' | 'storage_path' | 'tag' | 'created_at' | 'patient_id' | 'appointment_id' | 'uploaded_by'> | null };
export function useChat(id: string, enabled = true) {
  return useQuery({
    queryKey: cqk.chat(id),
    enabled,
    queryFn: async () =>
      (await unwrap(sb().from('chat_messages').select('*, documents(id, file_name, mime_type, size_bytes, storage_path, tag, created_at, patient_id, appointment_id, uploaded_by)').eq('appointment_id', id).order('created_at').limit(500))) as ChatRow[],
  });
}

export function useSendChat(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { body: string; documentId?: string }) => unwrap(sb().rpc('send_chat_message', { p_appt: id, p_body: v.body, p_document_id: v.documentId ?? null })) as Promise<ChatMessage>,
    onSuccess: () => qc.invalidateQueries({ queryKey: cqk.chat(id) }),
  });
}

export type CallEventName = 'leave' | 'reconnecting' | 'reconnected' | 'disconnected' | 'quality' | 'failure' | 'device_error' | 'audio_only' | 'video_on' | 'end';
/** Best-effort call log (never blocks the call). Details are whitelisted server-side. */
export async function logCallEvent(id: string, event: CallEventName, detail: Record<string, string | number> = {}) {
  try {
    await unwrap(sb().rpc('log_call_event', { p_appt: id, p_event: event, p_detail: detail }));
  } catch {
    /* offline or rate-limited – the server-side webhook still records joins and leaves */
  }
}

export interface CallSummary {
  provider: string | null;
  doctor_joined_at: string | null;
  patient_joined_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  quality: { samples: number; worst: string | null; poor_share: number | null } | null;
  reconnects: number;
  failures: { at: string; who: string | null; reason: string | null }[];
  recording: false;
}
export function useCallSummary(id: string, enabled = true) {
  return useQuery({
    queryKey: cqk.summary(id),
    enabled,
    queryFn: async () => (await unwrap(sb().rpc('call_summary', { p_appt: id }))) as CallSummary,
  });
}

export interface ConsultAppointment {
  id: string; ref_code: string; patient_id: string; doctor_id: string; mode: 'video' | 'audio'; start_at: string; end_at: string;
  patients: { full_name: string } | null;
  doctors: { full_name: string; photo_url: string; departments: { name: string; name_ml: string } | null } | null;
}
/** Header details for the room (both participants can read the booking under RLS). */
export function useConsultAppointment(id: string) {
  return useQuery({
    queryKey: ['consult', 'appointment', id],
    queryFn: async () =>
      (await unwrap(sb().from('appointments').select('id, ref_code, patient_id, doctor_id, mode, start_at, end_at, patients(full_name), doctors(full_name, photo_url, departments(name, name_ml))').eq('id', id).maybeSingle())) as unknown as ConsultAppointment | null,
  });
}
