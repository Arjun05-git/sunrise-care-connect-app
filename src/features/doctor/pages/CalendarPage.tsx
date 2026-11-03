import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CalendarCog, ChevronLeft, ChevronRight, Plane } from 'lucide-react';
import { addDaysKey, formatDayNum, formatMonthShort, formatTime, formatWeekdayShort, istDateKey, istWeekday } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState, ListSkeleton } from '@/components/feedback/states';
import { LiveBadge } from '@/components/feedback/LiveBadge';
import { useRealtime } from '@/lib/realtime';
import { cn } from '@/lib/utils';
import { dqk, useAvailability, useDoctorAppointments, useMyDoctor, type DoctorAppt } from '../api';

const DOT: Record<string, string> = {
  confirmed: 'border-l-primary', in_progress: 'border-l-highlight', completed: 'border-l-success', no_show: 'border-l-warning', cancelled: 'border-l-destructive',
};

/** Week agenda (Mon–Sun, IST): bookings and leave; columns on desktop, stacked days on phones. */
export function CalendarPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const today = istDateKey();
  const monday = addDaysKey(today, -((istWeekday(new Date()) + 6) % 7));
  const [weekStart, setWeekStart] = useState(monday);
  const weekEnd = addDaysKey(weekStart, 6);
  const me = useMyDoctor();
  const appts = useDoctorAppointments(weekStart, weekEnd, me.data?.id);
  const avail = useAvailability(me.data?.id);
  const live = useRealtime('doctor-calendar', [{ table: 'appointments', filter: `doctor_id=eq.${me.data?.id}` }, { table: 'reschedule_requests' }], [dqk.appts], undefined, !!me.data);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDaysKey(weekStart, i)), [weekStart]);
  const byDay = useMemo(() => {
    const m = new Map<string, DoctorAppt[]>();
    for (const a of appts.data ?? []) if (a.status !== 'rescheduled') m.set(istDateKey(a.start_at), [...(m.get(istDateKey(a.start_at)) ?? []), a]);
    return m;
  }, [appts.data]);
  const leaveOn = (d: string) => avail.data?.rows.filter((r) => r.kind === 'block' && r.block_date_from! <= d && d <= r.block_date_to!) ?? [];
  const hasHours = (d: string) => avail.data?.rows.some((r) => r.kind === 'weekly' && r.weekday === istWeekday(`${d}T12:00:00+05:30`)) ?? true;
  const rangeLabel = `${formatDayNum(weekStart)} ${formatMonthShort(weekStart, lang)} – ${formatDayNum(weekEnd)} ${formatMonthShort(weekEnd, lang)}`;

  return (
    <div className="space-y-4">
      <PageHeader title={t('nav.calendar')} subtitle={rangeLabel} actions={<div className="flex items-center gap-2"><LiveBadge state={live} /><Button variant="outline" size="sm" asChild><Link to="/d/availability" aria-label={t('doctor.avail.title')}><CalendarCog aria-hidden /><span className="hidden sm:inline" aria-hidden>{t('doctor.avail.title')}</span></Link></Button></div>} />
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon" aria-label={t('doctor.cal.prev')} onClick={() => setWeekStart(addDaysKey(weekStart, -7))}><ChevronLeft className="h-4 w-4" /></Button>
        <Button variant="outline" size="sm" disabled={weekStart === monday} onClick={() => setWeekStart(monday)}>{t('doctor.cal.thisWeek')}</Button>
        <Button variant="outline" size="icon" aria-label={t('doctor.cal.next')} onClick={() => setWeekStart(addDaysKey(weekStart, 7))}><ChevronRight className="h-4 w-4" /></Button>
      </div>
      {appts.isPending || me.isPending ? <ListSkeleton rows={3} /> : appts.isError ? <ErrorState onRetry={() => void appts.refetch()} /> : (
        <div className="grid gap-3 lg:grid-cols-7">
          {days.map((d) => {
            const list = byDay.get(d) ?? [];
            const leave = leaveOn(d);
            return (
              <Card key={d} className={cn('min-w-0 p-3', d === today && 'ring-2 ring-primary', d < today && 'opacity-80')}>
                <h2 className="mb-2 flex items-baseline justify-between gap-1 lg:flex-col lg:items-start lg:gap-0">
                  <span className="whitespace-nowrap text-sm font-semibold">{d === today ? t('patient.today') : formatWeekdayShort(d, lang)} <span className="text-muted-foreground">{formatDayNum(d)} {formatMonthShort(d, lang)}</span></span>
                  <span className="text-xs text-muted-foreground">{t('doctor.cal.count', { count: list.filter((a) => a.status !== 'cancelled').length })}</span>
                </h2>
                {leave.map((l) => (
                  <p key={l.id} className="mb-1.5 flex items-center gap-1 rounded-lg bg-muted px-2 py-1 text-xs"><Plane className="h-3 w-3 shrink-0" aria-hidden />
                    {l.start_time.slice(0, 5) === '00:00' && l.end_time.slice(0, 5) >= '23:59' ? t('doctor.cal.leaveDay') : `${l.start_time.slice(0, 5)}–${l.end_time.slice(0, 5)}`}{l.reason ? ` · ${l.reason}` : ''}</p>
                ))}
                {!hasHours(d) && !leave.length && list.length === 0 && <p className="text-xs text-muted-foreground">{t('doctor.cal.off')}</p>}
                <ul className="space-y-1.5">
                  {list.map((a) => (
                    <li key={a.id}>
                      <Link to={`/d/appointments/${a.id}`} className={cn('block rounded-lg border border-l-4 bg-card px-2 py-1.5 text-xs hover:bg-accent', DOT[a.status] ?? 'border-l-muted', a.status === 'cancelled' && 'text-muted-foreground line-through')}>
                        <span className="font-semibold tabular-nums">{formatTime(a.start_at, lang)}</span>
                        <span className="block truncate">{a.patients?.full_name}</span>
                        {a.reschedule_requests.some((r) => r.status === 'pending') && <span className="text-warning">{t('doctor.status.reschedulePending')}</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
