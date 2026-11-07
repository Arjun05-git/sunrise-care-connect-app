import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRealtime } from '@/lib/realtime';
import type { VideoCall } from '@/services/video/types';
import * as api from './api';
import { AudioCapture } from './capture';
import { ChunkUploader } from './uploader';

export type RecordingPhase = 'off' | 'idle' | 'asked' | 'invited' | 'ready' | 'recording' | 'saving' | 'interrupted';

export function derivePhase(s: { enabled: boolean; role: 'doctor' | 'patient'; mine: boolean; theirs: boolean; active: boolean; saving: boolean; capturing: boolean }): RecordingPhase {
  if (!s.enabled) return 'off';
  if (s.saving) return 'saving';
  if (s.capturing) return 'recording';
  if (s.active) return s.role === 'doctor' && !s.capturing ? 'interrupted' : 'recording';
  if (s.mine && s.theirs) return 'ready';
  if (s.role === 'doctor') return s.mine ? 'asked' : 'idle';
  return s.theirs ? 'invited' : 'idle';
}

type Call = Pick<VideoCall, 'audioTracks'> & { provider?: string | null; phase: string };
interface Session { id: string; capture: AudioCapture; uploader: ChunkUploader; finishing: boolean }

export function useRecording({ appointmentId, role, call }: { appointmentId: string; role: 'doctor' | 'patient'; call: Call }) {
  const enabled = api.useRecordingEnabled().data === true;
  const state = api.useRecordingState(appointmentId).data;
  useRealtime(`rec:${appointmentId}`, [{ table: 'recording_consents', filter: `appointment_id=eq.${appointmentId}` }, { table: 'consult_recordings', filter: `appointment_id=eq.${appointmentId}` }], [api.recordingKey(appointmentId)], undefined, enabled);

  const [saving, setSaving] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = useRef<Session | null>(null);
  const callRef = useRef(call);
  callRef.current = call;

  const other = role === 'doctor' ? 'patient' : 'doctor';
  const live = (p: string) => state?.consents.some((c) => c.party === p && !c.withdrawn_at) ?? false;
  const active = state?.recordings.find((r) => r.status === 'recording');
  const phase = derivePhase({ enabled, role, mine: live(role), theirs: live(other), active: !!active, saving, capturing });

  const canRecord = useMemo(() => {
    if (call.provider && call.provider !== 'livekit') return { ok: false as const, reason: 'provider' as const };
    if (!AudioCapture.supported()) return { ok: false as const, reason: 'browser' as const };
    return { ok: true as const };
  }, [call.provider]);

  const finalize = useCallback(async (s: Session, serverStopped: boolean) => {
    if (s.finishing) return;
    s.finishing = true;
    setSaving(true);
    try {
      await s.capture.stop();
      if (!serverStopped) await api.stopRecording(s.id).catch(() => undefined);
      const res = await s.uploader.drain();
      if (res.failed) {
        const reason = res.reason ?? 'upload_failed';
        await api.failRecording(s.id, reason).catch(() => undefined);
        setError(reason);
      } else {
        await api.finishRecording(s.id, res.bytes, 'audio/webm');
      }
    } catch (e) {
      setError((e as { message?: string }).message ?? 'upload_failed');
    } finally {
      if (session.current === s) session.current = null;
      setCapturing(false);
      setSaving(false);
    }
  }, []);

  const giveConsent = useCallback(() => api.setRecordingConsent(appointmentId, true), [appointmentId]);
  const withdrawConsent = useCallback(() => api.setRecordingConsent(appointmentId, false), [appointmentId]);

  const start = useCallback(async () => {
    setError(null);
    if (!canRecord.ok) return setError(canRecord.reason === 'provider' ? 'unsupported_provider' : 'unsupported_browser');
    if (!callRef.current.audioTracks().length) return setError('no_audio');
    try {
      const r = await api.startRecording(appointmentId);
      const uploader = new ChunkUploader(r.storage_prefix, api.uploadPart, { requireHeader: true });
      const capture = new AudioCapture(() => callRef.current.audioTracks(), (b) => uploader.push(b));
      capture.start();
      session.current = { id: r.id, capture, uploader, finishing: false };
      setCapturing(true);
    } catch (e) {
      setError((e as { message?: string }).message ?? 'start_failed');
    }
  }, [appointmentId, canRecord]);

  const stop = useCallback(async () => { if (session.current) await finalize(session.current, false); }, [finalize]);

  const endInterrupted = useCallback(async () => {
    if (!active) return;
    await api.stopRecording(active.id).catch(() => undefined);
    try { await api.finishRecording(active.id, 1, 'audio/webm'); }
    catch { await api.failRecording(active.id, 'interrupted').catch(() => undefined); }
  }, [active]);

  // the server ended it (consent withdrawn) or the call ended: save what we have
  const serverEnded = !!session.current && !active && !!state?.recordings.some((r) => r.id === session.current!.id && r.status !== 'recording');
  useEffect(() => { if (serverEnded && session.current) void finalize(session.current, true); }, [serverEnded, finalize]);
  useEffect(() => { if (call.phase === 'disconnected' && session.current) void finalize(session.current, false); }, [call.phase, finalize]);
  useEffect(() => () => { if (session.current) void finalize(session.current, false); }, [finalize]);

  return { phase, canRecord, error, active, giveConsent, withdrawConsent, start, stop, endInterrupted };
}
