import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AlertTriangle, Copy, Plus, Trash2, X } from 'lucide-react';
import { addDaysKey, formatDate, formatDateTime, istDateKey } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { CardSkeleton, ErrorState } from '@/components/feedback/states';
import { useAddLeave, useAvailability, useMyDoctor, useRemoveLeave, useSaveWeeklyHours, type AvailabilityRow } from '../api';
import { useDoctorError } from '../components';

// Monday-first for display; stored weekday is 0 = Sunday … 6 = Saturday (Postgres dow)
const WEEK = [1, 2, 3, 4, 5, 6, 0];
type Range = { start: string; end: string };
type Week = Record<number, Range[]>;

const toWeek = (rows: AvailabilityRow[]): Week => {
  const w: Week = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const r of rows) if (r.kind === 'weekly' && r.weekday != null) w[r.weekday]!.push({ start: r.start_time.slice(0, 5), end: r.end_time.slice(0, 5) });
  return w;
};
/** Problems in one day's ranges: empty, end ≤ start, or overlapping. */
export function rangeErrors(ranges: Range[]): ('order' | 'overlap')[] {
  const errs = new Set<'order' | 'overlap'>();
  const sorted = [...ranges].sort((a, b) => a.start.localeCompare(b.start));
  sorted.forEach((r, i) => {
    if (!r.start || !r.end || r.end <= r.start) errs.add('order');
    if (i > 0 && r.start < sorted[i - 1]!.end) errs.add('overlap');
  });
  return [...errs];
}

