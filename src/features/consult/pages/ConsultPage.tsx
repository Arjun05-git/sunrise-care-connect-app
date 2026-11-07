import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, ClipboardList, Clock, FileText, Loader2, MessageSquare, NotebookPen, PhoneOff, Pill, RefreshCw, Stethoscope, UserX, Volume2, WifiOff, X } from 'lucide-react';
import { formatDateLong, formatTime } from '@/domain/time';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmergencyNotice } from '@/components/brand/EmergencyNotice';
import { EmptyState } from '@/components/feedback/EmptyState';
import { FullPageLoader } from '@/components/feedback/states';
import { useRealtime } from '@/lib/realtime';
import { cn } from '@/lib/utils';
import { PersonAvatar } from '@/features/patient/components/common';
import { useDoctorAppointment, useRecordOutcome } from '@/features/doctor/api';
import { DocumentList, NoteDialog, SymptomsView, useDoctorError } from '@/features/doctor/components';
import { NotesEditor } from '@/features/clinical/notes';
import { RxBuilder } from '@/features/clinical/rx';
import { clockSkew, cqk, useConsultAccess, useConsultAppointment, type ConsultAccess, type ConsultAppointment } from '../api';
import { RecordingPanel } from '../recording/RecordingPanel';
import { ChatPanel, ControlButton, DeviceCheck, Elapsed, icons, NotRecorded, QualityIndicator, ReconnectBanner, WarningLine } from '../components';
import { loadPrefs, useDeviceCheck } from '../devices';
import { useCall } from '../useCall';

/**
 * Consultation room for both participants: waiting room with device check and join window →
 * in-call screen → after-call (doctor records the outcome). Rendered outside the tab shell.
 */
export function ConsultPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const access = useConsultAccess(id);
  const appt = useConsultAppointment(id);
  if (access.isPending || appt.isPending) return <FullPageLoader />;
  if (!access.data || !appt.data)
    return <div className="mx-auto max-w-lg p-4"><EmptyState art="search" title={t('consult.notFound')} action={<Button asChild variant="outline"><Link to="/">{t('common.back')}</Link></Button>} /></div>;
  return <Room id={id} access={access.data} appt={appt.data} />;
}

type Stage = 'prejoin' | 'call' | 'after';
type Panel = null | 'chat' | 'symptoms' | 'docs' | 'notes' | 'rx';

function Room({ id, access, appt }: { id: string; access: ConsultAccess; appt: ConsultAppointment }) {
  const qc = useQueryClient();
  const isDoctor = access.role === 'doctor';
  const wantVideo = access.mode === 'video';
  const [stage, setStage] = useState<Stage>('prejoin');
  const [audioOnly, setAudioOnly] = useState(!wantVideo);
  const call = useCall(id);

  useRealtime(`consult-${id}`, [{ table: 'appointments', filter: `id=eq.${id}` }], [cqk.access(id), ['doctor', 'appointment', id], cqk.summary(id)]);

  // outcome recorded (or booking cancelled) while in the room → the call is over for the patient
  const active = ['confirmed', 'in_progress'].includes(access.status);
  useEffect(() => {
    if (!active && stage === 'call' && !isDoctor) {
      void call.leave('leave');
      setStage('after');
    }
  }, [active, stage, isDoctor, call]);

  const leave = async (kind: 'leave' | 'end') => {
    await call.leave(kind);
    setStage('after');
    void qc.invalidateQueries({ queryKey: cqk.access(id) });
  };

  if (stage === 'prejoin')
    return <PreJoin access={access} appt={appt} wantVideo={wantVideo} audioOnly={audioOnly} setAudioOnly={setAudioOnly} onJoin={() => setStage('call')} />;
  if (stage === 'after')
    return isDoctor ? <DoctorAfter id={id} access={access} appt={appt} onRejoin={() => setStage('call')} /> : <PatientAfter access={access} appt={appt} onRejoin={() => setStage('call')} />;
  return <CallStage id={id} access={access} appt={appt} call={call} wantVideo={wantVideo} audioOnly={audioOnly} onLeave={leave} />;
}

