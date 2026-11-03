import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CircleCheck, CircleDashed, Plus, Search } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { ErrorState, ListSkeleton } from '@/components/feedback/states';
import { EmptyState } from '@/components/feedback/EmptyState';
import { useHasRole } from '../components';
import { useDoctors, useMasters, type VerificationStatus } from '../console-api';

export const VERIFY_VARIANT: Record<VerificationStatus, BadgeProps['variant']> = { draft: 'outline', pending: 'warning', verified: 'success', rejected: 'destructive', suspended: 'neutral' };
const TABS = ['all', 'pending', 'draft', 'verified', 'rejected', 'suspended'] as const;

/** Doctors: onboarding pipeline and registration status. */
export function DoctorsPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('status') ?? 'all') as (typeof TABS)[number];
  const [q, setQ] = useState('');
  const doctors = useDoctors();
  const masters = useMasters();
  const canOnboard = useHasRole('admin', 'coordinator');
  const dept = useMemo(() => Object.fromEntries((masters.data?.departments ?? []).map((d) => [d.id, d.name])), [masters.data]);
  const hosp = useMemo(() => Object.fromEntries((masters.data?.hospitals ?? []).map((h) => [h.id, h.name])), [masters.data]);
  const all = doctors.data ?? [];
  const count = (s: string) => (s === 'all' ? all.length : all.filter((d) => d.verification_status === s).length);
  const rows = all.filter((d) => (tab === 'all' || d.verification_status === tab) &&
    (!q.trim() || `${d.full_name} ${d.registration_no} ${d.phone}`.toLowerCase().includes(q.trim().toLowerCase())));

  return (
    <div className="space-y-4">
      <PageHeader title={t('admin.doctors')} subtitle={t('adm.doc.subtitle')}
        actions={canOnboard && <Button asChild><Link to="/a/doctors/new"><Plus aria-hidden />{t('adm.doc.new')}</Link></Button>} />
      <div className="flex flex-wrap items-center gap-3">
        <Segmented aria-label={t('adm.doc.filter')} className="h-auto flex-wrap" value={tab} onValueChange={(v) => setParams(v === 'all' ? {} : { status: v }, { replace: true })}
          options={TABS.map((s) => ({ value: s, label: <>{t(`adm.doc.st.${s}`)} <span className="ml-1 tabular-nums">{count(s)}</span></> }))} />
        <div className="relative ml-auto w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('adm.doc.search')} aria-label={t('adm.doc.search')} />
        </div>
      </div>
      {doctors.isPending ? <ListSkeleton rows={5} /> : doctors.isError ? <ErrorState onRetry={() => void doctors.refetch()} /> : rows.length === 0 ? (
        <Card><EmptyState art="users" title={t('adm.doc.none')} /></Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm" data-ref="doctor-table">
            <thead><tr className="border-b text-left text-xs text-muted-foreground">
              {['name', 'department', 'registration', 'login', 'status'].map((h) => <th key={h} scope="col" className="px-4 py-2 font-medium">{t(`adm.doc.col.${h}`)}</th>)}
            </tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="cursor-pointer border-b last:border-0 hover:bg-accent" onClick={() => nav(`/a/doctors/${d.id}`)}>
                  <td className="px-4 py-2.5"><Link to={`/a/doctors/${d.id}`} className="font-semibold text-primary hover:underline" onClick={(e) => e.stopPropagation()}>{d.full_name}</Link>
                    <span className="block text-xs text-muted-foreground">{d.qualification}</span></td>
                  <td className="px-4 py-2.5">{dept[d.department_id]}<span className="block text-xs text-muted-foreground">{hosp[d.hospital_id]}</span></td>
                  <td className="px-4 py-2.5 font-mono text-xs">{d.registration_no}<span className="block font-sans text-muted-foreground">{d.registration_council}</span></td>
                  <td className="px-4 py-2.5">{d.profile_id ? <CircleCheck className="h-4 w-4 text-success" aria-label={t('adm.doc.hasLogin')} /> : <CircleDashed className="h-4 w-4 text-muted-foreground" aria-label={t('adm.doc.noLogin')} />}</td>
                  <td className="px-4 py-2.5"><Badge variant={VERIFY_VARIANT[d.verification_status]}>{t(`adm.doc.st.${d.verification_status}`)}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
