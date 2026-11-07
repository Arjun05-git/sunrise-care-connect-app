import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AlertTriangle, ArrowRight, Ban, CalendarClock, CheckCircle2, History, NotebookPen, Phone, UserX, Video, WifiOff } from 'lucide-react';
import { ageFromDob, formatDateLong, formatTime, istDateKey } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { CardSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { LiveBadge } from '@/components/feedback/LiveBadge';
import { useRealtime } from '@/lib/realtime';
import { cn } from '@/lib/utils';
import { isBookable } from '@/features/patient/slots';
import { dqk, useDaySlots, useDoctorAppointment, useDoctorCancel, useMyDoctor, useProposeReschedule, useRecordOutcome, useWithdrawReschedule } from '../api';
import { ApptStatus, DocumentList, NoteDialog, SymptomsView, useClinicSettings, useDoctorError, useNow } from '../components';
import { JoinLink } from '@/features/consult/JoinLink';
import { CallLogCard } from '@/features/consult/CallLogCard';
import { RecordingsCard } from '@/features/consult/recording/RecordingsCard';

type Dlg = null | 'technical' | 'noshow' | 'reschedule' | 'cancel';

export function AppointmentPage() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const appt = useDoctorAppointment(id);
  const me = useMyDoctor();
  const settings = useClinicSettings();
  const outcome = useRecordOutcome();
  const withdraw = useWithdrawReschedule();
  const errText = useDoctorError();
  const now = useNow(15_000);
  const [dlg, setDlg] = useState<Dlg>(null);

  const live = useRealtime('doctor-appt', [{ table: 'appointments', filter: `id=eq.${id}` }, { table: 'reschedule_requests', filter: `appointment_id=eq.${id}` }],
    [dqk.appointment(id), dqk.appts, ['doctor', 'day-slots'], ['consult', 'summary', id]], undefined, !!id);

  if (appt.isPending) return <><PageHeader back title={t('doctor.appt.title')} /><CardSkeleton /><CardSkeleton className="mt-4" /></>;
  const a = appt.data;
  if (!a) return <><PageHeader back="/d" title={t('doctor.appt.title')} /><EmptyState art="search" title={t('doctor.appt.notFound')} /></>;
  const p = a.patients!;
  const sym = a.appointment_symptoms;
  const pending = a.reschedule_requests.find((r) => r.status === 'pending');
  const lastResponse = [...a.reschedule_requests].filter((r) => r.status !== 'pending').sort((x, y) => (y.responded_at ?? '').localeCompare(x.responded_at ?? ''))[0];
  const active = ['confirmed', 'in_progress'].includes(a.status);
  const start = new Date(a.start_at).getTime();
  const joinMs = (settings.data?.join_window_minutes ?? 10) * 60_000;
  const graceMs = (settings.data?.patient_grace_minutes ?? 10) * 60_000;
  const canComplete = active && now >= start - joinMs;
  const canNoShow = active && now >= start + graceMs;

  const done = (msg: string) => ({ onSuccess: () => { toast.success(msg); setDlg(null); }, onError: (e: unknown) => toast.error(errText(e)) });

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader back="/d" title={p.full_name} subtitle={`${a.ref_code} · ${formatDateLong(a.start_at, lang)}, ${formatTime(a.start_at, lang)}`} actions={<LiveBadge state={live} />} />

      {a.status === 'rescheduled' && a.rescheduled_to_id && (
        <Link to={`/d/appointments/${a.rescheduled_to_id}`} className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary-soft/50 p-4 text-sm font-medium">
          <CalendarClock className="h-5 w-5 text-primary" aria-hidden />{t('doctor.appt.movedTo')}<ArrowRight className="ml-auto h-4 w-4" aria-hidden />
        </Link>
      )}
      {lastResponse && !pending && a.status !== 'rescheduled' && (
        <p className="rounded-lg bg-muted p-3 text-sm">{t(`doctor.appt.response.${lastResponse.status}`, { defaultValue: '' })}</p>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px] [&>*]:min-w-0">
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-3 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <ApptStatus a={a} />
                <Badge variant="outline">{a.mode === 'video' ? <Video className="h-3 w-3" aria-hidden /> : <Phone className="h-3 w-3" aria-hidden />}{t(`patient.mode.${a.mode}`)}</Badge>
                <Badge variant="neutral">{t(a.consult_type === 'follow_up' ? 'patient.review.followUp' : 'patient.review.first')}</Badge>
                {a.is_free && <Badge variant="highlight">{t('patient.review.free')}</Badge>}
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
                <div><dt className="text-xs text-muted-foreground">{t('doctor.appt.age')}</dt><dd className="font-medium">{t('patient.age', { count: ageFromDob(p.date_of_birth) })}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{t('patient.f.gender')}</dt><dd className="font-medium">{t(`patient.gender.${p.gender}`)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{t('patient.f.bloodGroup')}</dt><dd className="font-medium">{p.blood_group ?? '—'}</dd></div>
                <div><dt className="text-xs text-muted-foreground">MRN</dt><dd className="font-medium">{p.his_mrn ?? '—'}</dd></div>
              </dl>
              {(p.allergies.length > 0 || sym?.allergies) && (
                <p role="note" className="flex gap-2 rounded-xl bg-destructive-soft p-3 text-sm text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /><span><b>{t('patient.f.allergies')}:</b> {[...new Set([...p.allergies, ...(sym?.allergies ? [sym.allergies] : [])])].join(', ')}</span>
                </p>
              )}
              <Button variant="link" className="px-0" asChild><Link to={`/d/patients/${p.id}`}><History aria-hidden />{t('doctor.appt.timeline')}</Link></Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t('doctor.appt.symptoms')}</CardTitle></CardHeader>
            <CardContent><SymptomsView sym={sym} /></CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t('doctor.appt.documents', { count: a.documents.length })}</CardTitle></CardHeader>
            <CardContent><DocumentList docs={a.documents} /></CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          {active && <JoinLink appt={a} who="d" size="lg" block joinMin={settings.data?.join_window_minutes} />}
          {['in_progress', 'completed'].includes(a.status) && (
            <Button asChild size="lg" block variant={a.status === 'completed' ? 'default' : 'outline'}><Link to={`/d/appointments/${a.id}/write`} data-ref="write-link"><NotebookPen aria-hidden />{t('clinical.page.open')}</Link></Button>
          )}
          {active && (
            <Card>
              <CardHeader><CardTitle>{t('doctor.appt.outcome')}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <Button block disabled={!canComplete || outcome.isPending} onClick={() => outcome.mutate({ id: a.id, outcome: 'completed' }, done(t('doctor.appt.markedDone')))}>
                  <CheckCircle2 aria-hidden />{t('doctor.appt.completed')}
                </Button>
                <Button block variant="outline" disabled={!canNoShow} onClick={() => setDlg('noshow')}><UserX aria-hidden />{t('doctor.appt.noShow')}</Button>
                <Button block variant="outline" disabled={!canComplete} onClick={() => setDlg('technical')}><WifiOff aria-hidden />{t('doctor.appt.technical')}</Button>
                {!canComplete && <p className="text-xs text-muted-foreground">{t('doctor.appt.outcomeFrom', { time: formatTime(new Date(start - joinMs).toISOString(), lang) })}</p>}
                {canComplete && !canNoShow && <p className="text-xs text-muted-foreground">{t('doctor.appt.noShowFrom', { time: formatTime(new Date(start + graceMs).toISOString(), lang), min: settings.data?.patient_grace_minutes ?? 10 })}</p>}
              </CardContent>
            </Card>
          )}

          {now >= start - joinMs && <CallLogCard id={a.id} />}
          <RecordingsCard appointmentId={a.id} />

          {a.status === 'confirmed' && start > now && (
            <Card>
              <CardHeader><CardTitle>{t('doctor.appt.change')}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {pending ? (
                  <div className="space-y-2 rounded-xl border border-highlight/60 bg-highlight-soft/50 p-3 text-sm">
                    <p className="font-semibold">{t('doctor.appt.proposed', { time: pending.proposed_start_at ? formatTime(pending.proposed_start_at, lang) : '' })}</p>
                    <p className="text-xs text-muted-foreground">{t('doctor.today.answerBy', { time: pending.respond_by ? formatTime(pending.respond_by, lang) : '—' })}</p>
                    <Button variant="outline" size="sm" disabled={withdraw.isPending} onClick={() => withdraw.mutate(pending.id, done(t('doctor.today.withdrawn')))}>{t('doctor.today.withdraw')}</Button>
                  </div>
                ) : (
                  <Button block variant="secondary" onClick={() => setDlg('reschedule')}><CalendarClock aria-hidden />{t('doctor.appt.reschedule')}</Button>
                )}
                <Button block variant="ghost" className="text-destructive" onClick={() => setDlg('cancel')}><Ban aria-hidden />{t('doctor.appt.cannotAttend')}</Button>
                <p className="text-xs text-muted-foreground">{t('doctor.appt.changeHint')}</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <NoteDialog open={dlg === 'technical'} onOpenChange={(o) => !o && setDlg(null)} title={t('doctor.appt.technicalTitle')} description={t('doctor.appt.technicalBody')} confirm={t('doctor.appt.technical')} required busy={outcome.isPending}
        onConfirm={(note) => outcome.mutate({ id: a.id, outcome: 'technical_failure', note }, done(t('doctor.appt.recorded')))} />
      <NoteDialog open={dlg === 'noshow'} onOpenChange={(o) => !o && setDlg(null)} title={t('doctor.appt.noShowTitle')} description={t('doctor.appt.noShowBody')} confirm={t('doctor.appt.noShow')} busy={outcome.isPending}
        onConfirm={(note) => outcome.mutate({ id: a.id, outcome: 'patient_no_show', note }, done(t('doctor.appt.recorded')))} />
      <CancelDialog open={dlg === 'cancel'} onOpenChange={(o) => !o && setDlg(null)} apptId={a.id} onDone={() => setDlg(null)} />
      {me.data && <RescheduleDialog open={dlg === 'reschedule'} onOpenChange={(o) => !o && setDlg(null)} doctorId={me.data.id} appt={a} onDone={() => setDlg(null)} />}
    </div>
  );
}

function CancelDialog({ open, onOpenChange, apptId, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; apptId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const cancel = useDoctorCancel();
  const errText = useDoctorError();
  return (
    <NoteDialog open={open} onOpenChange={onOpenChange} title={t('doctor.appt.cancelTitle')} description={t('doctor.appt.cancelBody')} confirm={t('doctor.appt.cannotAttend')} required busy={cancel.isPending}
      onConfirm={(reason) => cancel.mutate({ id: apptId, reason }, { onSuccess: () => { toast.success(t('doctor.appt.cancelled')); onDone(); }, onError: (e) => toast.error(errText(e)) })} />
  );
}

/** Same-day proposal: open slots that leave the patient ≥ 5 minutes to answer (deadline = 15 min before the earlier time). */
function RescheduleDialog({ open, onOpenChange, doctorId, appt, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; doctorId: string; appt: { id: string; start_at: string; slot_id: string }; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const day = istDateKey(appt.start_at);
  const slots = useDaySlots(open ? doctorId : undefined, day);
  const propose = useProposeReschedule();
  const errText = useDoctorError();
  const [slotId, setSlotId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const options = useMemo(() => {
    const now = Date.now();
    return (slots.data ?? []).filter((s) => s.id !== appt.slot_id && isBookable(s) &&
      Math.min(new Date(s.start_at).getTime(), new Date(appt.start_at).getTime()) - 15 * 60_000 > now + 5 * 60_000);
  }, [slots.data, appt]);
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { setSlotId(null); setReason(''); } }}>
      <DialogContent closeLabel={t('common.close')}>
        <DialogHeader><DialogTitle>{t('doctor.appt.rescheduleTitle')}</DialogTitle><DialogDescription>{t('doctor.appt.rescheduleBody')}</DialogDescription></DialogHeader>
        {slots.isPending ? <CardSkeleton /> : options.length === 0 ? <p className="text-sm text-muted-foreground">{t('doctor.appt.noSameDay')}</p> : (
          <div role="radiogroup" aria-label={t('doctor.appt.newTime')} className="grid max-h-56 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
            {options.map((s) => (
              <button key={s.id} type="button" role="radio" aria-checked={slotId === s.id} onClick={() => setSlotId(s.id)}
                className={cn('min-h-11 rounded-xl border text-sm font-medium', slotId === s.id ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent')}>
                {formatTime(s.start_at, i18n.language)}
              </button>
            ))}
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="resched-reason">{t('doctor.appt.reasonForPatient')}</Label>
          <Textarea id="resched-reason" rows={2} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('doctor.appt.reasonPh')} />
          <p className="text-xs text-muted-foreground">{t('doctor.appt.reasonHint')}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button disabled={!slotId || reason.trim().length < 5} loading={propose.isPending}
            onClick={() => propose.mutate({ id: appt.id, slotId: slotId!, reason: reason.trim() }, { onSuccess: () => { toast.success(t('doctor.appt.proposalSent')); onDone(); }, onError: (e) => toast.error(errText(e)) })}>
            {t('doctor.appt.sendProposal')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