/** Weekly consulting hours + leave. Saving regenerates the next 14 days of slots; booked ones are never touched. */
export function AvailabilityPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const me = useMyDoctor();
  const avail = useAvailability(me.data?.id);
  const saveHours = useSaveWeeklyHours();
  const addLeave = useAddLeave();
  const removeLeave = useRemoveLeave();
  const errText = useDoctorError();
  const [week, setWeek] = useState<Week | null>(null);
  const [dirty, setDirty] = useState(false);
  const today = istDateKey();
  const [leave, setLeave] = useState({ from: today, to: today, allDay: true, start: '09:00', end: '13:00', reason: '' });

  useEffect(() => {
    if (avail.data && !dirty) setWeek(toWeek(avail.data.rows));
  }, [avail.data, dirty]);

  const edit = (day: number, fn: (r: Range[]) => Range[]) => { setWeek((w) => ({ ...w!, [day]: fn(w![day]!) })); setDirty(true); };
  const invalid = week ? WEEK.some((d) => rangeErrors(week[d]!).length > 0) : true;
  const leaves = avail.data?.rows.filter((r) => r.kind === 'block' && r.block_date_to! >= today).sort((a, b) => a.block_date_from!.localeCompare(b.block_date_from!)) ?? [];
  const leaveValid = leave.from >= today && leave.to >= leave.from && leave.to <= addDaysKey(leave.from, 90) && (leave.allDay || leave.end > leave.start);

  const reportClashes = (n: number, ok: string) => (n > 0 ? toast.warning(t('doctor.avail.clashToast', { count: n })) : toast.success(ok));

  if (me.isPending || avail.isPending || !week) return <><PageHeader back="/d/calendar" title={t('doctor.avail.title')} /><CardSkeleton /><CardSkeleton className="mt-4" /></>;
  if (avail.isError) return <ErrorState onRetry={() => void avail.refetch()} />;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader back="/d/calendar" title={t('doctor.avail.title')} subtitle={t('doctor.avail.subtitle', { min: me.data?.slot_minutes })} />

      {avail.data.clashes.length > 0 && (
        <Card className="border-warning/50 bg-warning-soft/40">
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><AlertTriangle className="h-5 w-5 text-warning" aria-hidden />{t('doctor.avail.clashTitle', { count: avail.data.clashes.length })}</CardTitle><CardDescription>{t('doctor.avail.clashDesc')}</CardDescription></CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {avail.data.clashes.map((c) => <li key={c.appointment_id}><Link className="font-medium text-primary underline-offset-2 hover:underline" to={`/d/appointments/${c.appointment_id}`}>{formatDateTime(c.start_at, lang)} · {c.patient_name}</Link></li>)}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>{t('doctor.avail.weekly')}</CardTitle><CardDescription>{t('doctor.avail.weeklyDesc')}</CardDescription></CardHeader>
        <CardContent className="space-y-1">
          {WEEK.map((d) => {
            const ranges = week[d]!;
            const errs = rangeErrors(ranges);
            const dayName = t(`doctor.avail.day.${d}`);
            return (
              <div key={d} className="flex flex-col gap-2 border-b py-3 last:border-0 sm:flex-row sm:items-start">
                <div className="flex w-32 shrink-0 items-center justify-between sm:block">
                  <p className="font-medium">{dayName}</p>
                  {ranges.length === 0 && <p className="text-xs text-muted-foreground">{t('doctor.avail.off')}</p>}
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  {ranges.map((r, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input type="time" step={900} className="min-w-0 flex-1 sm:w-32 sm:flex-none" value={r.start} aria-label={t('doctor.avail.from', { day: dayName })} onChange={(e) => edit(d, (rs) => rs.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
                      <span aria-hidden>–</span>
                      <Input type="time" step={900} className="min-w-0 flex-1 sm:w-32 sm:flex-none" value={r.end} aria-label={t('doctor.avail.to', { day: dayName })} onChange={(e) => edit(d, (rs) => rs.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
                      <Button variant="ghost" size="icon" aria-label={t('doctor.avail.removeRange', { day: dayName })} onClick={() => edit(d, (rs) => rs.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>
                    </div>
                  ))}
                  {errs.map((e) => <p key={e} role="alert" className="text-xs text-destructive">{t(`doctor.avail.err.${e}`)}</p>)}
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => edit(d, (rs) => [...rs, rs.length ? { start: rs[rs.length - 1]!.end, end: rs[rs.length - 1]!.end < '20:00' ? `${String(Math.min(23, Number(rs[rs.length - 1]!.end.slice(0, 2)) + 3)).padStart(2, '0')}:00` : '23:00' } : { start: '09:00', end: '13:00' }])}>
                      <Plus aria-hidden />{t('doctor.avail.addRange')}
                    </Button>
                    {d === 1 && ranges.length > 0 && (
                      <Button variant="ghost" size="sm" onClick={() => { setWeek((w) => ({ ...w!, 2: [...ranges], 3: [...ranges], 4: [...ranges], 5: [...ranges] })); setDirty(true); }}><Copy aria-hidden />{t('doctor.avail.copyWeekdays')}</Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          <div className="flex flex-wrap gap-2 pt-3">
            <Button disabled={!dirty || invalid} loading={saveHours.isPending}
              onClick={() => saveHours.mutate(WEEK.flatMap((d) => week[d]!.map((r) => ({ weekday: d, start: r.start, end: r.end }))), {
                onSuccess: (n) => { setDirty(false); reportClashes(n as number, t('doctor.avail.saved')); },
                onError: (e) => toast.error(errText(e)),
              })}>{t('doctor.avail.save')}</Button>
            {dirty && <Button variant="ghost" onClick={() => { setDirty(false); setWeek(toWeek(avail.data.rows)); }}>{t('common.cancel')}</Button>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('doctor.avail.leave')}</CardTitle><CardDescription>{t('doctor.avail.leaveDesc')}</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label htmlFor="lv-from">{t('admin.pay.from')}</Label><Input id="lv-from" type="date" min={today} value={leave.from} onChange={(e) => setLeave((l) => ({ ...l, from: e.target.value, to: l.to < e.target.value ? e.target.value : l.to }))} /></div>
            <div className="space-y-1.5"><Label htmlFor="lv-to">{t('admin.pay.to')}</Label><Input id="lv-to" type="date" min={leave.from} value={leave.to} onChange={(e) => setLeave((l) => ({ ...l, to: e.target.value }))} /></div>
          </div>
          <label className="flex min-h-11 items-center justify-between gap-3 text-sm">{t('doctor.avail.allDay')}<Switch checked={leave.allDay} onCheckedChange={(v) => setLeave((l) => ({ ...l, allDay: v }))} /></label>
          {!leave.allDay && (
            <div className="flex items-center gap-2">
              <Input type="time" step={900} className="min-w-0 flex-1 sm:w-32 sm:flex-none" aria-label={t('doctor.avail.leaveFrom')} value={leave.start} onChange={(e) => setLeave((l) => ({ ...l, start: e.target.value }))} />
              <span aria-hidden>–</span>
              <Input type="time" step={900} className="min-w-0 flex-1 sm:w-32 sm:flex-none" aria-label={t('doctor.avail.leaveTo')} value={leave.end} onChange={(e) => setLeave((l) => ({ ...l, end: e.target.value }))} />
            </div>
          )}
          <div className="space-y-1.5"><Label htmlFor="lv-reason">{t('doctor.avail.leaveReason')}</Label><Input id="lv-reason" maxLength={120} value={leave.reason} onChange={(e) => setLeave((l) => ({ ...l, reason: e.target.value }))} placeholder={t('doctor.avail.leaveReasonPh')} /></div>
          {!leaveValid && <p className="text-xs text-destructive">{t('doctor.avail.leaveInvalid')}</p>}
          <Button disabled={!leaveValid} loading={addLeave.isPending}
            onClick={() => addLeave.mutate({ from: leave.from, to: leave.to, start: leave.allDay ? null : leave.start, end: leave.allDay ? null : leave.end, reason: leave.reason }, {
              onSuccess: (n) => { setLeave((l) => ({ ...l, reason: '' })); reportClashes(n as number, t('doctor.avail.leaveAdded')); },
              onError: (e) => toast.error(errText(e)),
            })}>{t('doctor.avail.addLeave')}</Button>

          {leaves.length > 0 && (
            <ul className="divide-y rounded-xl border">
              {leaves.map((l) => (
                <li key={l.id} className="flex items-center gap-3 p-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{formatDate(`${l.block_date_from}T12:00:00+05:30`, lang)}{l.block_date_to !== l.block_date_from ? ` – ${formatDate(`${l.block_date_to}T12:00:00+05:30`, lang)}` : ''}</p>
                    <p className="text-xs text-muted-foreground">{l.start_time.slice(0, 5) === '00:00' && l.end_time.slice(0, 5) >= '23:59' ? t('doctor.cal.leaveDay') : `${l.start_time.slice(0, 5)}–${l.end_time.slice(0, 5)}`}{l.reason ? ` · ${l.reason}` : ''}</p>
                  </div>
                  <Button variant="ghost" size="icon" aria-label={t('doctor.avail.removeLeave')} disabled={removeLeave.isPending}
                    onClick={() => removeLeave.mutate(l.id, { onSuccess: () => toast.success(t('doctor.avail.leaveRemoved')), onError: (e) => toast.error(errText(e)) })}><Trash2 className="h-4 w-4" /></Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
