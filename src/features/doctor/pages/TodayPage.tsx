import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CalendarClock, ChevronRight, Clock, Hourglass, Phone, Video } from 'lucide-react';
import { ageFromDob, formatDateLong, formatTime, istDateKey } from '@/domain/time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, ListSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { LiveBadge } from '@/components/feedback/LiveBadge';
import { useRealtime } from '@/lib/realtime';
import { cn } from '@/lib/utils';
import { dqk, useDoctorAppointments, useMyDoctor, useWithdrawReschedule, type DoctorAppt } from '../api';
import { ApptStatus, useClinicSettings, useDoctorError, useNow } from '../components';
import { JoinLink } from '@/features/consult/JoinLink';

const ACTIVE = ['confirmed', 'in_progress'];

/** Doctor's day: what's next, the schedule, proposals waiting for patients – updated live. */
export function TodayPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const me = useMyDoctor();
  const today = istDateKey();
  const appts = useDoctorAppointments(today, today, me.data?.id);
  const withdraw = useWithdrawReschedule();
  const errText = useDoctorError();
  const now = useNow(15_000);

  const live = useRealtime(
    'doctor-today',
    [{ table: 'appointments', filter: `doctor_id=eq.${me.data?.id}` }, { table: 'reschedule_requests' }],
    [dqk.appts],
    (p) => {
      const row = p.new as { status?: string; ref_code?: string };
      if (p.table === 'reschedule_requests' && row.status && row.status !== 'pending') toast.info(t(`doctor.today.response.${row.status}`, { defaultValue: t('doctor.today.updated') }));
      if (p.table === 'appointments' && p.eventType === 'UPDATE' && row.status === 'cancelled') toast.warning(t('doctor.today.cancelledToast', { ref: row.ref_code }));
    },
    !!me.data,
  );

  const list = useMemo(() => (appts.data ?? []).filter((a) => a.status !== 'rescheduled'), [appts.data]);
  const stats = useMemo(() => ({
    total: list.filter((a) => a.status !== 'cancelled').length,
    done: list.filter((a) => a.status === 'completed').length,
    left: list.filter((a) => ACTIVE.includes(a.status) && new Date(a.end_at).getTime() > now).length,
    missed: list.filter((a) => a.status === 'no_show' || a.status === 'cancelled').length,
  }), [list, now]);
  const next = list.find((a) => ACTIVE.includes(a.status) && new Date(a.end_at).getTime() > now);
  const pending = list.filter((a) => a.reschedule_requests.some((r) => r.status === 'pending'));
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(now));

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm text-muted-foreground">{t(`patient.home.greeting.${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}`)} · {formatDateLong(new Date(now).toISOString(), lang)}</p>
          <h1 className="text-2xl font-extrabold tracking-tight">{me.data?.full_name ?? t('nav.today')}</h1>
        </div>
        <LiveBadge state={live} />
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {(['total', 'done', 'left', 'missed'] as const).map((k) => (
          <Card key={k}><CardContent className="p-4"><p className="text-xs font-medium text-muted-foreground">{t(`doctor.today.stat.${k}`)}</p><p className="mt-1 text-2xl font-extrabold tabular-nums">{stats[k]}</p></CardContent></Card>
        ))}
      </div>

      {appts.isPending || me.isPending ? <ListSkeleton rows={3} /> : appts.isError || me.isError ? <ErrorState onRetry={() => void appts.refetch()} /> : (
        <>
          {next && <NextUp a={next} now={now} />}

          {pending.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><Hourglass className="h-5 w-5 text-warning" aria-hidden />{t('doctor.today.awaiting')}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {pending.map((a) => {
                  const r = a.reschedule_requests.find((x) => x.status === 'pending')!;
                  return (
                    <div key={r.id} className="flex flex-wrap items-center gap-3 rounded-xl border p-3 text-sm">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{a.patients?.full_name} · {formatTime(a.start_at, lang)} → {r.proposed_start_at && formatTime(r.proposed_start_at, lang)}</p>
                        <p className="text-xs text-muted-foreground">{t('doctor.today.answerBy', { time: r.respond_by ? formatTime(r.respond_by, lang) : '—' })}</p>
                      </div>
                      <Button variant="ghost" size="sm" disabled={withdraw.isPending} onClick={() => withdraw.mutate(r.id, { onSuccess: () => toast.success(t('doctor.today.withdrawn')), onError: (e) => toast.error(errText(e)) })}>{t('doctor.today.withdraw')}</Button>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          <section aria-labelledby="sched-h">
            <div className="mb-2 flex items-center justify-between">
              <h2 id="sched-h" className="text-lg font-bold">{t('doctor.today.schedule')}</h2>
              <Link to="/d/calendar" className="text-sm font-semibold text-primary">{t('nav.calendar')}</Link>
            </div>
            {list.length === 0 ? (
              <Card><EmptyState art="calendar" title={t('doctor.today.none')} body={t('doctor.today.noneBody')} action={<Button variant="outline" asChild><Link to="/d/availability">{t('doctor.avail.title')}</Link></Button>} /></Card>
            ) : (
              <Card>
                <ol className="divide-y">
                  {list.map((a) => <ScheduleRow key={a.id} a={a} now={now} isNext={a.id === next?.id} />)}
                </ol>
              </Card>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function NextUp({ a, now }: { a: DoctorAppt; now: number }) {
  const { t, i18n } = useTranslation();
  const settings = useClinicSettings();
  const mins = Math.round((new Date(a.start_at).getTime() - now) / 60_000);
  return (
    <Card className="border-primary/40 bg-primary-soft/40">
      <CardContent className="flex flex-wrap items-center gap-4 p-5">
        <div className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-2xl bg-primary text-primary-foreground">
          <Clock className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-primary">{t('doctor.today.next')}</p>
          <p className="text-lg font-bold">{a.patients?.full_name} <span className="text-sm font-normal text-muted-foreground">· {a.patients && t('patient.age', { count: ageFromDob(a.patients.date_of_birth) })}</span></p>
          <p className="text-sm">{formatTime(a.start_at, i18n.language)} · {t(`patient.mode.${a.mode}`)} · <b>{mins > 0 ? t('doctor.today.inMin', { count: mins }) : t('doctor.today.now')}</b></p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto">
          <JoinLink appt={a} who="d" size="lg" joinMin={settings.data?.join_window_minutes} />
          <Button asChild size="lg" variant="outline"><Link to={`/d/appointments/${a.id}`}>{t('doctor.today.open')}</Link></Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ScheduleRow({ a, now, isNext }: { a: DoctorAppt; now: number; isNext: boolean }) {
  const { t, i18n } = useTranslation();
  const past = new Date(a.end_at).getTime() < now;
  return (
    <li>
      <Link to={`/d/appointments/${a.id}`} className={cn('flex items-center gap-3 p-4 hover:bg-accent', isNext && 'bg-primary-soft/30', past && ACTIVE.includes(a.status) && 'bg-warning-soft/40')}>
        <div className="w-16 shrink-0 text-sm font-semibold tabular-nums">{formatTime(a.start_at, i18n.language)}</div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{a.patients?.full_name}</p>
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {a.mode === 'video' ? <Video className="h-3.5 w-3.5" aria-hidden /> : <Phone className="h-3.5 w-3.5" aria-hidden />}{t(`patient.mode.${a.mode}`)}
            · {t(a.consult_type === 'follow_up' ? 'patient.review.followUp' : 'patient.review.first')}
            {a.is_free && <Badge variant="highlight" className="px-1.5 py-0 text-[10px]">{t('patient.review.free')}</Badge>}
            {a.rescheduled_from_id && <span className="inline-flex items-center gap-0.5"><CalendarClock className="h-3 w-3" aria-hidden />{t('doctor.today.moved')}</span>}
          </p>
          <div className="mt-1.5 sm:hidden"><ApptStatus a={a} /></div>
        </div>
        <div className="hidden sm:block"><ApptStatus a={a} /></div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
    </li>
  );
}
