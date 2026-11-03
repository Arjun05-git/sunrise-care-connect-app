import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Camera, CameraOff, FileText, ImageIcon, Loader2, MessageSquare, Mic, MicOff, Paperclip, PhoneOff, RefreshCw, Send, ShieldCheck, Speaker, Video, VideoOff, Volume2, Wifi, WifiOff,
} from 'lucide-react';
import { formatTime } from '@/domain/time';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/auth/AuthProvider';
import { useRealtime } from '@/lib/realtime';
import { config } from '@/lib/config';
import { cn } from '@/lib/utils';
import { qualityBars, type Quality } from '@/services/video';
import { signedDocumentUrl, uploadDocument } from '@/features/patient/api';
import { ACCEPT, formatBytes, MAX_UPLOAD_BYTES, validateFile } from '@/features/patient/documents';
import { cqk, useChat, useSendChat, type ChatRow } from './api';
import { playTestTone, useNetworkCheck, type MediaProblem, type useDeviceCheck } from './devices';

/** Four-bar network indicator; colour and label follow the SFU's connection-quality rating. */
export function QualityIndicator({ quality, className, light }: { quality: Quality; className?: string; light?: boolean }) {
  const { t } = useTranslation();
  const bars = qualityBars(quality);
  const color = quality === 'excellent' || quality === 'good' ? 'bg-success' : quality === 'poor' ? 'bg-warning' : 'bg-destructive';
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', className)} role="img" aria-label={t('consult.quality.label', { q: t(`consult.quality.${quality}`) })}>
      <span className="flex h-4 items-end gap-0.5" aria-hidden>
        {[1, 2, 3, 4].map((i) => <span key={i} className={cn('w-1 rounded-sm', i <= bars ? color : light ? 'bg-white/25' : 'bg-muted-foreground/30')} style={{ height: `${i * 25}%` }} />)}
      </span>
      <span aria-hidden>{t(`consult.quality.${quality}`)}</span>
    </span>
  );
}

/** "Not recorded" reassurance shown in the waiting room and during the call. */
export function NotRecorded({ className }: { className?: string }) {
  const { t } = useTranslation();
  return <span className={cn('inline-flex items-center gap-1 text-xs', className)}><ShieldCheck className="h-3.5 w-3.5" aria-hidden />{t('consult.notRecorded')}</span>;
}

export function Elapsed({ since }: { since: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!since) return null;
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return <span className="font-mono tabular-nums">{String(Math.floor(s / 60)).padStart(2, '0')}:{String(s % 60).padStart(2, '0')}</span>;
}

// ---------------------------------------------------------------- device check
const problemKey = (p: MediaProblem) => `consult.device.problem.${p}`;

