import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { formatDate, formatDateTime, formatTime } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { CardSkeleton } from '@/components/feedback/states';
import { useRealtime } from '@/lib/realtime';
import { rpcErrorCode } from '@/lib/supabase';
import { myApptsKey, qk, resolveDoctorCancellation, respondReschedule, useAppointment, useSlots } from '../api';
import { PersonAvatar, StickyBar, useRpcErrorText } from '../components/common';
import { SlotPicker } from '../components/SlotPicker';

/**
 * Free reschedule with the same doctor (no payment): after declining a same-day proposal (?req=…)
 * or after a doctor-side cancellation. Slots update live while the patient chooses.
 */
export function ChooseTimePage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const req = params.get('req');
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const nav = useNavigate();
  const qc = useQueryClient();
  const errText = useRpcErrorText();
  const appt = useAppointment(id);
  const doctorId = appt.data?.doctor_id ?? '';
  const slots = useSlots(doctorId);
  useRealtime('choose-slots', [{ table: 'slots', filter: `doctor_id=eq.${doctorId}` }], [qk.slots(doctorId)], undefined, !!doctorId);
  const [slotId, setSlotId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const chosen = slots.data?.find((s) => s.id === slotId);

  const confirm = async () => {
    if (!slotId) return;
    setBusy(true);
    try {
      if (req) await respondReschedule(req, 'reschedule', slotId);
      else await resolveDoctorCancellation(id, 'reschedule', slotId);
      await qc.invalidateQueries({ queryKey: myApptsKey });
      toast.success(t('patient.appts.movedToast', { when: chosen ? formatDateTime(chosen.start_at, lang) : '' }));
      nav('/p/appointments', { replace: true });
    } catch (e) {
      const code = rpcErrorCode(e);
      toast.error(errText(code));
      if (code === 'slot_taken') void slots.refetch();
      if (code === 'not_pending' || code === 'not_eligible') nav('/p/appointments', { replace: true });
    } finally {
      setBusy(false);
    }
  };

  if (appt.isPending) return <><PageHeader back="/p/appointments" title={t('patient.appts.chooseTitle')} /><CardSkeleton /></>;
  const a = appt.data;
  return (
    <div className="mx-auto max-w-2xl pb-28">
      <PageHeader back="/p/appointments" title={t('patient.appts.chooseTitle')} subtitle={t('patient.appts.chooseSub')} />
      {a && (
        <Card className="mb-4">
          <CardContent className="flex items-center gap-3 p-4 text-sm">
            <PersonAvatar name={a.doctors?.full_name ?? ''} src={a.doctors?.photo_url} />
            <div><p className="font-semibold">{a.doctors?.full_name}</p><p className="text-muted-foreground">{t('patient.appts.originally', { when: formatDateTime(a.start_at, lang) })} · {t('patient.forName', { name: a.patients?.full_name })}</p></div>
          </CardContent>
        </Card>
      )}
      <Card><CardContent className="p-5"><SlotPicker slots={slots} value={slotId} onChange={setSlotId} /></CardContent></Card>
      <StickyBar>
        <div className="min-w-0 flex-1 text-sm">
          {chosen ? <p className="font-semibold">{formatDate(chosen.start_at, lang)}, {formatTime(chosen.start_at, lang)}</p> : <p className="text-muted-foreground">{t('patient.book.selectSlot')}</p>}
          <p className="text-xs text-muted-foreground">{t('patient.appts.noCharge')}</p>
        </div>
        <Button size="lg" disabled={!slotId} loading={busy} onClick={() => void confirm()}>{t('patient.appts.confirmTime')}</Button>
      </StickyBar>
    </div>
  );
}