// ---------------------------------------------------------------- waiting room
function useServerNow(access: ConsultAccess) {
  const skew = clockSkew(access);
  const [now, setNow] = useState(() => Date.now() + skew);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() + skew), 1000);
    return () => clearInterval(id);
  }, [skew]);
  return now;
}

const countdown = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};

function PreJoin({ access, appt, wantVideo, audioOnly, setAudioOnly, onJoin }: {
  access: ConsultAccess; appt: ConsultAppointment; wantVideo: boolean; audioOnly: boolean; setAudioOnly: (v: boolean) => void; onJoin: () => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const qc = useQueryClient();
  const isDoctor = access.role === 'doctor';
  const dc = useDeviceCheck(wantVideo);
  const now = useServerNow(access);
  const opens = new Date(access.opens_at).getTime();
  const closes = new Date(access.closes_at).getTime();
  const start = new Date(access.start_at).getTime();
  const active = ['confirmed', 'in_progress'].includes(access.status);
  const early = active && now < opens;
  const closed = active && now > closes;
  const open = active && !early && !closed;
  const doctorDue = start + (access.auto_doctor_no_show_minutes ?? 30) * 60_000;
  const back = isDoctor ? `/d/appointments/${appt.id}` : '/p/appointments';
  const dept = appt.doctors?.departments;

  // the moment the window opens, re-check with the server
  const refetched = useRef(false);
  useEffect(() => {
    if (!refetched.current && active && now >= opens && !access.can_join) {
      refetched.current = true;
      void qc.invalidateQueries({ queryKey: cqk.access(appt.id) });
    }
  }, [now, opens, active, access.can_join, qc, appt.id]);

  const join = () => {
    dc.stop(); // release the preview camera before the call opens it
    onJoin();
  };

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-card/95 px-4 py-3 backdrop-blur">
        <Button variant="ghost" size="icon" asChild><Link to={back} aria-label={t('common.back')}><ArrowLeft className="h-5 w-5" /></Link></Button>
        <h1 className="text-lg font-semibold">{t(isDoctor ? 'consult.pre.titleDoctor' : 'consult.pre.title')}</h1>
        <NotRecorded className="ml-auto text-muted-foreground" />
      </header>
      <main id="main" className="mx-auto grid max-w-5xl gap-4 p-4 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              {isDoctor ? <PersonAvatar name={appt.patients?.full_name ?? ''} className="h-12 w-12" /> : <PersonAvatar name={appt.doctors?.full_name ?? ''} src={appt.doctors?.photo_url} className="h-12 w-12" />}
              <div className="min-w-0">
                <p className="truncate font-semibold">{isDoctor ? appt.patients?.full_name : appt.doctors?.full_name}</p>
                <p className="text-sm text-muted-foreground">{!isDoctor && dept ? `${lang === 'ml' ? dept.name_ml : dept.name} · ` : ''}{formatDateLong(access.start_at, lang)}, {formatTime(access.start_at, lang)}</p>
                <p className="text-xs text-muted-foreground">{appt.ref_code} · {t(`patient.mode.${access.mode}`)}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t('consult.device.title')}</CardTitle></CardHeader>
            <CardContent><DeviceCheck dc={dc} wantVideo={wantVideo} audioOnly={audioOnly} onAudioOnly={setAudioOnly} /></CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card className="lg:sticky lg:top-20">
            <CardContent className="space-y-4 p-5" aria-live="polite">
              {!active ? (
                <div className="space-y-2">
                  <p className="font-semibold">{t(`consult.pre.state.${access.status === 'cancelled' && access.outcome ? access.outcome : access.status}`, { defaultValue: t('consult.pre.state.unavailable') })}</p>
                  <Button variant="outline" block asChild><Link to={back}>{t('common.back')}</Link></Button>
                </div>
              ) : early ? (
                <div className="space-y-1 text-center">
                  <Clock className="mx-auto h-8 w-8 text-primary" aria-hidden />
                  <p className="text-sm text-muted-foreground">{t('consult.pre.opensIn')}</p>
                  <p className="font-mono text-3xl font-bold tabular-nums" role="timer">{countdown(opens - now)}</p>
                  <p className="text-sm text-muted-foreground">{t('consult.pre.opensAt', { time: formatTime(access.opens_at, lang) })}</p>
                </div>
              ) : closed ? (
                <p className="font-semibold">{t('consult.pre.closed')}</p>
              ) : (
                <div className="space-y-1">
                  <p className="font-semibold text-success">{t('consult.pre.open')}</p>
                  {isDoctor ? (
                    <p className="text-sm text-muted-foreground">{access.patient_joined_at ? t('consult.pre.patientWaiting') : t('consult.pre.patientNotYet')}</p>
                  ) : access.doctor_joined_at ? (
                    <p className="text-sm">{t('consult.pre.doctorIn')}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground">{now > start ? t('consult.pre.doctorDelayed', { time: formatTime(new Date(doctorDue).toISOString(), lang) }) : t('consult.pre.doctorSoon')}</p>
                  )}
                </div>
              )}
              {active && !closed && (
                <Button block size="lg" disabled={!open || !access.can_join || dc.checking} onClick={join} data-ref="join">
                  {wantVideo && !audioOnly ? icons.cam : icons.audioOnly}{t(isDoctor ? 'consult.pre.start' : 'consult.pre.join')}
                </Button>
              )}
              {open && dc.micProblem && <WarningLine>{t('consult.pre.noMicWarning')}</WarningLine>}
              <p className="text-xs text-muted-foreground">{t(isDoctor ? 'consult.pre.windowDoctor' : 'consult.pre.window', { before: Math.round((start - opens) / 60_000), until: formatTime(access.closes_at, lang) })}</p>
            </CardContent>
          </Card>
          {!isDoctor && <EmergencyNotice compact />}
          {isDoctor && <DoctorPatientCard id={appt.id} />}
        </div>
      </main>
    </div>
  );
}

