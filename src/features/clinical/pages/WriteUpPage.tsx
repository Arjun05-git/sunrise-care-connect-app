import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ClipboardPen, Pill } from 'lucide-react';
import { ageFromDob, formatDateLong, formatTime } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CardSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { useDoctorAppointment } from '@/features/doctor/api';
import { CategoryLegend } from '../legend';
import { NotesEditor } from '../notes';
import { RxBuilder } from '../rx';

/** Doctor: clinical notes and the e-prescription for one consultation, side by side on wide screens. */
export function WriteUpPage() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const appt = useDoctorAppointment(id);
  if (appt.isPending) return <><PageHeader back title={t('clinical.page.title')} /><CardSkeleton /></>;
  const a = appt.data;
  if (!a) return <><PageHeader back="/d" title={t('clinical.page.title')} /><EmptyState art="search" title={t('doctor.appt.notFound')} /></>;
  const p = a.patients!;
  const allergies = [...new Set([...p.allergies, ...(a.appointment_symptoms?.allergies ? [a.appointment_symptoms.allergies] : [])])].filter(Boolean);
  const allowed = ['in_progress', 'completed'].includes(a.status);
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader back={`/d/appointments/${id}`} title={p.full_name}
        subtitle={`${t('patient.age', { count: ageFromDob(p.date_of_birth) })} · ${t(`patient.gender.${p.gender}`)} · ${a.ref_code} · ${formatDateLong(a.start_at, i18n.language)}, ${formatTime(a.start_at, i18n.language)} · ${t(`patient.mode.${a.mode}`)} · ${t(a.consult_type === 'first' ? 'clinical.rx.first' : 'clinical.rx.followUp')}`} />
      {allergies.length > 0 && (
        <p role="note" className="flex gap-2 rounded-xl bg-destructive-soft p-3 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /><span><b>{t('patient.f.allergies')}:</b> {allergies.join(', ')}</span></p>
      )}
      {!allowed && <p className="rounded-xl bg-muted p-3 text-sm">{t('clinical.page.notYet')}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><ClipboardPen className="h-5 w-5 text-primary" aria-hidden />{t('clinical.page.notes')}</CardTitle></CardHeader>
          <CardContent><NotesEditor appointmentId={id} /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Pill className="h-5 w-5 text-primary" aria-hidden />{t('clinical.page.rx')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">{allowed ? <RxBuilder appointmentId={id} /> : <p className="text-sm text-muted-foreground">{t('clinical.err.rx_not_allowed')}</p>}<CategoryLegend /></CardContent>
        </Card>
      </div>
    </div>
  );
}
