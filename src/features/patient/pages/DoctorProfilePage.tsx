import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BadgeCheck, Building2, Gift, Languages, Phone, Star, Video } from 'lucide-react';
import type { ConsultMode } from '@/domain/types';
import { formatDate, formatTime } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { CardSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { cn } from '@/lib/utils';
import { useBookingPreview, useDoctor, useDoctorFees, useFamily, useSlots } from '../api';
import { useBookingDraft } from '../BookingDraft';
import { PersonAvatar, rupees, Steps, StickyBar } from '../components/common';
import { SlotPicker } from '../components/SlotPicker';

export function DoctorProfilePage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const nav = useNavigate();
  const doctor = useDoctor(id);
  const fees = useDoctorFees(id);
  const slots = useSlots(id);
  const family = useFamily();
  const { draft, start } = useBookingDraft();

  const sameDoctorDraft = draft?.doctorId === id ? draft : null;
  const [patientId, setPatientId] = useState<string | undefined>(params.get('patient') ?? sameDoctorDraft?.patientId);
  const [mode, setMode] = useState<ConsultMode | undefined>(sameDoctorDraft?.mode);
  const [slotId, setSlotId] = useState<string | undefined>();

  // defaults once data arrives
  useEffect(() => {
    if (!patientId && family.data?.length) setPatientId(family.data.find((m) => m.is_primary)?.id ?? family.data[0]!.id);
  }, [family.data, patientId]);
  useEffect(() => {
    if (!mode && doctor.data) setMode(doctor.data.modes.includes('video') ? 'video' : doctor.data.modes[0]);
  }, [doctor.data, mode]);

  const selected = slots.data?.find((s) => s.id === slotId);

  const preview = useBookingPreview(id, patientId, slotId, mode);

  if (doctor.isPending) return <><PageHeader back title={<Skeleton className="h-7 w-48" />} /><CardSkeleton /></>;
  if (doctor.isError) return <><PageHeader back="/p/doctors" title={t('patient.doctors.title')} /><EmptyState art="search" title={t('patient.err.doctor_unavailable')} /></>;
  const d = doctor.data;
  const feeFor = (m: ConsultMode) => fees.data?.find((f) => f.mode === m)?.first_fee;

  const proceed = () => {
    if (!selected || !mode || !patientId) return;
    start({ doctorId: id, doctorName: d.full_name, patientId, slotId: selected.id, slotStart: selected.start_at, mode });
    nav('/p/book/details');
  };

  return (
    <div className="pb-28">
      <PageHeader back title={d.full_name} subtitle={i18n.language === 'ml' ? d.department_name_ml : d.department_name} />
      <Steps current={1} />
      <div className="grid grid-cols-1 gap-4 [&>*]:min-w-0 lg:grid-cols-[360px_minmax(0,1fr)]">
        <Card className="h-fit">
          <CardContent className="p-5">
            <div className="flex gap-4">
              <PersonAvatar name={d.full_name} src={d.photo_url} className="h-20 w-20" />
              <div className="min-w-0">
                <p className="flex items-center gap-1 text-lg font-bold">{d.full_name}<BadgeCheck className="h-5 w-5 text-primary" aria-label={t('patient.doctors.verified')} /></p>
                <p className="text-sm text-muted-foreground">{d.qualification}</p>
                <p className="mt-1 text-sm">{t('patient.doctors.years', { count: d.experience_years })}</p>
                {d.rating_count > 0 && <p className="mt-1 flex items-center gap-1 text-sm"><Star className="h-4 w-4 fill-highlight text-highlight" aria-hidden />{Number(d.rating_avg).toFixed(1)} · {t('patient.doctors.ratings', { count: d.rating_count })}</p>}
              </div>
            </div>
            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex gap-2"><Building2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden /><dd>{d.hospital_name}, {d.hospital_city}</dd></div>
              <div className="flex gap-2"><Languages className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden /><dd>{d.languages.join(', ')}</dd></div>
              <div className="flex gap-2"><BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden /><dd>{t('patient.doctors.registration', { no: d.registration_no, council: d.registration_council })}</dd></div>
            </dl>
            {d.bio && <p className="mt-4 text-sm text-muted-foreground">{d.bio}</p>}
          </CardContent>
        </Card>

        <div className="min-w-0 space-y-4">
          <Card>
            <CardContent className="grid gap-4 p-5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="who">{t('patient.book.forWhom')}</Label>
                <Select value={patientId} onValueChange={(v) => { setPatientId(v); }}>
                  <SelectTrigger id="who"><SelectValue placeholder={t('patient.f.choose')} /></SelectTrigger>
                  <SelectContent>
                    {family.data?.map((m) => <SelectItem key={m.id} value={m.id}>{m.full_name}{m.is_primary ? ` (${t('patient.family.you')})` : ''}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <fieldset className="space-y-1.5">
                <legend className="mb-1.5 text-sm font-medium">{t('patient.doctors.mode')}</legend>
                <div className="grid grid-cols-2 gap-2">
                  {d.modes.map((m) => (
                    <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
                      className={cn('flex min-h-11 flex-col items-start rounded-xl border px-3 py-2 text-left text-sm transition-colors', mode === m ? 'border-primary bg-primary-soft/60' : 'hover:bg-accent')}>
                      <span className="flex items-center gap-1.5 font-semibold">{m === 'video' ? <Video className="h-4 w-4" aria-hidden /> : <Phone className="h-4 w-4" aria-hidden />}{t(`patient.mode.${m}`)}</span>
                      {feeFor(m) != null && <span className="text-xs text-muted-foreground">{rupees(feeFor(m)!, lang)}</span>}
                    </button>
                  ))}
                </div>
              </fieldset>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5">
              <h2 className="mb-3 font-semibold">{t('patient.book.pickTime')}</h2>
              <SlotPicker slots={slots} value={slotId} onChange={setSlotId} />
            </CardContent>
          </Card>
        </div>
      </div>

      {/* sticky summary + CTA */}
      <StickyBar>
          <div className="min-w-0 flex-1 text-sm" aria-live="polite">
            {selected ? (
              <>
                <p className="truncate font-semibold">{formatDate(selected.start_at, lang)}, {formatTime(selected.start_at, lang)}</p>
                {preview.isPending ? <Skeleton className="mt-1 h-4 w-24" /> : preview.data && (
                  preview.data.is_free
                    ? <p className="flex items-center gap-1 font-semibold text-warning"><Gift className="h-4 w-4" aria-hidden />{t('patient.book.freeFollowUp')}</p>
                    : <p className="text-muted-foreground">{t(preview.data.consult_type === 'follow_up' ? 'patient.book.followUpFee' : 'patient.book.consultFee')}: <b className="text-foreground">{rupees(preview.data.fee, lang)}</b></p>
                )}
              </>
            ) : <p className="text-muted-foreground">{t('patient.book.selectSlot')}</p>}
          </div>
          <Button size="lg" disabled={!selected || !patientId || !mode} onClick={proceed}>{t('patient.book.continue')}</Button>
      </StickyBar>
    </div>
  );
}