function DoctorPatientCard({ id }: { id: string }) {
  const { t } = useTranslation();
  const a = useDoctorAppointment(id);
  return (
    <Card>
      <CardHeader><CardTitle>{t('doctor.appt.symptoms')}</CardTitle></CardHeader>
      <CardContent>{a.data ? <SymptomsView sym={a.data.appointment_symptoms} compact /> : <Loader2 className="h-5 w-5 animate-spin" aria-label={t('common.loading')} />}</CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- in call
type CallApi = ReturnType<typeof useCall>;

function CallStage({ id, access, appt, call, wantVideo, audioOnly, onLeave }: {
  id: string; access: ConsultAccess; appt: ConsultAppointment; call: CallApi; wantVideo: boolean; audioOnly: boolean; onLeave: (kind: 'leave' | 'end') => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const isDoctor = access.role === 'doctor';
  const other = isDoctor ? appt.patients?.full_name ?? '' : appt.doctors?.full_name ?? '';
  const [panel, setPanel] = useState<Panel>(() => (isDoctor && window.matchMedia?.('(min-width: 1024px)').matches ? 'symptoms' : null));
  const [unread, setUnread] = useState(0);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const started = useRef(false);
  const poorSince = useRef<number | null>(null);
  const suggested = useRef(false);
  const { phase, remote, media, quality } = call;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void call.join({ mic: true, camera: wantVideo && !audioOnly, audioOnly: !wantVideo || audioOnly }, loadPrefs());
  }, [call, wantVideo, audioOnly]);

  useEffect(() => {
    if (panel === 'chat') setUnread(0);
  }, [panel]);

  // sustained poor quality on video → suggest audio only (once)
  useEffect(() => {
    if (media.audioOnly || suggested.current || !wantVideo) return;
    if (quality === 'poor' || quality === 'lost') {
      poorSince.current ??= Date.now();
      if (Date.now() - poorSince.current > 15_000) {
        suggested.current = true;
        toast.warning(t('consult.call.poorSuggest'), { action: { label: t('consult.audioOnly'), onClick: () => void call.setAudioOnly(true) }, duration: 15_000 });
      }
    } else poorSince.current = null;
  }, [quality, media.audioOnly, wantVideo, call, t]);

  const failedFinal = phase === 'failed' && !call.retryPending;
  const showRemoteOverlay = !call.embedsUi && (phase === 'connected' || phase === 'reconnecting') && (!remote.present || !remote.video);
  const errKey = (code: string | null) => (code && i18n.exists(`consult.err.${code}`) ? `consult.err.${code}` : 'consult.err.generic');

  return (
    <div className="fixed inset-0 z-40 flex bg-neutral-950 text-white">
      <main id="main" className="relative flex min-w-0 flex-1 flex-col">
        <header className="z-10 flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent px-4 py-3">
          <div className="min-w-0">
            <p className="truncate font-semibold">{other}</p>
            <p className="flex items-center gap-2 text-xs text-white/70">
              {phase === 'connected' ? <Elapsed since={call.connectedAt} /> : <span>{t(`consult.phase.${phase}`)}</span>}
              <span aria-hidden>·</span><span>{t('consult.call.until', { time: formatTime(access.closes_at, i18n.language) })}</span>
            </p>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <NotRecorded className="hidden text-white/70 sm:inline-flex" />
            {call.provider === 'livekit' && <QualityIndicator quality={quality} light />}
          </div>
        </header>

        <div className="absolute left-4 top-16 z-20 max-w-[calc(100%-2rem)]"><RecordingPanel appointmentId={id} role={access.role} call={call} /></div>

        <div className="absolute inset-0">
          <div ref={call.setRemoteEl} className="flex h-full w-full items-center justify-center [&>iframe]:h-full [&>iframe]:w-full" data-ref="remote" />
          {showRemoteOverlay && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-neutral-950 p-6 text-center">
              <PersonAvatar name={other} src={isDoctor ? null : appt.doctors?.photo_url} className="h-24 w-24 text-2xl" />
              <p className="text-lg font-semibold">{other}</p>
              <p className="text-sm text-white/70" data-ref="remote-status">
                {!remote.present ? t(isDoctor ? 'consult.call.waitingPatient' : 'consult.call.waitingDoctor') : media.audioOnly ? t('consult.call.audioOnlyOn') : t('consult.call.cameraOff')}
              </p>
              {remote.present && !remote.audio && <p className="text-xs text-white/60">{t('consult.call.remoteMuted')}</p>}
            </div>
          )}
          {remote.present && !remote.audio && !showRemoteOverlay && !call.embedsUi && (
            <span className="absolute left-4 top-20 rounded-full bg-black/60 px-3 py-1 text-xs">{t('consult.call.remoteMuted')}</span>
          )}
        </div>

        {!call.embedsUi && (
          <video ref={call.setLocalEl} autoPlay playsInline muted aria-label={t('consult.call.selfView')}
            className={cn('absolute bottom-24 right-4 z-10 w-28 -scale-x-100 rounded-xl border border-white/20 bg-neutral-800 object-cover shadow-lg sm:w-44', (!media.camera || media.audioOnly) && 'hidden')} />
        )}

        {(phase === 'reconnecting' || (phase === 'failed' && call.retryPending)) && <ReconnectBanner attempt={call.retryPending ? call.retries : 0} max={call.maxRetries} />}
        {phase === 'joining' && !call.retries && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-neutral-950/80" role="status">
            <Loader2 className="h-10 w-10 animate-spin" aria-hidden /><p>{t('consult.call.connecting')}</p>
          </div>
        )}
        {failedFinal && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-neutral-950/90 p-4" role="alertdialog" aria-labelledby="lost-title">
            <div className="w-full max-w-sm space-y-3 text-center">
              <WifiOff className="mx-auto h-10 w-10 text-warning" aria-hidden />
              <h2 id="lost-title" className="text-lg font-semibold">{t('consult.call.lostTitle')}</h2>
              <p className="text-sm text-white/80">{t(errKey(call.error))}</p>
              <div className="grid gap-2">
                <Button onClick={() => void call.reconnect()} data-ref="reconnect"><RefreshCw aria-hidden />{t('consult.call.reconnect')}</Button>
                {wantVideo && !media.audioOnly && <Button variant="secondary" onClick={() => { void call.setAudioOnly(true); void call.reconnect(); }}><Volume2 aria-hidden />{t('consult.call.reconnectAudio')}</Button>}
                <Button variant="ghost" className="text-white hover:bg-white/10 hover:text-white" onClick={() => setReportOpen(true)}>{t('consult.call.report')}</Button>
                <Button variant="ghost" className="text-white hover:bg-white/10 hover:text-white" onClick={() => void onLeave('leave')}>{t('consult.call.leave')}</Button>
              </div>
              <p className="text-xs text-white/60">{t(isDoctor ? 'consult.call.lostDoctorHint' : 'consult.call.lostPatientHint')}</p>
            </div>
          </div>
        )}

        <nav aria-label={t('consult.call.controls')} className="z-10 mt-auto flex items-center justify-center gap-2 bg-gradient-to-t from-black/80 to-transparent px-2 pb-[max(1rem,env(safe-area-inset-bottom))] pt-6 sm:gap-3">
          <ControlButton on={media.mic} onClick={() => void call.setMic(!media.mic)} label={t(media.mic ? 'consult.ctl.mute' : 'consult.ctl.unmute')} iconOn={icons.mic} iconOff={icons.micOff} />
          {wantVideo && <ControlButton on={media.camera && !media.audioOnly} disabled={media.audioOnly} onClick={() => void call.setCamera(!media.camera)} label={t(media.camera ? 'consult.ctl.camOff' : 'consult.ctl.camOn')} iconOn={icons.cam} iconOff={icons.camOff} />}
          {wantVideo && <ControlButton on={!media.audioOnly} onClick={() => void call.setAudioOnly(!media.audioOnly)} label={t(media.audioOnly ? 'consult.ctl.videoBack' : 'consult.ctl.audioOnly')} iconOn={icons.audioOnly} />}
          <ControlButton on={panel !== 'chat'} onClick={() => setPanel(panel === 'chat' ? null : 'chat')} label={t('consult.ctl.chat')} iconOn={icons.chat} badge={unread} />
          {isDoctor && <ControlButton on={!panel || panel === 'chat'} onClick={() => setPanel(panel && panel !== 'chat' ? null : 'symptoms')} label={t('consult.ctl.panel')} iconOn={<ClipboardList className="h-5 w-5" aria-hidden />} />}
          <ControlButton danger on onClick={() => (isDoctor ? setConfirmEnd(true) : void onLeave('leave'))} label={t(isDoctor ? 'consult.ctl.end' : 'consult.ctl.leave')} iconOn={icons.hangup} />
        </nav>
      </main>

      <aside className={cn('absolute inset-0 z-30 flex flex-col bg-card text-card-foreground lg:static lg:w-[400px] lg:border-l', !panel && 'hidden')} aria-label={t('consult.panel.label')}>
        <div className="flex items-center gap-1 border-b p-2">
          {isDoctor && (
            <div role="tablist" aria-label={t('consult.panel.label')} className="grid flex-1 grid-cols-5 gap-1">
              {([['symptoms', Stethoscope], ['docs', FileText], ['notes', NotebookPen], ['rx', Pill], ['chat', MessageSquare]] as const).map(([key, Icon]) => (
                <button key={key} role="tab" aria-selected={panel === key} onClick={() => setPanel(key)}
                  className={cn('flex min-h-11 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1 text-xs font-medium', panel === key ? 'bg-primary text-primary-foreground' : 'hover:bg-accent')}>
                  <Icon className="h-4 w-4" aria-hidden /><span className="max-w-full truncate">{t(`consult.panel.${key}`)}</span>
                </button>
              ))}
            </div>
          )}
          {!isDoctor && <h2 className="flex-1 px-2 font-semibold">{t('consult.chat.title')}</h2>}
          <Button variant="ghost" size="icon" onClick={() => setPanel(null)} aria-label={t('common.close')}><X className="h-5 w-5" /></Button>
        </div>
        <div className="min-h-0 flex-1">
          {/* chat stays mounted so unread counts and history survive tab switches */}
          <div className={cn('h-full', panel !== 'chat' && 'hidden')}>
            <ChatPanel appointmentId={id} patientId={appt.patient_id} enabled={access.can_join} onIncoming={(fromOther) => fromOther && panel !== 'chat' && setUnread((n) => n + 1)} />
          </div>
          {isDoctor && panel === 'symptoms' && <div className="h-full overflow-y-auto p-4"><DoctorSymptoms id={id} /></div>}
          {isDoctor && panel === 'docs' && <div className="h-full overflow-y-auto p-4"><DoctorDocs id={id} /></div>}
          {isDoctor && <div className={cn('h-full overflow-y-auto p-4', panel !== 'notes' && 'hidden')}><NotesEditor appointmentId={id} compact /></div>}
          {isDoctor && panel === 'rx' && <div className="h-full overflow-y-auto p-4"><RxBuilder appointmentId={id} compact /></div>}
        </div>
      </aside>

      <NoteDialog open={reportOpen} onOpenChange={setReportOpen} title={t('consult.call.report')} description={t('consult.call.reportBody')} confirm={t('consult.call.reportSend')} required
        onConfirm={(note) => { void call.reportProblem(problemCode(note)); setReportOpen(false); toast.success(t('consult.call.reported')); }} />
      {confirmEnd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="alertdialog" aria-labelledby="end-title">
          <div className="w-full max-w-sm space-y-3 rounded-2xl bg-card p-5 text-card-foreground">
            <h2 id="end-title" className="text-lg font-semibold">{t('consult.end.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('consult.end.body')}</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmEnd(false)}>{t('common.cancel')}</Button>
              <Button variant="destructive" onClick={() => { setConfirmEnd(false); void onLeave('end'); }} data-ref="end-confirm"><PhoneOff aria-hidden />{t('consult.ctl.end')}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Free-text problem reports are reduced to a category: call logs never hold free text. */
function problemCode(note: string): string {
  const n = note.toLowerCase();
  if (/hear|audio|sound|voice|കേൾ/.test(n)) return 'reported_no_audio';
  if (/video|camera|see|frozen|freeze|കാണ/.test(n)) return 'reported_no_video';
  if (/connect|network|internet|drop|slow/.test(n)) return 'reported_network';
  return 'reported_other';
}

function DoctorSymptoms({ id }: { id: string }) {
  const a = useDoctorAppointment(id);
  return a.data ? <SymptomsView sym={a.data.appointment_symptoms} compact /> : <Loader2 className="h-5 w-5 animate-spin" />;
}

function DoctorDocs({ id }: { id: string }) {
  const a = useDoctorAppointment(id);
  return a.data ? <DocumentList docs={a.data.documents} /> : <Loader2 className="h-5 w-5 animate-spin" />;
}

// ---------------------------------------------------------------- after the call
function PatientAfter({ access, appt, onRejoin }: { access: ConsultAccess; appt: ConsultAppointment; onRejoin: () => void }) {
  const { t } = useTranslation();
  const active = ['confirmed', 'in_progress'].includes(access.status);
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-4 p-6 text-center">
          <CheckCircle2 className="mx-auto h-12 w-12 text-success" aria-hidden />
          <h1 className="text-xl font-semibold">{t(active ? 'consult.after.left' : `consult.after.status.${access.status}`, { defaultValue: t('consult.after.ended') })}</h1>
          <p className="text-sm text-muted-foreground">{t(active ? 'consult.after.leftBody' : access.status === 'cancelled' ? 'consult.after.cancelledBody' : 'consult.after.doneBody', { doctor: appt.doctors?.full_name })}</p>
          <div className="grid gap-2">
            {active && access.can_join && <Button onClick={onRejoin} data-ref="rejoin"><RefreshCw aria-hidden />{t('consult.after.rejoin')}</Button>}
            <Button variant={active ? 'outline' : 'default'} asChild><Link to="/p/appointments">{t('consult.after.toAppointments')}</Link></Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DoctorAfter({ id, access, appt, onRejoin }: { id: string; access: ConsultAccess; appt: ConsultAppointment; onRejoin: () => void }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const outcome = useRecordOutcome();
  const errText = useDoctorError();
  const [dlg, setDlg] = useState<null | 'technical' | 'noshow'>(null);
  const active = ['confirmed', 'in_progress'].includes(access.status);
  const graceEnds = new Date(access.start_at).getTime() + access.patient_grace_minutes * 60_000;
  const record = (o: 'completed' | 'patient_no_show' | 'technical_failure', note?: string) =>
    outcome.mutate({ id, outcome: o, note }, {
      onSuccess: () => { toast.success(t('doctor.appt.recorded')); navigate(`/d/appointments/${id}`, { replace: true }); },
      onError: (e) => toast.error(errText(e)),
    });
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader><CardTitle>{t('consult.after.doctorTitle')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">{appt.patients?.full_name} · {appt.ref_code}</p>
          {active ? (
            <>
              <Button block loading={outcome.isPending} onClick={() => record('completed')} data-ref="outcome-completed"><CheckCircle2 aria-hidden />{t('doctor.appt.completed')}</Button>
              <Button block variant="outline" disabled={Date.now() < graceEnds || !!access.patient_joined_at} onClick={() => setDlg('noshow')}><UserX aria-hidden />{t('doctor.appt.noShow')}</Button>
              <Button block variant="outline" onClick={() => setDlg('technical')} data-ref="outcome-technical"><WifiOff aria-hidden />{t('doctor.appt.technical')}</Button>
              {access.can_join && <Button block variant="ghost" onClick={onRejoin} data-ref="rejoin"><RefreshCw aria-hidden />{t('consult.after.rejoin')}</Button>}
              <p className="text-xs text-muted-foreground">{t('consult.after.doctorHint', { time: formatTime(access.closes_at, i18n.language) })}</p>
            </>
          ) : (
            <p className="font-medium">{t(`doctor.status.${access.status}`)}</p>
          )}
          <Button block variant="secondary" asChild><Link to={`/d/appointments/${id}/write`} data-ref="after-write"><NotebookPen aria-hidden />{t('clinical.page.open')}</Link></Button>
          <Button block variant="link" asChild><Link to={`/d/appointments/${id}`}>{t('consult.after.toDetail')}</Link></Button>
        </CardContent>
      </Card>
      <NoteDialog open={dlg === 'technical'} onOpenChange={(o) => !o && setDlg(null)} title={t('doctor.appt.technicalTitle')} description={t('doctor.appt.technicalBody')} confirm={t('doctor.appt.technical')} required busy={outcome.isPending}
        onConfirm={(note) => record('technical_failure', note)} />
      <NoteDialog open={dlg === 'noshow'} onOpenChange={(o) => !o && setDlg(null)} title={t('doctor.appt.noShowTitle')} description={t('doctor.appt.noShowBody')} confirm={t('doctor.appt.noShow')} busy={outcome.isPending}
        onConfirm={(note) => record('patient_no_show', note)} />
    </div>
  );
}
