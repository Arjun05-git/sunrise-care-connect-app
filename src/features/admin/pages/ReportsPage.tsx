import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FileSpreadsheet } from 'lucide-react';
import { addDaysKey, istDateKey } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorState, ListSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { inr } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useHasRole } from '../components';
import { useReport, type ReportKind } from '../console-api';
import { downloadText, toCsv } from '../csv';

type Row = Record<string, unknown>;
type Cell = string | number | null;
interface Col { key: string; csv: (r: Row) => Cell; show?: (r: Row, lang: string) => string; num?: boolean }
const n = (r: Row, k: string) => Number(r[k] ?? 0);
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

/** Column definitions per report: the CSV gets raw values (IST dates, rupees, percentages); the screen formats them. */
const COLUMNS: Record<ReportKind, Col[]> = {
  appointments: [
    { key: 'ref_code', csv: (r) => r.ref_code as string }, { key: 'date_ist', csv: (r) => r.date_ist as string }, { key: 'time_ist', csv: (r) => r.time_ist as string },
    { key: 'doctor', csv: (r) => r.doctor as string }, { key: 'department', csv: (r) => r.department as string }, { key: 'hospital', csv: (r) => r.hospital as string },
    { key: 'mode', csv: (r) => r.mode as string }, { key: 'consult_type', csv: (r) => r.consult_type as string }, { key: 'is_free', csv: (r) => (r.is_free ? 'yes' : 'no') },
    { key: 'fee_amount', csv: (r) => n(r, 'fee_amount'), show: (r, l) => inr(n(r, 'fee_amount'), l), num: true }, { key: 'status', csv: (r) => r.status as string },
    { key: 'outcome', csv: (r) => (r.outcome as string) ?? '' }, { key: 'payment_status', csv: (r) => (r.payment_status as string) ?? '' },
    { key: 'refunded', csv: (r) => n(r, 'refunded'), show: (r, l) => inr(n(r, 'refunded'), l), num: true },
  ],
  revenue: [
    { key: 'date', csv: (r) => r.date as string }, { key: 'payments', csv: (r) => n(r, 'payments'), num: true },
    ...['gross', 'refunds_processed', 'net', 'refunds_initiated', 'refunds_failed'].map((k) => ({ key: k, csv: (r: Row) => n(r, k), show: (r: Row, l: string) => inr(n(r, k), l), num: true })),
    { key: 'refunds_count', csv: (r) => n(r, 'refunds_count'), num: true },
  ],
  no_shows: [
    { key: 'doctor', csv: (r) => r.doctor as string }, { key: 'department', csv: (r) => r.department as string }, { key: 'due', csv: (r) => n(r, 'due'), num: true },
    ...['completed', 'patient_no_show', 'doctor_no_show', 'both_no_show', 'technical_failure', 'doctor_cancelled'].map((k) => ({ key: k, csv: (r: Row) => n(r, k), num: true })),
    { key: 'no_show_rate', csv: (r) => pct(n(r, 'patient_no_show') + n(r, 'doctor_no_show') + n(r, 'both_no_show'), n(r, 'due')), show: (r) => `${pct(n(r, 'patient_no_show') + n(r, 'doctor_no_show') + n(r, 'both_no_show'), n(r, 'due'))}%`, num: true },
    { key: 'failure_rate', csv: (r) => pct(n(r, 'technical_failure') + n(r, 'doctor_cancelled'), n(r, 'due')), show: (r) => `${pct(n(r, 'technical_failure') + n(r, 'doctor_cancelled'), n(r, 'due'))}%`, num: true },
  ],
  utilisation: [
    { key: 'doctor', csv: (r) => r.doctor as string }, { key: 'department', csv: (r) => r.department as string },
    ...['offered', 'booked', 'completed', 'booked_minutes'].map((k) => ({ key: k, csv: (r: Row) => n(r, k), num: true })),
    { key: 'utilisation', csv: (r) => pct(n(r, 'booked'), n(r, 'offered')), show: (r) => `${pct(n(r, 'booked'), n(r, 'offered'))}%`, num: true },
  ],
  follow_ups: [
    { key: 'doctor', csv: (r) => r.doctor as string }, { key: 'department', csv: (r) => r.department as string },
    ...['paid_first_completed', 'free_booked', 'free_completed', 'via_override'].map((k) => ({ key: k, csv: (r: Row) => n(r, k), num: true })),
    { key: 'fee_forgone', csv: (r) => n(r, 'fee_forgone'), show: (r, l) => inr(n(r, 'fee_forgone'), l), num: true },
  ],
  notifications: [
    { key: 'template_key', csv: (r) => r.template_key as string }, { key: 'channel', csv: (r) => r.channel as string },
    ...['total', 'sent', 'delivered', 'read', 'failed', 'skipped', 'clicked'].map((k) => ({ key: k, csv: (r: Row) => n(r, k), num: true })),
    { key: 'delivery_rate', csv: (r) => pct(n(r, 'delivered'), n(r, 'total') - n(r, 'skipped')), show: (r) => `${pct(n(r, 'delivered'), n(r, 'total') - n(r, 'skipped'))}%`, num: true },
    { key: 'cost_inr', csv: (r) => n(r, 'cost_paise') / 100, show: (r, l) => `₹${(n(r, 'cost_paise') / 100).toLocaleString(l === 'ml' ? 'ml-IN' : 'en-IN', { minimumFractionDigits: 2 })}`, num: true },
  ],
};
const KINDS: ReportKind[] = ['appointments', 'revenue', 'no_shows', 'utilisation', 'follow_ups', 'notifications'];

