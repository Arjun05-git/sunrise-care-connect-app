import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, FileText, ImageIcon, ZoomIn, ZoomOut } from 'lucide-react';
import type { AppointmentSymptoms, MedicalDocument } from '@/domain/types';
import { formatDate } from '@/domain/time';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { RED_FLAGS } from '@/features/patient/symptoms';
import { getSupabase } from '@/lib/supabase';
import { signedDocumentUrl } from '@/features/patient/api';
import { formatBytes } from '@/features/patient/documents';
import type { DoctorAppt } from './api';

export const STATUS_VARIANT: Record<string, BadgeProps['variant']> = {
  confirmed: 'default', in_progress: 'highlight', completed: 'success', no_show: 'warning', cancelled: 'destructive', rescheduled: 'neutral', pending_payment: 'outline',
};

/** Status chip; a confirmed booking with a pending proposal shows "Reschedule pending". */
export function ApptStatus({ a }: { a: Pick<DoctorAppt, 'status' | 'outcome' | 'reschedule_requests'> }) {
  const { t } = useTranslation();
  const pending = a.reschedule_requests?.some((r) => r.status === 'pending');
  if (a.status === 'confirmed' && pending) return <Badge variant="warning">{t('doctor.status.reschedulePending')}</Badge>;
  const key = a.status === 'cancelled' && a.outcome ? `doctor.outcome.${a.outcome}` : `doctor.status.${a.status}`;
  return <Badge variant={STATUS_VARIANT[a.status]}>{t(key)}</Badge>;
}

export interface ClinicSettings { join_window_minutes: number; patient_grace_minutes: number; doctor_grace_minutes: number }
export function useClinicSettings() {
  return useQuery({
    queryKey: ['doctor', 'settings'],
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error } = await getSupabase().from('app_settings').select('key, value').in('key', ['join_window_minutes', 'patient_grace_minutes', 'doctor_grace_minutes']);
      if (error) throw error;
      return Object.fromEntries((data ?? []).map((r) => [r.key, Number(r.value)])) as unknown as ClinicSettings;
    },
  });
}

/** Translated RPC error (doctor.err.<code>, falling back to the generic message). */
export function useDoctorError() {
  const { t, i18n } = useTranslation();
  return (e: unknown) => {
    const code = (e as { message?: string })?.message ?? '';
    return i18n.exists(`doctor.err.${code}`) ? t(`doctor.err.${code}`) : t('common.error');
  };
}

/** Ticks every `ms` so countdowns and "available from" hints stay current. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * Medical documents: list + viewer (images with zoom, PDFs inline), previous / next. Files are fetched
 * through 60-second signed URLs; storage RLS only signs them for the treating doctor.
 */
