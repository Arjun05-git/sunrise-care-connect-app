import { useCallback, useEffect, useRef, useState } from 'react';
import { FunctionError } from '@/lib/functions';
import { loadProvider, QualityTracker, requestVideoCredentials, type CallState, type Quality, type RemoteStatus, type VideoCall, type VideoProviderName } from '@/services/video';
import { logCallEvent } from './api';
import type { DevicePrefs } from './devices';

export type Phase = 'idle' | 'joining' | CallState;
export interface CallMedia { mic: boolean; camera: boolean; audioOnly: boolean }

const SAMPLE_MS = 5_000;
const FLUSH_MS = 60_000;
const RETRY_DELAYS = [2_000, 5_000, 10_000];
/** Disconnects that a retry can't fix (or must not: another tab took over the seat). */
const FINAL_REASONS = new Set(['duplicate_identity', 'participant_removed', 'room_deleted', 'room_closed']);

/**
 * One consultation call: credentials → provider → events. Logs (best-effort) reconnects, failures with
 * a reason code, device errors, audio-only switches and a per-minute quality aggregate. A dropped
 * connection the SDK can't recover is re-joined automatically (fresh token) up to three times.
 */
export function useCall(appointmentId: string) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [quality, setQuality] = useState<Quality>('unknown');
  const [remote, setRemote] = useState<RemoteStatus>({ present: false, audio: false, video: false, quality: 'unknown' });
  const [media, setMedia] = useState<CallMedia>({ mic: true, camera: true, audioOnly: false });
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<VideoProviderName | null>(null);
  const [embedsUi, setEmbedsUi] = useState(false);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [retries, setRetries] = useState(0);
  const [retryPending, setRetryPending] = useState(false);

  const call = useRef<VideoCall | null>(null);
  const tracker = useRef(new QualityTracker());
  const lastQuality = useRef<Quality>('unknown');
  const els = useRef<{ remote: HTMLElement | null; local: HTMLVideoElement | null }>({ remote: null, local: null });
  const joinArgs = useRef<{ media: CallMedia; prefs: DevicePrefs } | null>(null);
  const providerRef = useRef<VideoProviderName | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>();
  const reconnectingSince = useRef<number | null>(null);
  const leaving = useRef(false);
  const retriesRef = useRef(0);
  const endedReason = useRef<string | null>(null);

  const flushQuality = useCallback(() => {
    const s = tracker.current.flush();
    if (s) void logCallEvent(appointmentId, 'quality', { ...s, provider: providerRef.current ?? 'livekit' });
  }, [appointmentId]);

  const teardown = useCallback(async () => {
    const c = call.current;
    call.current = null;
    if (c) await c.disconnect().catch(() => undefined);
  }, []);

  const connect = useCallback(async () => {
    const args = joinArgs.current;
    const remoteEl = els.current.remote;
    if (!args || !remoteEl) return;
    setPhase('joining');
    setError(null);
    setRetryPending(false);
    endedReason.current = null;
    await teardown();
    try {
      const creds = await requestVideoCredentials(appointmentId);
      providerRef.current = creds.provider;
      setProvider(creds.provider);
      const p = await loadProvider(creds.provider);
      const c = await p.connect(creds, { ...args.media, ...args.prefs, remote: remoteEl, local: els.current.local });
      if (leaving.current) return void c.disconnect();
      call.current = c;
      setEmbedsUi(c.embedsUi);
      c.on('quality', (q) => { lastQuality.current = q; setQuality(q); });
      c.on('remote', setRemote);
      c.on('ended', (reason) => {
        if (reason.startsWith('device_')) void logCallEvent(appointmentId, 'device_error', { reason, provider: creds.provider });
        else {
          endedReason.current = reason;
          setError(reason);
        }
      });
      c.on('state', (s) => {
        if (call.current !== c) return;
        setPhase(s);
        if (s === 'connected') {
          setConnectedAt((t) => t ?? Date.now());
          if (reconnectingSince.current) {
            void logCallEvent(appointmentId, 'reconnected', { seconds: Math.round((Date.now() - reconnectingSince.current) / 1000), provider: creds.provider });
            reconnectingSince.current = null;
          }
          retriesRef.current = 0;
          setRetries(0);
        } else if (s === 'reconnecting') {
          if (!reconnectingSince.current) {
            reconnectingSince.current = Date.now();
            void logCallEvent(appointmentId, 'reconnecting', { provider: creds.provider });
          }
        } else if (s === 'failed' && !leaving.current) {
          flushQuality();
          const reason = endedReason.current ?? 'connection_lost';
          void logCallEvent(appointmentId, 'disconnected', { reason, provider: creds.provider });
          if (!FINAL_REASONS.has(reason)) scheduleRetry();
        }
      });
    } catch (e) {
      const code = e instanceof FunctionError ? e.code : (e as Error)?.message === 'jitsi_unavailable' ? 'provider_unavailable' : 'connect_failed';
      setError(code);
      setPhase('failed');
      void logCallEvent(appointmentId, 'failure', { reason: code, provider: providerRef.current ?? 'unknown' });
      // window closed / not joinable are final; network-type failures are retried
      if (!(e instanceof FunctionError) || e.status >= 500) scheduleRetry();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointmentId, teardown, flushQuality]);

  function scheduleRetry() {
    clearTimeout(retryTimer.current);
    const n = retriesRef.current;
    if (n >= RETRY_DELAYS.length || leaving.current) return;
    retriesRef.current = n + 1;
    setRetries(n + 1);
    setRetryPending(true);
    if (!reconnectingSince.current) reconnectingSince.current = Date.now();
    retryTimer.current = setTimeout(() => void connect(), RETRY_DELAYS[n]);
  }

  /** Start the call. `remote` hosts the remote video (or the Jitsi iframe). */
  const join = useCallback(async (m: CallMedia, prefs: DevicePrefs) => {
    leaving.current = false;
    setMedia(m);
    joinArgs.current = { media: m, prefs };
    retriesRef.current = 0;
    await connect();
  }, [connect]);

  /** Manual reconnect from the "connection lost" screen. */
  const reconnect = useCallback(async () => {
    retriesRef.current = 0;
    setRetries(0);
    if (joinArgs.current) joinArgs.current.media = media;
    await connect();
  }, [connect, media]);

  const leave = useCallback(async (kind: 'leave' | 'end') => {
    leaving.current = true;
    clearTimeout(retryTimer.current);
    setRetryPending(false);
    flushQuality();
    void logCallEvent(appointmentId, kind, { provider: providerRef.current ?? 'unknown', seconds: connectedAt ? Math.round((Date.now() - connectedAt) / 1000) : 0 });
    await teardown();
    setPhase('disconnected');
  }, [appointmentId, connectedAt, flushQuality, teardown]);

  /** Patient/doctor reports a problem they can't fix (no audio, frozen video, …) – shown in the call log. */
  const reportProblem = useCallback((reason: string) => logCallEvent(appointmentId, 'failure', { reason, provider: providerRef.current ?? 'unknown' }), [appointmentId]);

  const setMic = useCallback(async (on: boolean) => {
    setMedia((m) => ({ ...m, mic: on }));
    await call.current?.setMic(on).catch(() => void logCallEvent(appointmentId, 'device_error', { reason: 'device_mic' }));
  }, [appointmentId]);
  const setCamera = useCallback(async (on: boolean) => {
    setMedia((m) => ({ ...m, camera: on }));
    await call.current?.setCamera(on).catch(() => void logCallEvent(appointmentId, 'device_error', { reason: 'device_camera' }));
  }, [appointmentId]);
  const setAudioOnly = useCallback(async (on: boolean) => {
    setMedia((m) => ({ ...m, audioOnly: on }));
    await call.current?.setAudioOnly(on);
    void logCallEvent(appointmentId, on ? 'audio_only' : 'video_on', { provider: providerRef.current ?? 'unknown', quality: lastQuality.current });
  }, [appointmentId]);

  // quality sampling + periodic flush while connected
  useEffect(() => {
    if (phase !== 'connected' && phase !== 'reconnecting') return;
    const s = setInterval(() => tracker.current.add(phase === 'reconnecting' ? 'lost' : lastQuality.current), SAMPLE_MS);
    const f = setInterval(flushQuality, FLUSH_MS);
    return () => {
      clearInterval(s);
      clearInterval(f);
    };
  }, [phase, flushQuality]);

  // leaving the page ends the call (the LiveKit webhook records participant_left server-side as well)
  useEffect(() => () => {
    leaving.current = true;
    clearTimeout(retryTimer.current);
    flushQuality();
    void teardown();
  }, [flushQuality, teardown]);

  const setRemoteEl = useCallback((el: HTMLElement | null) => { els.current.remote = el; }, []);
  const setLocalEl = useCallback((el: HTMLVideoElement | null) => {
    els.current.local = el;
    call.current?.setLocalElement(el);
  }, []);

  return { phase, quality, remote, media, error, provider, embedsUi, connectedAt, retries, retryPending, maxRetries: RETRY_DELAYS.length, join, reconnect, leave, reportProblem, setMic, setCamera, setAudioOnly, setRemoteEl, setLocalEl };
}