/** Reports with CSV export. No report row identifies a patient. */
export function ReportsPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const money = useHasRole('admin', 'finance');
  const ops = useHasRole('admin', 'coordinator');
  const allowed = (k: ReportKind) => (k === 'revenue' ? money : k === 'notifications' ? ops : true);
  const kinds = KINDS.filter(allowed);
  const today = istDateKey();
  const [kind, setKind] = useState<ReportKind>(kinds[0] ?? 'appointments');
  const [from, setFrom] = useState(addDaysKey(today, -29));
  const [to, setTo] = useState(today);
  const ok = from <= to;
  const rep = useReport(kind, from, to, ok);
  const cols = COLUMNS[kind];
  const rows = rep.data ?? [];

  const exportCsv = () => {
    downloadText(`sunrise-${kind}_${from}_${to}.csv`, toCsv(cols.map((c) => c.key), rows.map((r) => cols.map((c) => c.csv(r)))));
    toast.success(t('adm.rep.exported', { count: rows.length }));
  };

  return (
    <div className="space-y-4">
      <PageHeader title={t('admin.reports')} subtitle={t('adm.rep.subtitle')} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label={t('adm.rep.choose')}>
        {kinds.map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} data-ref={`report-${k}`}
            className={cn('rounded-lg border bg-card p-3 text-left shadow-soft transition-colors', kind === k ? 'border-primary ring-2 ring-primary/30' : 'hover:bg-accent')}>
            <p className="font-semibold">{t(`adm.rep.k.${k}`)}</p><p className="text-xs text-muted-foreground">{t(`adm.rep.d.${k}`)}</p>
          </button>
        ))}
      </div>
      <Card>
        <CardHeader className="flex-row flex-wrap items-end justify-between gap-3 space-y-0">
          <div><CardTitle>{t(`adm.rep.k.${kind}`)}</CardTitle><CardDescription>{t('adm.rep.rows', { count: rows.length })}</CardDescription></div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1"><Label htmlFor="r-from">{t('admin.pay.from')}</Label><Input id="r-from" type="date" max={to} value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="r-to">{t('admin.pay.to')}</Label><Input id="r-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            <Button variant="outline" disabled={!rows.length} onClick={exportCsv} data-ref="report-csv"><FileSpreadsheet aria-hidden />{t('adm.rep.csv')}</Button>
          </div>
        </CardHeader>
        <CardContent>
          {!ok ? <p className="text-sm text-destructive">{t('adm.rep.badRange')}</p> : rep.isPending ? <ListSkeleton rows={4} /> : rep.isError ? <ErrorState onRetry={() => void rep.refetch()} /> : rows.length === 0 ? (
            <EmptyState art="search" title={t('adm.rep.none')} />
          ) : (
            <div className="max-h-[60vh] overflow-auto rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" tabIndex={0} role="region" aria-label={t(`adm.rep.k.${kind}`)}>
              <table className="w-full text-sm" data-ref="report-table">
                <thead className="sticky top-0 bg-card"><tr className="border-b text-left text-xs text-muted-foreground">{cols.map((c) => <th key={c.key} scope="col" className={cn('whitespace-nowrap px-2 py-1.5 font-medium', c.num && 'text-right')}>{t(`adm.rep.c.${c.key}`)}</th>)}</tr></thead>
                <tbody>{rows.slice(0, 500).map((r, i) => (
                  <tr key={i} className="border-b last:border-0">{cols.map((c) => <td key={c.key} className={cn('whitespace-nowrap px-2 py-1.5', c.num && 'text-right tabular-nums')}>{c.show ? c.show(r, lang) : String(c.csv(r) ?? '')}</td>)}</tr>
                ))}</tbody>
              </table>
              {rows.length > 500 && <p className="p-2 text-xs text-muted-foreground">{t('adm.rep.truncated', { count: rows.length })}</p>}
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">{t(`adm.rep.note.${kind}`)}</p>
        </CardContent>
      </Card>
    </div>
  );
}
