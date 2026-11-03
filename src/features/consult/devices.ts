import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Pre-call device check: camera preview, microphone level, device pickers, speaker test tone and a
 * quick connection probe. Chosen devices are remembered per browser (a convenience – not required).
 */
export interface DevicePrefs { micId?: string; cameraId?: string; speakerId?: string }
const PREFS_KEY = 'scc.devices';
export function loadPrefs(): DevicePrefs {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as DevicePrefs;
  } catch {
    return {};
  }
}
function savePrefs(p: DevicePrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* private mode */
  }
}

export type MediaProblem = 'denied' | 'not_found' | 'in_use' | 'insecure' | 'other' | null;
export function mediaProblem(e: unknown): MediaProblem {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'not_found';
  if (name === 'NotReadableError' || name === 'AbortError') return 'in_use';
  return 'other';
}

export function useDeviceCheck(wantVideo: boolean) {
  const [prefs, setPrefs] = useState<DevicePrefs>(loadPrefs);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [camProblem, setCamProblem] = useState<MediaProblem>(null);
  const [micProblem, setMicProblem] = useState<MediaProblem>(null);
  const [level, setLevel] = useState(0);
  const [checking, setChecking] = useState(true);
  const streamRef = useRef<MediaStream | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  const start = useCallback(async () => {
    setChecking(true);
    stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicProblem(window.isSecureContext ? 'other' : 'insecure');
      setCamProblem(wantVideo ? (window.isSecureContext ? 'other' : 'insecure') : null);
      setChecking(false);
      return;
    }
    const tracks: MediaStreamTrack[] = [];
    try {
      const a = await navigator.mediaDevices.getUserMedia({ audio: prefs.micId ? { deviceId: { exact: prefs.micId } } : true });
      tracks.push(...a.getTracks());
      setMicProblem(null);
    } catch (e) {
      setMicProblem(mediaProblem(e));
    }
    if (wantVideo) {
      try {
        const v = await navigator.mediaDevices.getUserMedia({ video: prefs.cameraId ? { deviceId: { exact: prefs.cameraId } } : { facingMode: 'user' } });
        tracks.push(...v.getTracks());
        setCamProblem(null);
      } catch (e) {
        setCamProblem(mediaProblem(e));
      }
    } else setCamProblem(null);
    const s = new MediaStream(tracks);
    streamRef.current = s;
    setStream(s);
    try {
      setDevices(await navigator.mediaDevices.enumerateDevices()); // labels are only filled in after permission
    } catch {
      setDevices([]);
    }
    setChecking(false);
  }, [prefs.micId, prefs.cameraId, wantVideo, stop]);

  useEffect(() => {
    void start();
    return stop;
  }, [start, stop]);

  // microphone level meter (RMS of the analyser's time-domain data, 0–1)
  useEffect(() => {
    const track = stream?.getAudioTracks()[0];
    if (!track) {
      setLevel(0);
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(new MediaStream([track])).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    let raf = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      void ctx.close();
    };
  }, [stream]);

  const choose = (patch: DevicePrefs) => {
    const next = { ...prefs, ...patch };
    savePrefs(next);
    setPrefs(next);
  };

  return {
    prefs, choose, stream, level, checking, camProblem, micProblem, retry: start, stop,
    mics: devices.filter((d) => d.kind === 'audioinput' && d.deviceId),
    cameras: devices.filter((d) => d.kind === 'videoinput' && d.deviceId),
    speakers: devices.filter((d) => d.kind === 'audiooutput' && d.deviceId),
    canPickSpeaker: typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype,
  };
}

/** One-second 660 Hz test tone (generated WAV) played through the chosen speaker. */
export async function playTestTone(speakerId?: string) {
  const rate = 22050;
  const n = rate;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin((2 * Math.PI * 660 * i) / rate) * 0.25 * 32767 * Math.min(1, (n - i) / 2000), true);
  const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  const audio = new Audio(url);
  if (speakerId && 'setSinkId' in audio) await (audio as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(speakerId).catch(() => undefined);
  audio.onended = () => URL.revokeObjectURL(url);
  await audio.play();
}

export type NetCheck = { state: 'checking' | 'good' | 'slow' | 'offline'; rttMs?: number };
/** Round-trip to our own API (no third parties); > 600 ms or a 2G connection is reported as slow. */
export function useNetworkCheck(probeUrl: string) {
  const [net, setNet] = useState<NetCheck>({ state: 'checking' });
  const run = useCallback(async () => {
    if (!navigator.onLine) return setNet({ state: 'offline' });
    setNet({ state: 'checking' });
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      try {
        await fetch(probeUrl, { cache: 'no-store' });
        times.push(performance.now() - t0);
      } catch {
        return setNet({ state: 'offline' });
      }
    }
    const rtt = Math.round(Math.min(...times));
    const eff = (navigator as unknown as { connection?: { effectiveType?: string } }).connection?.effectiveType;
    setNet({ state: rtt > 600 || eff === '2g' || eff === 'slow-2g' ? 'slow' : 'good', rttMs: rtt });
  }, [probeUrl]);
  useEffect(() => {
    void run();
    const on = () => void run();
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, [run]);
  return { net, recheck: run };
}
