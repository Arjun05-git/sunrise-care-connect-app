import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Gift, Plus, Search, Trash2, X } from 'lucide-react';
import { addDaysKey, formatDate, fromIst, istDateKey } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CardSkeleton, ErrorState } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import {
  searchPatients, useFeeData, useGrantOverride, useOverrides, usePolicies, useRevokeOverride, useSavePolicy, useSaveTiers,
  type MatchRule, type OverrideRow, type PatientHit, type Tier,
} from '../api';
import { ReadOnlyNote, ReasonDialog, useAdminError, useHasRole } from '../components';

const RULES: MatchRule[] = ['same_doctor', 'same_department', 'any'];

/** Follow-up policy, cancellation refund tiers and per-patient follow-up overrides (admin only to change). */
export function PoliciesPage() {
  const { t } = useTranslation();
  const isAdmin = useHasRole('admin');
  const policies = usePolicies();
  return (
    <div className="space-y-4">
      <PageHeader title={t('admin.policies')} subtitle={t('admin.pol.subtitle')} />
      {!isAdmin && <ReadOnlyNote>{t('admin.pol.adminOnly')}</ReadOnlyNote>}
      {policies.isPending ? <><CardSkeleton /><CardSkeleton /></> : policies.isError ? <ErrorState onRetry={() => void policies.refetch()} /> : (
        <div className="grid gap-4 xl:grid-cols-2">
          <FollowUpCard key={policies.data.policy.updated_at} canEdit={isAdmin} initial={policies.data.policy} />
          <TiersCard key={JSON.stringify(policies.data.tiers)} canEdit={isAdmin} initial={policies.data.tiers} />
        </div>
      )}
      <OverridesCard canEdit={isAdmin} />
    </div>
  );
}

function FollowUpCard({ canEdit, initial }: { canEdit: boolean; initial: { free_window_days: number; free_follow_up_count: number; match_rule: MatchRule } }) {
  const { t } = useTranslation();
  const save = useSavePolicy();
  const errText = useAdminError();
  const [days, setDays] = useState(String(initial.free_window_days));
  const [count, setCount] = useState(String(initial.free_follow_up_count));
  const [rule, setRule] = useState<MatchRule>(initial.match_rule);
  const [confirming, setConfirming] = useState(false);
  const valid = /^\d+$/.test(days) && Number(days) <= 365 && /^\d+$/.test(count) && Number(count) <= 10;
  const changed = Number(days) !== initial.free_window_days || Number(count) !== initial.free_follow_up_count || rule !== initial.match_rule;

  return (
    <Card>
      <CardHeader><CardTitle>{t('admin.pol.followUp')}</CardTitle><CardDescription>{t('admin.pol.followUpDesc')}</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="fw-days">{t('admin.pol.windowDays')}</Label>
            <Input id="fw-days" inputMode="numeric" disabled={!canEdit} value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fw-count">{t('admin.pol.freeCount')}</Label>
            <Input id="fw-count" inputMode="numeric" disabled={!canEdit} value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ''))} />
          </div>
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">{t('admin.pol.matchRule')}</legend>
          <RadioGroup value={rule} onValueChange={(v) => setRule(v as MatchRule)} disabled={!canEdit}>
            {RULES.map((r) => (
              <label key={r} className="flex min-h-11 cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary-soft/40">
                <RadioGroupItem value={r} className="mt-0.5" />
                <span className="text-sm"><span className="font-medium">{t(`admin.pol.rule.${r}`)}</span><span className="block text-xs text-muted-foreground">{t(`admin.pol.ruleHint.${r}`)}</span></span>
              </label>
            ))}
          </RadioGroup>
        </fieldset>
        <p className="rounded-xl bg-primary-soft/40 p-3 text-sm" aria-live="polite">
          {valid ? (Number(count) === 0 ? t('admin.pol.summaryNone') : t('admin.pol.summary', { count: Number(count), days: Number(days), rule: t(`admin.pol.rule.${rule}`).toLowerCase() })) : t('admin.pol.invalid')}
        </p>
        {canEdit && <Button disabled={!valid || !changed} onClick={() => setConfirming(true)}>{t('admin.pol.save')}</Button>}
      </CardContent>
      <ReasonDialog open={confirming} onOpenChange={setConfirming} title={t('admin.pol.confirmTitle')} description={t('admin.pol.confirmBody')} confirmLabel={t('common.save')} busy={save.isPending}
        onConfirm={(reason) => save.mutate({ window: Number(days), count: Number(count), match: rule, reason }, {
          onSuccess: () => { toast.success(t('common.saved')); setConfirming(false); },
          onError: (e) => toast.error(errText(e)),
        })} />
    </Card>
  );
}