export function DocumentList({ docs }: { docs: MedicalDocument[] }) {
  const { t, i18n } = useTranslation();
  const [index, setIndex] = useState<number | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  const [failed, setFailed] = useState(false);
  const doc = index != null ? docs[index] : null;

  useEffect(() => {
    if (!doc) return;
    setUrl(null);
    setFailed(false);
    setZoom(false);
    let alive = true;
    signedDocumentUrl(doc.storage_path).then((u) => alive && setUrl(u)).catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [doc]);

  if (!docs.length) return <p className="text-sm text-muted-foreground">{t('doctor.appt.noDocs')}</p>;
  return (
    <>
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2">
        {docs.map((d, i) => (
          <li key={d.id}>
            <button type="button" onClick={() => setIndex(i)} className="flex w-full items-center gap-3 rounded-xl border bg-card p-2.5 text-left hover:bg-accent" aria-label={t('patient.docs.previewName', { name: d.file_name })}>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft">
                {d.mime_type === 'application/pdf' ? <FileText className="h-5 w-5 text-primary" aria-hidden /> : <ImageIcon className="h-5 w-5 text-primary" aria-hidden />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{d.file_name}</span>
                <span className="block text-xs text-muted-foreground">{t(`patient.docs.tag.${d.tag}`)} · {formatBytes(d.size_bytes)} · {formatDate(d.created_at, i18n.language)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <Dialog open={doc != null} onOpenChange={(o) => !o && setIndex(null)}>
        <DialogContent closeLabel={t('common.close')} className="max-w-4xl">
          {doc && (
            <>
              <DialogHeader>
                <DialogTitle className="truncate pr-8">{doc.file_name}</DialogTitle>
                <DialogDescription>{t(`patient.docs.tag.${doc.tag}`)} · {t('doctor.appt.docCount', { n: index! + 1, total: docs.length })}</DialogDescription>
              </DialogHeader>
              <div className="relative min-h-[50dvh] overflow-auto rounded-lg border bg-muted/40">
                {failed ? <p className="p-6 text-sm text-destructive">{t('common.error')}</p>
                  : !url ? <div className="flex h-[50dvh] items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-primary-soft border-t-primary" role="status" aria-label={t('common.loading')} /></div>
                  : doc.mime_type === 'application/pdf' ? <iframe title={doc.file_name} src={url} className="h-[70dvh] w-full" />
                  : <img src={url} alt={doc.file_name} onClick={() => setZoom((z) => !z)} className={zoom ? 'max-w-none cursor-zoom-out' : 'mx-auto max-h-[70dvh] w-auto cursor-zoom-in object-contain'} />}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex gap-1">
                  <Button variant="outline" size="icon" disabled={index === 0} onClick={() => setIndex((i) => i! - 1)} aria-label={t('doctor.appt.prevDoc')}><ChevronLeft className="h-4 w-4" /></Button>
                  <Button variant="outline" size="icon" disabled={index === docs.length - 1} onClick={() => setIndex((i) => i! + 1)} aria-label={t('doctor.appt.nextDoc')}><ChevronRight className="h-4 w-4" /></Button>
                </div>
                <div className="flex gap-1">
                  {doc.mime_type !== 'application/pdf' && <Button variant="outline" size="sm" onClick={() => setZoom((z) => !z)}>{zoom ? <ZoomOut aria-hidden /> : <ZoomIn aria-hidden />}{t(zoom ? 'doctor.appt.fit' : 'doctor.appt.zoom')}</Button>}
                  {url && <Button variant="outline" size="sm" asChild><a href={url} target="_blank" rel="noreferrer noopener"><ExternalLink aria-hidden />{t('doctor.appt.openTab')}</a></Button>}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Fact({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return <div><p className="text-xs text-muted-foreground">{label}</p><p className={cn('font-medium', strong && 'text-destructive')}>{value}</p></div>;
}

/** Pre-consultation answers: red flags first, then area / duration / severity, vitals and history. */
export function SymptomsView({ sym, compact }: { sym: AppointmentSymptoms | null; compact?: boolean }) {
  const { t } = useTranslation();
  if (!sym) return <p className="text-sm text-muted-foreground">{t('doctor.appt.noSymptoms')}</p>;
  const redFlags = sym.symptoms.filter((s) => RED_FLAGS.includes(s));
  return (
    <div className="space-y-3 text-sm">
      {redFlags.length > 0 && <p className="flex items-center gap-2 font-semibold text-destructive"><AlertTriangle className="h-4 w-4" aria-hidden />{t('doctor.appt.redFlag', { list: redFlags.map((s) => t(`patient.symptom.${s}`)).join(', ') })}</p>}
      <div className={cn('grid gap-2', compact ? 'grid-cols-3' : 'sm:grid-cols-3')}>
        <Fact label={t('patient.pre.bodyArea')} value={sym.body_area ? t(`patient.area.${sym.body_area}`, { defaultValue: sym.body_area }) : '—'} />
        <Fact label={t('patient.pre.duration')} value={sym.duration ? t(`patient.duration.${sym.duration}`, { defaultValue: sym.duration }) : '—'} />
        <Fact label={t('patient.pre.severity')} value={`${sym.severity}/10`} strong={sym.severity >= 8} />
      </div>
      {sym.symptoms.length > 0 && <div className="flex flex-wrap gap-1.5">{sym.symptoms.map((s) => <Badge key={s} variant={RED_FLAGS.includes(s) ? 'destructive' : 'neutral'}>{t(`patient.symptom.${s}`, { defaultValue: s })}</Badge>)}</div>}
      {sym.description && <p className="whitespace-pre-line rounded-xl bg-muted/60 p-3">{sym.description}</p>}
      {Object.keys(sym.vitals ?? {}).length > 0 && (
        <div className="flex flex-wrap gap-2">{Object.entries(sym.vitals).map(([k, v]) => <span key={k} className="rounded-lg border px-2 py-1"><span className="text-xs text-muted-foreground">{t(`patient.vital.${k}`, { defaultValue: k })}</span> <b>{v}</b></span>)}</div>
      )}
      {sym.allergies && <Fact label={t('patient.f.allergies')} value={sym.allergies} strong />}
      {sym.current_medicines && <Fact label={t('patient.pre.medicines')} value={sym.current_medicines} />}
      {sym.past_history && <Fact label={t('patient.pre.history')} value={sym.past_history} />}
    </div>
  );
}

export function NoteDialog({ open, onOpenChange, title, description, confirm, required, busy, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description: string; confirm: string; required?: boolean; busy?: boolean; onConfirm: (note: string) => void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setNote(''); }}>
      <DialogContent closeLabel={t('common.close')}>
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="outcome-note">{t(required ? 'doctor.appt.note' : 'doctor.appt.noteOptional')}</Label>
          <Textarea id="outcome-note" rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button disabled={required && note.trim().length < 5} loading={busy} onClick={() => onConfirm(note.trim())}>{confirm}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