export function DeviceCheck({ dc, wantVideo, audioOnly, onAudioOnly }: { dc: ReturnType<typeof useDeviceCheck>; wantVideo: boolean; audioOnly: boolean; onAudioOnly: (v: boolean) => void }) {
  const { t } = useTranslation();
  const video = useRef<HTMLVideoElement>(null);
  const { net, recheck } = useNetworkCheck(`${config.supabaseUrl}/auth/v1/health`);
  const [toneBusy, setToneBusy] = useState(false);

  useEffect(() => {
    if (video.current) video.current.srcObject = dc.stream && dc.stream.getVideoTracks().length ? dc.stream : null;
  }, [dc.stream]);
  const hasVideo = !!dc.stream?.getVideoTracks().length;

  return (
    <div className="space-y-4">
      {wantVideo && (
        <div className="relative aspect-video overflow-hidden rounded-xl bg-neutral-900">
          <video ref={video} autoPlay playsInline muted className={cn('h-full w-full -scale-x-100 object-cover', (!hasVideo || audioOnly) && 'invisible')} aria-label={t('consult.device.preview')} />
          {(!hasVideo || audioOnly) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-white/80">
              <CameraOff className="h-8 w-8" aria-hidden />
              {audioOnly ? t('consult.device.audioOnlyOn') : dc.checking ? t('consult.device.checking') : t(problemKey(dc.camProblem ?? 'other'))}
            </div>
          )}
        </div>
      )}

      <ul className="space-y-2 text-sm">
        {wantVideo && (
          <CheckRow ok={!dc.camProblem} busy={dc.checking} icon={<Camera className="h-4 w-4" aria-hidden />} label={t('consult.device.camera')} detail={dc.camProblem ? t(problemKey(dc.camProblem)) : undefined}>
            {dc.cameras.length > 1 && <DeviceSelect label={t('consult.device.camera')} devices={dc.cameras} value={dc.prefs.cameraId} onChange={(cameraId) => dc.choose({ cameraId })} />}
          </CheckRow>
        )}
        <CheckRow ok={!dc.micProblem} busy={dc.checking} icon={<Mic className="h-4 w-4" aria-hidden />} label={t('consult.device.mic')} detail={dc.micProblem ? t(problemKey(dc.micProblem)) : t('consult.device.speakNow')}>
          {!dc.micProblem && (
            <div className="h-2 w-24 overflow-hidden rounded-full bg-muted" role="meter" aria-label={t('consult.device.micLevel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(dc.level * 100)}>
              <div className="h-full bg-success transition-[width] duration-75" style={{ width: `${Math.round(dc.level * 100)}%` }} />
            </div>
          )}
          {dc.mics.length > 1 && <DeviceSelect label={t('consult.device.mic')} devices={dc.mics} value={dc.prefs.micId} onChange={(micId) => dc.choose({ micId })} />}
        </CheckRow>
        <CheckRow ok icon={<Speaker className="h-4 w-4" aria-hidden />} label={t('consult.device.speaker')} detail={t('consult.device.speakerHint')}>
          <Button size="sm" variant="outline" loading={toneBusy} onClick={() => { setToneBusy(true); void playTestTone(dc.prefs.speakerId).catch(() => toast.error(t('consult.device.toneFailed'))).finally(() => setTimeout(() => setToneBusy(false), 1000)); }}>
            <Volume2 aria-hidden />{t('consult.device.playTone')}
          </Button>
          {dc.canPickSpeaker && dc.speakers.length > 1 && <DeviceSelect label={t('consult.device.speaker')} devices={dc.speakers} value={dc.prefs.speakerId} onChange={(speakerId) => dc.choose({ speakerId })} />}
        </CheckRow>
        <CheckRow ok={net.state === 'good'} warn={net.state === 'slow'} busy={net.state === 'checking'} icon={net.state === 'offline' ? <WifiOff className="h-4 w-4" aria-hidden /> : <Wifi className="h-4 w-4" aria-hidden />}
          label={t('consult.device.network')} detail={t(`consult.device.net.${net.state}`, { ms: net.rttMs })}>
          {net.state !== 'checking' && net.state !== 'good' && <Button size="sm" variant="ghost" onClick={() => void recheck()}><RefreshCw aria-hidden />{t('common.retry')}</Button>}
        </CheckRow>
      </ul>

      {(dc.camProblem || dc.micProblem) && !dc.checking && (
        <div className="space-y-2 rounded-xl bg-warning-soft p-3 text-sm">
          <p>{t(dc.camProblem === 'denied' || dc.micProblem === 'denied' ? 'consult.device.allowHelp' : 'consult.device.generalHelp')}</p>
          <Button size="sm" variant="outline" onClick={() => void dc.retry()}><RefreshCw aria-hidden />{t('consult.device.checkAgain')}</Button>
        </div>
      )}

      {wantVideo && (
        <label className="flex items-start gap-3 rounded-xl border p-3 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={audioOnly} onChange={(e) => onAudioOnly(e.target.checked)} />
          <span><span className="font-medium">{t('consult.audioOnly')}</span><span className="block text-xs text-muted-foreground">{t('consult.audioOnlyHint')}</span></span>
        </label>
      )}
    </div>
  );
}

function CheckRow({ ok, warn, busy, icon, label, detail, children }: { ok: boolean; warn?: boolean; busy?: boolean; icon: ReactNode; label: string; detail?: string; children?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border p-3">
      <span className={cn('flex h-8 w-8 items-center justify-center rounded-full', busy ? 'bg-muted' : ok ? 'bg-success-soft text-success' : warn ? 'bg-warning-soft text-warning' : 'bg-destructive-soft text-destructive')}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      </span>
      <span className="min-w-0 flex-1"><span className="block font-medium">{label}</span>{detail && <span className="block text-xs text-muted-foreground">{detail}</span>}</span>
      <span className="flex flex-wrap items-center gap-2">{children}</span>
    </li>
  );
}

function DeviceSelect({ label, devices, value, onChange }: { label: string; devices: MediaDeviceInfo[]; value?: string; onChange: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <select aria-label={t('consult.device.choose', { what: label })} className="h-9 max-w-[12rem] rounded-lg border bg-card px-2 text-sm" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('consult.device.default')}</option>
      {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `${label} ${i + 1}`}</option>)}
    </select>
  );
}

