import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { JoinLink } from '@/features/consult/JoinLink';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, Clock, Download, FileText, Gift, Hourglass, Phone, ShieldCheck, Video } from 'lucide-react';
import { formatDateLong, formatTime } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { CardSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { rpcErrorCode } from '@/lib/supabase';
import { FunctionError } from '@/lib/functions';
import { CheckoutCancelled, CheckoutFailed, downloadReceipt, payForAppointment } from '@/services/payments';
import { cn } from '@/lib/utils';
import { confirmFreeBooking, qk, releaseHold, useAppointment, useSettings } from '../api';
import { useBookingDraft } from '../BookingDraft';
import { PersonAvatar, rupees, Steps, StickyBar, useRpcErrorText } from '../components/common';
import { mmss } from '../slots';
import { useHoldCountdown } from '../useHoldCountdown';

/** Step 3: review with the live 10-minute hold countdown. The hold is released when it runs out. */
export function ReviewPage() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const nav = useNavigate();
  const qc = useQueryClient();
  const errText = useRpcErrorText();
  const appt = useAppointment(id);
  const settings = useSettings();
  const { draft, update, clear } = useBookingDraft();
  const [busy, setBusy] = useState(false);
  const [refundPending, setRefundPending] = useState(false);
  const [announce, setAnnounce] = useState('');
  const doctorId = appt.data?.doctor_id;

  const { phase, secondsLeft, markConfirmed } = useHoldCountdown(id, () => {
    // client timer hit 0: release right away (server also expires lapsed holds on its own)
    void releaseHold(id).finally(() => {
      if (doctorId) void qc.invalidateQueries({ queryKey: qk.slots(doctorId) });
      void qc.invalidateQueries({ queryKey: qk.appointment(id) });
    });
    update({ heldAppointmentId: undefined });
    setAnnounce(t('patient.review.expiredTitle'));
  });

  // screen-reader + toast warnings at 5, 2 and 1 minute(s)
  const warned = useRef(new Set<number>());
  useEffect(() => {
    if (phase !== 'active') return;
    for (const m of [5, 2, 1]) {
      if (secondsLeft <= m * 60 && secondsLeft > m * 60 - 5 && !warned.current.has(m)) {
        warned.current.add(m);
        setAnnounce(t('patient.review.minutesLeft', { count: m }));
        if (m <= 2) toast.warning(t('patient.review.minutesLeft', { count: m }));
      }
    }
  }, [secondsLeft, phase, t]);

  const totalSec = (settings.data?.slot_hold_minutes ?? 10) * 60;
  const a = appt.data;
  const changeSlot = async () => {
    await releaseHold(id).catch(() => undefined);
    update({ heldAppointmentId: undefined });
    if (a) void qc.invalidateQueries({ queryKey: qk.slots(a.doctor_id) });
    nav(a ? `/p/doctors/${a.doctor_id}?patient=${a.patient_id}` : '/p/doctors');
  };

  const confirm = async () => {
    setBusy(true);
    try {
      await confirmFreeBooking(id);
      markConfirmed();
      clear();
      void qc.invalidateQueries({ queryKey: qk.upcoming });
      void qc.invalidateQueries({ queryKey: qk.followUps });
      void qc.invalidateQueries({ queryKey: qk.appointment(id) });
    } catch (e) {
      toast.error(errText(rpcErrorCode(e)));
    } finally {
      setBusy(false);
    }
  };

  const pay = async () => {
    setBusy(true);
    try {
      const r = await payForAppointment(id, { description: t('pay.description'), themeColor: '#0F766E', language: lang === 'ml' ? 'ml' : 'en' });
      if (r.result === 'refund_pending') setRefundPending(true);
      else {
        markConfirmed();
        clear();
        toast.success(t('pay.success'));
      }
      void qc.invalidateQueries({ queryKey: qk.upcoming });
      void qc.invalidateQueries({ queryKey: qk.appointment(id) });
    } catch (e) {
      if (e instanceof CheckoutCancelled) toast.info(t('pay.cancelled'));
      else if (e instanceof CheckoutFailed) toast.error(t('pay.failed'));
      else toast.error(errText(e instanceof FunctionError ? e.code : 'unknown'));
    } finally {
      setBusy(false);
    }
  };

  if (appt.isPending || phase === 'loading') return <div className="mx-auto max-w-2xl"><PageHeader title={t('patient.review.title')} /><CardSkeleton /><CardSkeleton className="mt-4" /></div>;
  if (!a || phase === 'gone') return <EmptyState art="calendar" title={t('patient.review.notFound')} action={<Button asChild><Link to="/p/doctors">{t('patient.home.findDoctor')}</Link></Button>} />;

  const live = <div className="sr-only" aria-live="assertive">{announce}</div>;

  const paid = a.payments.find((p) => p.receipt_no);

  if (refundPending)
    return (
      <div className="mx-auto max-w-lg">
        <EmptyState art="calendar" title={t('pay.lateTitle')} body={t('pay.lateBody', { amount: rupees(a.fee_amount, lang) })}
          action={<Button size="lg" onClick={() => nav(`/p/doctors/${a.doctor_id}?patient=${a.patient_id}`)}>{t('patient.review.pickAnother')}</Button>} />
      </div>
    );

  if (phase === 'confirmed' || a.status === 'confirmed')
    return (
      <div className="mx-auto max-w-lg py-6 text-center">
        {live}
        <CheckCircle2 className="mx-auto h-16 w-16 text-success" aria-hidden />
        <h1 className="mt-4 text-2xl font-extrabold">{t('patient.review.confirmedTitle')}</h1>
        <p className="mt-1 text-muted-foreground">{t('patient.review.confirmedBody', { doctor: a.doctors?.full_name, when: `${formatDateLong(a.start_at, lang)}, ${formatTime(a.start_at, lang)}` })}</p>
        <p className="mt-4 inline-block rounded-xl bg-muted px-4 py-2 font-mono text-lg font-bold tracking-wider">{a.ref_code}</p>
        <div className="mt-6 flex flex-col gap-2">
          <JoinLink appt={a} who="p" size="lg" />
          {paid && (
            <Button size="lg" variant="secondary" onClick={() => void downloadReceipt(paid.id).catch(() => toast.error(t('common.error')))}>
              <Download aria-hidden />{t('pay.receipt', { no: paid.receipt_no })}
            </Button>
          )}
          <Button asChild size="lg"><Link to="/p">{t('patient.review.goHome')}</Link></Button>
          <Button asChild variant="outline"><Link to="/p/appointments">{t('nav.appointments')}</Link></Button>
        </div>
      </div>
    );

  if (phase === 'expired' || a.status !== 'pending_payment')
    return (
      <div className="mx-auto max-w-lg">
        {live}
        <EmptyState art="calendar" title={t('patient.review.expiredTitle')} body={t('patient.review.expiredBody')}
          action={<Button size="lg" onClick={() => nav(`/p/doctors/${a.doctor_id}?patient=${a.patient_id}`)}>{t('patient.review.pickAnother')}</Button>} />
      </div>
    );

  const sym = a.appointment_symptoms;
  const urgent = secondsLeft <= 60;
  const low = secondsLeft <= 120;

  return (
    <div className="mx-auto max-w-2xl pb-28">
      {live}
      <PageHeader title={t('patient.review.title')} />
      <Steps current={3} />

      <div role="timer" aria-label={t('patient.review.heldFor', { time: mmss(secondsLeft) })}
        className={cn('sticky top-16 z-20 mb-4 rounded-lg border p-4 shadow-soft backdrop-blur', urgent ? 'border-destructive/40 bg-destructive-soft/95' : low ? 'border-highlight/60 bg-highlight-soft/95' : 'border-primary/30 bg-primary-soft/90')}>
        <div className="flex items-center gap-3">
          <Hourglass className={cn('h-6 w-6 shrink-0', urgent ? 'text-destructive' : low ? 'text-warning' : 'text-primary')} aria-hidden />
          <p className="min-w-0 flex-1 text-sm"><b>{t('patient.review.heldTitle')}</b><span className="block text-muted-foreground">{t('patient.review.heldBody')}</span></p>
          <span className={cn('font-mono text-2xl font-extrabold tabular-nums', urgent ? 'text-destructive' : low ? 'text-warning' : 'text-primary')} aria-hidden>{mmss(secondsLeft)}</span>
        </div>
        <Progress value={(secondsLeft / totalSec) * 100} className="mt-3 h-1.5" aria-hidden />
      </div>

      <div className="space-y-4">
        <Card>
          <CardContent className="flex gap-4 p-5">
            <PersonAvatar name={a.doctors?.full_name ?? ''} src={a.doctors?.photo_url} className="h-16 w-16" />
            <div className="min-w-0 flex-1">
              <p className="font-bold">{a.doctors?.full_name}</p>
              <p className="text-sm text-muted-foreground">{a.doctors?.qualification} · {t('patient.doctors.regShort', { no: a.doctors?.registration_no })}</p>
              <p className="text-sm">{lang === 'ml' ? a.departments?.name_ml : a.departments?.name} · {a.hospitals?.name}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge variant="outline">{a.mode === 'video' ? <Video className="h-3 w-3" aria-hidden /> : <Phone className="h-3 w-3" aria-hidden />}{t(`patient.mode.${a.mode}`)}</Badge>
                <Badge variant={a.is_free ? 'highlight' : 'neutral'}>{t(a.consult_type === 'follow_up' ? 'patient.review.followUp' : 'patient.review.first')}</Badge>
              </div>
            </div>
          </CardContent>
          <Separator />
          <CardContent className="grid gap-3 p-5 text-sm sm:grid-cols-2">
            <Row icon={<Clock className="h-4 w-4" aria-hidden />} label={t('patient.review.when')} value={`${formatDateLong(a.start_at, lang)}, ${formatTime(a.start_at, lang)} IST`} />
            <Row icon={<ShieldCheck className="h-4 w-4" aria-hidden />} label={t('patient.review.patient')} value={a.patients?.full_name ?? ''} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0"><CardTitle>{t('patient.review.yourDetails')}</CardTitle>
            <Button variant="link" size="sm" onClick={() => draft ? nav('/p/book/details') : void changeSlot()}>{t('patient.review.edit')}</Button>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {sym ? (
              <>
                <p><span className="text-muted-foreground">{t('patient.pre.bodyArea')}:</span> {sym.body_area ? t(`patient.area.${sym.body_area}`) : '—'} · <span className="text-muted-foreground">{t('patient.pre.duration')}:</span> {sym.duration ? t(`patient.duration.${sym.duration}`) : '—'} · <span className="text-muted-foreground">{t('patient.pre.severity')}:</span> {sym.severity}/10</p>
                {sym.symptoms.length > 0 && <div className="flex flex-wrap gap-1.5">{sym.symptoms.map((x) => <Badge key={x} variant="neutral">{t(`patient.symptom.${x}`)}</Badge>)}</div>}
                <p className="whitespace-pre-line rounded-xl bg-muted/60 p-3">{sym.description}</p>
                {Object.keys(sym.vitals ?? {}).length > 0 && (
                  <p className="text-muted-foreground">{Object.entries(sym.vitals).map(([k, v]) => `${t(`patient.vital.${k}`)} ${v}`).join(' · ')}</p>
                )}
              </>
            ) : <p className="text-muted-foreground">—</p>}
            <p className="flex items-center gap-1.5 pt-1"><FileText className="h-4 w-4 text-muted-foreground" aria-hidden />{t('patient.review.docs', { count: a.documents.length })}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t('patient.review.payment')}</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {a.is_free ? (
              <>
                <div className="flex justify-between"><span>{t('patient.review.followUp')}</span><span className="font-semibold text-warning">{t('patient.review.free')}</span></div>
                <p className="flex gap-1.5 rounded-xl bg-highlight-soft/70 p-3 text-xs"><Gift className="h-4 w-4 shrink-0 text-warning" aria-hidden />{t('patient.review.freeExplain')}</p>
              </>
            ) : (
              <div className="flex justify-between"><span>{t(a.consult_type === 'follow_up' ? 'patient.book.followUpFee' : 'patient.book.consultFee')}</span><span>{rupees(a.fee_amount, lang)}</span></div>
            )}
            <Separator />
            <div className="flex justify-between text-base font-bold"><span>{t('patient.review.total')}</span><span>{rupees(a.fee_amount, lang)}</span></div>
            {settings.data?.cancellation_tiers && (
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                {settings.data.cancellation_tiers.map((c) => (
                  <li key={c.min_hours_before}>{c.min_hours_before > 0 ? t('patient.review.refundTier', { percent: c.percent, hours: c.min_hours_before }) : t('patient.review.refundLate', { percent: c.percent })}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Button variant="ghost" block onClick={() => void changeSlot()}>{t('patient.review.changeSlot')}</Button>
      </div>

      <StickyBar>
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-bold">{a.is_free ? t('patient.review.free') : rupees(a.fee_amount, lang)}</p>
          <p className="truncate text-xs text-muted-foreground">{t('patient.review.payNote')}</p>
        </div>
        {a.is_free ? (
          <Button size="lg" loading={busy} onClick={() => void confirm()}>{t('patient.review.confirmFree')}</Button>
        ) : (
          <Button size="lg" loading={busy} onClick={() => void pay()}>{t('patient.review.pay', { amount: rupees(a.fee_amount, lang) })}</Button>
        )}
      </StickyBar>
    </div>
  );
}

function Row({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <div><p className="text-xs text-muted-foreground">{label}</p><p className="font-medium">{value}</p></div>
    </div>
  );
}
