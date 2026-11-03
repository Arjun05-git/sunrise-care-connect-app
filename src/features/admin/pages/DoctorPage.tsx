import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BadgeCheck, Ban, Check, ExternalLink, FileUp, KeyRound, RotateCcw, Save, Send, ShieldCheck, ShieldX } from 'lucide-react';
import type { ConsultMode } from '@/domain/types';
import { formatDateTime } from '@/domain/time';
import { useAuth } from '@/auth/AuthProvider';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { CardSkeleton, ErrorState } from '@/components/feedback/states';
import { cn } from '@/lib/utils';
import { ReadOnlyNote, ReasonDialog, useAdminError, useHasRole } from '../components';
import {
  cqk, createDoctorLogin, openCredential, reinstateDoctor, saveDoctor, submitDoctor, suspendDoctor, uploadCredential, useDoctor, useMasters, verifyDoctor,
  type Credential, type DoctorInput, type DoctorRow,
} from '../console-api';
import { VERIFY_VARIANT } from './DoctorsPage';

const EMPTY: DoctorInput = { full_name: '', phone: '+91', qualification: '', registration_no: '', registration_council: 'Travancore-Cochin Medical Council', experience_years: 0, languages: ['English', 'Malayalam'], hospital_id: '', department_id: '', bio: '', modes: ['video', 'audio'], slot_minutes: 15, his_doctor_code: '' };
const KINDS: Credential['kind'][] = ['registration_certificate', 'degree', 'id_proof', 'other'];
const toInput = (d: DoctorRow): DoctorInput => ({
  full_name: d.full_name, phone: d.phone, qualification: d.qualification, registration_no: d.registration_no, registration_council: d.registration_council,
  experience_years: d.experience_years, languages: d.languages, hospital_id: d.hospital_id, department_id: d.department_id, bio: d.bio ?? '', modes: d.modes,
  slot_minutes: d.slot_minutes, his_doctor_code: d.his_doctor_code ?? '',
});

/**
 * One doctor: profile → phone login → registration certificate → submit → a SECOND admin verifies
 * (or rejects with the reason). Verified doctors can be suspended (future bookings cancelled, patients
 * choose free reschedule or refund); reinstating needs verification again.
 */