// ---------------------------------------------------------------- controls
export function ControlButton({ on, onClick, label, iconOn, iconOff, danger, disabled, badge }: {
  on: boolean; onClick: () => void; label: string; iconOn: ReactNode; iconOff?: ReactNode; danger?: boolean; disabled?: boolean; badge?: number;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-pressed={danger ? undefined : on} aria-label={label} title={label}
      className={cn('relative flex h-12 w-12 items-center justify-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40 sm:h-14 sm:w-14',
        danger ? 'bg-destructive text-white hover:bg-destructive/90' : on ? 'bg-white/15 text-white hover:bg-white/25' : 'bg-white text-neutral-900 hover:bg-white/90')}>
      {on || !iconOff ? iconOn : iconOff}
      {!!badge && <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-highlight px-1 text-[11px] font-bold text-highlight-foreground">{badge}</span>}
    </button>
  );
}

export const icons = {
  mic: <Mic className="h-5 w-5" aria-hidden />, micOff: <MicOff className="h-5 w-5" aria-hidden />,
  cam: <Video className="h-5 w-5" aria-hidden />, camOff: <VideoOff className="h-5 w-5" aria-hidden />,
  chat: <MessageSquare className="h-5 w-5" aria-hidden />, hangup: <PhoneOff className="h-5 w-5" aria-hidden />,
  audioOnly: <Volume2 className="h-5 w-5" aria-hidden />,
};

// ---------------------------------------------------------------- chat
/**
 * In-call chat. Messages go through send_chat_message (sender role decided server-side) and arrive
 * via Realtime. Files are uploaded to the patient's private document store and join the consultation.
 */
export function ChatPanel({ appointmentId, patientId, enabled, onIncoming }: { appointmentId: string; patientId: string; enabled: boolean; onIncoming?: (fromOther: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const { session } = useAuth();
  const qc = useQueryClient();
  const chat = useChat(appointmentId);
  const send = useSendChat(appointmentId);
  const [body, setBody] = useState('');
  const [upload, setUpload] = useState<number | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const me = session?.user.id;

  useRealtime(`chat-${appointmentId}`, [{ table: 'chat_messages', filter: `appointment_id=eq.${appointmentId}` }], [cqk.chat(appointmentId)], (p) => {
    const row = p.new as Partial<ChatRow> | undefined;
    onIncoming?.(!!row && row.sender_user_id !== me);
    if (row?.document_id) void qc.invalidateQueries({ queryKey: ['doctor', 'appointment', appointmentId] });
  });

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [chat.data?.length]);

  const errorText = (e: unknown) => {
    const code = (e as { message?: string })?.message ?? '';
    return i18n.exists(`consult.chat.err.${code}`) ? t(`consult.chat.err.${code}`) : t('common.error');
  };

  const submit = () => {
    const text = body.trim();
    if (!text) return;
    send.mutate({ body: text }, { onSuccess: () => setBody(''), onError: (e) => toast.error(errorText(e)) });
  };

  const onFile = async (f: File | undefined) => {
    if (file.current) file.current.value = '';
    if (!f || !me) return;
    const check = await validateFile(f);
    if (!check.ok) return void toast.error(t(`patient.docs.err.${check.error}`, { name: f.name, max: formatBytes(MAX_UPLOAD_BYTES) }));
    setUpload(0);
    try {
      const doc = await uploadDocument(f, { patientId, userId: me, tag: check.mime === 'application/pdf' ? 'other' : 'photo', mime: check.mime, ext: check.ext }, setUpload);
      await send.mutateAsync({ body: '', documentId: doc.id });
    } catch (e) {
      toast.error((e as Error).message === 'size' ? t('patient.docs.err.size', { name: f.name, max: formatBytes(MAX_UPLOAD_BYTES) }) : errorText(e));
    } finally {
      setUpload(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={list} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3" aria-live="polite" aria-label={t('consult.chat.title')}>
        {chat.data?.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">{t('consult.chat.empty')}</p>}
        {chat.data?.map((m) => {
          const mine = m.sender_user_id === me;
          return (
            <div key={m.id} className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
              <span className="mb-0.5 text-[11px] text-muted-foreground">{mine ? t('consult.chat.you') : t(`consult.role.${m.sender_role}`)} · {formatTime(m.created_at, i18n.language)}</span>
              <div className={cn('max-w-[85%] rounded-2xl px-3 py-2 text-sm', mine ? 'rounded-br-sm bg-primary text-primary-foreground' : 'rounded-bl-sm bg-muted')}>
                {m.body && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
                {m.documents && <SharedFile doc={m.documents} mine={mine} />}
              </div>
            </div>
          );
        })}
      </div>
      <div className="border-t p-2">
        {!enabled && <p className="px-1 pb-2 text-xs text-muted-foreground">{t('consult.chat.closed')}</p>}
        {upload != null && <p className="px-1 pb-2 text-xs text-muted-foreground" role="status">{t('consult.chat.uploading', { pct: upload })}</p>}
        <form className="flex items-end gap-1.5" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <input ref={file} type="file" accept={ACCEPT} className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} data-ref="chat-file" />
          <Button type="button" size="icon" variant="ghost" disabled={!enabled || upload != null} onClick={() => file.current?.click()} aria-label={t('consult.chat.attach')}><Paperclip className="h-5 w-5" /></Button>
          <Label htmlFor={`chat-${appointmentId}`} className="sr-only">{t('consult.chat.placeholder')}</Label>
          <Textarea id={`chat-${appointmentId}`} rows={1} maxLength={2000} value={body} disabled={!enabled} placeholder={t('consult.chat.placeholder')} className="max-h-32 min-h-11 flex-1 resize-none"
            onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} />
          <Button type="submit" size="icon" disabled={!enabled || !body.trim()} loading={send.isPending} aria-label={t('consult.chat.send')}><Send className="h-5 w-5" /></Button>
        </form>
      </div>
    </div>
  );
}

function SharedFile({ doc, mine }: { doc: NonNullable<ChatRow['documents']>; mine: boolean }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      // new tab, never in place – navigating away would end the call
      const a = Object.assign(document.createElement('a'), { href: await signedDocumentUrl(doc.storage_path), target: '_blank', rel: 'noopener noreferrer' });
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      toast.error(t('common.error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" onClick={() => void open()} disabled={busy} className={cn('mt-1 flex w-full items-center gap-2 rounded-xl p-2 text-left', mine ? 'bg-white/15' : 'bg-card')} aria-label={t('patient.docs.previewName', { name: doc.file_name })}>
      {doc.mime_type === 'application/pdf' ? <FileText className="h-5 w-5 shrink-0" aria-hidden /> : <ImageIcon className="h-5 w-5 shrink-0" aria-hidden />}
      <span className="min-w-0"><span className="block truncate font-medium">{doc.file_name}</span><span className="block text-[11px] opacity-80">{formatBytes(doc.size_bytes)}</span></span>
    </button>
  );
}

/** Thin banner over the call when the connection is being restored. */
export function ReconnectBanner({ attempt, max }: { attempt: number; max: number }) {
  const { t } = useTranslation();
  return (
    <div role="status" className="absolute inset-x-0 top-14 z-20 mx-auto flex w-fit items-center gap-2 rounded-full bg-warning px-4 py-2 text-sm font-medium text-warning-foreground shadow">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />{attempt ? t('consult.call.retrying', { n: attempt, max }) : t('consult.call.reconnecting')}
    </div>
  );
}

export function WarningLine({ children }: { children: ReactNode }) {
  return <p className="flex items-start gap-2 text-sm"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />{children}</p>;
}
