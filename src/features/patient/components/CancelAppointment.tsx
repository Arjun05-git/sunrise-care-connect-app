import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { formatDateTime } from '@/domain/time';
import { FunctionError } from '@/lib/functions';
import { rpcErrorCode } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { canPatientCancel, cancelAppointment, myApptsKey, qk, refundCase, useCancelQuote, type MyAppointment } from '../api';
import { rupees, useRpcErrorText } from './common';

/**
 * "Cancel appointment" for the patient (or their family): shows what the cancellation policy refunds BEFORE anything
 * is cancelled, then cancels through the server (cancel_appointment: confirmed bookings only, before the start time;
 * the refund is queued and sent to the gateway there). Renders nothing for a booking that cannot be cancelled.
 */
export function CancelAppointment({ a }: { a: MyAppointment }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const qc = useQueryClient();
  const errText = useRpcErrorText();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const quote = useCancelQuote(a.id, open);
  if (!canPatientCancel(a)) return null;

  const confirm = async () => {
    setBusy(true);
    try {
      const res = await cancelAppointment(a.id, reason.trim());
      const amount = res.amount ?? (quote.data && refundCase(quote.data) === 'refund' ? quote.data.amount : 0);
      toast.success(amount > 0 ? t('patient.appts.cancelledRefund', { amount: rupees(amount, lang) }) : t('patient.appts.cancelled'));
      setOpen(false);
      setReason('');
    } catch (e) {
      toast.error(errText(e instanceof FunctionError ? e.code : rpcErrorCode(e)));
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: myApptsKey });
      void qc.invalidateQueries({ queryKey: qk.upcoming });
    }
  };

  const q = quote.data;
  const refund = q ? refundCase(q) : null;
  return (
    <>
      <Button variant="outline" size="sm" className="text-destructive" onClick={() => setOpen(true)} data-testid="cancel-appt">{t('patient.appts.cancel')}</Button>
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{t('patient.appts.cancelTitle')}</DialogTitle>
            <DialogDescription>{t('patient.appts.cancelBody', { doctor: a.doctors?.full_name, time: formatDateTime(a.start_at, lang) })}</DialogDescription>
          </DialogHeader>
          <p className="rounded-xl bg-muted p-3 text-sm" aria-live="polite" data-testid="cancel-refund">
            {quote.isPending ? t('patient.appts.cancelChecking')
              : quote.isError || !q ? t('patient.appts.cancelQuoteError')
              : refund === 'refund' ? t('patient.appts.cancelRefund', { amount: rupees(q.amount, lang), percent: q.percent, paid: rupees(q.paid, lang) })
              : refund === 'no_refund' ? t('patient.appts.cancelNoRefund')
              : t('patient.appts.cancelNothingToRefund')}
          </p>
          <div className="grid gap-1.5">
            <Label htmlFor={`cancel-reason-${a.id}`}>{t('patient.appts.cancelReason')}</Label>
            <Textarea id={`cancel-reason-${a.id}`} rows={2} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>{t('patient.appts.cancelKeep')}</Button>
            <Button variant="destructive" loading={busy} disabled={quote.isPending} onClick={() => void confirm()}>{t('patient.appts.cancelConfirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
