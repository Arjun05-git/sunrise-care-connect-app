import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, CalendarClock, ChevronDown } from 'lucide-react';
import { formatDateTime } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { rpcErrorCode } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { holdSlot, qk, releaseHold, useFamily, useSettings } from '../api';
import { useBookingDraft } from '../BookingDraft';
import { Steps, StickyBar, useRpcErrorText } from '../components/common';
import { DocumentUploader } from '../components/DocumentUploader';
import { BODY_AREAS, DURATIONS, RED_FLAGS, SYMPTOMS, symptomSchema, VITAL_KEYS, type SymptomValues } from '../symptoms';

/** Step 2: pre-consultation details + documents. Submitting places the 10-minute slot hold. */
export function PreConsultPage() {
  const { draft } = useBookingDraft();
  if (!draft) return <Navigate to="/p/doctors" replace />;
  return <PreConsultForm key={`${draft.patientId}-${draft.slotId}`} />;
}

function PreConsultForm() {
  const { t, i18n } = useTranslation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const errText = useRpcErrorText();
  const { draft, update } = useBookingDraft();
  const d = draft!;
  const family = useFamily();
  const settings = useSettings();
  const patient = family.data?.find((m) => m.id === d.patientId);
  const [busy, setBusy] = useState(false);
  const [showVitals, setShowVitals] = useState(false);

  // Came back from review (browser back / edit): give the slot back while editing.
  // Only the hold that existed when this page OPENED – not the one this page creates on submit.
  const heldOnOpen = useRef(d.heldAppointmentId);
  useEffect(() => {
    const held = heldOnOpen.current;
    if (!held) return;
    heldOnOpen.current = undefined;
    void releaseHold(held).finally(() => qc.invalidateQueries({ queryKey: qk.slots(d.doctorId) }));
    update({ heldAppointmentId: undefined });
  }, [d.doctorId, qc, update]);

  const s = d.symptoms;
  const form = useForm<SymptomValues>({
    resolver: zodResolver(symptomSchema),
    defaultValues: {
      body_area: (s?.body_area as SymptomValues['body_area']) ?? undefined,
      symptoms: (s?.symptoms as SymptomValues['symptoms']) ?? [],
      duration: (s?.duration as SymptomValues['duration']) ?? undefined,
      severity: s?.severity ?? 3,
      description: s?.description ?? '',
      vitals: { bp: '', pulse: '', temperature: '', spo2: '', weight: '', sugar: '', ...(s?.vitals ?? {}) },
      allergies: s?.allergies ?? '',
      current_medicines: s?.current_medicines ?? '',
      past_history: s?.past_history ?? '',
    },
  });
  // known allergies from the patient record pre-fill the field once
  useEffect(() => {
    if (patient && !s && !form.getValues('allergies')) form.setValue('allergies', patient.allergies.join(', '));
  }, [patient, s, form]);

  const chosen = useWatch({ control: form.control, name: 'symptoms' });
  const description = useWatch({ control: form.control, name: 'description' });
  const redFlag = chosen.some((c) => RED_FLAGS.includes(c));

  const submit = async (v: SymptomValues) => {
    const symptoms = { ...v, vitals: Object.fromEntries(Object.entries(v.vitals).filter(([, x]) => x !== '')) };
    update({ symptoms });
    setBusy(true);
    try {
      const appt = await holdSlot({ doctorId: d.doctorId, patientId: d.patientId, slotId: d.slotId, mode: d.mode, symptoms, documentIds: d.documents.map((x) => x.id) });
      update({ heldAppointmentId: appt.id });
      nav(`/p/book/review/${appt.id}`);
    } catch (e) {
      const code = rpcErrorCode(e);
      toast.error(errText(code));
      if (code === 'slot_taken' || code === 'slot_not_found') {
        void qc.invalidateQueries({ queryKey: qk.slots(d.doctorId) });
        nav(`/p/doctors/${d.doctorId}?patient=${d.patientId}`);
      } else if (code === 'consent_required') nav('/p/consent?next=/p/book/details');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl pb-28">
      <PageHeader back={`/p/doctors/${d.doctorId}?patient=${d.patientId}`} title={t('patient.pre.title')} />
      <Steps current={2} />
      <div className="mb-4 flex items-center gap-3 rounded-lg border bg-primary-soft/40 p-3 text-sm">
        <CalendarClock className="h-5 w-5 shrink-0 text-primary" aria-hidden />
        <p className="min-w-0 flex-1">
          <b>{d.doctorName}</b> · {formatDateTime(d.slotStart, i18n.language)} · {t(`patient.mode.${d.mode}`)}
          <span className="block text-muted-foreground">{t('patient.forName', { name: patient?.full_name ?? '' })}</span>
        </p>
        <Link to={`/p/doctors/${d.doctorId}?patient=${d.patientId}`} className="font-semibold text-primary">{t('auth.change')}</Link>
      </div>

      <Form {...form}>
        <form id="pre-form" onSubmit={form.handleSubmit(submit)} className="space-y-4" noValidate>
          <Card>
            <CardHeader><CardTitle>{t('patient.pre.whatsWrong')}</CardTitle><CardDescription>{t('patient.pre.whatsWrongHint')}</CardDescription></CardHeader>
            <CardContent className="space-y-5">
              <FormField control={form.control} name="body_area" render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('patient.pre.bodyArea')}</FormLabel>
                  <div role="radiogroup" aria-label={t('patient.pre.bodyArea')} className="flex flex-wrap gap-2">
                    {BODY_AREAS.map((a) => (
                      <Chip key={a} role="radio" selected={field.value === a} onClick={() => field.onChange(a)}>{t(`patient.area.${a}`)}</Chip>
                    ))}
                  </div>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="symptoms" render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('patient.pre.symptoms')} <span className="font-normal text-muted-foreground">({t('patient.pre.pickAny')})</span></FormLabel>
                  <div className="flex flex-wrap gap-2">
                    {SYMPTOMS.map((x) => {
                      const on = field.value.includes(x);
                      return <Chip key={x} selected={on} onClick={() => field.onChange(on ? field.value.filter((y) => y !== x) : [...field.value, x])}>{t(`patient.symptom.${x}`)}</Chip>;
                    })}
                  </div>
                </FormItem>
              )} />
              {redFlag && (
                <div role="alert" className="flex gap-2 rounded-xl border border-destructive/30 bg-destructive-soft p-3 text-sm text-destructive">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
                  <p><b>{t('patient.pre.redFlagTitle')}</b> {t('patient.pre.redFlagBody')} <a href="tel:112" className="font-bold underline">{t('emergency.call')}</a></p>
                </div>
              )}
              <FormField control={form.control} name="duration" render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('patient.pre.duration')}</FormLabel>
                  <div role="radiogroup" aria-label={t('patient.pre.duration')} className="flex flex-wrap gap-2">
                    {DURATIONS.map((x) => <Chip key={x} role="radio" selected={field.value === x} onClick={() => field.onChange(x)}>{t(`patient.duration.${x}`)}</Chip>)}
                  </div>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="severity" render={({ field }) => (
                <FormItem>
                  <div className="flex items-baseline justify-between">
                    <FormLabel>{t('patient.pre.severity')}</FormLabel>
                    <span className={cn('text-sm font-bold', field.value >= 8 ? 'text-destructive' : field.value >= 5 ? 'text-warning' : 'text-primary')}>{field.value}/10 · {t(`patient.pre.sev.${field.value >= 8 ? 'severe' : field.value >= 5 ? 'moderate' : 'mild'}`)}</span>
                  </div>
                  <FormControl><Slider min={0} max={10} step={1} value={[field.value]} onValueChange={([v]) => field.onChange(v)} thumbLabel={t('patient.pre.severity')} /></FormControl>
                  <div className="flex justify-between text-xs text-muted-foreground"><span>{t('patient.pre.sev.none')}</span><span>{t('patient.pre.sev.worst')}</span></div>
                </FormItem>
              )} />
              <FormField control={form.control} name="description" render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('patient.pre.describe')}</FormLabel>
                  <FormControl><Textarea rows={4} maxLength={1000} placeholder={t('patient.pre.describePh')} {...field} /></FormControl>
                  <FormDescription className="flex justify-between"><span>{t('patient.pre.describeHint')}</span><span aria-hidden>{description.length}/1000</span></FormDescription>
                  <FormMessage />
                </FormItem>
              )} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t('patient.pre.health')}</CardTitle><CardDescription>{t('patient.pre.healthHint')}</CardDescription></CardHeader>
            <CardContent className="space-y-5">
              <FormField control={form.control} name="allergies" render={({ field }) => (
                <FormItem><FormLabel>{t('patient.f.allergies')}</FormLabel><FormControl><Input placeholder={t('patient.f.allergiesPh')} {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="current_medicines" render={({ field }) => (
                <FormItem><FormLabel>{t('patient.pre.medicines')}</FormLabel><FormControl><Textarea rows={2} placeholder={t('patient.pre.medicinesPh')} {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="past_history" render={({ field }) => (
                <FormItem><FormLabel>{t('patient.pre.history')}</FormLabel><FormControl><Textarea rows={2} placeholder={t('patient.pre.historyPh')} {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div>
                <Button type="button" variant="ghost" className="-ml-3" aria-expanded={showVitals} aria-controls="vitals" onClick={() => setShowVitals((v) => !v)}>
                  <ChevronDown className={cn('transition-transform', showVitals && 'rotate-180')} aria-hidden />{t('patient.pre.vitals')}
                </Button>
                <div id="vitals" hidden={!showVitals} className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {VITAL_KEYS.map((k) => (
                    <FormField key={k} control={form.control} name={`vitals.${k}`} render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">{t(`patient.vital.${k}`)}</FormLabel>
                        <FormControl><Input inputMode={k === 'bp' ? 'text' : 'decimal'} placeholder={t(`patient.vital.${k}Ph`)} {...field} /></FormControl>
                        <FormMessage />
                      </FormItem>
                    )} />
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t('patient.docs.title')}</CardTitle><CardDescription>{t('patient.docs.subtitle')}</CardDescription></CardHeader>
            <CardContent>
              <DocumentUploader patientId={d.patientId} value={d.documents} onChange={(documents) => update({ documents })} />
            </CardContent>
          </Card>
        </form>
      </Form>

      <StickyBar>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t('patient.pre.holdNote', { minutes: settings.data?.slot_hold_minutes ?? 10 })}</p>
        <Button type="submit" form="pre-form" size="lg" loading={busy}>{t('patient.pre.toReview')}</Button>
      </StickyBar>
    </div>
  );
}

function Chip({ selected, children, onClick, role }: { selected: boolean; children: ReactNode; onClick: () => void; role?: 'radio' }) {
  return (
    <button type="button" role={role} aria-checked={role ? selected : undefined} aria-pressed={role ? undefined : selected} onClick={onClick}
      className={cn('min-h-10 rounded-full border px-3.5 text-sm font-medium transition-colors', selected ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:border-primary/50 hover:bg-primary-soft/40')}>
      {children}
    </button>
  );
}
