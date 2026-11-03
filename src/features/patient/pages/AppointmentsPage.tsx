import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertCircle, CalendarClock, CalendarPlus, Download, Phone, Undo2, Video } from 'lucide-react';
import { formatDateTime, formatTime } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorState, ListSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { LiveBadge } from '@/components/feedback/LiveBadge';
import { useRealtime } from '@/lib/realtime';
import { rpcErrorCode } from '@/lib/supabase';
import { downloadReceipt } from '@/services/payments';
import { JoinLink } from '@/features/consult/JoinLink';
import { myApptsKey, needsFallbackChoice, pendingProposal, qk, resolveDoctorCancellation, respondReschedule, useMyAppointments, useSettings, type MyAppointment } from '../api';
import { PersonAvatar, rupees, useRpcErrorText } from '../components/common';

/** Patient bookings, with live cards for anything that needs the patient's answer. */
export function AppointmentsPage() {
  const { t } = useTranslation();
  const appts = useMyAppointments();
  const live = useRealtime('patient-appts', [{ table: 'appointments' }, { table: 'reschedule_requests' }], [myApptsKey, qk.upcoming],
    (p) => {
      const row = p.new as { status?: string };
      if (p.table === 'reschedule_requests' && p.eventType === 'INSERT' && row.status === 'pending') toast.info(t('patient.appts.newProposal'));
    });
  const all = appts.data ?? [];
  const now = Date.now();
  const actions = all.filter((a) => pendingProposal(a) || needsFallbackChoice(a));
  const upcoming = all.filter((a) => ['confirmed', 'in_progress'].includes(a.status) && new Date(a.end_at).getTime() > now).reverse();
  const past = all.filter((a) => !upcoming.includes(a) && !actions.includes(a));

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title={t('nav.appointments')} actions={<LiveBadge state={live} />} />
      {appts.isPending ? <ListSkeleton rows={3} /> : appts.isError ? <ErrorState onRetry={() => void appts.refetch()} /> : (
        <>
          {actions.length > 0 && (
            <section aria-labelledby="act-h" className="space-y-3">
              <h2 id="act-h" className="flex items-center gap-2 text-lg font-bold"><AlertCircle className="h-5 w-5 text-warning" aria-hidden />{t('patient.appts.needsAnswer')}</h2>
              {actions.map((a) => (pendingProposal(a) ? <ProposalCard key={a.id} a={a} /> : <FallbackCard key={a.id} a={a} />))}
            </section>
          )}
          <Tabs defaultValue="upcoming">
            <TabsList>
              <TabsTrigger value="upcoming">{t('styleGuide.upcoming')} ({upcoming.length})</TabsTrigger>
              <TabsTrigger value="past">{t('styleGuide.past')} ({past.length})</TabsTrigger>
            </TabsList>
            <TabsContent value="upcoming" className="space-y-3">
              {upcoming.length === 0 ? <Card><EmptyState title={t('styleGuide.emptyTitle')} body={t('styleGuide.emptyBody')} action={<Button asChild><Link to="/p/doctors">{t('patient.home.findDoctor')}</Link></Button>} /></Card>
                : upcoming.map((a) => <ApptCard key={a.id} a={a} />)}
            </TabsContent>
            <TabsContent value="past" className="space-y-3">
              {past.length === 0 ? <Card><EmptyState art="folder" title={t('patient.appts.noPast')} /></Card> : past.map((a) => <ApptCard key={a.id} a={a} />)}
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

function ApptCard({ a }: { a: MyAppointment }) {
  const { t, i18n } = useTranslation();
  const settings = useSettings();
  const lang = i18n.language;
  const paid = a.payments.find((p) => p.receipt_no);
  const refunded = a.refunds.filter((r) => r.status === 'processed').reduce((s, r) => s + r.amount, 0);
  const inFlight = a.refunds.filter((r) => r.status === 'initiated').reduce((s, r) => s + r.amount, 0);
  return (
    <Card>
      <CardContent className="flex gap-3 p-4">
        <PersonAvatar name={a.doctors?.full_name ?? ''} src={a.doctors?.photo_url} className="h-12 w-12" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="truncate font-semibold">{a.doctors?.full_name}</p>
          <p className="truncate text-muted-foreground">{lang === 'ml' ? a.departments?.name_ml : a.departments?.name} · {t('patient.forName', { name: a.patients?.full_name })}</p>
          <p className="mt-1 font-medium">{formatDateTime(a.start_at, lang)}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge variant={a.status === 'confirmed' ? 'success' : a.status === 'cancelled' ? 'destructive' : 'neutral'}>{t(a.status === 'cancelled' && a.outcome ? `doctor.outcome.${a.outcome}` : `doctor.status.${a.status}`)}</Badge>
            <Badge variant="outline">{a.mode === 'video' ? <Video className="h-3 w-3" aria-hidden /> : <Phone className="h-3 w-3" aria-hidden />}{t(`patient.mode.${a.mode}`)}</Badge>
            {a.rescheduled_from_id && <Badge variant="neutral"><CalendarClock className="h-3 w-3" aria-hidden />{t('patient.appts.moved')}</Badge>}
            {refunded > 0 && <Badge variant="neutral">{t('patient.appts.refunded', { amount: rupees(refunded, lang) })}</Badge>}
            {inFlight > 0 && <Badge variant="warning">{t('patient.appts.refundInProgress', { amount: rupees(inFlight, lang) })}</Badge>}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t('patient.appts.ref', { ref: a.ref_code })}</p>
          <div className="mt-2"><JoinLink appt={a} who="p" joinMin={settings.data?.join_window_minutes} /></div>
        </div>
        {paid && (
          <Button variant="ghost" size="icon" aria-label={t('pay.receipt', { no: paid.receipt_no })} onClick={() => void downloadReceipt(paid.id).catch(() => toast.error(t('common.error')))}><Download className="h-4 w-4" /></Button>
        )}
      </CardContent>
    </Card>
  );
}

/** Doctor proposed another time today: accept, or decline and choose a free reschedule or a refund. */
function ProposalCard({ a }: { a: MyAppointment }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const nav = useNavigate();
  const qc = useQueryClient();
  const errText = useRpcErrorText();
  const r = pendingProposal(a)!;
  const [busy, setBusy] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const run = async (choice: 'accept' | 'refund') => {
    setBusy(choice);
    try {
      await respondReschedule(r.id, choice);
      toast.success(t(choice === 'accept' ? 'patient.appts.accepted' : 'patient.appts.refundChosen'));
      setDeclining(false);
      await qc.invalidateQueries({ queryKey: myApptsKey });
    } catch (e) {
      toast.error(errText(rpcErrorCode(e)));
      void qc.invalidateQueries({ queryKey: myApptsKey });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="border-highlight/60 bg-highlight-soft/50" data-testid="proposal-card" data-ref={a.ref_code}>
      <CardContent className="space-y-3 p-4 text-sm">
        <p className="font-semibold">{t('patient.appts.proposalTitle', { doctor: a.doctors?.full_name, from: formatTime(a.start_at, lang), to: r.proposed_start_at ? formatTime(r.proposed_start_at, lang) : '' })}</p>
        {r.reason && <p className="text-muted-foreground">“{r.reason}”</p>}
        <p className="text-xs text-muted-foreground">{t('patient.appts.answerBy', { time: r.respond_by ? formatTime(r.respond_by, lang) : '—' })}</p>
        <div className="flex flex-wrap gap-2">
          <Button loading={busy === 'accept'} disabled={!!busy} onClick={() => void run('accept')}>{t('patient.appts.accept', { time: r.proposed_start_at ? formatTime(r.proposed_start_at, lang) : '' })}</Button>
          <Button variant="outline" disabled={!!busy} onClick={() => setDeclining(true)}>{t('patient.appts.decline')}</Button>
        </div>
      </CardContent>
      <Dialog open={declining} onOpenChange={setDeclining}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader><DialogTitle>{t('patient.appts.declineTitle')}</DialogTitle><DialogDescription>{t('patient.appts.declineBody')}</DialogDescription></DialogHeader>
          <div className="grid gap-2">
            <Button variant="secondary" disabled={!!busy} onClick={() => nav(`/p/appointments/${a.id}/choose?req=${r.id}`)}><CalendarPlus aria-hidden />{t('patient.appts.pickOther')}</Button>
            <Button variant="outline" loading={busy === 'refund'} disabled={!!busy} onClick={() => void run('refund')}><Undo2 aria-hidden />{t('patient.appts.refundInstead', { amount: a.is_free ? t('patient.review.free') : rupees(a.fee_amount, lang) })}</Button>
          </div>
          <DialogFooter><Button variant="ghost" onClick={() => setDeclining(false)}>{t('common.cancel')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** Doctor cancelled / technical failure: free reschedule with the same doctor, or full refund. */
function FallbackCard({ a }: { a: MyAppointment }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const nav = useNavigate();
  const qc = useQueryClient();
  const errText = useRpcErrorText();
  const [busy, setBusy] = useState(false);
  const settings = useSettings();
  const refund = async () => {
    setBusy(true);
    try {
      await resolveDoctorCancellation(a.id, 'refund');
      toast.success(t('patient.appts.refundChosen'));
      await qc.invalidateQueries({ queryKey: myApptsKey });
    } catch (e) {
      toast.error(errText(rpcErrorCode(e)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="border-destructive/30 bg-destructive-soft/40" data-testid="fallback-card" data-ref={a.ref_code}>
      <CardContent className="space-y-3 p-4 text-sm">
        <p className="font-semibold">{t(`patient.appts.fallback.${a.outcome}`, { doctor: a.doctors?.full_name, when: formatDateTime(a.start_at, lang) })}</p>
        {/* neither side joined: rebooking is offered; the refund is there but only on request (never automatic) */}
        <p className="text-muted-foreground">{a.outcome === 'both_no_show' ? t('patient.appts.fallbackBodyBoth') : t('patient.appts.fallbackBody', { hours: settings.data?.doctor_no_show_auto_refund_hours ?? 24 })}</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => nav(`/p/appointments/${a.id}/choose`)}><CalendarPlus aria-hidden />{t('patient.appts.freeReschedule')}</Button>
          {!a.is_free && (
            <Button variant={a.outcome === 'both_no_show' ? 'ghost' : 'outline'} loading={busy} onClick={() => void refund()}>
              <Undo2 aria-hidden />{t(a.outcome === 'both_no_show' ? 'patient.appts.requestRefund' : 'patient.appts.fullRefund', { amount: rupees(a.fee_amount, lang) })}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
