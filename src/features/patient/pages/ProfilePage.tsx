import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
import type { ConsentType } from '@/domain/types';
import { ageFromDob, formatDateLong } from '@/domain/time';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { ListSkeleton } from '@/components/feedback/states';
import { SettingsPanel } from '@/pages/SettingsPanel';
import { useAuth } from '@/auth/AuthProvider';
import { rpcErrorCode } from '@/lib/supabase';
import { ALL_CONSENTS, REQUIRED_CONSENTS, useArchivePatient, useConsents, useFamily, useSetConsents, type FamilyMember } from '../api';
import { NotificationPrefsCard } from '@/features/notifications/PrefsCard';
import { PersonAvatar, QueryError, useRpcErrorText } from '../components/common';

export function ProfilePage() {
  const { t, i18n } = useTranslation();
  const { session } = useAuth();
  const family = useFamily();
  const archive = useArchivePatient();
  const consents = useConsents();
  const setConsents = useSetConsents();
  const nav = useNavigate();
  const errText = useRpcErrorText();
  const [removing, setRemoving] = useState<FamilyMember | null>(null);
  const [withdrawing, setWithdrawing] = useState<ConsentType | null>(null);

  const me = family.data?.find((m) => m.is_primary);
  const others = family.data?.filter((m) => !m.is_primary) ?? [];
  const active = (c: ConsentType) => consents.data?.find((r) => r.consent_type === c);

  const describe = (m: FamilyMember) =>
    [m.relation ? t(`patient.relation.${m.relation}`) : null, t('patient.age', { count: ageFromDob(m.date_of_birth) }), t(`patient.gender.${m.gender}`)].filter(Boolean).join(' · ');

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title={t('nav.profile')} subtitle={session?.user.phone ?? undefined} />

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div><CardTitle>{t('patient.family.title')}</CardTitle><CardDescription>{t('patient.family.subtitle')}</CardDescription></div>
          <Button size="sm" variant="secondary" asChild><Link to="/p/profile/family/new"><Plus aria-hidden />{t('patient.family.addShort')}</Link></Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {family.isPending ? <ListSkeleton rows={2} /> : family.isError ? <QueryError onRetry={() => void family.refetch()} /> : (
            <ul className="divide-y rounded-xl border">
              {[me, ...others].filter(Boolean).map((m) => (
                <li key={m!.id} className="flex items-center gap-2 p-3">
                  <PersonAvatar name={m!.full_name} />
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-semibold">{m!.full_name} {m!.is_primary && <Badge variant="neutral" className="ml-1 align-middle">{t('patient.family.you')}</Badge>}</p>
                    <p className="text-sm text-muted-foreground">{describe(m!)}{m!.allergies.length ? ` · ${t('patient.family.allergyCount', { count: m!.allergies.length })}` : ''}</p>
                  </div>
                  <Button variant="ghost" size="icon" aria-label={t('patient.family.editName', { name: m!.full_name })} onClick={() => nav(`/p/profile/family/${m!.id}`)}><Pencil className="h-4 w-4" /></Button>
                  {!m!.is_primary && (
                    <Button variant="ghost" size="icon" aria-label={t('patient.family.removeName', { name: m!.full_name })} onClick={() => setRemoving(m!)}><Trash2 className="h-4 w-4 text-muted-foreground" /></Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('patient.consent.manageTitle')}</CardTitle><CardDescription>{t('patient.consent.manageSubtitle')}</CardDescription></CardHeader>
        <CardContent className="space-y-1">
          {ALL_CONSENTS.map((c) => {
            const row = active(c);
            const required = REQUIRED_CONSENTS.includes(c);
            return (
              <div key={c} className="flex min-h-11 items-center gap-3 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{t(`patient.consent.${c}`)}</p>
                  <p className="text-xs text-muted-foreground">{row ? t('patient.consent.givenOn', { date: formatDateLong(row.granted_at, i18n.language), version: row.version }) : t('patient.consent.notGiven')}</p>
                </div>
                {required ? (
                  row && <Button variant="link" size="sm" className="text-destructive" onClick={() => setWithdrawing(c)}>{t('patient.consent.withdraw')}</Button>
                ) : (
                  <Switch checked={!!row} aria-label={t(`patient.consent.${c}`)} onCheckedChange={(v) => setConsents.mutate({ types: [c], granted: v }, { onError: () => toast.error(t('common.error')) })} />
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <NotificationPrefsCard />

      <Link to="/p/doctors" className="flex items-center justify-between rounded-lg border bg-card p-4 text-sm font-semibold shadow-soft hover:bg-accent">
        {t('patient.home.findDoctor')}<ChevronRight className="h-4 w-4" aria-hidden />
      </Link>
      <Link to="/p/help" data-ref="help-link" className="flex items-center justify-between rounded-lg border bg-card p-4 text-sm font-semibold shadow-soft hover:bg-accent">
        {t('help.title')}<ChevronRight className="h-4 w-4" aria-hidden />
      </Link>

      <SettingsPanel withHeader={false} />

      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{t('patient.family.removeTitle', { name: removing?.full_name })}</DialogTitle>
            <DialogDescription>{t('patient.family.removeBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" loading={archive.isPending} onClick={() => removing && archive.mutate(removing.id, {
              onSuccess: () => { toast.success(t('patient.family.removed')); setRemoving(null); },
              onError: (e) => toast.error(errText(rpcErrorCode(e))),
            })}>{t('patient.family.remove')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!withdrawing} onOpenChange={(o) => !o && setWithdrawing(null)}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{t('patient.consent.withdrawTitle')}</DialogTitle>
            <DialogDescription>{t('patient.consent.withdrawBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWithdrawing(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" loading={setConsents.isPending} onClick={() => withdrawing && setConsents.mutate({ types: [withdrawing], granted: false }, {
              onSuccess: () => setWithdrawing(null),
              onError: () => toast.error(t('common.error')),
            })}>{t('patient.consent.withdraw')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
