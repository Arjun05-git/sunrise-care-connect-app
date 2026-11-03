import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, BellOff, ChevronRight, LifeBuoy, ShieldQuestion, Undo2 } from 'lucide-react';
import { formatMonthShort, formatDayNum, formatDate, fromIst } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CardSkeleton, ErrorState } from '@/components/feedback/states';
import { inr } from '@/lib/format';
import { useRealtime } from '@/lib/realtime';
import { cn } from '@/lib/utils';
import { ChartCard, ColumnChart, DataTable, RankBars, type Column, type Series } from '../charts';
import { cqk, useDashboard } from '../console-api';

/** Admin home: today at a glance, what needs a person, and the last weeks as charts. */
export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [days, setDays] = useState(30);
  const q = useDashboard(days);
  const live = useRealtime('dashboard', [{ table: 'appointments' }], [cqk.dashboard(days)]);
  void live;
  const d = q.data;

  const series: Series[] = [
    { key: 'completed', label: t('adm.dash.s.completed'), color: 'var(--viz-1)' },
    { key: 'upcoming', label: t('adm.dash.s.upcoming'), color: 'var(--viz-2)' },
    { key: 'no_show', label: t('adm.dash.s.no_show'), color: 'var(--viz-3)' },
    { key: 'cancelled', label: t('adm.dash.s.cancelled'), color: 'var(--viz-4)' },
  ];
  const day = (key: string) => `${formatDayNum(key)} ${formatMonthShort(key, lang)}`;
  const cols: Column[] = (d?.days ?? []).map((x) => ({ label: day(x.date), full: formatDate(fromIst(x.date, '12:00').toISOString(), lang), values: { completed: x.completed, upcoming: x.upcoming, no_show: x.no_show, cancelled: x.cancelled } }));
  const money = (n: number) => inr(n, lang);
  const revenue: Column[] = (d?.days ?? []).map((x) => ({ label: day(x.date), full: formatDate(fromIst(x.date, '12:00').toISOString(), lang), values: { revenue: x.revenue ?? 0 } }));
  const deptName = (x: { name: string; name_ml: string }) => (lang === 'ml' ? x.name_ml : x.name);

  return (
    <div className="space-y-4">
      <PageHeader title={t('admin.dashboard')} subtitle={t('adm.dash.subtitle')}
        actions={
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="w-40" aria-label={t('adm.dash.range')}><SelectValue /></SelectTrigger>
            <SelectContent>{[14, 30, 90].map((n) => <SelectItem key={n} value={String(n)}>{t('adm.dash.lastDays', { count: n })}</SelectItem>)}</SelectContent>
          </Select>
        } />

      {q.isPending ? <CardSkeleton /> : q.isError || !d ? <ErrorState onRetry={() => void q.refetch()} /> : (
        <>
          {/* today */}
          <section aria-labelledby="today-h" className="space-y-2">
            <h2 id="today-h" className="text-sm font-semibold text-muted-foreground">{t('adm.dash.today')}</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" data-ref="kpis">
              <Kpi label={t('adm.dash.k.booked')} value={d.today.booked} to="/a/appointments" />
              <Kpi label={t('adm.dash.k.inProgress')} value={d.today.in_progress} to="/a/appointments" />
              <Kpi label={t('adm.dash.k.nextHour')} value={d.today.next_hour} to="/a/appointments" />
              <Kpi label={t('adm.dash.k.completed')} value={d.today.completed} />
              <Kpi label={t('adm.dash.k.noShows')} value={d.today.no_shows} />
              {d.money ? <Kpi label={t('adm.dash.k.revenue')} value={money(d.today.revenue ?? 0)} hint={t('adm.dash.k.month', { amount: money(d.month_revenue ?? 0) })} /> : <Kpi label={t('adm.dash.k.newBookings')} value={d.today.new_bookings} />}
            </div>
          </section>

          {/* needs a person */}
          <section aria-labelledby="todo-h" className="space-y-2">
            <h2 id="todo-h" className="text-sm font-semibold text-muted-foreground">{t('adm.dash.todo')}</h2>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Todo icon={AlertTriangle} n={d.attention} label={t('adm.dash.t.attention', { count: d.attention })} to="/a/appointments?attention=1" />
              <Todo icon={ShieldQuestion} n={d.pending_verifications} label={t('adm.dash.t.verify', { count: d.pending_verifications })} to="/a/doctors?status=pending" />
              <Todo icon={LifeBuoy} n={d.unanswered_tickets} label={t('adm.dash.t.tickets', { count: d.unanswered_tickets, open: d.open_tickets })} to="/a/support" />
              {d.refunds_pending
                ? <Todo icon={Undo2} n={d.refunds_pending.count} label={t('adm.dash.t.refunds', { count: d.refunds_pending.count, amount: money(d.refunds_pending.amount) })} to="/a/payments" />
                : <Todo icon={BellOff} n={d.failed_notifications} label={t('adm.dash.t.notifications', { count: d.failed_notifications })} to="/a/notifications" />}
            </div>
          </section>

          <div className="grid gap-4 xl:grid-cols-3">
            <ChartCard className="xl:col-span-2" title={t('adm.dash.c.consults')} legend={series}
              table={<DataTable head={[t('adm.dash.date'), ...series.map((s) => s.label)]} rows={cols.map((c) => [c.full, ...series.map((s) => c.values[s.key] ?? 0)])} />}>
              <ColumnChart columns={cols} series={series} label={t('adm.dash.c.consults')} />
            </ChartCard>
            <ChartCard title={t('adm.dash.c.departments')}
              table={<DataTable head={[t('adm.dash.department'), t('adm.dash.consults')]} rows={d.departments.map((x) => [deptName(x), x.count])} />}>
              {d.departments.length ? <RankBars rows={d.departments.slice(0, 8).map((x) => ({ label: deptName(x), value: x.count }))} color="var(--viz-1)" label={t('adm.dash.c.departments')} />
                : <p className="text-sm text-muted-foreground">{t('adm.dash.none')}</p>}
            </ChartCard>
            {d.money && (
              <ChartCard className="xl:col-span-3" title={t('adm.dash.c.revenue')}
                table={<DataTable head={[t('adm.dash.date'), t('adm.dash.net')]} rows={revenue.map((c) => [c.full, money(c.values.revenue ?? 0)])} />}>
                <p className="mb-1 text-xs text-muted-foreground">{t('adm.dash.c.revenueHint')}</p>
                <ColumnChart columns={revenue} series={[{ key: 'revenue', label: t('adm.dash.net'), color: 'var(--viz-1)' }]} format={money} label={t('adm.dash.c.revenue')} />
              </ChartCard>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, hint, to }: { label: string; value: number | string; hint?: string; to?: string }) {
  const body = (
    <CardContent className="p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </CardContent>
  );
  return <Card className={cn(to && 'transition-colors hover:bg-accent')}>{to ? <Link to={to} className="block rounded-[inherit]">{body}</Link> : body}</Card>;
}

function Todo({ icon: Icon, n, label, to }: { icon: typeof AlertTriangle; n: number; label: string; to: string }) {
  return (
    <Link to={to} className={cn('flex items-center gap-3 rounded-lg border bg-card p-3 text-sm shadow-soft hover:bg-accent', n > 0 ? 'border-warning/50' : 'opacity-80')}>
      <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', n > 0 ? 'bg-warning-soft text-warning' : 'bg-muted text-muted-foreground')}><Icon className="h-4 w-4" aria-hidden /></span>
      <span className="flex-1">{label}</span>
      <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
    </Link>
  );
}