function TiersCard({ canEdit, initial }: { canEdit: boolean; initial: Tier[] }) {
  const { t } = useTranslation();
  const save = useSaveTiers();
  const errText = useAdminError();
  const [tiers, setTiers] = useState(() => [...initial].sort((a, b) => b.min_hours_before - a.min_hours_before).map((x) => ({ h: String(x.min_hours_before), p: String(x.percent) })));
  const [confirming, setConfirming] = useState(false);
  const parsed = tiers.map((x) => ({ min_hours_before: Number(x.h), percent: Number(x.p) }));
  const valid = tiers.every((x) => /^\d+(\.\d+)?$/.test(x.h) && /^\d+$/.test(x.p) && Number(x.p) <= 100 && Number(x.h) <= 720)
    && new Set(parsed.map((x) => x.min_hours_before)).size === parsed.length && parsed.some((x) => x.min_hours_before === 0);
  const sorted = [...parsed].sort((a, b) => b.min_hours_before - a.min_hours_before);

  return (
    <Card>
      <CardHeader><CardTitle>{t('admin.pol.tiers')}</CardTitle><CardDescription>{t('admin.pol.tiersDesc')}</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-2">
          {tiers.map((x, i) => (
            <li key={i} className="flex items-end gap-2">
              <div className="flex-1 space-y-1">
                <Label htmlFor={`tier-h-${i}`} className="text-xs">{t('admin.pol.hoursBefore')}</Label>
                <Input id={`tier-h-${i}`} inputMode="decimal" disabled={!canEdit} value={x.h} onChange={(e) => setTiers((s) => s.map((y, j) => (j === i ? { ...y, h: e.target.value } : y)))} />
              </div>
              <div className="flex-1 space-y-1">
                <Label htmlFor={`tier-p-${i}`} className="text-xs">{t('admin.pol.refundPercent')}</Label>
                <Input id={`tier-p-${i}`} inputMode="numeric" disabled={!canEdit} value={x.p} onChange={(e) => setTiers((s) => s.map((y, j) => (j === i ? { ...y, p: e.target.value.replace(/\D/g, '') } : y)))} />
              </div>
              {canEdit && tiers.length > 1 && <Button variant="ghost" size="icon" aria-label={t('admin.pol.removeTier')} onClick={() => setTiers((s) => s.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>}
            </li>
          ))}
        </ul>
        {canEdit && tiers.length < 6 && <Button variant="outline" size="sm" onClick={() => setTiers((s) => [...s, { h: '', p: '' }])}><Plus aria-hidden />{t('admin.pol.addTier')}</Button>}
        <div className="rounded-xl bg-primary-soft/40 p-3 text-sm" aria-live="polite">
          {valid ? (
            <ul className="list-disc space-y-0.5 pl-5">
              {sorted.map((x) => <li key={x.min_hours_before}>{x.min_hours_before > 0 ? t('patient.review.refundTier', { percent: x.percent, hours: x.min_hours_before }) : t('patient.review.refundLate', { percent: x.percent })}</li>)}
              <li>{t('admin.pol.doctorCancel')}</li>
            </ul>
          ) : t('admin.pol.tiersInvalid')}
        </div>
        {canEdit && <Button disabled={!valid} onClick={() => setConfirming(true)}>{t('admin.pol.saveTiers')}</Button>}
      </CardContent>
      <ReasonDialog open={confirming} onOpenChange={setConfirming} title={t('admin.pol.confirmTitle')} description={t('admin.pol.confirmBody')} confirmLabel={t('common.save')} busy={save.isPending}
        onConfirm={(reason) => save.mutate({ tiers: parsed, reason }, { onSuccess: () => { toast.success(t('common.saved')); setConfirming(false); }, onError: (e) => toast.error(errText(e)) })} />
    </Card>
  );
}

function OverridesCard({ canEdit }: { canEdit: boolean }) {
  const { t, i18n } = useTranslation();
  const list = useOverrides();
  const grant = useGrantOverride();
  const revoke = useRevokeOverride();
  const docs = useFeeData();
  const errText = useAdminError();
  const [granting, setGranting] = useState(false);
  const [revoking, setRevoking] = useState<OverrideRow | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<PatientHit[]>([]);
  const [patient, setPatient] = useState<PatientHit | null>(null);
  const [doctor, setDoctor] = useState('any');
  const [count, setCount] = useState('1');
  const [until, setUntil] = useState(addDaysKey(istDateKey(), 14));

  useEffect(() => {
    if (patient) return;
    const id = setTimeout(() => void searchPatients(q).then(setHits).catch(() => setHits([])), 250);
    return () => clearTimeout(id);
  }, [q, patient]);

  const reset = () => { setQ(''); setHits([]); setPatient(null); setDoctor('any'); setCount('1'); setUntil(addDaysKey(istDateKey(), 14)); };
  const maxDate = addDaysKey(istDateKey(), 180);
  const valid = !!patient && /^[1-5]$/.test(count) && until > istDateKey() && until <= maxDate;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div><CardTitle>{t('admin.ovr.title')}</CardTitle><CardDescription>{t('admin.ovr.desc')}</CardDescription></div>
        {canEdit && <Button size="sm" onClick={() => { reset(); setGranting(true); }}><Gift aria-hidden />{t('admin.ovr.grant')}</Button>}
      </CardHeader>
      <CardContent>
        {list.isPending ? <CardSkeleton /> : list.isError ? <ErrorState onRetry={() => void list.refetch()} /> : list.data.length === 0 ? (
          <EmptyState className="py-6" art="users" title={t('admin.ovr.none')} />
        ) : (
          <ul className="divide-y rounded-xl border">
            {list.data.map((o) => (
              <li key={o.id} className="flex items-center gap-3 p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{o.patients?.full_name} <Badge variant="highlight" className="ml-1">{t('admin.ovr.free', { count: o.free_count })}</Badge></p>
                  <p className="text-muted-foreground">{o.doctors?.full_name ?? t('admin.ovr.anyDoctor')} · {t('admin.ovr.until', { date: formatDate(o.valid_until, i18n.language) })}</p>
                  <p className="truncate text-xs text-muted-foreground">{o.reason}</p>
                </div>
                {canEdit && <Button variant="ghost" size="icon" aria-label={t('admin.ovr.revokeFor', { name: o.patients?.full_name })} onClick={() => setRevoking(o)}><X className="h-4 w-4" /></Button>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <ReasonDialog open={granting} onOpenChange={setGranting} title={t('admin.ovr.grantTitle')} description={t('admin.ovr.grantDesc')} confirmLabel={t('admin.ovr.grant')} busy={grant.isPending} valid={valid}
        onConfirm={(reason) => grant.mutate(
          { patient_id: patient!.id, doctor_id: doctor === 'any' ? null : doctor, count: Number(count), valid_until: new Date(fromIst(until, '23:59').getTime()).toISOString(), reason },
          { onSuccess: () => { toast.success(t('admin.ovr.granted')); setGranting(false); }, onError: (e) => toast.error(errText(e)) },
        )}>
        <div className="space-y-1.5">
          <Label htmlFor="ovr-patient">{t('admin.ovr.patient')}</Label>
          {patient ? (
            <div className="flex items-center justify-between rounded-xl border bg-primary-soft/40 px-3 py-2 text-sm">
              <span><b>{patient.full_name}</b> · {patient.his_mrn ?? patient.phone}</span>
              <Button variant="ghost" size="sm" onClick={() => setPatient(null)}>{t('auth.change')}</Button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input id="ovr-patient" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('admin.ovr.searchPh')} autoComplete="off" />
              </div>
              {hits.length > 0 && (
                <ul className="max-h-40 overflow-y-auto rounded-xl border" role="listbox" aria-label={t('admin.ovr.patient')}>
                  {hits.map((h) => (
                    <li key={h.id}><button type="button" role="option" aria-selected={false} className="w-full px-3 py-2 text-left text-sm hover:bg-accent" onClick={() => setPatient(h)}>
                      <b>{h.full_name}</b> <span className="text-muted-foreground">· {h.his_mrn ?? h.phone} · {h.date_of_birth}</span>
                    </button></li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ovr-doctor">{t('admin.ovr.doctor')}</Label>
          <Select value={doctor} onValueChange={setDoctor}>
            <SelectTrigger id="ovr-doctor"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any">{t('admin.ovr.anyDoctor')}</SelectItem>
              {docs.data?.doctors.filter((d) => d.active && d.verification_status === 'verified').map((d) => <SelectItem key={d.id} value={d.id}>{d.full_name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="ovr-count">{t('admin.ovr.count')}</Label>
            <Input id="ovr-count" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, '').slice(0, 1))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ovr-until">{t('admin.ovr.validUntil')}</Label>
            <Input id="ovr-until" type="date" min={addDaysKey(istDateKey(), 1)} max={maxDate} value={until} onChange={(e) => setUntil(e.target.value)} />
          </div>
        </div>
      </ReasonDialog>

      <ReasonDialog open={!!revoking} onOpenChange={(o) => !o && setRevoking(null)} title={t('admin.ovr.revokeTitle', { name: revoking?.patients?.full_name })} confirmLabel={t('admin.ovr.revoke')} destructive busy={revoke.isPending}
        onConfirm={(reason) => revoke.mutate({ id: revoking!.id, reason }, { onSuccess: () => { toast.success(t('admin.ovr.revoked')); setRevoking(null); }, onError: (e) => toast.error(errText(e)) })} />
    </Card>
  );
}