export function DoctorPage() {
  const { id } = useParams();
  const isNew = id === 'new';
  const { t } = useTranslation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const errText = useAdminError();
  const q = useDoctor(isNew ? undefined : id);
  const masters = useMasters();
  const canEdit = useHasRole('admin', 'coordinator');
  const [form, setForm] = useState<DoctorInput>(EMPTY);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const d = q.data?.doctor;
  useEffect(() => { if (d) setForm(toInput(d)); }, [d]);

  const set = (p: Partial<DoctorInput>) => setForm((f) => ({ ...f, ...p }));
  const regLocked = !!d && ['verified', 'pending'].includes(d.verification_status);
  const valid = form.full_name.trim().length >= 3 && /^\+91[6-9]\d{9}$/.test(form.phone) && form.registration_no.trim().length >= 3 &&
    form.registration_council.trim().length >= 3 && form.qualification.trim().length >= 2 && !!form.hospital_id && !!form.department_id && form.modes.length > 0;
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: cqk.doctors }), qc.invalidateQueries({ queryKey: cqk.doctor(id ?? '') })]);

  const save = async (reason: string) => {
    setBusy(true);
    try {
      const newId = await saveDoctor(isNew ? null : id!, { ...form, registration_no: form.registration_no.trim() }, reason);
      toast.success(t('adm.doc.saved'));
      setConfirm(false);
      await refresh();
      if (isNew) nav(`/a/doctors/${newId}`, { replace: true });
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!isNew && q.isPending) return <CardSkeleton />;
  if (!isNew && (q.isError || !d)) return <ErrorState onRetry={() => void q.refetch()} />;
  const hospitals = (masters.data?.hospitals ?? []).filter((h) => h.active || h.id === form.hospital_id);
  const departments = (masters.data?.departments ?? []).filter((x) => x.active || x.id === form.department_id);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader back="/a/doctors" title={isNew ? t('adm.doc.new') : d!.full_name}
        subtitle={d ? <Badge variant={VERIFY_VARIANT[d.verification_status]} data-ref="doc-status">{t(`adm.doc.st.${d.verification_status}`)}</Badge> : t('adm.doc.newHint')} />
      {d && <Steps d={d} creds={q.data!.credentials} />}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <CardHeader><CardTitle>{t('adm.doc.profile')}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {!canEdit && <ReadOnlyNote>{t('adm.doc.readOnly')}</ReadOnlyNote>}
            <fieldset disabled={!canEdit} className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
              <F id="d-name" label={t('adm.doc.f.full_name')}><Input id="d-name" value={form.full_name} maxLength={120} onChange={(e) => set({ full_name: e.target.value })} /></F>
              <F id="d-phone" label={t('adm.doc.f.phone')} hint={d?.profile_id ? t('adm.doc.phoneLocked') : t('adm.doc.phoneHint')}>
                <Input id="d-phone" inputMode="tel" value={form.phone} disabled={!!d?.profile_id} onChange={(e) => set({ phone: e.target.value.replace(/[^\d+]/g, '') })} /></F>
              <F id="d-qual" label={t('adm.doc.f.qualification')}><Input id="d-qual" value={form.qualification} maxLength={200} onChange={(e) => set({ qualification: e.target.value })} /></F>
              <F id="d-exp" label={t('adm.doc.f.experience_years')}><Input id="d-exp" type="number" min={0} max={70} value={form.experience_years} onChange={(e) => set({ experience_years: Number(e.target.value) })} /></F>
              <F id="d-reg" label={t('adm.doc.f.registration_no')} hint={regLocked ? t('adm.doc.regLocked') : undefined}>
                <Input id="d-reg" value={form.registration_no} disabled={regLocked} maxLength={40} onChange={(e) => set({ registration_no: e.target.value })} /></F>
              <F id="d-council" label={t('adm.doc.f.registration_council')}>
                <Input id="d-council" list="councils" value={form.registration_council} disabled={regLocked} maxLength={120} onChange={(e) => set({ registration_council: e.target.value })} />
                <datalist id="councils"><option value="Travancore-Cochin Medical Council" /><option value="National Medical Commission" /><option value="Tamil Nadu Medical Council" /><option value="Karnataka Medical Council" /></datalist></F>
              <F id="d-hosp" label={t('adm.doc.f.hospital')}>
                <Select value={form.hospital_id} onValueChange={(v) => set({ hospital_id: v })}><SelectTrigger id="d-hosp"><SelectValue placeholder={t('adm.doc.choose')} /></SelectTrigger>
                  <SelectContent>{hospitals.map((h) => <SelectItem key={h.id} value={h.id}>{h.name}</SelectItem>)}</SelectContent></Select></F>
              <F id="d-dept" label={t('adm.doc.f.department')}>
                <Select value={form.department_id} onValueChange={(v) => set({ department_id: v })}><SelectTrigger id="d-dept"><SelectValue placeholder={t('adm.doc.choose')} /></SelectTrigger>
                  <SelectContent>{departments.map((x) => <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>)}</SelectContent></Select></F>
              <F id="d-lang" label={t('adm.doc.f.languages')} hint={t('adm.doc.languagesHint')}>
                <Input id="d-lang" value={form.languages.join(', ')} onChange={(e) => set({ languages: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></F>
              <F id="d-slot" label={t('adm.doc.f.slot_minutes')}>
                <Select value={String(form.slot_minutes)} onValueChange={(v) => set({ slot_minutes: Number(v) })}><SelectTrigger id="d-slot"><SelectValue /></SelectTrigger>
                  <SelectContent>{[10, 15, 20, 30].map((n) => <SelectItem key={n} value={String(n)}>{t('adm.doc.minutes', { count: n })}</SelectItem>)}</SelectContent></Select></F>
              <fieldset className="space-y-1.5 sm:col-span-2">
                <legend className="text-sm font-medium">{t('adm.doc.f.modes')}</legend>
                <div className="flex gap-4">
                  {(['video', 'audio'] as ConsultMode[]).map((m) => (
                    <label key={m} className="flex items-center gap-2 text-sm"><Checkbox checked={form.modes.includes(m)} onCheckedChange={(v) => set({ modes: v ? [...new Set([...form.modes, m])] : form.modes.filter((x) => x !== m) })} />{t(`patient.mode.${m}`)}</label>
                  ))}
                </div>
              </fieldset>
              <F id="d-his" label={t('adm.doc.f.his_doctor_code')}><Input id="d-his" value={form.his_doctor_code} maxLength={40} onChange={(e) => set({ his_doctor_code: e.target.value })} /></F>
              <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="d-bio">{t('adm.doc.f.bio')}</Label><Textarea id="d-bio" rows={3} maxLength={1000} value={form.bio} onChange={(e) => set({ bio: e.target.value })} /></div>
            </fieldset>
            {canEdit && <div className="flex justify-end"><Button disabled={!valid} onClick={() => setConfirm(true)} data-ref="doc-save"><Save aria-hidden />{isNew ? t('adm.doc.create') : t('common.save')}</Button></div>}
            <ReasonDialog open={confirm} onOpenChange={setConfirm} title={isNew ? t('adm.doc.create') : t('adm.doc.saveTitle')} confirmLabel={t('common.save')} busy={busy} onConfirm={(r) => void save(r)} />
          </CardContent>
        </Card>

        {d && (
          <div className="min-w-0 space-y-4">
            <LoginCard d={d} onDone={refresh} />
            <Credentials d={d} creds={q.data!.credentials} names={q.data!.names} onDone={refresh} />
          </div>
        )}
      </div>
      {d && <Verification d={d} creds={q.data!.credentials} names={q.data!.names} onDone={refresh} />}
    </div>
  );
}

function F({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label htmlFor={id}>{label}</Label>{children}{hint && <p className="text-xs text-muted-foreground">{hint}</p>}</div>;
}

function Steps({ d, creds }: { d: DoctorRow; creds: Credential[] }) {
  const { t } = useTranslation();
  const steps = [
    { k: 'profile', done: true },
    { k: 'login', done: !!d.profile_id },
    { k: 'certificate', done: creds.some((c) => c.kind === 'registration_certificate') },
    { k: 'submitted', done: ['pending', 'verified', 'suspended'].includes(d.verification_status) },
    { k: 'verified', done: d.verification_status === 'verified' },
  ];
  return (
    <ol className="flex flex-wrap gap-2" aria-label={t('adm.doc.steps')}>
      {steps.map((s, i) => (
        <li key={s.k} className={cn('flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium', s.done ? 'border-success/40 bg-success-soft text-success' : 'text-muted-foreground')}>
          {s.done ? <Check className="h-3.5 w-3.5" aria-hidden /> : <span className="tabular-nums">{i + 1}</span>}
          {t(`adm.doc.step.${s.k}`)}<span className="sr-only">{s.done ? t('adm.doc.done') : t('adm.doc.todo')}</span>
        </li>
      ))}
    </ol>
  );
}

function LoginCard({ d, onDone }: { d: DoctorRow; onDone: () => Promise<unknown> }) {
  const { t } = useTranslation();
  const errText = useAdminError();
  const canEdit = useHasRole('admin', 'coordinator');
  const [busy, setBusy] = useState(false);
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><KeyRound className="h-4 w-4" aria-hidden />{t('adm.doc.login')}</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm">
        {d.profile_id ? <p data-ref="login-ok">{t('adm.doc.loginOk', { phone: d.phone })}</p> : (
          <>
            <p className="text-muted-foreground">{t('adm.doc.loginHint', { phone: d.phone })}</p>
            {canEdit && <Button size="sm" variant="secondary" loading={busy} data-ref="create-login" onClick={() => {
              setBusy(true);
              void createDoctorLogin(d.id).then(() => { toast.success(t('adm.doc.loginCreated')); return onDone(); }).catch((e) => toast.error(errText(e))).finally(() => setBusy(false));
            }}>{t('adm.doc.createLogin')}</Button>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Credentials({ d, creds, names, onDone }: { d: DoctorRow; creds: Credential[]; names: Record<string, string>; onDone: () => Promise<unknown> }) {
  const { t, i18n } = useTranslation();
  const errText = useAdminError();
  const canEdit = useHasRole('admin', 'coordinator');
  const [kind, setKind] = useState<Credential['kind']>('registration_certificate');
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      await uploadCredential(d.id, kind, f);
      toast.success(t('adm.doc.uploaded'));
      await onDone();
    } catch (e) {
      const code = (e as { code?: string }).code;
      toast.error(code === 'file_type' || code === 'file_too_large' ? t(`adm.doc.${code}`) : errText(e));
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">{t('adm.doc.credentials')}</CardTitle><CardDescription>{t('adm.doc.credentialsHint')}</CardDescription></CardHeader>
      <CardContent className="space-y-3 text-sm">
        {creds.length === 0 ? <p className="text-muted-foreground">{t('adm.doc.noCredentials')}</p> : (
          <ul className="divide-y rounded-xl border" data-ref="credentials">
            {creds.map((c) => (
              <li key={c.id} className="flex items-center gap-2 p-2">
                <div className="min-w-0 flex-1"><p className="truncate font-medium">{t(`adm.doc.kind.${c.kind}`)}</p>
                  <p className="truncate text-xs text-muted-foreground">{c.file_name} · {formatDateTime(c.uploaded_at, i18n.language)}{c.uploaded_by && names[c.uploaded_by] ? ` · ${names[c.uploaded_by]}` : ''}</p></div>
                <Button size="icon" variant="ghost" aria-label={t('adm.doc.open', { name: c.file_name })} onClick={() => void openCredential(c.storage_path).catch((e) => toast.error(errText(e)))}><ExternalLink className="h-4 w-4" /></Button>
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <div className="space-y-2">
            <Select value={kind} onValueChange={(v) => setKind(v as Credential['kind'])}>
              <SelectTrigger aria-label={t('adm.doc.kindLabel')}><SelectValue /></SelectTrigger>
              <SelectContent>{KINDS.map((k) => <SelectItem key={k} value={k}>{t(`adm.doc.kind.${k}`)}</SelectItem>)}</SelectContent>
            </Select>
            <input ref={file} type="file" accept="application/pdf,image/jpeg,image/png" className="sr-only" id="cred-file" data-ref="cred-file" tabIndex={-1} aria-label={t('adm.doc.upload')} onChange={(e) => void upload(e.target.files?.[0])} />
            <Button size="sm" variant="outline" block loading={busy} onClick={() => file.current?.click()}><FileUp aria-hidden />{t('adm.doc.upload')}</Button>
            <p className="text-xs text-muted-foreground">{t('adm.doc.uploadHint')}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Verification({ d, creds, names, onDone }: { d: DoctorRow; creds: Credential[]; names: Record<string, string>; onDone: () => Promise<unknown> }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { session } = useAuth();
  const errText = useAdminError();
  const isAdmin = useHasRole('admin');
  const canEdit = useHasRole('admin', 'coordinator');
  const [dialog, setDialog] = useState<'verified' | 'rejected' | 'suspend' | 'reinstate' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const me = session?.user.id;
  const involved = !!me && (me === d.onboarded_by || me === d.submitted_by);
  const name = (u: string | null) => (u && names[u]) || '—';
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      setDialog(null);
      await onDone();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const missing = [!d.profile_id && t('adm.doc.step.login'), !creds.some((c) => c.kind === 'registration_certificate') && t('adm.doc.step.certificate')].filter(Boolean) as string[];

  return (
    <Card data-ref="verification">
      <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" aria-hidden />{t('adm.doc.verification')}</CardTitle>
        <CardDescription>{t('adm.doc.twoPerson')}</CardDescription></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          <Row k={t('adm.doc.onboardedBy')} v={`${name(d.onboarded_by)} · ${formatDateTime(d.created_at, lang)}`} />
          {d.submitted_at && <Row k={t('adm.doc.submittedBy')} v={`${name(d.submitted_by)} · ${formatDateTime(d.submitted_at, lang)}`} />}
          {d.verified_at && <Row k={t('adm.doc.verifiedBy')} v={`${name(d.verified_by)} · ${formatDateTime(d.verified_at, lang)}`} />}
          {d.verification_note && d.verification_status === 'verified' && <Row k={t('adm.doc.note')} v={d.verification_note} />}
          {d.verification_status === 'rejected' && d.rejection_reason && <Row k={t('adm.doc.rejectedBecause')} v={d.rejection_reason} />}
          {d.verification_status === 'suspended' && <Row k={t('adm.doc.suspendedBecause')} v={`${d.suspension_reason ?? ''} · ${d.suspended_at ? formatDateTime(d.suspended_at, lang) : ''}`} />}
        </dl>

        <div className="flex flex-wrap gap-2">
          {['draft', 'rejected'].includes(d.verification_status) && canEdit && (
            <>
              <Button disabled={missing.length > 0} loading={busy} data-ref="submit-doc"
                onClick={() => void run(() => submitDoctor(d.id), t('adm.doc.submitted'))}><Send aria-hidden />{t('adm.doc.submit')}</Button>
              {missing.length > 0 && <p className="self-center text-xs text-muted-foreground">{t('adm.doc.missing', { list: missing.join(', ') })}</p>}
            </>
          )}
          {d.verification_status === 'pending' && isAdmin && !involved && (
            <>
              <Button data-ref="verify-doc" onClick={() => { setNote(''); setDialog('verified'); }}><BadgeCheck aria-hidden />{t('adm.doc.verify')}</Button>
              <Button variant="outline" onClick={() => { setNote(''); setDialog('rejected'); }}><ShieldX aria-hidden />{t('adm.doc.reject')}</Button>
            </>
          )}
          {d.verification_status === 'pending' && (involved || !isAdmin) && <ReadOnlyNote>{involved ? t('adm.doc.notYou') : t('adm.doc.adminVerifies')}</ReadOnlyNote>}
          {['verified', 'pending'].includes(d.verification_status) && isAdmin && (
            <Button variant="outline" className="text-destructive" onClick={() => setDialog('suspend')}><Ban aria-hidden />{t('adm.doc.suspend')}</Button>
          )}
          {d.verification_status === 'suspended' && isAdmin && <Button variant="outline" onClick={() => setDialog('reinstate')}><RotateCcw aria-hidden />{t('adm.doc.reinstate')}</Button>}
        </div>

        <Dialog open={dialog === 'verified' || dialog === 'rejected'} onOpenChange={(o) => !o && setDialog(null)}>
          <DialogContent closeLabel={t('common.close')}>
            <DialogHeader>
              <DialogTitle>{dialog === 'verified' ? t('adm.doc.verifyTitle', { name: d.full_name }) : t('adm.doc.rejectTitle', { name: d.full_name })}</DialogTitle>
              <DialogDescription>{t('adm.doc.registrationLine', { no: d.registration_no, council: d.registration_council })}</DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="v-note">{dialog === 'verified' ? t('adm.doc.verifyNote') : t('adm.doc.rejectNote')}</Label>
              <Textarea id="v-note" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={dialog === 'verified' ? t('adm.doc.verifyNotePh') : ''} />
              <p className="text-xs text-muted-foreground">{t('adm.doc.noteHint')}</p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialog(null)}>{t('common.cancel')}</Button>
              <Button variant={dialog === 'rejected' ? 'destructive' : 'default'} disabled={note.trim().length < 10} loading={busy}
                onClick={() => void run(() => verifyDoctor(d.id, dialog as 'verified' | 'rejected', note.trim()), dialog === 'verified' ? t('adm.doc.verifiedOk') : t('adm.doc.rejectedOk'))}>
                {dialog === 'verified' ? t('adm.doc.verify') : t('adm.doc.reject')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <ReasonDialog open={dialog === 'suspend'} onOpenChange={(o) => !o && setDialog(null)} destructive title={t('adm.doc.suspendTitle', { name: d.full_name })}
          description={t('adm.doc.suspendBody')} confirmLabel={t('adm.doc.suspend')} busy={busy}
          onConfirm={(r) => void run(async () => {
            const res = await suspendDoctor(d.id, r);
            toast.message(t('adm.doc.suspendedResult', { count: res.cancelled, holds: res.holds_released }));
          }, t('adm.doc.suspendedOk'))} />
        <ReasonDialog open={dialog === 'reinstate'} onOpenChange={(o) => !o && setDialog(null)} title={t('adm.doc.reinstateTitle', { name: d.full_name })}
          description={t('adm.doc.reinstateBody')} confirmLabel={t('adm.doc.reinstate')} busy={busy}
          onConfirm={(r) => void run(() => reinstateDoctor(d.id, r), t('adm.doc.reinstatedOk'))} />
      </CardContent>
    </Card>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex flex-col py-0.5"><dt className="text-xs text-muted-foreground">{k}</dt><dd>{v}</dd></div>;
}
