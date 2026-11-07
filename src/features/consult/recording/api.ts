import { useQuery } from '@tanstack/react-query';
import { getSupabase } from '@/lib/supabase';

/** Recording data access: every write is an RPC from migration 20261101000023; parts go to the consult-recordings bucket. */
const sb = () => getSupabase();
async function unwrap<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw error;
  return data as T;
}

export const recordingKey = (appt: string) => ['recording', appt] as const;

export const setRecordingConsent = (appt: string, granted: boolean) => unwrap(sb().rpc('set_recording_consent', { p_appt: appt, p_granted: granted }));
export const startRecording = (appt: string) => unwrap<{ id: string; storage_prefix: string; kind: 'audio' }>(sb().rpc('start_recording', { p_appt: appt }));
export const stopRecording = (rec: string) => unwrap(sb().rpc('stop_recording', { p_rec: rec }));
export const finishRecording = (rec: string, size: number, mime: string) => unwrap(sb().rpc('finish_recording', { p_rec: rec, p_size: size, p_mime: mime }));
export const failRecording = (rec: string, reason: string) => unwrap(sb().rpc('fail_recording', { p_rec: rec, p_reason: reason }));

export async function uploadPart(path: string, blob: Blob): Promise<void> {
  const { error } = await sb().storage.from('consult-recordings').upload(path, blob, { contentType: 'audio/webm', upsert: false });
  if (error) throw error;
}

/** Consents and recordings of one appointment. Explicit columns: storage_prefix is never readable by clients. */
export function useRecordingState(appt: string) {
  return useQuery({
    queryKey: recordingKey(appt),
    queryFn: async () => {
      const [consents, recordings] = await Promise.all([
        unwrap<{ party: 'doctor' | 'patient'; withdrawn_at: string | null }[]>(sb().from('recording_consents').select('party, withdrawn_at').eq('appointment_id', appt)),
        unwrap<{ id: string; status: string; stop_reason: string | null; started_at: string; ended_at: string | null; duration_seconds: number | null }[]>(
          sb().from('consult_recordings').select('id, status, stop_reason, started_at, ended_at, duration_seconds').eq('appointment_id', appt).order('started_at', { ascending: false }),
        ),
      ]);
      return { consents, recordings };
    },
  });
}

export function useRecordingEnabled() {
  return useQuery({
    queryKey: ['recording', 'enabled'] as const,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const rows = await unwrap<{ value: unknown }[]>(sb().from('app_settings').select('value').eq('key', 'recording_enabled'));
      return rows[0]?.value === true;
    },
  });
}
