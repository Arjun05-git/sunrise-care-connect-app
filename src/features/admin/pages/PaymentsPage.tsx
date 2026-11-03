import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, Download, FileSpreadsheet, RotateCw, Search, Undo2 } from 'lucide-react';
import { addDaysKey, formatDateTime, istDateKey } from '@/domain/time';
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
import { ErrorState, ListSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { inr } from '@/lib/format';
import { downloadReceipt } from '@/services/payments';
import {
  cancelBooking, issueRefund, reconciliation, refundableAmount, refundedAmount, refundQuote, reprocessRefund, retryFailedRefund,
  type PaymentRow, type RefundQuote,
} from '../api';
import { usePayments } from '../api';
import { ReasonDialog, useAdminError, useHasRole } from '../components';
import { downloadText, toCsv } from '../csv';

const STATUSES = ['captured', 'partially_refunded', 'refunded', 'created', 'failed'] as const;
const STATUS_VARIANT: Record<string, BadgeProps['variant']> = { captured: 'success', partially_refunded: 'warning', refunded: 'neutral', failed: 'destructive', created: 'outline', authorized: 'outline' };
const REFUND_VARIANT: Record<string, BadgeProps['variant']> = { processed: 'success', initiated: 'warning', failed: 'destructive' };

export function PaymentsPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const today = istDateKey();
  const [from, setFrom] = useState(addDaysKey(today, -6));
  const [to, setTo] = useState(today);
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const errText = useAdminError();
  const rangeOk = from <= to;
  const payments = usePayments({ from: rangeOk ? from : to, to, status: status === 'all' ? undefined : status, q });
  const rows = payments.data ?? [];
  const current = rows.find((r) => r.id === selected) ?? null;

  const totals = useMemo(() => {
    const captured = rows.filter((r) => ['captured', 'partially_refunded', 'refunded'].includes(r.status));
    const collected = captured.reduce((s, r) => s + r.amount, 0);
    const refunded = rows.reduce((s, r) => s + refundedAmount(r), 0);
    const inFlight = rows.reduce((s, r) => s + r.refunds.filter((x) => x.status === 'initiated').length, 0);
    return { collected, refunded, net: collected - refunded, inFlight, count: captured.length, failed: rows.filter((r) => r.status === 'failed').length };
  }, [rows]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const data = await reconciliation(from, to);
      const csv = toCsv(
        ['type', 'date_time_ist', 'booking_ref', 'receipt_no', 'gateway', 'order_id', 'payment_id', 'refund_id', 'method', 'amount_inr', 'payment_status', 'refund_status', 'settled', 'settlement_id', 'note'],
        data.map((r) => [r.kind, r.at_ist.replace('T', ' ').slice(0, 19), r.ref_code, r.receipt_no, r.provider, r.order_id, r.payment_id, r.refund_id, r.method, r.amount, r.payment_status, r.refund_status, r.settled ? 'yes' : 'no', r.settlement_id, r.note]),
      );
      downloadText(`sunrise-reconciliation_${from}_${to}.csv`, csv);
      toast.success(t('admin.pay.exported', { count: data.length }));
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title={t('admin.payments')} subtitle={t('admin.pay.subtitle')}
        actions={<Button variant="outline" loading={exporting} disabled={!rangeOk} onClick={() => void exportCsv()}><FileSpreadsheet aria-hidden /><span className="hidden sm:inline">{t('admin.pay.export')}</span></Button>} />

      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5"><Label htmlFor="p-from">{t('admin.pay.from')}</Label><Input id="p-from" type="date" max={to} value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="p-to">{t('admin.pay.to')}</Label><Input id="p-to" type="date" max={today} value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <div className="space-y-1.5">
            <Label htmlFor="p-status">{t('admin.pay.status')}</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="p-status"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">{t('patient.doctors.any')}</SelectItem>{STATUSES.map((s) => <SelectItem key={s} value={s}>{t(`admin.pay.st.${s}`)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-q">{t('admin.pay.search')}</Label>
            <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input id="p-q" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('admin.pay.searchPh')} /></div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-live="polite">
        <Tile label={t('admin.pay.collected')} value={inr(totals.collected, lang)} hint={t('admin.pay.nPayments', { count: totals.count })} />
        <Tile label={t('admin.pay.refunded')} value={inr(totals.refunded, lang)} hint={totals.inFlight ? t('admin.pay.inFlight', { count: totals.inFlight }) : undefined} />
        <Tile label={t('admin.pay.net')} value={inr(totals.net, lang)} strong />
        <Tile label={t('admin.pay.failed')} value={String(totals.failed)} />
      </div>

      {payments.isPending ? <ListSkeleton rows={4} /> : payments.isError ? <ErrorState onRetry={() => void payments.refetch()} /> : rows.length === 0 ? (
        <Card><EmptyState art="search" title={t('admin.pay.none')} /></Card>
      ) : (
        <Card className="overflow-hidden">
          {/* table on md+, stacked rows on phones */}
          <table className="hidden w-full text-sm md:table">
            <thead><tr className="border-b text-left text-xs text-muted-foreground">
              {['date', 'booking', 'doctor', 'method', 'amount', 'refundedCol', 'status'].map((h) => <th key={h} className={`px-4 py-2 font-medium ${['amount', 'refundedCol'].includes(h) ? 'text-right' : ''}`}>{t(`admin.pay.col.${h}`)}</th>)}
            </tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="cursor-pointer border-b last:border-0 hover:bg-accent" onClick={() => setSelected(p.id)}>
                  <td className="whitespace-nowrap px-4 py-2.5">{formatDateTime(p.captured_at ?? p.created_at, lang)}</td>
                  <td className="px-4 py-2.5"><button className="font-mono font-semibold text-primary underline-offset-2 hover:underline" onClick={(e) => { e.stopPropagation(); setSelected(p.id); }}>{p.appointments?.ref_code}</button><span className="block text-xs text-muted-foreground">{p.appointments?.patients?.full_name}</span></td>
                  <td className="px-4 py-2.5">{p.appointments?.doctors?.full_name}</td>
                  <td className="px-4 py-2.5">{p.method ? t(`pay.method.${p.method}`) : '—'}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{inr(p.amount, lang)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{refundedAmount(p) ? inr(refundedAmount(p), lang) : '—'}</td>
                  <td className="px-4 py-2.5"><Badge variant={STATUS_VARIANT[p.status]}>{t(`admin.pay.st.${p.status}`)}</Badge>{p.settled && <Badge variant="outline" className="ml-1">{t('admin.pay.settled')}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="divide-y md:hidden">
            {rows.map((p) => (
              <li key={p.id}>
                <button className="flex w-full items-center gap-3 p-4 text-left hover:bg-accent" onClick={() => setSelected(p.id)}>
                  <div className="min-w-0 flex-1">
                    <p className="font-mono font-semibold">{p.appointments?.ref_code}</p>
                    <p className="truncate text-xs text-muted-foreground">{formatDateTime(p.captured_at ?? p.created_at, lang)} · {p.appointments?.doctors?.full_name}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold tabular-nums">{inr(p.amount, lang)}</p>
                    <Badge variant={STATUS_VARIANT[p.status]}>{t(`admin.pay.st.${p.status}`)}</Badge>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Sheet open={!!current} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent side="right" closeLabel={t('common.close')} className="w-full overflow-y-auto sm:max-w-md">
          {current && <PaymentDetail p={current} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Tile({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className={`mt-1 text-xl tabular-nums ${strong ? 'font-extrabold text-primary' : 'font-bold'}`}>{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function PaymentDetail({ p }: { p: PaymentRow }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const qc = useQueryClient();
  const errText = useAdminError();
  const canRefund = useHasRole('admin', 'finance');
  const canCancel = useHasRole('admin');
  const [refunding, setRefunding] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [kind, setKind] = useState<'full' | 'partial'>('full');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<RefundQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const refundable = refundableAmount(p);
  const a = p.appointments;
  const upcoming = a?.status === 'confirmed' && new Date(a.start_at) > new Date();
  const value = kind === 'full' ? refundable : Number(amount);
  const amountOk = Number.isInteger(value) && value > 0 && value <= refundable;
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'payments'] });

  const openRefund = () => {
    setKind('full');
    setAmount('');
    setRefunding(true);
    void refundQuote(p.appointment_id, 'patient').then(setQuote).catch(() => setQuote(null));
  };
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      await refresh();
      return true;
    } catch (e) {
      toast.error(errText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const rows: [string, string | null | undefined][] = [
    [t('admin.pay.d.patient'), a?.patients?.full_name],
    [t('admin.pay.d.doctor'), a?.doctors?.full_name],
    [t('admin.pay.d.consult'), a ? `${formatDateTime(a.start_at, lang)} · ${t(`patient.mode.${a.mode}`)} · ${t(`admin.pay.apptStatus.${a.status}`, { defaultValue: a.status })}` : null],
    [t('admin.pay.d.receipt'), p.receipt_no],
    [t('admin.pay.d.gateway'), p.provider === 'razorpay' ? 'Razorpay' : t('admin.pay.testGateway')],
    [t('admin.pay.d.order'), p.provider_order_id],
    [t('admin.pay.d.payment'), p.provider_payment_id],
    [t('admin.pay.d.method'), p.method ? t(`pay.method.${p.method}`) : null],
    [t('admin.pay.d.paidAt'), p.captured_at ? formatDateTime(p.captured_at, lang) : null],
    [t('admin.pay.d.verified'), p.verified_via ? t(`admin.pay.via.${p.verified_via}`) : null],
    [t('admin.pay.d.settlement'), p.settled ? p.settlement_id ?? t('admin.pay.settled') : t('admin.pay.notSettled')],
    [t('admin.pay.d.failure'), p.failure_reason],
  ];

  return (
    <div className="space-y-4">
      <div>
        <SheetTitle className="font-mono">{a?.ref_code}</SheetTitle>
        <SheetDescription className="flex items-center gap-2"><span className="text-2xl font-extrabold text-foreground tabular-nums">{inr(p.amount, lang)}</span><Badge variant={STATUS_VARIANT[p.status]}>{t(`admin.pay.st.${p.status}`)}</Badge></SheetDescription>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        {rows.filter(([, v]) => v).map(([k, v]) => (<div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="break-all">{v}</dd></div>))}
      </dl>

      <div className="flex flex-wrap gap-2">
        {p.receipt_no && <Button variant="outline" size="sm" onClick={() => void downloadReceipt(p.id).catch((e) => toast.error(errText(e)))}><Download aria-hidden />{t('admin.pay.receipt')}</Button>}
        {canRefund && refundable > 0 && <Button size="sm" onClick={openRefund}><Undo2 aria-hidden />{t('admin.pay.refund')}</Button>}
        {canCancel && upcoming && <Button size="sm" variant="destructive" onClick={() => setCancelling(true)}><Ban aria-hidden />{t('admin.pay.cancelBooking')}</Button>}
      </div>

      <Separator />
      <div>
        <h3 className="mb-2 text-sm font-semibold">{t('admin.pay.refunds')}</h3>
        {p.refunds.length === 0 ? <p className="text-sm text-muted-foreground">{t('admin.pay.noRefunds')}</p> : (
          <ul className="space-y-2">
            {[...p.refunds].sort((x, y) => x.created_at.localeCompare(y.created_at)).map((r) => (
              <li key={r.id} className="rounded-xl border p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold tabular-nums">{inr(r.amount, lang)}</span>
                  <Badge variant={REFUND_VARIANT[r.status]}>{t(`admin.pay.rst.${r.status}`)}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(r.processed_at ?? r.created_at, lang)}{r.provider_refund_id ? ` · ${r.provider_refund_id}` : ''}</p>
                <p className="text-xs">{r.reason}</p>
                {r.failure_reason && <p className="text-xs text-destructive">{r.failure_reason}</p>}
                {canRefund && r.status === 'failed' && <Button variant="link" size="sm" className="px-0" disabled={busy} onClick={() => void act(() => retryFailedRefund(r.id), t('admin.pay.retried'))}><RotateCw aria-hidden />{t('admin.pay.retry')}</Button>}
                {canRefund && r.status === 'initiated' && !r.provider_refund_id && <Button variant="link" size="sm" className="px-0" disabled={busy} onClick={() => void act(() => reprocessRefund(r.id), t('admin.pay.retried'))}><RotateCw aria-hidden />{t('admin.pay.processNow')}</Button>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ReasonDialog open={refunding} onOpenChange={setRefunding} title={t('admin.pay.refundTitle', { ref: a?.ref_code })} description={t('admin.pay.refundable', { amount: inr(refundable, lang) })}
        confirmLabel={amountOk ? t('admin.pay.refundAmount', { amount: inr(value, lang) }) : t('admin.pay.refund')} busy={busy} valid={amountOk}
        onConfirm={(reason) => void act(() => issueRefund(p.id, value, reason), t('admin.pay.refundDone')).then((ok) => ok && setRefunding(false))}>
        <RadioGroup value={kind} onValueChange={(v) => setKind(v as 'full' | 'partial')} className="grid grid-cols-2 gap-2">
          {(['full', 'partial'] as const).map((k) => (
            <label key={k} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border px-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary-soft/40">
              <RadioGroupItem value={k} />{t(`admin.pay.${k}`)}
            </label>
          ))}
        </RadioGroup>
        {kind === 'partial' && (
          <div className="space-y-1.5">
            <Label htmlFor="refund-amount">{t('admin.fee.amount')}</Label>
            <div className="flex"><span className="inline-flex items-center rounded-l-xl border border-r-0 bg-muted px-3 text-sm">₹</span>
              <Input id="refund-amount" inputMode="numeric" className="rounded-l-none" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} aria-invalid={amount !== '' && !amountOk} /></div>
            {amount !== '' && !amountOk && <p className="text-xs text-destructive">{t('admin.pay.amountRange', { max: inr(refundable, lang) })}</p>}
          </div>
        )}
        {quote && <p className="rounded-xl bg-muted p-3 text-xs">{t('admin.pay.policyHint', { percent: quote.percent, amount: inr(quote.amount, lang), hours: Math.max(0, Math.round(quote.hours_before)) })}</p>}
      </ReasonDialog>

      <ReasonDialog open={cancelling} onOpenChange={setCancelling} title={t('admin.pay.cancelTitle', { ref: a?.ref_code })} description={t('admin.pay.cancelBody', { amount: inr(refundable, lang) })}
        confirmLabel={t('admin.pay.cancelBooking')} destructive busy={busy}
        onConfirm={(reason) => void act(() => cancelBooking(p.appointment_id, reason), t('admin.pay.cancelled')).then((ok) => ok && setCancelling(false))} />
    </div>
  );
}
