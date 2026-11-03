import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowRightLeft, Ban, CheckSquare, Clock, Phone, Search, TimerReset } from 'lucide-react';
import { addDaysKey, formatDate, formatDateTime, formatTime, istDateKey } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { ErrorState, ListSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { LiveBadge } from '@/components/feedback/LiveBadge';
import { inr } from '@/lib/format';
import { useRealtime } from '@/lib/realtime';
import { cn } from '@/lib/utils';
import { ReasonDialog, useAdminError, useHasRole } from '../components';
import {
  cancelByStaff, extendWindow, moveByStaff, moveOptions, outcomeByStaff, refundPreview, useDoctors, useMasters, useMonitor,
  type MonitorFilters, type MonitorRow,
} from '../console-api';

const STATUS_VARIANT: Record<string, BadgeProps['variant']> = { confirmed: 'default', in_progress: 'success', completed: 'neutral', cancelled: 'outline', no_show: 'warning', pending_payment: 'outline' };
const STATUSES = ['confirmed', 'in_progress', 'completed', 'no_show', 'cancelled', 'pending_payment'];

/** Appointment monitor: every booking in a date range, live, with what needs a person and the manual actions. */
export function AppointmentsPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [params, setParams] = useSearchParams();
  const today = istDateKey();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(addDaysKey(today, 1));
  const [status, setStatus] = useState('all');
  const [dept, setDept] = useState('all');
  const [doctor, setDoctor] = useState('all');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const attention = params.get('attention') === '1';
  useEffect(() => { const h = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(h); }, [q]);
  const f: MonitorFilters = {
    from: attention ? addDaysKey(today, -3) : from, to: attention ? addDaysKey(today, 1) : (from <= to ? to : from),
    status: status === 'all' ? undefined : status, department_id: dept === 'all' ? undefined : dept, doctor_id: doctor === 'all' ? undefined : doctor,
    q: term || undefined, attention: attention || undefined,
  };
  const m = useMonitor(f);
  const masters = useMasters();
  const doctors = useDoctors();
  const live = useRealtime('monitor', [{ table: 'appointments' }, { table: 'reschedule_requests' }], [['console', 'appts']]);
  const [open, setOpen] = useState<string | null>(null);
  const rows = m.data?.rows ?? [];
  const current = rows.find((r) => r.id === open) ?? null;
  const docOptions = (doctors.data ?? []).filter((d) => d.verification_status !== 'draft' && (dept === 'all' || d.department_id === dept));

  return (
    <div className="space-y-4">
      <PageHeader title={t('admin.appointments')} subtitle={t('adm.appt.subtitle')} actions={<LiveBadge state={live} />} />
      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-6">
          <div className="space-y-1.5"><Label htmlFor="m-from">{t('admin.pay.from')}</Label><Input id="m-from" type="date" disabled={attention || !!term} value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="m-to">{t('admin.pay.to')}</Label><Input id="m-to" type="date" disabled={attention || !!term} min={from} value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="m-st">{t('adm.appt.status')}</Label>
            <Select value={status} onValueChange={setStatus}><SelectTrigger id="m-st"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">{t('patient.doctors.any')}</SelectItem>{STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`adm.appt.st.${s}`)}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1.5"><Label htmlFor="m-dept">{t('adm.appt.department')}</Label>
            <Select value={dept} onValueChange={(v) => { setDept(v); setDoctor('all'); }}><SelectTrigger id="m-dept"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">{t('patient.doctors.any')}</SelectItem>{(masters.data?.departments ?? []).map((x) => <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1.5"><Label htmlFor="m-doc">{t('adm.appt.doctor')}</Label>
            <Select value={doctor} onValueChange={setDoctor}><SelectTrigger id="m-doc"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">{t('patient.doctors.any')}</SelectItem>{docOptions.map((x) => <SelectItem key={x.id} value={x.id}>{x.full_name}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1.5"><Label htmlFor="m-q">{t('adm.appt.search')}</Label>
            <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input id="m-q" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('adm.appt.searchPh')} /></div></div>
          <label className="flex items-center gap-2 text-sm lg:col-span-6">
            <Switch checked={attention} onCheckedChange={(v) => setParams(v ? { attention: '1' } : {}, { replace: true })} data-ref="attention-toggle" />
            {t('adm.appt.onlyAttention')}{m.data && <Badge variant={m.data.attention ? 'warning' : 'outline'}>{m.data.attention}</Badge>}
            {attention && <span className="text-xs text-muted-foreground">{t('adm.appt.attentionRange')}</span>}
            {term && !attention && <span className="text-xs text-muted-foreground">{t('adm.appt.searchAllDates')}</span>}
          </label>
        </CardContent>
      </Card>

      {m.isPending ? <ListSkeleton rows={5} /> : m.isError ? <ErrorState onRetry={() => void m.refetch()} /> : rows.length === 0 ? (
        <Card><EmptyState art="calendar" title={t('adm.appt.none')} /></Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm" data-ref="monitor-table">
            <thead><tr className="border-b text-left text-xs text-muted-foreground">
              {['time', 'ref', 'patient', 'doctor', 'mode', 'status', 'flags'].map((h) => <th key={h} scope="col" className="px-3 py-2 font-medium">{t(`adm.appt.col.${h}`)}</th>)}
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-ref="monitor-row" className={cn('cursor-pointer border-b last:border-0 hover:bg-accent', r.attention.length > 0 && 'bg-warning-soft/40')} onClick={() => setOpen(r.id)}>
                  <td className="whitespace-nowrap px-3 py-2">{formatDate(r.start_at, lang)}<span className="block font-semibold tabular-nums">{formatTime(r.start_at, lang)}</span></td>
                  <td className="px-3 py-2"><button className="font-mono font-semibold text-primary hover:underline" onClick={(e) => { e.stopPropagation(); setOpen(r.id); }}>{r.ref_code}</button></td>
                  <td className="px-3 py-2">{r.patient_name}</td>
                  <td className="px-3 py-2">{r.doctor_name}<span className="block text-xs text-muted-foreground">{r.department}</span></td>
                  <td className="px-3 py-2">{t(`patient.mode.${r.mode}`)}{r.is_free && <Badge variant="outline" className="ml-1">{t('adm.appt.free')}</Badge>}</td>
                  <td className="px-3 py-2"><Badge variant={STATUS_VARIANT[r.status]}>{t(`adm.appt.st.${r.status}`)}</Badge>
                    {r.outcome && r.status !== 'completed' && <span className="block text-xs text-muted-foreground">{t(`adm.appt.out.${r.outcome}`)}</span>}</td>
                  <td className="px-3 py-2">{r.attention.map((a) => <Badge key={a} variant="warning" className="mb-0.5 mr-1"><AlertTriangle className="mr-1 h-3 w-3" aria-hidden />{t(`adm.appt.att.${a}`)}</Badge>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {m.data && m.data.total > rows.length && <p className="p-3 text-xs text-muted-foreground">{t('adm.appt.more', { shown: rows.length, total: m.data.total })}</p>}
        </Card>
      )}

      <Sheet open={!!current} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent side="right" closeLabel={t('common.close')} className="w-full overflow-y-auto sm:max-w-md">
          {current && <Detail r={current} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Detail({ r }: { r: MonitorRow }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const qc = useQueryClient();
  const errText = useAdminError();
  const canAct = useHasRole('admin', 'coordinator');
  const canCancel = useHasRole('admin', 'coordinator', 'finance');
  const anyRefund = useHasRole('admin', 'finance');
  const [dialog, setDialog] = useState<'cancel' | 'move' | 'outcome' | 'extend' | null>(null);
  const [busy, setBusy] = useState(false);
  const [refund, setRefund] = useState<'full' | 'policy' | 'none'>('full');
  const [quotes, setQuotes] = useState<{ full: number; policy: number; paid: number } | null>(null);
  const [anyDoctor, setAnyDoctor] = useState(false);
  const [options, setOptions] = useState<Awaited<ReturnType<typeof moveOptions>> | null>(null);
  const [slot, setSlot] = useState('');
  const [outcome, setOutcome] = useState<'completed' | 'patient_no_show' | 'doctor_no_show' | 'technical_failure'>('completed');
  const [minutes, setMinutes] = useState(15);
  const started = new Date(r.start_at) <= new Date();
  const active = r.status === 'confirmed' || r.status === 'in_progress';

  useEffect(() => {
    if (dialog !== 'cancel') return;
    setRefund('full');
    void Promise.all([refundPreview(r.id, 'admin'), refundPreview(r.id, 'patient')]).then(([a, p]) => setQuotes({ full: a.amount, policy: p.amount, paid: a.paid })).catch(() => setQuotes(null));
  }, [dialog, r.id]);
  const errRef = useRef(errText);
  errRef.current = errText;
  useEffect(() => {
    if (dialog !== 'move') return;
    let live = true;
    setSlot('');
    setOptions(null);
    void moveOptions(r.id, anyDoctor).then((o) => live && setOptions(o)).catch((e) => { if (live) { setOptions([]); toast.error(errRef.current(e)); } });
    return () => { live = false; };
  }, [dialog, anyDoctor, r.id]);
  const byDay = useMemo(() => {
    const g = new Map<string, NonNullable<typeof options>>();
    for (const o of options ?? []) {
      const k = istDateKey(o.start_at);
      g.set(k, [...(g.get(k) ?? []), o]);
    }
    return [...g.entries()];
  }, [options]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      setDialog(null);
      await qc.invalidateQueries({ queryKey: ['console'] });
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-ref="appt-detail">
      <div>
        <SheetTitle className="font-mono">{r.ref_code}</SheetTitle>
        <SheetDescription>{formatDateTime(r.start_at, lang)} · {t(`patient.mode.${r.mode}`)} · {t(`adm.appt.type.${r.consult_type}`)}</SheetDescription>
      </div>
      <div className="flex flex-wrap gap-1"><Badge variant={STATUS_VARIANT[r.status]}>{t(`adm.appt.st.${r.status}`)}</Badge>
        {r.outcome && <Badge variant="outline">{t(`adm.appt.out.${r.outcome}`)}</Badge>}
        {r.attention.map((a) => <Badge key={a} variant="warning">{t(`adm.appt.att.${a}`)}</Badge>)}</div>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <D k={t('adm.appt.col.patient')} v={r.patient_name} />
        <D k={t('adm.appt.contact')} v={r.contact_phone ? <a className="inline-flex items-center gap-1 text-primary" href={`tel:${r.contact_phone}`}><Phone className="h-3.5 w-3.5" aria-hidden />{r.contact_phone}</a> : '—'} />
        <D k={t('adm.appt.col.doctor')} v={`${r.doctor_name} · ${r.department}`} />
        <D k={t('adm.appt.hospital')} v={r.hospital} />
        <D k={t('adm.appt.fee')} v={r.is_free ? t('adm.appt.free') : inr(r.fee_amount, lang)} />
        <D k={t('adm.appt.payment')} v={r.payment_status ? `${t(`admin.pay.st.${r.payment_status}`)}${r.refunded ? ` · ${t('adm.appt.refunded', { amount: inr(r.refunded, lang) })}` : ''}` : '—'} />
        <D k={t('adm.appt.joined')} v={[r.doctor_joined_at && `${t('adm.appt.doctorIn')} ${formatTime(r.doctor_joined_at, lang)}`, r.patient_joined_at && `${t('adm.appt.patientIn')} ${formatTime(r.patient_joined_at, lang)}`].filter(Boolean).join(' · ') || t('adm.appt.nobody')} />
        {r.extended_minutes > 0 && <D k={t('adm.appt.extended')} v={t('adm.appt.minutes', { count: r.extended_minutes })} />}
        {r.outcome_reason && <div className="col-span-2"><D k={t('adm.appt.reason')} v={r.outcome_reason} /></div>}
      </dl>
      <p className="text-xs text-muted-foreground">{t('adm.appt.privacy')}</p>
      <Separator />
      <div className="grid gap-2">
        {r.status === 'confirmed' && canCancel && <Button variant="outline" className="justify-start text-destructive" onClick={() => setDialog('cancel')} data-ref="act-cancel"><Ban aria-hidden />{t('adm.appt.cancel')}</Button>}
        {r.status === 'confirmed' && !started && canAct && <Button variant="outline" className="justify-start" onClick={() => { setAnyDoctor(false); setDialog('move'); }} data-ref="act-move"><ArrowRightLeft aria-hidden />{t('adm.appt.move')}</Button>}
        {active && started && canAct && <Button variant="outline" className="justify-start" onClick={() => setDialog('outcome')} data-ref="act-outcome"><CheckSquare aria-hidden />{t('adm.appt.outcome')}</Button>}
        {active && canAct && <Button variant="outline" className="justify-start" onClick={() => setDialog('extend')} data-ref="act-extend"><TimerReset aria-hidden />{t('adm.appt.extend')}</Button>}
        {!active && r.status !== 'pending_payment' && <p className="text-sm text-muted-foreground">{t('adm.appt.noActions')}</p>}
      </div>

      <ReasonDialog open={dialog === 'cancel'} onOpenChange={(o) => !o && setDialog(null)} destructive title={t('adm.appt.cancelTitle', { ref: r.ref_code })} description={t('adm.appt.cancelBody')}
        confirmLabel={t('adm.appt.cancel')} busy={busy}
        onConfirm={(reason) => void run(async () => { const res = await cancelByStaff(r.id, refund, reason); toast.message(t('adm.appt.cancelled', { amount: inr(res.refund_amount, lang) })); }, t('adm.appt.done'))}>
        <RadioGroup value={refund} onValueChange={(v) => setRefund(v as typeof refund)} className="space-y-1" aria-label={t('adm.appt.refundChoice')}>
          {(['full', 'policy', 'none'] as const).map((k) => (
            <label key={k} className={cn('flex items-start gap-2 rounded-lg border p-2.5 text-sm', k !== 'full' && !anyRefund && 'opacity-50')}>
              <RadioGroupItem value={k} disabled={k !== 'full' && !anyRefund} className="mt-0.5" />
              <span><span className="font-medium">{t(`adm.appt.refund.${k}`)}</span>
                {quotes && <span className="block text-xs text-muted-foreground">{k === 'none' ? inr(0, lang) : inr(k === 'full' ? quotes.full : quotes.policy, lang)} {t('adm.appt.ofPaid', { paid: inr(quotes.paid, lang) })}</span>}</span>
            </label>
          ))}
        </RadioGroup>
        {!anyRefund && <p className="text-xs text-muted-foreground">{t('adm.appt.fullOnly')}</p>}
      </ReasonDialog>

      <ReasonDialog open={dialog === 'move'} onOpenChange={(o) => !o && setDialog(null)} title={t('adm.appt.moveTitle', { ref: r.ref_code })} description={t('adm.appt.moveBody')}
        confirmLabel={t('adm.appt.move')} busy={busy} valid={!!slot}
        onConfirm={(reason) => void run(() => moveByStaff(r.id, slot, reason), t('adm.appt.moved'))}>
        <label className="flex items-center gap-2 text-sm"><Switch checked={anyDoctor} onCheckedChange={setAnyDoctor} />{t('adm.appt.anyDoctor', { dept: r.department })}</label>
        <div className="max-h-64 space-y-3 overflow-y-auto" role="radiogroup" aria-label={t('adm.appt.chooseSlot')}>
          {options === null ? <ListSkeleton rows={2} /> : byDay.length === 0 ? <p className="text-sm text-muted-foreground">{t('adm.appt.noSlots')}</p> : byDay.map(([day, list]) => (
            <div key={day}><p className="mb-1 text-xs font-semibold text-muted-foreground">{formatDate(list[0]!.start_at, lang)}</p>
              <div className="flex flex-wrap gap-1.5">{list.map((o) => (
                <button key={o.slot_id} type="button" role="radio" aria-checked={slot === o.slot_id} onClick={() => setSlot(o.slot_id)}
                  className={cn('rounded-lg border px-2.5 py-1.5 text-xs', slot === o.slot_id ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent')}>
                  <span className="font-semibold tabular-nums">{formatTime(o.start_at, lang)}</span>{anyDoctor && <span className="block">{o.doctor_name}</span>}
                </button>))}</div></div>
          ))}
        </div>
        {anyDoctor && <p className="text-xs text-muted-foreground">{t('adm.appt.feeKept')}</p>}
      </ReasonDialog>

      <ReasonDialog open={dialog === 'outcome'} onOpenChange={(o) => !o && setDialog(null)} title={t('adm.appt.outcomeTitle', { ref: r.ref_code })} description={t('adm.appt.outcomeBody')}
        confirmLabel={t('adm.appt.record')} busy={busy} onConfirm={(reason) => void run(() => outcomeByStaff(r.id, outcome, reason), t('adm.appt.done'))}>
        <RadioGroup value={outcome} onValueChange={(v) => setOutcome(v as typeof outcome)} className="space-y-1" aria-label={t('adm.appt.outcome')}>
          {(['completed', 'patient_no_show', 'doctor_no_show', 'technical_failure'] as const).map((k) => (
            <label key={k} className="flex items-start gap-2 rounded-lg border p-2.5 text-sm"><RadioGroupItem value={k} className="mt-0.5" />
              <span><span className="font-medium">{t(`adm.appt.out.${k}`)}</span><span className="block text-xs text-muted-foreground">{t(`adm.appt.outHint.${k}`)}</span></span></label>
          ))}
        </RadioGroup>
      </ReasonDialog>

      <ReasonDialog open={dialog === 'extend'} onOpenChange={(o) => !o && setDialog(null)} title={t('adm.appt.extendTitle', { ref: r.ref_code })} description={t('adm.appt.extendBody', { used: r.extended_minutes })}
        confirmLabel={t('adm.appt.extend')} busy={busy} valid={r.extended_minutes + minutes <= 60}
        onConfirm={(reason) => void run(() => extendWindow(r.id, minutes, reason), t('adm.appt.extendedOk', { count: minutes }))}>
        <div className="flex items-center gap-2"><Clock className="h-4 w-4 text-muted-foreground" aria-hidden />
          <Select value={String(minutes)} onValueChange={(v) => setMinutes(Number(v))}><SelectTrigger className="w-40" aria-label={t('adm.appt.extendBy')}><SelectValue /></SelectTrigger>
            <SelectContent>{[10, 15, 20, 30].map((n) => <SelectItem key={n} value={String(n)} disabled={r.extended_minutes + n > 60}>{t('adm.appt.minutes', { count: n })}</SelectItem>)}</SelectContent></Select></div>
      </ReasonDialog>
    </div>
  );
}

function D({ k, v }: { k: string; v: React.ReactNode }) {
  return <div><dt className="text-xs text-muted-foreground">{k}</dt><dd className="font-medium">{v}</dd></div>;
}
