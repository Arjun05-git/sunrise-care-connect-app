import { useMemo, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CalendarCheck, Pill, Stethoscope } from 'lucide-react';
import { ageFromDob, formatDate, formatDateTime } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CardSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { usePatientTimeline } from '../api';
import { DocumentList, STATUS_VARIANT } from '../components';

interface Item { kind: 'consult' | 'rx'; at: string; id: string; node: ReactNode }

const ICON = { consult: Stethoscope, rx: Pill };
const diagLabel = (d: { code?: string; label?: string; name?: string }) => [d.code, d.label ?? d.name].filter(Boolean).join(' ');

/**
 * Everything this doctor may see about one patient, newest first: own consultations with the
 * patient's symptoms and notes, final prescriptions from any Sunrise doctor, and uploaded documents.
 * Opening the timeline writes an audit entry.
 */
export function PatientTimelinePage() {
  const { id = '' } = useParams();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const tl = usePatientTimeline(id);

  const items = useMemo<Item[]>(() => {
    if (!tl.data) return [];
    const notes = new Map(tl.data.notes.map((n) => [n.appointment_id, n]));
    const out: Item[] = [];
    for (const a of tl.data.appointments.filter((x) => x.status !== 'rescheduled')) {
      const note = notes.get(a.id);
      out.push({
        kind: 'consult', at: a.start_at, id: a.id,
        node: (
          <>
            <p className="flex flex-wrap items-center gap-2 font-medium">
              <Link to={`/d/appointments/${a.id}`} className="text-primary underline-offset-2 hover:underline">{formatDateTime(a.start_at, lang)}</Link>
              <Badge variant={STATUS_VARIANT[a.status]}>{t(a.status === 'cancelled' && a.outcome ? `doctor.outcome.${a.outcome}` : `doctor.status.${a.status}`)}</Badge>
              <span className="text-xs text-muted-foreground">{t(`patient.mode.${a.mode}`)} · {t(a.consult_type === 'follow_up' ? 'patient.review.followUp' : 'patient.review.first')}</span>
            </p>
            {a.appointment_symptoms?.description && <p className="mt-1 text-sm text-muted-foreground">{a.appointment_symptoms.description}</p>}
            {note && (note.chief_complaint || note.diagnoses.length > 0) && (
              <p className="mt-1 text-sm"><b>{t('doctor.tl.diagnosis')}:</b> {note.diagnoses.map(diagLabel).join(', ') || note.chief_complaint} {note.status !== 'final' && <Badge variant="outline">{t('doctor.tl.draft')}</Badge>}</p>
            )}
          </>
        ),
      });
    }
    for (const rx of tl.data.prescriptions) {
      out.push({
        kind: 'rx', at: rx.finalized_at ?? '', id: rx.id,
        node: (
          <>
            <p className="font-medium">{t('doctor.tl.rx', { doctor: rx.doctors?.full_name ?? '', v: rx.version })} · <span className="text-muted-foreground">{rx.finalized_at && formatDate(rx.finalized_at, lang)}</span></p>
            {rx.diagnoses.length > 0 && <p className="text-sm">{rx.diagnoses.map(diagLabel).join(', ')}</p>}
            <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
              {rx.prescription_items.map((it, i) => <li key={i}>{it.drug_name} {it.strength} – {[it.dose, it.frequency, it.duration].filter(Boolean).join(', ')}</li>)}
            </ul>
          </>
        ),
      });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }, [tl.data, t, lang]);

  if (tl.isPending) return <><PageHeader back="/d/patients" title={t('doctor.tl.title')} /><CardSkeleton /></>;
  if (tl.isError || !tl.data) return <><PageHeader back="/d/patients" title={t('doctor.tl.title')} /><EmptyState art="users" title={t('doctor.tl.notVisible')} /></>;
  const p = tl.data.patient;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader back title={p.full_name} subtitle={`${t('patient.age', { count: ageFromDob(p.date_of_birth) })} · ${t(`patient.gender.${p.gender}`)}${p.blood_group ? ` · ${p.blood_group}` : ''}${p.his_mrn ? ` · MRN ${p.his_mrn}` : ''}`} />
      {p.allergies.length > 0 && (
        <p role="note" className="flex gap-2 rounded-xl bg-destructive-soft p-3 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /><span><b>{t('patient.f.allergies')}:</b> {p.allergies.join(', ')}</span></p>
      )}
      <div className="grid gap-4 lg:grid-cols-[1fr_340px] [&>*]:min-w-0">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><CalendarCheck className="h-5 w-5 text-primary" aria-hidden />{t('doctor.tl.history')}</CardTitle></CardHeader>
          <CardContent>
            {items.length === 0 ? <p className="text-sm text-muted-foreground">{t('doctor.tl.empty')}</p> : (
              <ol className="relative space-y-5 border-l pl-6">
                {items.map((it) => {
                  const Icon = ICON[it.kind];
                  return (
                    <li key={`${it.kind}-${it.id}`} className="relative">
                      <span className="absolute -left-[37px] flex h-6 w-6 items-center justify-center rounded-full border bg-card"><Icon className="h-3.5 w-3.5 text-primary" aria-hidden /></span>
                      {it.node}
                    </li>
                  );
                })}
              </ol>
            )}
          </CardContent>
        </Card>
        <Card className="h-fit">
          <CardHeader><CardTitle>{t('doctor.appt.documents', { count: tl.data.documents.length })}</CardTitle></CardHeader>
          <CardContent><DocumentList docs={tl.data.documents} /></CardContent>
        </Card>
      </div>
      <p className="text-xs text-muted-foreground">{t('doctor.tl.auditNote')}</p>
    </div>
  );
}
